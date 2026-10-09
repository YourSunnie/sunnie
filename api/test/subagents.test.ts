import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import type { AgentEvent } from '../src/agent/events.ts';
import { buildHelperInstructions, buildInstructions } from '../src/agent/prompt.ts';
import type { Computer } from '../src/computer/computer.ts';
import type { RiskFilter, RiskVerdict } from '../src/router/risk.ts';
import { createTools } from '../src/tools/index.ts';
import { TEST_API_KEY, eventSink, promptText, registryOf, testSunnie, textStep, toolStep } from './helpers.ts';

type StreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];

const isHelper = (options: StreamOptions) => promptText(options).includes('You are a helper of Sunnie');
const hasToolResult = (options: StreamOptions) => promptText(options).includes('tool-result');
/** Which of the tasks below a helper's call belongs to. */
const taskOf = (options: StreamOptions) => /hotels in (\w+)/.exec(promptText(options))?.[1] ?? '';

const TASKS = ['Find hotels in Ubud for 3–5 May', 'Find hotels in Canggu for 3–5 May', 'Find hotels in Seminyak for 3–5 May'];

function turn(sunnie: ReturnType<typeof testSunnie>, conversationId: string, text: string, extra: Partial<Parameters<typeof runTurn>[1]> = {}) {
  const sink = eventSink();
  const done = runTurn(sunnie.deps, {
    conversationId,
    runId: 'run_test',
    text,
    signal: new AbortController().signal,
    emit: sink.emit,
    ...extra,
  });
  return { sink, done };
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

test('delegate sends one helper per task, they work at the same time, and their reports come back as the tool result', async () => {
  // Every helper's first call waits until all three have started: helpers run one after another
  // would never get past it.
  let started = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => (release = resolve));
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      if (!isHelper(options)) {
        return hasToolResult(options) ? textStep('Ubud is the best fit.') : toolStep('delegate', { tasks: TASKS }, 'call-d');
      }
      if (hasToolResult(options)) return textStep(`Report: three hotels in ${taskOf(options)}, from $80.`);
      if (++started === TASKS.length) release();
      await allStarted;
      return toolStep('bash', { command: `echo looking in ${taskOf(options)}` }, `call-${taskOf(options)}`);
    },
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { conversations, memory, core } = sunnie.deps;
  core.set('user', 'Name: Aditya');
  memory.add({ content: 'Aditya prefers hotels with a pool', source: 'agent' });
  const conv = conversations.create();

  const { sink, done } = turn(sunnie, conv.id, 'Find me hotels in Bali for 3–5 May', { timeZone: 'Asia/Jakarta' });
  const result = await done;

  assert.equal(result.status, 'completed');
  // What the helpers spent counts towards the run: 2 steps of the main agent, 2 of each helper.
  assert.equal(result.usage.inputTokens, 80);

  // The main agent got every report, in task order, as the result of its one call.
  const toolResult = JSON.stringify(conversations.listMessages(conv.id).find((m) => m.role === 'tool')!.content);
  assert.match(toolResult, /## Helper 1 \(id: conv_[\w-]+\)\\nTask: Find hotels in Ubud[^#]*three hotels in Ubud[\s\S]*## Helper 2[^#]*Canggu[\s\S]*## Helper 3[^#]*Seminyak/);
  assert.equal(conversations.listMessages(conv.id).at(-1)!.text, 'Ubud is the best fit.');

  // Each helper has a transcript of its own, reachable from the parent and absent from the user's list.
  const helpers = conversations.children(conv.id);
  assert.deepEqual(helpers.map((h) => [h.kind, h.parentId, h.title]), TASKS.map((t) => ['subagent', conv.id, t]));
  assert.deepEqual(conversations.list().map((c) => c.id), [conv.id]);
  assert.deepEqual(conversations.listMessages(helpers[0]!.id).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  // ...which the agent's own history search does not take for something the user said.
  assert.ok(conversations.searchMessages('hotels Ubud').every((h) => h.conversationId === conv.id));

  // A helper is a smaller agent: its own prompt, the user block for context, no recall, and
  // tools to look things up with — no memory, no follow-ups, no vault, no helpers of its own.
  const helperCall = model.doStreamCalls.find(isHelper)!;
  const prompt = promptText(helperCall);
  assert.match(prompt, /Name: Aditya/);
  assert.doesNotMatch(prompt, /prefers hotels with a pool/);
  assert.match(prompt, /Current time:/);
  // Sent and forgotten: unless the agent says otherwise, a helper is not told it may ask.
  assert.doesNotMatch(prompt, /For this task you may come back with a question/);
  // Helpers may list and read skills, never install or write them.
  assert.deepEqual(
    helperCall.tools!.map((t) => t.name),
    ['bash', 'read_file', 'view_image', 'write_file', 'edit_file', 'web_fetch', 'skill_list', 'skill_read', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_key', 'browser_control'],
  );
  // The main agent's own prompt and tool list say that helpers exist.
  const mainCall = model.doStreamCalls.find((c) => !isHelper(c))!;
  assert.match(promptText(mainCall), /# Helpers/);
  assert.deepEqual(mainCall.tools!.map((t) => t.name).slice(-2), ['delegate', 'helper_message']);

  // The client is told who is at work, under the call that sent them.
  const startedEvents = ofType(sink.events, 'subagent.started');
  assert.deepEqual(startedEvents.map((e) => [e.toolCallId, e.index, e.task]), TASKS.map((t, i) => ['call-d', i, t]));
  assert.deepEqual(new Set(startedEvents.map((e) => e.agentId)), new Set(helpers.map((h) => h.id)));
  assert.deepEqual(ofType(sink.events, 'subagent.tool').map((e) => e.name), ['bash', 'bash', 'bash']);
  assert.deepEqual(ofType(sink.events, 'subagent.finished').map((e) => [e.status, e.steps]), TASKS.map(() => ['completed', 2]));
  // A helper's own messages and text stay out of the parent's stream.
  assert.equal(ofType(sink.events, 'message').filter((e) => e.message.conversationId !== conv.id).length, 0);

  // Deleting the conversation takes the helpers' transcripts with it.
  conversations.delete(conv.id);
  assert.equal(conversations.get(helpers[0]!.id), null);
  await sunnie.close();
});

test('no more helpers work at once than the configured concurrency, and a list sent as a string is still a list', async () => {
  let working = 0;
  let most = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      if (!isHelper(options)) {
        return hasToolResult(options) ? textStep('Done.') : toolStep('delegate', { tasks: JSON.stringify(['a', 'b', 'c', 'd', 'e']) });
      }
      most = Math.max(most, ++working);
      await new Promise((r) => setTimeout(r, 20));
      working -= 1;
      return textStep('ok');
    },
  });
  const sunnie = testSunnie({ subagents: { concurrency: 2 } }, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  await turn(sunnie, conv.id, 'go').done;
  assert.equal(sunnie.deps.conversations.children(conv.id).length, 5);
  assert.equal(most, 2);
  await sunnie.close();
});

test('a helper cannot ask for approval: a held call is declined, and the user is not asked', async () => {
  const risk: RiskFilter = {
    name: 'scripted',
    async assess(input): Promise<RiskVerdict> {
      const command = (input.call.input as { command?: string }).command ?? '';
      return /\brm\b/.test(command) ? { confirm: true, risk: 0.97 } : { confirm: false, risk: 0.01 };
    },
  };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      if (!isHelper(options)) return hasToolResult(options) ? textStep('It needs your go-ahead.') : toolStep('delegate', { tasks: ['Tidy up'] });
      return hasToolResult(options) ? textStep('Deleting keep.txt is waiting for approval.') : toolStep('bash', { command: 'rm keep.txt' });
    },
  });
  const sunnie = testSunnie({}, { models: registryOf(model), risk });
  const conv = sunnie.deps.conversations.create();
  const drive = join(sunnie.deps.config.computer.workspace, 'Drive');
  mkdirSync(drive, { recursive: true });
  const file = join(drive, 'keep.txt');
  writeFileSync(file, 'x');

  const asked: string[] = [];
  const { sink, done } = turn(sunnie, conv.id, 'tidy', {
    confirm: async (call) => {
      asked.push(call.name);
      return true;
    },
  });
  await done;

  assert.ok(existsSync(file), 'the held command did not run');
  assert.deepEqual(asked, []);
  assert.equal(ofType(sink.events, 'tool.approval.requested').length, 0);
  const helper = sunnie.deps.conversations.children(conv.id)[0]!;
  const refused = JSON.stringify(sunnie.deps.conversations.listMessages(helper.id).find((m) => m.role === 'tool')!.content);
  assert.match(refused, /only the agent you report to can get, so it was not run/);
  assert.match(JSON.stringify(sunnie.deps.conversations.listMessages(conv.id).find((m) => m.role === 'tool')!.content), /waiting for approval/);
  await sunnie.close();
});

test('a helper that fails or runs out of steps does not sink the others; when all fail the call is an error', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const text = promptText(options);
      if (!isHelper(options)) {
        if (text.includes('None of the helpers')) return textStep('I will do it myself.');
        if (hasToolResult(options)) return textStep('Two of three came back.');
        return toolStep('delegate', { tasks: text.includes('all broken') ? ['broken one', 'broken two'] : ['good', 'broken', 'endless'] });
      }
      if (text.includes('broken')) throw new Error('provider exploded');
      if (text.includes('endless')) {
        return text.includes('Write your report now') ? textStep('Ran out of steps; found nothing yet.') : toolStep('bash', { command: 'true' });
      }
      return textStep('All good here.');
    },
  });
  const sunnie = testSunnie({ subagents: { maxSteps: 2 }, agent: { stepRetries: 0 } }, { models: registryOf(model) });
  const { conversations } = sunnie.deps;

  const conv = conversations.create();
  const { sink, done } = turn(sunnie, conv.id, 'three pieces');
  assert.equal((await done).status, 'completed');
  const mixed = JSON.stringify(conversations.listMessages(conv.id).find((m) => m.role === 'tool')!.content);
  assert.match(mixed, /1 of 3 helpers did not finish/);
  assert.match(mixed, /## Helper 1 \(id: [\w-]+\)\\nTask: good\\n\\nAll good here\./);
  assert.match(mixed, /## Helper 2 \(id: [\w-]+\) \(failed\)\\nTask: broken\\n\\nCould not do this: provider exploded/);
  assert.match(mixed, /## Helper 3 \(id: [\w-]+\)\\nTask: endless\\n\\nRan out of steps; found nothing yet\./);
  assert.deepEqual(ofType(sink.events, 'subagent.finished').map((e) => e.status).sort(), ['completed', 'completed', 'failed']);

  const other = conversations.create();
  await turn(sunnie, other.id, 'all broken').done;
  const failed = conversations.listMessages(other.id).find((m) => m.role === 'tool')!;
  assert.match(JSON.stringify(failed.content), /error-text[\s\S]*None of the helpers could do its task \(Could not do this: provider exploded\)/);
  assert.equal(conversations.listMessages(other.id).at(-1)!.text, 'I will do it myself.');
  await sunnie.close();
});

test('a helper allowed to ask can be answered: it carries on in its own conversation with what it had', async () => {
  const helperId = (options: StreamOptions) => /id: (conv_[\w-]+)/.exec(promptText(options))?.[1] ?? '';
  const results = (options: StreamOptions) => promptText(options).split('"type":"tool-result"').length - 1;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const text = promptText(options);
      if (isHelper(options)) {
        return text.includes('Twin beds') ? textStep('Booked nothing; the twin room is $95.') : textStep('Found the hotel. Which bed type: twin or double?');
      }
      switch (results(options)) {
        case 0:
          return toolStep('delegate', { tasks: ['Price a room at Hotel Tjampuhan'], allow_questions: true }, 'c1');
        case 1:
          return toolStep('helper_message', { helper: 'conv_nobody', message: 'Twin beds.' }, 'c2');
        case 2:
          return toolStep('helper_message', { helper: helperId(options), message: 'Twin beds.' }, 'c3');
        default:
          return textStep('The twin room is $95.');
      }
    },
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { conversations } = sunnie.deps;
  const conv = conversations.create();
  const { sink, done } = turn(sunnie, conv.id, 'How much is a room at Tjampuhan?');
  await done;

  const [helper] = conversations.children(conv.id);
  assert.equal(conversations.children(conv.id).length, 1, 'answering a helper does not send a new one');
  // The permission rode on the task, for the model only; the answer is the helper's next message.
  const transcript = conversations.listMessages(helper!.id);
  assert.deepEqual(transcript.map((m) => m.text), [
    'Price a room at Hotel Tjampuhan',
    'Found the hotel. Which bed type: twin or double?',
    'Twin beds.',
    'Booked nothing; the twin room is $95.',
  ]);
  assert.match(JSON.stringify(transcript[0]!.content), /For this task you may come back with a question/);
  const second = model.doStreamCalls.filter(isHelper)[1]!;
  assert.match(promptText(second), /Which bed type: twin or double\?/, 'the helper still has what it found');

  const outputs = conversations.listMessages(conv.id).filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content));
  assert.match(outputs[1]!, /error-text[\s\S]*There is no helper \\"conv_nobody\\" in this conversation\. Helpers that have reported here: conv_[\w-]+ \(Price a room/);
  assert.ok(outputs[2]!.includes(`## Helper (id: ${helper!.id})\\n\\nBooked nothing; the twin room is $95.`));
  assert.deepEqual(ofType(sink.events, 'subagent.started').map((e) => [e.toolCallId, e.agentId, e.task]), [
    ['c1', helper!.id, 'Price a room at Hotel Tjampuhan'],
    ['c3', helper!.id, 'Twin beds.'],
  ]);

  // A helper of another conversation is not this one's to message.
  const other = conversations.create();
  const stranger = new MockLanguageModelV4({
    doStream: async (options) =>
      hasToolResult(options) ? textStep('ok') : toolStep('helper_message', { helper: helper!.id, message: 'hello' }),
  });
  const elsewhere = { ...sunnie, deps: { ...sunnie.deps, models: registryOf(stranger) } };
  await turn(elsewhere, other.id, 'go').done;
  assert.match(JSON.stringify(conversations.listMessages(other.id).find((m) => m.role === 'tool')!.content), /No helper has been sent yet; use delegate/);
  assert.equal(conversations.listMessages(helper!.id).length, 4);
  await sunnie.close();
});

test('cancelling the run stops its helpers', async () => {
  const abort = new AbortController();
  let helpersStarted = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      if (!isHelper(options)) return toolStep('delegate', { tasks: ['one', 'two'] });
      if (++helpersStarted === 2) setTimeout(() => abort.abort(), 10);
      // A provider that never answers: only the cancel ends this.
      return new Promise<never>(() => {});
    },
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  const { sink, done } = turn(sunnie, conv.id, 'go', { signal: abort.signal });
  assert.equal((await done).status, 'cancelled');
  assert.deepEqual(ofType(sink.events, 'subagent.finished').map((e) => e.status), ['cancelled', 'cancelled']);
  // The half-finished delegate call is not stored (a call never goes without its result).
  assert.deepEqual(sunnie.deps.conversations.listMessages(conv.id).map((m) => m.role), ['user']);
  await sunnie.close();
});

test('with helpers off there is no delegate tool and no prompt section; a helper prompt never mentions them', async () => {
  const sunnie = testSunnie({ subagents: { enabled: false } }, { models: registryOf(new MockLanguageModelV4({ doStream: async () => textStep('hi') })) });
  const conv = sunnie.deps.conversations.create();
  await turn(sunnie, conv.id, 'hello').done;
  const call = (sunnie.deps.models.resolve(null).model as MockLanguageModelV4).doStreamCalls[0]!;
  assert.ok(!call.tools!.some((t) => t.name === 'delegate' || t.name === 'helper_message'));
  assert.doesNotMatch(promptText(call), /# Helpers/);
  assert.ok(!('delegate' in createTools({ ...sunnie.deps, conversationId: conv.id })));
  await sunnie.close();

  const computer: Computer = { workspace: '/home/test', describe: () => 'test', exec: async () => assert.fail('not used') };
  assert.match(buildInstructions({ name: 'Sunnie', computer, browser: true, helpers: { tasks: 10, steps: 15 }, blocks: {} }), /# Helpers\n[\s\S]*Up to 10 helpers in one call, each with 15 steps[\s\S]*# Your memory/);
  const helper = buildHelperInstructions({ name: 'Sunnie', computer, browser: true, blocks: { user: 'Likes tea' } });
  assert.match(helper, /Likes tea/);
  assert.doesNotMatch(helper, /delegate|helper_message|memory_save|browser_fill_login|task_add/);
  assert.doesNotMatch(buildHelperInstructions({ name: 'Sunnie', computer, browser: false, blocks: {} }), /browser_/);
});

test('API: helpers are listed under their conversation, readable, and otherwise left alone', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      if (isHelper(options)) return textStep('Report.');
      return hasToolResult(options) ? textStep('Done.') : toolStep('delegate', { tasks: ['look something up'] });
    },
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const api = (path: string, init: { method?: string; body?: unknown } = {}) =>
    sunnie.app.request(path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

  const info = await json(api('/v1/info'));
  assert.deepEqual(info.subagents, { enabled: true, maxTasks: 10, concurrency: 5 });

  const conv = (await json(api('/v1/conversations', { body: {} }))).id as string;
  const sent = await json(api(`/v1/conversations/${conv}/messages`, { body: { text: 'go', stream: false } }));
  assert.equal(sent.run.status, 'completed');
  // The run's own messages only: the helper's are in its transcript.
  assert.deepEqual(sent.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'tool', 'assistant']);

  assert.deepEqual((await json(api('/v1/conversations'))).conversations.map((c: { id: string }) => c.id), [conv]);
  const { helpers } = await json(api(`/v1/conversations/${conv}/helpers`));
  assert.equal(helpers.length, 1);
  assert.deepEqual([helpers[0].kind, helpers[0].parentId, helpers[0].title], ['subagent', conv, 'look something up']);

  const transcript = await json(api(`/v1/conversations/${helpers[0].id}/messages`));
  assert.deepEqual(transcript.messages.map((m: { text: string }) => m.text), ['look something up', 'Report.']);

  for (const [path, init] of [
    [`/v1/conversations/${helpers[0].id}/messages`, { body: { text: 'hello' } }],
    [`/v1/conversations/${helpers[0].id}/compact`, { method: 'POST' }],
    [`/v1/conversations/${helpers[0].id}`, { method: 'DELETE' }],
  ] as const) {
    assert.equal((await api(path, init)).status, 400, path);
  }
  assert.equal((await api(`/v1/conversations/${conv}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/v1/conversations/${helpers[0].id}`)).status, 404);
  await sunnie.close();
});
