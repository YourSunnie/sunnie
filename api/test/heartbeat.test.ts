import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import { toMessageDto } from '../src/agent/events.ts';
import { buildState } from '../src/router/jev.ts';
import { createTools } from '../src/tools/index.ts';
import { parseLocalTime } from '../src/util/time.ts';
import { TEST_API_KEY, eventSink, promptText, registryOf, testSunnie, textStep, toolStep } from './helpers.ts';

const minutes = (n: number) => n * 60_000;

test('local times are read in the user\'s zone, across a DST change', () => {
  assert.equal(parseLocalTime('2026-10-02 09:00', 'Asia/Jakarta')!.toISOString(), '2026-10-02T02:00:00.000Z');
  assert.equal(parseLocalTime('2026-03-28T08:30', 'Europe/Berlin')!.toISOString(), '2026-03-28T07:30:00.000Z');
  assert.equal(parseLocalTime('2026-03-29 08:30', 'Europe/Berlin')!.toISOString(), '2026-03-29T06:30:00.000Z');
  assert.equal(parseLocalTime('2026-10-02 09:00', 'UTC')!.toISOString(), '2026-10-02T09:00:00.000Z');
  assert.equal(parseLocalTime('tomorrow morning', 'UTC'), null);
  assert.equal(parseLocalTime('2026-02-30 09:00', 'UTC'), null);
});

test('tasks become due at their time, and a checked task is pushed out instead of coming back every tick', () => {
  const sunnie = testSunnie();
  const { tasks } = sunnie.deps;
  const now = new Date('2026-10-01T10:00:00Z');

  const soon = tasks.add({ content: 'Soon' });
  const later = tasks.add({ content: 'Later', dueAt: new Date(now.getTime() + minutes(30)) });
  const past = tasks.add({ content: 'Overdue', dueAt: new Date(now.getTime() - minutes(5)) });
  const closed = tasks.add({ content: 'Closed' });
  tasks.update(closed.id, { status: 'done' });

  assert.deepEqual(tasks.due(now, 10).map((t) => t.content).sort(), ['Overdue', 'Soon']);
  assert.deepEqual(tasks.due(new Date(now.getTime() + minutes(31)), 10).length, 3);
  assert.equal(tasks.due(now, 1).length, 1);

  tasks.markChecked([soon.id, past.id], new Date(now.getTime() + minutes(60)));
  assert.deepEqual(tasks.due(now, 10), []);
  assert.equal(tasks.get(soon.id)!.checks, 1);
  assert.deepEqual(tasks.due(new Date(now.getTime() + minutes(61)), 10).length, 3);

  // A patch keeps what it does not mention; dueAt: null means "next check-in".
  tasks.update(later.id, { note: 'half done' });
  assert.equal(tasks.get(later.id)!.dueAt, new Date(now.getTime() + minutes(30)).toISOString());
  tasks.update(later.id, { dueAt: null });
  assert.equal(tasks.get(later.id)!.dueAt, null);
  assert.equal(tasks.countOpen(), 3);
  assert.deepEqual(tasks.list({ status: 'done' }).map((t) => t.content), ['Closed']);
  sunnie.db.close();
});

test('the agent notes, moves and closes follow-ups with its tools', async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('task_add', { content: 'Check the SIN-NRT fare for 15 November again', due: '2026-10-02 09:00' }),
      textStep('I will look again tomorrow morning.'),
    ],
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { conversations, tasks } = sunnie.deps;
  const conv = conversations.create();

  await runTurn(sunnie.deps, {
    conversationId: conv.id,
    runId: 'run_test',
    text: 'Keep an eye on that fare',
    timeZone: 'Asia/Jakarta',
    signal: new AbortController().signal,
    emit: () => {},
  });

  const [task] = tasks.list();
  assert.equal(task!.content, 'Check the SIN-NRT fare for 15 November again');
  assert.equal(task!.dueAt, '2026-10-02T02:00:00.000Z');
  assert.equal(task!.timeZone, 'Asia/Jakarta');
  assert.equal(task!.conversationId, conv.id);
  // The system prompt explains follow-ups, and the tool result reads back in the user's zone.
  assert.match(promptText(model.doStreamCalls[0]), /# Follow-ups[\s\S]*every 10 minutes/);
  assert.match(promptText(model.doStreamCalls[1]), /2 October 2026 at 09:00/);

  const tools = createTools({ ...sunnie.deps, conversationId: conv.id, timeZone: 'Asia/Jakarta' });
  const call = (name: string, input: unknown) =>
    tools[name]!.execute!(input, { toolCallId: 'c', messages: [] } as never) as Promise<string>;

  assert.match(await call('task_list', {}), new RegExp(task!.id));
  const before = Date.now();
  await call('task_update', { id: task!.id, wait_minutes: 90, note: 'Fare was 312 SGD' });
  const moved = tasks.get(task!.id)!;
  assert.equal(moved.note, 'Fare was 312 SGD');
  assert.ok(Date.parse(moved.dueAt!) - before >= minutes(90) && Date.parse(moved.dueAt!) - before < minutes(91));

  await assert.rejects(call('task_update', { id: task!.id, due: 'next week' }), /YYYY-MM-DD HH:MM/);
  await assert.rejects(call('task_done', { id: 'task_nope' }), /No task with id/);
  await call('task_done', { id: task!.id });
  assert.equal(await call('task_list', {}), 'No open follow-ups.');
  assert.match(await call('task_list', { status: 'done' }), /\[done\]/);
  await sunnie.close();
});

test('a tick with nothing due calls no model and creates nothing', async () => {
  const model = new MockLanguageModelV4({ doStream: [] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  sunnie.deps.tasks.add({ content: 'Not yet', dueAt: new Date(Date.now() + minutes(60)) });

  assert.equal(sunnie.heartbeat.tick(), null);
  assert.equal(model.doStreamCalls.length, 0);
  assert.equal(sunnie.deps.conversations.list().length, 0);
  await sunnie.close();
});

test('a tick with a due follow-up runs a check-in in the check-ins conversation', async () => {
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) =>
      JSON.stringify(prompt.at(-1)).includes('tool-result')
        ? textStep('Your passport renewal slot opens today.')
        : toolStep('task_update', { id: other.id, wait_minutes: 120, note: 'watered once' }),
  });
  const sunnie = testSunnie({ heartbeat: { model: 'mock/cheap' } }, { models: registryOf(model) });
  const { conversations, tasks } = sunnie.deps;
  const chat = conversations.create({ title: 'Passport' });
  const task = tasks.add({ content: 'Remind Aditya the passport slot opens', timeZone: 'Asia/Jakarta', conversationId: chat.id });
  const other = tasks.add({ content: 'Water the plants' });
  tasks.update(other.id, { note: 'asked twice' });

  const now = new Date();
  const run = sunnie.heartbeat.tick(now)!;
  assert.ok(run);
  // Both tasks are pushed out the moment the run starts, so the next tick stays quiet.
  assert.equal(tasks.get(other.id)!.dueAt, new Date(now.getTime() + minutes(60)).toISOString());
  assert.equal(sunnie.heartbeat.tick(now), null);
  await run.done;
  assert.equal(run.status, 'completed');

  const checkIns = conversations.findByKind('heartbeat')!;
  assert.equal(run.conversationId, checkIns.id);
  assert.equal(checkIns.title, 'Check-ins');
  assert.notEqual(checkIns.id, chat.id);

  const messages = conversations.listMessages(checkIns.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  const opener = toMessageDto(messages[0]!);
  assert.equal(opener.origin, 'heartbeat');
  assert.equal(opener.text, 'Check-in on 2 follow-ups:\n- Remind Aditya the passport slot opens\n- Water the plants');
  assert.doesNotMatch(JSON.stringify(opener), /<heartbeat>|task_/, 'instructions and ids stay server-side');
  assert.equal(toMessageDto(messages[3]!).origin, null);
  // The router and the risk filter, unlike the client, read the instructions of a check-in.
  const routed = JSON.stringify(buildState({ summary: null, messages }));
  assert.match(routed, /"from":"heartbeat","text":"<heartbeat>/);
  assert.doesNotMatch(routed, /Current time/);
  assert.equal(messages[3]!.text, 'Your passport renewal slot opens today.');
  for await (const event of sunnie.runs.subscribe(run.id)) {
    if (event.type === 'run.started') assert.equal(event.model, 'mock/cheap', 'the heartbeat model override is used');
  }

  const prompt = promptText(model.doStreamCalls[0]);
  assert.match(prompt, /scheduled check-in, not a message from the user/);
  assert.match(prompt, new RegExp(`${task.id}: Remind Aditya`));
  assert.match(prompt, /Water the plants — note: asked twice/);
  assert.match(prompt, /closed automatically/);
  assert.match(prompt, /Current time: .*(WIB|GMT\+7)/);

  // The run completed: the task the agent left alone is closed, the one it moved stays open.
  assert.equal(tasks.get(task.id)!.status, 'done');
  const kept = tasks.get(other.id)!;
  assert.equal(kept.status, 'open');
  assert.equal(kept.note, 'watered once');
  assert.equal(kept.checks, 1);
  assert.equal(sunnie.heartbeat.tick(new Date(now.getTime() + minutes(61))), null);

  // The same conversation is reused when the moved task comes round again.
  const again = sunnie.heartbeat.tick(new Date(Date.now() + minutes(121)))!;
  await again.done;
  assert.equal(again.conversationId, checkIns.id);
  assert.match(promptText(model.doStreamCalls.at(-2)), /watered once \(looked at 1 time before\)/);
  await sunnie.close();
});

test('a check-in that fails or is stopped closes nothing; its tasks come back after the recheck time', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('upstream exploded');
    },
  });
  const sunnie = testSunnie({ agent: { stepRetries: 0 } }, { models: registryOf(model) });
  const task = sunnie.deps.tasks.add({ content: 'Fragile' });

  const now = new Date();
  const run = sunnie.heartbeat.tick(now)!;
  await run.done;
  assert.equal(run.status, 'failed');
  assert.equal(sunnie.deps.tasks.get(task.id)!.status, 'open');
  assert.equal(sunnie.heartbeat.tick(new Date(now.getTime() + minutes(59))), null);
  const retry = sunnie.heartbeat.tick(new Date(now.getTime() + minutes(61)))!;
  assert.ok(retry);
  await retry.done;
  await sunnie.close();
});

test('a tick waits while the check-ins conversation is busy, and leaves the tasks due', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const model = new MockLanguageModelV4({
    doStream: async () => {
      await gate;
      return textStep('Nothing to report.');
    },
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { tasks } = sunnie.deps;
  tasks.add({ content: 'First' });

  const first = sunnie.heartbeat.tick()!;
  const second = tasks.add({ content: 'Second' });
  assert.equal(sunnie.heartbeat.tick(), null);
  assert.equal(tasks.get(second.id)!.checks, 0);
  assert.equal(tasks.get(second.id)!.dueAt, null);

  release();
  await first.done;
  const next = sunnie.heartbeat.tick()!;
  await next.done;
  assert.match(promptText(model.doStreamCalls.at(-1)), /Second/);
  await sunnie.close();
});

test('a check-in waiting for a go-ahead gives way once something else is due, and what it was woken for comes back', async () => {
  const model = new MockLanguageModelV4({
    doStream: [
      toolStep('bash', { command: 'rm -rf old-reports' }, 'c1'),
      // Told that nobody answered, it tries once more: that must not start another wait.
      toolStep('bash', { command: 'rm -rf old-reports' }, 'c2'),
      textStep('Deleting the old reports is waiting for your OK.'),
      textStep('Time to call the dentist.'),
    ],
  });
  const risk = {
    name: 'scripted',
    assess: async (input: { call: { input: unknown } }) =>
      /\brm\b/.test((input.call.input as { command?: string }).command ?? '') ? { confirm: true as const, risk: 0.9 } : { confirm: false as const },
  };
  const sunnie = testSunnie({}, { models: registryOf(model), risk });
  const { tasks, config } = sunnie.deps;
  const started = new Date();
  const at = (min: number) => new Date(started.getTime() + minutes(min));
  const cleanup = tasks.add({ content: 'Clean up the old reports' });

  const held = sunnie.heartbeat.tick(started)!;
  for (let i = 0; i < 200 && held.pendingApprovals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(held.pendingApprovals.length, 1);

  // Nothing else is due: it may wait as long as it takes, even past the limit.
  assert.equal(sunnie.heartbeat.tick(at(config.heartbeat.approvalWaitMinutes + 5)), null);
  assert.equal(held.pendingApprovals.length, 1);
  // Its own follow-up coming due again is no reason either: that would only ask the same thing anew.
  assert.equal(sunnie.heartbeat.tick(at(config.heartbeat.recheckMinutes + 1)), null);
  assert.equal(held.pendingApprovals.length, 1);

  // A reminder comes due behind it. Too soon, it waits; after the limit the check-in gives way.
  const dentist = tasks.add({ content: 'Remind the user to call the dentist' });
  assert.equal(sunnie.heartbeat.tick(at(1)), null);
  assert.equal(held.pendingApprovals.length, 1);
  assert.equal(sunnie.heartbeat.tick(at(config.heartbeat.approvalWaitMinutes + 1)), null);
  await held.done;
  assert.equal(held.status, 'completed');
  assert.equal(held.unanswered, true);
  assert.deepEqual(held.pendingApprovals, []);

  const events = [];
  for await (const e of sunnie.runs.subscribe(held.id)) events.push(e);
  assert.deepEqual(events.filter((e) => e.type === 'tool.approval.resolved').map(({ seq: _seq, ...e }) => e), [
    { type: 'tool.approval.resolved', toolCallId: 'c1', approved: false, reason: 'unanswered' },
    { type: 'tool.approval.resolved', toolCallId: 'c2', approved: false, reason: 'unanswered' },
  ]);
  // The model was told it was nobody's no, and its account of what is waiting is what the user reads.
  assert.match(promptText(model.doStreamCalls[1]), /Nobody answered in time/);
  assert.doesNotMatch(promptText(model.doStreamCalls[1]), /The user declined/);
  assert.ok(sunnie.deps.conversations.messagesForRun(held.id).some((m) => m.text === 'Deleting the old reports is waiting for your OK.'));

  // What it was woken for is not done, so it stays open; the reminder behind it starts at once.
  assert.equal(tasks.get(cleanup.id)!.status, 'open');
  for (let i = 0; i < 200 && tasks.get(dentist.id)!.status === 'open'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(tasks.get(dentist.id)!.status, 'done');
  assert.match(promptText(model.doStreamCalls.at(-1)), /call the dentist/);
  await sunnie.close();
});

test('an approval the user is asked for in their own turn is never given up on', async () => {
  const model = new MockLanguageModelV4({ doStream: [toolStep('bash', { command: 'rm -rf x' }, 'c1'), textStep('ok')] });
  const risk = { name: 'scripted', assess: async () => ({ confirm: true as const, risk: 0.9 }) };
  const sunnie = testSunnie({}, { models: registryOf(model), risk });
  const { tasks, conversations } = sunnie.deps;
  // The user is talking in the Check-ins conversation itself.
  const checkIns = conversations.create({ kind: 'heartbeat', title: 'Check-ins' });
  const run = sunnie.runs.start({ conversationId: checkIns.id, text: 'Delete x' });
  for (let i = 0; i < 200 && run.pendingApprovals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  tasks.add({ content: 'Something due' });
  assert.equal(sunnie.heartbeat.tick(new Date(Date.now() + minutes(600))), null);
  assert.equal(sunnie.runs.waitingCheckIn(checkIns.id), null);
  assert.equal(run.pendingApprovals.length, 1, 'still waiting for the user');
  sunnie.runs.resolveApproval(run.id, 'c1', false);
  await run.done;
  await sunnie.close();
});

test('a tick that cannot start a run does not throw and does not use up the task', async () => {
  const sunnie = testSunnie({ heartbeat: { model: 'nope/model' } });
  const task = sunnie.deps.tasks.add({ content: 'Still due' });
  assert.equal(sunnie.heartbeat.tick(), null);
  assert.equal(sunnie.deps.tasks.get(task.id)!.checks, 0);
  await sunnie.close();
});

test('with the heartbeat off there are no task tools, no prompt section and no clock', async () => {
  const model = new MockLanguageModelV4({ doStream: [textStep('Hi.')] });
  const sunnie = testSunnie({ heartbeat: { enabled: false } }, { models: registryOf(model) });
  const conv = sunnie.deps.conversations.create();
  const sink = eventSink();
  await runTurn(sunnie.deps, { conversationId: conv.id, runId: 'r', text: 'hi', signal: new AbortController().signal, emit: sink.emit });

  assert.deepEqual(model.doStreamCalls[0]!.tools!.map((t) => t.name).filter((n) => n.startsWith('task_')), []);
  assert.doesNotMatch(promptText(model.doStreamCalls[0]), /# Follow-ups/);
  sunnie.heartbeat.start();
  await sunnie.close();
});

test('the API shows the heartbeat, conversation kinds and the task list', async () => {
  const sunnie = testSunnie();
  const get = async (path: string) =>
    (await sunnie.app.request(path, { headers: { authorization: `Bearer ${TEST_API_KEY}` } })).json() as Promise<any>;

  assert.deepEqual((await get('/v1/info')).heartbeat, { enabled: true, intervalMinutes: 10 });

  sunnie.deps.conversations.create({ kind: 'heartbeat', title: 'Check-ins' });
  sunnie.deps.conversations.create();
  assert.deepEqual((await get('/v1/conversations')).conversations.map((c: any) => c.kind).sort(), ['chat', 'heartbeat']);

  const open = sunnie.deps.tasks.add({ content: 'Open one' });
  sunnie.deps.tasks.update(sunnie.deps.tasks.add({ content: 'Done one' }).id, { status: 'done' });
  assert.deepEqual((await get('/v1/tasks')).tasks.map((t: any) => t.content), ['Open one', 'Done one']);
  const listed = (await get('/v1/tasks?status=open')).tasks;
  assert.deepEqual(listed.map((t: any) => t.id), [open.id]);
  assert.deepEqual(Object.keys(listed[0]).sort(), [
    'checks', 'content', 'conversationId', 'createdAt', 'dueAt', 'id', 'note', 'status', 'timeZone', 'updatedAt',
  ]);
  await sunnie.close();
});
