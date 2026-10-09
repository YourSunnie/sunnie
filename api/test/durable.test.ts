import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createSunnie, type Sunnie } from '../src/app.ts';
import type { RunEvent } from '../src/agent/runs.ts';
import { buildHelperInstructions, buildInstructions } from '../src/agent/prompt.ts';
import { parseWidgetBody } from '../src/home/widgets.ts';
import { promptText, registryOf, testConfig, testSunnie, textStep, toolStep } from './helpers.ts';

type Steps = ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer O ? (O extends { doStream?: infer S } ? S : never) : never;

/** A database file that outlives one Sunnie, and a way to open the next "process" over it. */
function restartable(raw: Record<string, unknown> = {}) {
  const config = testConfig(raw);
  const dbPath = join(mkdtempSync(join(tmpdir(), 'sunnie-durable-')), 'sunnie.db');
  const boot = (doStream: Steps): { sunnie: Sunnie; model: MockLanguageModelV4 } => {
    const model = new MockLanguageModelV4({ doStream });
    return { sunnie: createSunnie(config, { dbPath, models: registryOf(model) }), model };
  };
  return { boot };
}

const runRow = (sunnie: Sunnie, id: string) => ({
  ...(sunnie.db.prepare('SELECT status, resumes, error FROM runs WHERE id = ?').get(id) as { status: string; resumes: number; error: string | null }),
});

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('a run stopped by a shutdown goes on after the restart, and is told what it had begun', async () => {
  const { boot } = restartable();
  const first = boot([toolStep('bash', { command: 'echo started > mark.txt && sleep 30' })]);
  const conv = first.sunnie.deps.conversations.create();
  const run = first.sunnie.runs.start({ conversationId: conv.id, text: 'Leave a mark, then wait.' });
  await until(
    () => (first.sunnie.db.prepare('SELECT COUNT(*) AS n FROM run_actions').get() as { n: number }).n === 1,
    'the shell call to be written down',
  );

  await first.sunnie.close();
  assert.equal(run.status, 'cancelled');

  const second = boot([textStep('The mark is there.')]);
  // Still "running" on disk, so the new process took it up under the same id.
  const resumed = second.sunnie.runs.get(run.id);
  assert.ok(resumed);
  assert.equal(second.sunnie.runs.activeFor(conv.id)?.id, run.id);
  const events: RunEvent[] = [];
  for await (const event of second.sunnie.runs.subscribe(run.id, 7)) events.push(event);
  await resumed.done;

  assert.equal(resumed.status, 'completed');
  assert.deepEqual(runRow(second.sunnie, run.id), { status: 'completed', resumes: 1, error: null });
  // A client that asks for what came after the last event of the old process gets all the new ones.
  assert.equal(events[0]!.type, 'run.started');
  assert.ok(events[0]!.seq > 1_000_000);
  assert.equal(events.at(-1)!.type, 'run.completed');

  // The opening message was not stored again, and the half-done step left nothing behind.
  const messages = second.sunnie.deps.conversations.listMessages(conv.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(messages[1]!.text, 'The mark is there.');
  assert.equal(messages[1]!.runId, run.id);

  const prompt = promptText(second.model.doStreamCalls[0]);
  assert.match(prompt, /The server restarted in the middle of this turn/);
  assert.match(prompt, /bash .*mark\.txt.*finished, but its result was lost/);
  assert.equal((second.sunnie.db.prepare('SELECT COUNT(*) AS n FROM run_actions').get() as { n: number }).n, 0);

  await second.sunnie.close();
});

test('after a crash, a call that never returned is reported as possibly done; a look-only call is not reported', async () => {
  const { boot } = restartable();
  const first = boot([]);
  const { conversations, runLog } = first.sunnie.deps;
  const conv = conversations.create();
  // What a killed process leaves: the run, its opening message, one finished step, and the
  // calls of the step it died in.
  runLog.create({ id: 'run_crashed', conversationId: conv.id, input: { conversationId: conv.id, text: 'Order the tea.' }, startedAt: new Date().toISOString() });
  conversations.appendMessages(conv.id, [
    { role: 'user', content: [{ type: 'text', text: 'Order the tea.' }], text: 'Order the tea.', runId: 'run_crashed' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'browser_open', input: { url: 'https://tea.test' } }], runId: 'run_crashed' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'browser_open', output: { type: 'text', value: 'Tea shop' } }], runId: 'run_crashed' },
  ]);
  runLog.actionStarted('run_crashed', { toolCallId: 'c2', name: 'browser_click', input: { ref: 'e7' } });
  first.sunnie.db.close();

  const second = boot([textStep('The order went through; I checked the confirmation page.')]);
  await second.sunnie.runs.get('run_crashed')!.done;

  const prompt = promptText(second.model.doStreamCalls[0]);
  assert.match(prompt, /browser_click \{\\"ref\\":\\"e7\\"\} — had started; it may or may not have finished/);
  assert.match(prompt, /Do not repeat one blindly: first check, once, how much/);
  // The note is sent, not stored.
  const messages = second.sunnie.deps.conversations.listMessages(conv.id);
  assert.equal(messages.length, 4);
  assert.doesNotMatch(JSON.stringify(messages.map((m) => m.content)), /server restarted/);
  await second.sunnie.close();

  // Look-only tools are not written down at all.
  const third = boot([toolStep('read_file', { path: 'nothing.txt' }), toolStep('write_file', { path: 'a.txt', content: 'a' }, 'call-2'), textStep('Done.')]);
  const seen: number[] = [];
  const count = () => (third.sunnie.db.prepare('SELECT COUNT(*) AS n FROM run_actions').get() as { n: number }).n;
  const run = third.sunnie.runs.start({ conversationId: third.sunnie.deps.conversations.create().id, text: 'Read, then write.' });
  for await (const event of third.sunnie.runs.subscribe(run.id)) {
    if (event.type === 'tool.result') seen.push(count());
  }
  // After the read: nothing. After the write: its row, until the step is stored.
  assert.deepEqual(seen, [0, 1]);
  assert.equal(count(), 0);
  await third.sunnie.close();
});

test('an interrupted run with nothing stored starts over; one whose answer was stored is simply closed', async () => {
  const { boot } = restartable();
  const first = boot([]);
  const { conversations, runLog } = first.sunnie.deps;
  const fresh = conversations.create();
  const answered = conversations.create();
  const startedAt = new Date().toISOString();
  runLog.create({ id: 'run_fresh', conversationId: fresh.id, input: { conversationId: fresh.id, text: 'Hello?' }, startedAt });
  runLog.create({ id: 'run_answered', conversationId: answered.id, input: { conversationId: answered.id, text: 'Hi' }, startedAt });
  conversations.appendMessages(answered.id, [
    { role: 'user', content: [{ type: 'text', text: 'Hi' }], text: 'Hi', runId: 'run_answered' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }], text: 'Hello.', runId: 'run_answered' },
  ]);
  first.sunnie.db.close();

  const second = boot([textStep('Hello! I am here.')]);
  await Promise.all([second.sunnie.runs.get('run_fresh')!.done, second.sunnie.runs.get('run_answered')!.done]);

  assert.deepEqual(second.sunnie.deps.conversations.listMessages(fresh.id).map((m) => m.text), ['Hello?', 'Hello! I am here.']);
  assert.equal(second.sunnie.deps.conversations.listMessages(answered.id).length, 2);
  assert.equal(second.model.doStreamCalls.length, 1);
  assert.equal(runRow(second.sunnie, 'run_fresh').status, 'completed');
  assert.equal(runRow(second.sunnie, 'run_answered').status, 'completed');
  await second.sunnie.close();
});

test('a run that was restarted too often, or was cancelled by the user, is not started again', async () => {
  const { boot } = restartable();
  const first = boot([toolStep('bash', { command: 'sleep 30' })]);
  const { conversations, runLog } = first.sunnie.deps;
  const loop = conversations.create();
  runLog.create({ id: 'run_loop', conversationId: loop.id, input: { conversationId: loop.id, text: 'Again' }, startedAt: new Date().toISOString() });
  first.sunnie.db.prepare("UPDATE runs SET resumes = 3 WHERE id = 'run_loop'").run();

  const stopped = conversations.create();
  const run = first.sunnie.runs.start({ conversationId: stopped.id, text: 'Wait.' });
  await until(() => (first.sunnie.db.prepare('SELECT COUNT(*) AS n FROM run_actions').get() as { n: number }).n === 1, 'the shell call');
  first.sunnie.runs.cancel(run.id);
  await first.sunnie.close();

  const second = boot([]);
  assert.equal(runRow(second.sunnie, run.id).status, 'cancelled');
  assert.equal(second.sunnie.runs.activeFor(loop.id), null);
  assert.equal(second.sunnie.runs.activeFor(stopped.id), null);
  assert.equal(second.sunnie.runs.get(run.id)!.status, 'cancelled');
  assert.equal(second.model.doStreamCalls.length, 0);
  const row = runRow(second.sunnie, 'run_loop');
  assert.equal(row.status, 'failed');
  assert.match(row.error!, /not started again/);
  await second.sunnie.close();
});

test('a check-in that is picked up after a restart still closes the follow-ups it was woken for', async () => {
  const { boot } = restartable();
  const first = boot([toolStep('bash', { command: 'sleep 30' })]);
  const task = first.sunnie.deps.tasks.add({ content: 'Water the basil', dueAt: new Date(Date.now() - 60_000) });
  const run = first.sunnie.heartbeat.tick();
  assert.ok(run);
  await until(() => (first.sunnie.db.prepare('SELECT COUNT(*) AS n FROM run_actions').get() as { n: number }).n === 1, 'the shell call');
  await first.sunnie.close();

  const second = boot([textStep('Nothing to report.')]);
  await second.sunnie.runs.get(run.id)!.done;
  await new Promise((r) => setImmediate(r));

  assert.equal(second.sunnie.deps.tasks.get(task.id)!.status, 'done');
  await second.sunnie.close();
});

test('sending again with the same request id returns the first run, also after it has left memory', async () => {
  const { boot } = restartable();
  const first = boot([textStep('Four.')]);
  const conv = first.sunnie.deps.conversations.create();
  const send = (sunnie: Sunnie, body: Record<string, unknown>) =>
    sunnie.app.request(`/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, ...body }),
    });

  const one = (await (await send(first.sunnie, { text: 'Two plus two?', requestId: 'req-1' })).json()) as { run: { id: string; status: string } };
  const again = (await (await send(first.sunnie, { text: 'Two plus two?', requestId: 'req-1' })).json()) as { run: { id: string } };
  assert.equal(again.run.id, one.run.id);
  assert.equal(first.model.doStreamCalls.length, 1);
  assert.equal(first.sunnie.deps.conversations.listMessages(conv.id).length, 2);
  await first.sunnie.close();

  // A new process knows the run only from the database.
  const second = boot([textStep('Not asked.')]);
  const res = await send(second.sunnie, { text: 'Two plus two?', requestId: 'req-1', stream: true });
  const stream = await res.text();
  const types = [...stream.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(types, ['run.started', 'message', 'message', 'run.completed']);
  assert.match(stream, /Four\./);
  assert.match(stream, /"usage":\{"inputTokens":10/);
  assert.equal(second.model.doStreamCalls.length, 0);

  const status = (await (
    await second.sunnie.app.request(`/v1/runs/${one.run.id}`, { headers: { authorization: 'Bearer test-key' } })
  ).json()) as { status: string; finishedAt: string | null };
  assert.equal(status.status, 'completed');
  assert.ok(status.finishedAt);

  // A different request id is a new message.
  const other = (await (await send(second.sunnie, { text: 'And three?', requestId: 'req-2' })).json()) as { run: { id: string } };
  assert.notEqual(other.run.id, one.run.id);
  assert.equal(second.model.doStreamCalls.length, 1);
  await second.sunnie.close();
});

test('the agent is taught the card blocks the app draws; a helper, whose reader is the agent, is not', () => {
  const sunnie = testSunnie();
  const common = { name: 'Sunnie', computer: sunnie.deps.computer, browser: false, blocks: {} };
  const main = buildInstructions(common);
  for (const block of ['```event', '```schedule', '```card', '```drive', '```widget']) assert.ok(main.includes(block), block);
  assert.ok(!buildHelperInstructions(common).includes('```event'));
  // The example the model copies from has to be a body the app can draw.
  const example = /```widget\n([\s\S]*?)\n```/.exec(main);
  assert.ok(example);
  assert.equal((parseWidgetBody(example[1]) as { type: string }).type, 'stack');
  void sunnie.close();
});

// ── Steering ──────────────────────────────────────────────────────────────────────────────

test('a message sent while the run works joins it between two steps', async () => {
  const model = new MockLanguageModelV4({
    doStream: [toolStep('bash', { command: 'sleep 0.4; echo first' }), toolStep('bash', { command: 'echo second' }, 'call-2'), textStep('Both done.')],
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  const run = sunnie.runs.start({ conversationId: conv.id, text: 'Do the first thing.' });
  const count = () => (sunnie.db.prepare('SELECT COUNT(*) AS n FROM run_actions').get() as { n: number }).n;
  await until(() => count() === 1, 'the first command to start');

  const steer = (body: Record<string, unknown>) =>
    sunnie.app.request(`/v1/runs/${run.id}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await steer({ text: 'And the second thing too.', requestId: 's1' })).status, 202);
  // The same send again (a retry) is not a second message.
  assert.equal((await steer({ text: 'And the second thing too.', requestId: 's1' })).status, 202);
  await run.done;

  assert.equal(run.status, 'completed');
  const messages = sunnie.deps.conversations.listMessages(conv.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[3]!.text, 'And the second thing too.');
  assert.ok(messages.every((m) => m.runId === run.id));
  // The model saw it from the second call on, marked as having arrived mid-work.
  assert.doesNotMatch(promptText(model.doStreamCalls[0]), /second thing/);
  assert.match(promptText(model.doStreamCalls[1]), /sent the following while you were working[\s\S]*And the second thing too\./);

  // Once the run is over there is nothing to steer.
  assert.equal((await steer({ text: 'Too late.' })).status, 409);
  assert.equal(sunnie.runs.isBusy(conv.id), false);
  await sunnie.close();
});

test('a message that arrives during the final answer keeps the turn going; one sent to a stopped run is dropped', async () => {
  let calls = 0;
  let sunnie!: Sunnie;
  let runId = '';
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        sunnie.runs.steer(runId, { text: 'Also, in French please.' });
        return textStep('Here is the answer.');
      }
      if (calls === 2) return textStep('Voici la réponse.');
      return toolStep('bash', { command: 'sleep 30' });
    },
  });
  sunnie = testSunnie({}, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  // Started on a later tick than `start` returns, so the id is known when the model is called.
  const run = sunnie.runs.start({ conversationId: conv.id, text: 'Answer me.' });
  runId = run.id;
  await run.done;

  assert.equal(calls, 2);
  assert.deepEqual(
    sunnie.deps.conversations.listMessages(conv.id).map((m) => `${m.role}: ${m.text}`),
    ['user: Answer me.', 'assistant: Here is the answer.', 'user: Also, in French please.', 'assistant: Voici la réponse.'],
  );

  const second = sunnie.runs.start({ conversationId: conv.id, text: 'Now wait.' });
  await until(() => (sunnie.db.prepare('SELECT COUNT(*) AS n FROM run_actions').get() as { n: number }).n === 1, 'the wait to start');
  sunnie.runs.steer(second.id, { text: 'Never mind.' });
  sunnie.runs.cancel(second.id);
  await second.done;
  assert.equal(second.status, 'cancelled');
  assert.equal(sunnie.runs.isBusy(conv.id), false);
  assert.ok(!sunnie.deps.conversations.listMessages(conv.id).some((m) => m.text === 'Never mind.'));
  await sunnie.close();
});
