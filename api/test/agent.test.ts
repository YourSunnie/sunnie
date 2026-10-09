import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { tool, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { buildContextMessages, runTurn, withoutStaleProviderTools } from '../src/agent/agent.ts';
import { chooseCut } from '../src/agent/compaction.ts';
import { toMessageDto } from '../src/agent/events.ts';
import type { StoredMessage } from '../src/store/conversations.ts';
import { eventSink, generated, promptText, registryOf, testSunnie, textStep, toolStep } from './helpers.ts';

function turn(sunnie: ReturnType<typeof testSunnie>, conversationId: string, text: string, signal?: AbortSignal) {
  const sink = eventSink();
  const done = runTurn(sunnie.deps, {
    conversationId,
    runId: 'run_test',
    text,
    signal: signal ?? new AbortController().signal,
    emit: sink.emit,
  });
  return { sink, done };
}

test('a turn runs tools on the computer and persists every step', async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('bash', { command: 'echo "42 degrees" > reading.txt && cat reading.txt' }),
      textStep('The reading is 42 degrees.'),
    ],
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { conversations, memory, core } = sunnie.deps;
  core.set('user', 'Name: Aditya');
  memory.add({ content: 'The greenhouse sensor reading is logged every morning', source: 'agent' });
  const conv = conversations.create();

  const { sink, done } = turn(sunnie, conv.id, 'What is the greenhouse reading?');
  const result = await done;

  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 2);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const messages = conversations.listMessages(conv.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[0]!.text, 'What is the greenhouse reading?');
  assert.equal(messages[3]!.text, 'The reading is 42 degrees.');
  assert.match(JSON.stringify(messages[2]!.content), /42 degrees\\n\\n\[exit code 0\]/);
  assert.equal(conversations.get(conv.id)!.title, 'What is the greenhouse reading?');

  const types = sink.types();
  assert.deepEqual(types.filter((t) => t !== 'text.delta'), [
    'message', 'tool.call', 'tool.result', 'message', 'message', 'message',
  ]);
  assert.ok(types.includes('text.delta'));

  // The model saw core memory in the system prompt and the recalled memory next to the question.
  const first = promptText(model.doStreamCalls[0]);
  assert.match(first, /Name: Aditya/);
  assert.match(first, /greenhouse sensor reading is logged every morning/);
  assert.match(first, /Current time:/);
  // The second call carried the tool exchange back to the model.
  assert.match(promptText(model.doStreamCalls[1]), /tool-result/);

  await sunnie.close();
});

/** The system message of a recorded model call. */
const systemOf = (call: unknown) =>
  JSON.stringify((call as { prompt: Array<{ role: string }> }).prompt.filter((m) => m.role === 'system'));

test('a provider that caches only where asked gets the marks on the system prompt and the last message of every call', async () => {
  const model = new MockLanguageModelV4({
    doStream: [toolStep('bash', { command: 'echo hi' }), textStep('Done.')],
  });
  const marks = { system: { mock: { cacheControl: { type: 'ephemeral', ttl: '1h' } } }, message: { mock: { cacheControl: { type: 'ephemeral' } } } };
  const sunnie = testSunnie({}, { models: registryOf(model, 128_000, false, { cacheMarks: marks }) });
  const conv = sunnie.deps.conversations.create();

  await turn(sunnie, conv.id, 'Say hi').done;

  type Call = { prompt: Array<{ role: string; providerOptions?: unknown }> };
  const calls = model.doStreamCalls as unknown as Call[];
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const [system, ...rest] = call.prompt;
    assert.equal(system!.role, 'system');
    assert.deepEqual(system!.providerOptions, marks.system);
    // Only the last message is marked: the step before it was the prefix the mark now extends.
    assert.deepEqual(rest.at(-1)!.providerOptions, marks.message);
    assert.ok(rest.slice(0, -1).every((m) => m.providerOptions === undefined));
  }
  assert.equal(calls[1]!.prompt.at(-1)!.role, 'tool');
  // The marks never reach storage.
  assert.ok(sunnie.deps.conversations.listMessages(conv.id).every((m) => !JSON.stringify(m.content).includes('cacheControl')));

  await sunnie.close();
});

test('a provider that takes notes as system messages gets the wrap-up that way, unmarked and unstored', async () => {
  const model = new MockLanguageModelV4({
    doStream: [toolStep('bash', { command: 'echo one' }, 'call-1'), textStep('That is as far as I got.')],
  });
  const marks = { system: { mock: { cache: 'system' } }, message: { mock: { cache: 'tail' } } };
  const notes = { mock: { clearAt: 'next_user_message' } };
  const sunnie = testSunnie({ agent: { maxSteps: 1 } }, { models: registryOf(model, 128_000, false, { cacheMarks: marks, systemNotes: notes }) });
  const conv = sunnie.deps.conversations.create();

  const result = await turn(sunnie, conv.id, 'count to three').done;

  assert.equal(result.finishReason, 'step-limit');
  type Call = { prompt: Array<{ role: string; content: unknown; providerOptions?: unknown }> };
  const wrapUp = (model.doStreamCalls[1] as unknown as Call).prompt;
  const [note, tail] = [wrapUp.at(-1)!, wrapUp.at(-2)!];
  assert.equal(note.role, 'system');
  assert.match(JSON.stringify(note.content), /used all the steps you have for this turn/);
  assert.deepEqual(note.providerOptions, notes);
  // The cache mark stays on the last stored message; the note behind it is gone next call anyway.
  assert.equal(tail.role, 'tool');
  assert.deepEqual(tail.providerOptions, marks.message);
  // The user's own message carries nothing but the user's words.
  assert.ok(!JSON.stringify(wrapUp[1]!.content).includes('Automatic note'));
  assert.doesNotMatch(JSON.stringify(sunnie.deps.conversations.listMessages(conv.id).map((m) => m.content)), /Automatic note/);
  await sunnie.close();
});

test('tools the provider runs itself are sent beside the agent\'s, told of in the prompt, and dropped from history once gone', async () => {
  const model = new MockLanguageModelV4({ doStream: [textStep('Hello.')] });
  const advisor = tool({ description: 'A stronger model', inputSchema: z.object({}) });
  const sunnie = testSunnie({}, { models: registryOf(model, 128_000, false, { providerTools: { advisor } }) });
  const conv = sunnie.deps.conversations.create();

  await turn(sunnie, conv.id, 'hi').done;

  const call = model.doStreamCalls[0]!;
  assert.ok(call.tools!.some((t) => t.name === 'advisor'));
  assert.match(systemOf(call), /# Your advisor/);
  await sunnie.close();

  const history: ModelMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'a1', toolName: 'advisor', input: {}, providerExecuted: true },
      // The result comes back without the flag; it goes with its call.
      { type: 'tool-result', toolCallId: 'a1', toolName: 'advisor', output: { type: 'text', value: 'advice' } },
      { type: 'tool-call', toolCallId: 's1', toolName: 'bash', input: { command: 'ls' } },
      { type: 'text', text: 'Done.' },
    ] },
  ];
  const stripped = withoutStaleProviderTools(history, { shell: advisor });
  assert.deepEqual((stripped[1]!.content as Array<{ type: string }>).map((p) => p.type), ['tool-call', 'text']);
  // With the advisor still in the set, nothing is touched.
  assert.strictEqual(withoutStaleProviderTools(history, { advisor })[1], history[1]);
});

test('the agent can write to its own memory without disturbing the cached prompt prefix', async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('memory_save', { content: 'Aditya is allergic to peanuts', kind: 'fact' }),
      toolStep('core_memory_append', { block: 'persona', text: 'Prefers short answers.' }, 'call-2'),
      textStep('Noted.'),
      textStep('Hello again.'),
    ],
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { conversations, memory, core } = sunnie.deps;
  const conv = conversations.create();

  await turn(sunnie, conv.id, 'I am allergic to peanuts. Also, keep it short.').done;

  assert.equal(memory.search('peanuts')[0]?.source, 'agent');
  assert.equal(core.get('persona'), 'Prefers short answers.');

  // The system prompt is byte-identical across every call of the conversation — the edit must
  // not rewrite it, or the provider's prompt cache would be thrown away mid-conversation...
  const [first, second, third] = model.doStreamCalls.map(systemOf);
  assert.equal(second, first);
  assert.equal(third, first);
  assert.doesNotMatch(third!, /Prefers short answers/);
  // ...the model learns the block's new contents from the tool result instead.
  assert.match(promptText(model.doStreamCalls[2]), /It now reads:\\nPrefers short answers\./);

  // A new conversation starts from the updated core memory.
  await turn(sunnie, conversations.create().id, 'hi').done;
  assert.match(systemOf(model.doStreamCalls[3]), /Prefers short answers\./);
  await sunnie.close();
});

/** The text of every tool result stored in a conversation, in order. */
function toolOutputs(sunnie: ReturnType<typeof testSunnie>, conversationId: string): string[] {
  return sunnie.deps.conversations
    .listMessages(conversationId)
    .filter((m) => m.role === 'tool')
    .map((m) => toMessageDto(m).parts.map((p) => (p.type === 'tool_result' ? p.output : '')).join(''));
}

test('file tools write, edit and read files on the computer', async () => {
  const tricky = "notes/it's a plan.md";
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('write_file', { path: tricky, content: 'line one\nprice: $5\nline three\n' }, 'c1'),
      toolStep('edit_file', { path: tricky, old_text: 'price: $5', new_text: 'price: $& 10' }, 'c2'),
      toolStep('edit_file', { path: tricky, old_text: 'line', new_text: 'row' }, 'c3'),
      toolStep('read_file', { path: tricky, offset: 2 }, 'c4'),
      textStep('Done.'),
    ],
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  await turn(sunnie, conv.id, 'Make some notes').done;

  const [write, edit, ambiguous, read] = toolOutputs(sunnie, conv.id);
  assert.match(write!, /^Wrote 30 characters/);
  assert.match(edit!, /^Replaced 1 occurrence/);
  assert.match(ambiguous!, /matches 2 places/);
  // Replacement text is literal, and line numbers follow the offset.
  assert.equal(read, '    2  price: $& 10\n    3  line three');
  await sunnie.close();
});

test('a binary file is refused by read_file, and view_image shows the model the picture itself', async () => {
  // A 1×1 red PNG.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('bash', { command: `echo ${png} | base64 -d > dot.png` }, 'c1'),
      toolStep('read_file', { path: 'dot.png' }, 'c2'),
      toolStep('view_image', { path: 'dot.png' }, 'c3'),
      toolStep('view_image', { path: 'missing.png' }, 'c4'),
      textStep('A red dot.'),
    ],
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  await turn(sunnie, conv.id, 'Make a dot and look at it').done;

  const [, read, view, missing] = toolOutputs(sunnie, conv.id);
  assert.match(read!, /dot\.png is an image, not text.*Use view_image/);
  // The app and the router see a line about the picture, never its bytes.
  assert.equal(view, `${sunnie.deps.computer.workspace}/Drive/dot.png (image/png, 0 KB)\n[image]`);
  assert.match(missing!, /No such file/);
  // The model got the picture as a file part, stored with the step like any tool result.
  const stored = sunnie.deps.conversations.listMessages(conv.id).filter((m) => m.role === 'tool');
  const shown = (stored[2]!.content as Array<{ output: { type: string; value: Array<{ type: string; mediaType?: string; data?: { data: string } }> } }>)[0]!.output;
  assert.equal(shown.type, 'content');
  assert.deepEqual(shown.value.map((v) => v.type), ['text', 'file']);
  assert.equal(shown.value[1]!.mediaType, 'image/png');
  assert.equal(shown.value[1]!.data!.data, png);
  const prompt = JSON.stringify((model.doStreamCalls[3] as { prompt: unknown }).prompt);
  assert.ok(prompt.includes(png), 'the next call carries the picture');
  await sunnie.close();
});

test('web_fetch reads a page through the computer and reduces HTML to text', async () => {
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><style>p{}</style></head><body><h1>Ferry times</h1><p>Departs&nbsp;at 9am &amp; 2pm</p><script>x()</script></body></html>');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/ferry`;

  const model = new MockLanguageModelV4({ doStream: [toolStep('web_fetch', { url }), textStep('9am and 2pm.')] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  await turn(sunnie, conv.id, 'When is the ferry?').done;

  assert.equal(toolOutputs(sunnie, conv.id)[0], `HTTP 200 ${url}\n\nFerry times\nDeparts at 9am & 2pm`);
  await sunnie.close();
  site.close();
});

test('a failing tool is reported to the model instead of failing the turn', async () => {
  const model = new MockLanguageModelV4({
    doStream: [toolStep('read_file', { path: 'missing.txt' }), textStep('That file does not exist.')],
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();

  const { sink, done } = turn(sunnie, conv.id, 'Read missing.txt');
  assert.equal((await done).status, 'completed');

  const toolResult = sink.events.find((e) => e.type === 'tool.result');
  assert.ok(toolResult?.type === 'tool.result' && toolResult.isError);
  assert.match(toolResult.output, /No such file/);
  assert.match(promptText(model.doStreamCalls[1]), /No such file/);
  await sunnie.close();
});

test('a model error rejects the turn but keeps the user message', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('upstream exploded');
    },
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();

  await assert.rejects(turn(sunnie, conv.id, 'hello').done, /upstream exploded/);
  assert.deepEqual(sunnie.deps.conversations.listMessages(conv.id).map((m) => m.role), ['user']);
  await sunnie.close();
});

test('a transient failure before any output is retried; a permanent one is not', async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      if (calls === 1) throw new Error('openai/gpt is temporarily rate-limited upstream. Please retry shortly.');
      return textStep('Here now.');
    },
  });
  const sunnie = testSunnie({ agent: { retryBaseMs: 1 } }, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();

  const result = await turn(sunnie, conv.id, 'hello').done;
  assert.equal(result.status, 'completed');
  assert.equal(result.steps, 1, 'a retried attempt does not use up a step');
  assert.equal(calls, 2);
  assert.deepEqual(sunnie.deps.conversations.listMessages(conv.id).map((m) => m.text), ['hello', 'Here now.']);

  const denied = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      throw new Error('Invalid API key');
    },
  });
  const other = testSunnie({ agent: { retryBaseMs: 1 } }, { models: registryOf(denied) });
  calls = 0;
  await assert.rejects(turn(other, other.deps.conversations.create().id, 'hello').done, /Invalid API key/);
  assert.equal(calls, 1);
  await sunnie.close();
  await other.close();
});

test('cancelling mid-tool stops the command and leaves no dangling tool call', async () => {
  const model = new MockLanguageModelV4({ doStream: [toolStep('bash', { command: 'sleep 30' })] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  const abort = new AbortController();

  const sink = eventSink();
  const started = Date.now();
  const result = await runTurn(sunnie.deps, {
    conversationId: conv.id,
    runId: 'run_test',
    text: 'wait a while',
    signal: abort.signal,
    emit: (e) => {
      sink.emit(e);
      if (e.type === 'tool.call') setTimeout(() => abort.abort(), 50);
    },
  });

  assert.equal(result.status, 'cancelled');
  assert.ok(Date.now() - started < 5000, 'the sleep was killed, not waited for');
  assert.deepEqual(sunnie.deps.conversations.listMessages(conv.id).map((m) => m.role), ['user']);
  await sunnie.close();
});

test('the context is compacted automatically once it outgrows its budget', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      generated(
        '<summary>\nThe user is planning a trip to Lombok in December and asked for ferry times.\n</summary>\n' +
          '<memories>\n- [event] Aditya is travelling to Lombok in December 2026\n- [preference] Aditya prefers ferries over flights\n</memories>',
      ),
    ],
    doStream: [textStep('Picking up where we left off.')],
  });
  const sunnie = testSunnie(
    { compaction: { maxContextTokens: 3000, keepRecentTokens: 800 } },
    { models: registryOf(model) },
  );
  const { conversations, memory } = sunnie.deps;
  const conv = conversations.create();
  const filler = 'ferry schedule details '.repeat(60);
  for (let i = 0; i < 6; i++) {
    conversations.appendMessages(conv.id, [
      { role: 'user', content: [{ type: 'text', text: `question ${i} ${filler}` }], text: `question ${i} ${filler}` },
      { role: 'assistant', content: [{ type: 'text', text: `answer ${i} ${filler}` }], text: `answer ${i} ${filler}` },
    ]);
  }

  memory.add({ content: 'Aditya gets seasick on small boats', source: 'agent', conversationId: conv.id });
  memory.add({ content: 'Aditya keeps bees', source: 'agent', conversationId: 'conv_other' });

  const { sink, done } = turn(sunnie, conv.id, 'So what did we decide?');
  await done;

  assert.ok(sink.types().includes('compaction.started'));
  // The summariser is shown what this conversation already saved, so it does not save it again.
  const asked = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  assert.match(asked, /<known_memory>[^<]*- Aditya gets seasick on small boats/);
  assert.doesNotMatch(asked, /keeps bees/);
  const completed = sink.events.find((e) => e.type === 'compaction.completed');
  assert.ok(completed?.type === 'compaction.completed' && completed.memoriesSaved === 2);

  const after = conversations.get(conv.id)!;
  assert.match(after.summary!, /trip to Lombok/);
  assert.ok(after.summaryUptoSeq >= 10, 'most of the old exchange was folded into the summary');
  assert.equal(memory.search('Lombok December')[0]?.source, 'compaction');

  // The summariser was given the old transcript; the agent then saw the summary, not the transcript.
  assert.match(promptText(model.doGenerateCalls[0]), /question 0/);
  const agentPrompt = promptText(model.doStreamCalls[0]);
  assert.match(agentPrompt, /conversation_summary/);
  assert.doesNotMatch(agentPrompt, /question 0/);
  assert.match(agentPrompt, /So what did we decide\?/);

  // Nothing is deleted: the full history is still there for the client and for search.
  assert.equal(conversations.listMessages(conv.id).length, 14);
  assert.ok(conversations.searchMessages('question 0').length > 0);
  await sunnie.close();
});

test('a summariser that is down does not take the turn down with it', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('Invalid summariser configuration');
    },
    doStream: [textStep('Still here.')],
  });
  const sunnie = testSunnie(
    { compaction: { maxContextTokens: 3000, keepRecentTokens: 800 } },
    { models: registryOf(model) },
  );
  const { conversations } = sunnie.deps;
  const conv = conversations.create();
  const filler = 'ferry schedule details '.repeat(60);
  for (let i = 0; i < 6; i++) {
    conversations.appendMessages(conv.id, [
      { role: 'user', content: [{ type: 'text', text: filler }], text: filler },
      { role: 'assistant', content: [{ type: 'text', text: filler }], text: filler },
    ]);
  }

  const { sink, done } = turn(sunnie, conv.id, 'Are you there?');
  assert.equal((await done).status, 'completed');
  assert.ok(sink.types().includes('compaction.started'));
  assert.ok(sink.types().includes('compaction.failed'));
  assert.equal(conversations.get(conv.id)!.summary, null);
  assert.equal(conversations.listMessages(conv.id).at(-1)!.text, 'Still here.');
  await sunnie.close();
});

const msg = (seq: number, role: StoredMessage['role'], size = 100): StoredMessage => ({
  id: `m${seq}`,
  conversationId: 'c',
  origin: null,
  seq,
  role,
  content: [{ type: 'text', text: 'x'.repeat(size) }],
  text: '',
  model: null,
  runId: null,
  createdAt: '',
});

test('chooseCut keeps tool calls with their results and prefers turn boundaries', () => {
  const roles: StoredMessage['role'][] = ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant'];
  const messages = roles.map((role, i) => msg(i + 1, role));

  // Everything fits: nothing to compact.
  assert.equal(chooseCut(messages, 10_000), 0);
  // Room for the last two messages, which would start on a tool result: there is no later user
  // turn, so fall back to the nearest point that is not between a call and its result.
  assert.equal(messages[chooseCut(messages, 100)]!.role, 'assistant');
  assert.equal(chooseCut(messages, 100), 7);
  // Room for the last five: the cut lands exactly on the second user turn.
  assert.equal(chooseCut(messages, 200), 4);
  // An unanswered user message is never summarised away, however small the budget.
  assert.equal(chooseCut([msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user', 5000)], 10), 2);
});

const readStep = (seq: number, chars: number, tool = 'web_fetch'): StoredMessage[] => [
  { ...msg(seq, 'assistant', 20), content: [{ type: 'tool-call', toolCallId: `c${seq}`, toolName: tool, input: {} }] },
  { ...msg(seq + 1, 'tool', 0), content: [{ type: 'tool-result', toolCallId: `c${seq}`, toolName: tool, output: { type: 'text', value: 'p'.repeat(chars) } }] },
];

test('chooseCut keeps the latest long read whole when it is within reach', () => {
  // A turn that fetched an article and answered, then a turn of small steps after it.
  const messages = [
    msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user'), ...readStep(4, 20_000), msg(6, 'assistant'),
    msg(7, 'user'), ...readStep(8, 200, 'read_file'), msg(10, 'assistant'),
  ];
  // Without reach the article is summarised away: the cut lands on the last turn.
  assert.equal(chooseCut(messages, 400), 6);
  // With room for it the cut moves back to the step that fetched it, or to its whole turn when that fits too.
  assert.equal(chooseCut(messages, 400, 6_020), 3);
  assert.equal(chooseCut(messages, 400, 6_100), 2);
  // A read longer than the reach is left to the summary.
  assert.equal(chooseCut(messages, 400, 3_000), 6);
  // A short read is not a long read, and a failed one is not a read at all.
  const short = [msg(1, 'user'), ...readStep(2, 500), msg(4, 'assistant'), msg(5, 'user'), msg(6, 'assistant')];
  assert.equal(chooseCut(short, 150, 10_000), 4);
  const failed = [msg(1, 'user'), ...readStep(2, 20_000), msg(4, 'assistant'), msg(5, 'user'), msg(6, 'assistant')];
  (failed[2]!.content as Array<Record<string, unknown>>)[0]!.output = { type: 'error-text', value: 'x'.repeat(20_000) };
  assert.equal(chooseCut(failed, 150, 10_000), 4);
});

test('the summary is folded into the first user message, or stands alone before an assistant one', () => {
  const conversation = {
    id: 'c', kind: 'chat' as const, parentId: null, title: null, model: null, summary: 'Earlier: things happened.', summaryUptoSeq: 2, coreSnapshot: null,
    contextTokens: null, contextTokensSeq: null, createdAt: '', updatedAt: '',
  };
  const fromUser = buildContextMessages(conversation, [msg(3, 'user'), msg(4, 'assistant')]);
  assert.deepEqual(fromUser.map((m) => m.role), ['user', 'assistant']);
  assert.match(JSON.stringify(fromUser[0]), /Earlier: things happened\./);

  const fromAssistant = buildContextMessages(conversation, [msg(3, 'assistant'), msg(4, 'tool')]);
  assert.deepEqual(fromAssistant.map((m) => m.role), ['user', 'assistant', 'tool']);
});

test('a model call that goes quiet is given up on: retried before any output, failed after', async () => {
  /** A provider that accepted the request and then never sends another byte. */
  const silentAfter = (chunks: unknown[]) => ({
    stream: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
    }),
  });
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return (calls === 1 ? silentAfter([]) : textStep('Here now.')) as never;
    },
  });
  const sunnie = testSunnie({ agent: { retryBaseMs: 1, stallTimeoutMs: 150 } }, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  const result = await turn(sunnie, conv.id, 'hello').done;
  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  assert.deepEqual(sunnie.deps.conversations.listMessages(conv.id).map((m) => m.text), ['hello', 'Here now.']);

  // Once the user has been shown something the call cannot be repeated: the turn fails, with
  // what was shown kept.
  const half = new MockLanguageModelV4({
    doStream: async () =>
      silentAfter([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Let me' },
      ]) as never,
  });
  const other = testSunnie({ agent: { retryBaseMs: 1, stallTimeoutMs: 150 } }, { models: registryOf(half) });
  const conv2 = other.deps.conversations.create();
  await assert.rejects(turn(other, conv2.id, 'hello').done, /timed out: it sent nothing/);
  assert.deepEqual(other.deps.conversations.listMessages(conv2.id).map((m) => m.text), ['hello', 'Let me']);

  // A tool that takes longer than the limit is not the model stalling.
  const slowTool = new MockLanguageModelV4({ doStream: [toolStep('bash', { command: 'sleep 0.6; echo done' }), textStep('Finished.')] });
  const third = testSunnie({ agent: { stallTimeoutMs: 150 } }, { models: registryOf(slowTool) });
  const conv3 = third.deps.conversations.create();
  assert.equal((await turn(third, conv3.id, 'run it').done).status, 'completed');
  assert.deepEqual(third.deps.conversations.listMessages(conv3.id).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);

  await sunnie.close();
  await other.close();
  await third.close();
});

test('a command returns when its shell exits, whatever it left running', async () => {
  const sunnie = testSunnie();
  const { computer } = sunnie.deps;

  // A background job that keeps the output pipe open: the command is done when the shell is.
  const background = await computer.exec('sleep 5 & echo started', { timeoutMs: 4000 });
  assert.equal(background.timedOut, false);
  assert.equal(background.output, 'started\n');
  assert.ok(background.durationMs < 2000, `took ${background.durationMs} ms`);

  // A process that left the group survives the kill at the timeout and still holds the pipe.
  const escaped = await computer.exec(`python3 -c "import os,time; os.setsid(); time.sleep(5)" & sleep 30`, { timeoutMs: 300 });
  assert.equal(escaped.timedOut, true);
  assert.ok(escaped.durationMs < 2000, `took ${escaped.durationMs} ms`);

  // Output written just before exit is still collected.
  const tail = await computer.exec('for i in $(seq 1 2000); do echo line $i; done');
  assert.match(tail.output, /line 2000\n$/);
  await sunnie.close();
});

test('a turn that runs out of steps ends with the agent\'s own account, written without tools', async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('bash', { command: 'echo one' }, 'call-1'),
      toolStep('bash', { command: 'echo two' }, 'call-2'),
      textStep('I got as far as two; the third is still open.'),
    ],
  });
  const sunnie = testSunnie({ agent: { maxSteps: 2 } }, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  const result = await turn(sunnie, conv.id, 'count to three').done;

  assert.deepEqual([result.status, result.finishReason, result.steps], ['completed', 'step-limit', 2]);
  const wrapUp = model.doStreamCalls[2]!;
  assert.deepEqual(wrapUp.toolChoice, { type: 'none' });
  assert.match(promptText(wrapUp), /used all the steps you have for this turn/);
  // The same tools and the same stored prefix as every other call: the note only rides behind.
  assert.equal(wrapUp.tools!.length, model.doStreamCalls[0]!.tools!.length);
  const stored = sunnie.deps.conversations.listMessages(conv.id);
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  assert.equal(stored.at(-1)!.text, 'I got as far as two; the third is still open.');
  assert.doesNotMatch(JSON.stringify(stored.map((m) => m.content)), /Automatic note/, 'the note is never stored');
  await sunnie.close();

  // A wrap-up that cannot be had falls back to the plain note instead of failing the turn.
  let calls = 0;
  const failing = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      if (calls > 1) throw new Error('Invalid API key');
      return toolStep('bash', { command: 'echo one' });
    },
  });
  const other = testSunnie({ agent: { maxSteps: 1 } }, { models: registryOf(failing) });
  const conv2 = other.deps.conversations.create();
  const fallback = await turn(other, conv2.id, 'go').done;
  assert.equal(fallback.finishReason, 'step-limit');
  assert.match(other.deps.conversations.listMessages(conv2.id).at(-1)!.text, /reached my step limit/);
  await other.close();
});

test('the system prompt tells the agent to work around failures, within the configured limits', async () => {
  const sunnie = testSunnie({ agent: { maxAttempts: 4, maxSteps: 25 } }, { models: registryOf(new MockLanguageModelV4({ doStream: [textStep('ok')] })) });
  const conv = sunnie.deps.conversations.create();
  await turn(sunnie, conv.id, 'hello').done;
  const model = sunnie.deps.models.resolve(null).model as MockLanguageModelV4;
  const prompt = promptText(model.doStreamCalls[0]);
  assert.match(prompt, /# When something does not work/);
  assert.match(prompt, /at most 4 genuinely different attempts/);
  assert.match(prompt, /You have 25 steps in a turn/);
  await sunnie.close();
});
