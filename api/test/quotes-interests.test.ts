import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { toMessageDto } from '../src/agent/events.ts';
import { steerBatch } from '../src/agent/steers.ts';
import { InterestStore } from '../src/memory/interests.ts';
import { quoteContext, quotesSchema, type MessageQuote } from '../src/store/quotes.ts';
import { createTools } from '../src/tools/index.ts';
import { TEST_API_KEY, promptText, registryOf, testSunnie, textStep, toolStep } from './helpers.ts';

const quote: MessageQuote = { id: 'q1', kind: 'card', title: 'Concert', text: '```event\ntitle: Concert\nstart: 2026-10-17 20:00\n```' };
const headers = { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' };

test('a quote-only send persists its snapshot, reaches the model, and deduplicates on retry', async () => {
  const model = new MockLanguageModelV4({ doStream: [textStep('What would you like to know about the concert?')] });
  const sunnie = testSunnie({ skills: { enabled: false } }, { models: registryOf(model) });
  try {
    const conversation = sunnie.deps.conversations.create();
    const send = () => sunnie.app.request(`/v1/conversations/${conversation.id}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ quotes: [quote], requestId: 'same-send', stream: false }),
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const messages = sunnie.deps.conversations.listMessages(conversation.id);
    assert.equal(messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(messages[0]!.text, '');
    assert.deepEqual(toMessageDto(messages[0]!).quotes, [quote]);
    assert.match(promptText(model.doStreamCalls[0]), /Concert/);
    assert.match(promptText(model.doStreamCalls[0]), /not a new instruction/);
    assert.equal(model.doStreamCalls.length, 1);
    assert.equal('content' in toMessageDto(messages[0]!), false);
  } finally { await sunnie.close(); }
});

test('queued quote snapshots survive storage and batching leaves overflow or duplicate IDs queued', async () => {
  const sunnie = testSunnie();
  try {
    const { runLog, attachments } = sunnie.deps;
    const first = Array.from({ length: 8 }, (_, n) => ({ ...quote, id: `q${n}` }));
    runLog.addSteer('run', { text: '', quotes: first, requestId: 'first' });
    runLog.addSteer('run', { text: 'Also this', quotes: [quote], requestId: 'second' });
    const pending = runLog.pendingSteers('run');
    assert.deepEqual(pending[0]!.quotes, first);
    assert.equal(steerBatch(pending, attachments).length, 1);
    assert.equal(steerBatch([{ ...pending[0]!, quotes: [quote] }, pending[1]!], attachments).length, 1);
    assert.equal(quotesSchema.safeParse([{ ...quote, text: 'x'.repeat(8_001) }]).success, false);
    assert.equal(quotesSchema.safeParse([quote, quote]).success, false);
    assert.match(quoteContext([quote]), /snapshot/);
  } finally { await sunnie.close(); }
});

test('remembering a muted topic never opts the user back in, including after a store is reopened', async () => {
  const sunnie = testSunnie();
  try {
    const { interests } = sunnie.deps;
    const now = new Date('2026-10-03T00:00:00Z');
    const topic = interests.remember('Wuthering Waves', 'm1', 'remember', now);
    interests.setStatus(topic.id, 'muted');
    const reopened = new InterestStore(sunnie.db);
    assert.equal(reopened.remember('  Wuthering   Waves ', 'm2').status, 'muted');
    assert.deepEqual(reopened.forHeartbeat(), []);
    reopened.remember('Wuthering Waves', 'm3', 'resume');
    assert.equal(reopened.forHeartbeat().length, 1);
    reopened.pause(true);
    assert.deepEqual(new InterestStore(sunnie.db).forHeartbeat(), []);
  } finally { await sunnie.close(); }
});

test('saving an interest and rejecting it each change memory and discovery in the same tool call', async () => {
  const sunnie = testSunnie();
  try {
    const conv = sunnie.deps.conversations.create();
    const tools = createTools({ ...sunnie.deps, conversationId: conv.id });
    const save = (input: unknown) => tools.memory_save!.execute!(input, { toolCallId: 'c', messages: [] } as never);
    await save({ content: 'The user enjoys Wuthering Waves.', kind: 'preference', interest_topic: 'Wuthering Waves' });
    const topic = sunnie.deps.interests.list()[0]!;
    assert.equal(topic.status, 'active');
    await save({ content: 'Do not send unsolicited Wuthering Waves updates.', kind: 'instruction', interest_topic: 'Wuthering Waves', interest_action: 'mute' });
    assert.equal(sunnie.deps.interests.get(topic.id)!.status, 'muted');
    assert.equal(sunnie.deps.memory.count(), 2);
    await save({ content: 'Pause all discovery updates.', kind: 'instruction', proactive_updates: 'pause' });
    assert.equal(sunnie.deps.interests.preferences().paused, true);
  } finally { await sunnie.close(); }
});

test('an ordinary remember follows nothing and leaves the pause alone, even from a model that fills in every argument', async () => {
  const sunnie = testSunnie();
  try {
    const { interests, memory } = sunnie.deps;
    const tools = createTools({ ...sunnie.deps, conversationId: sunnie.deps.conversations.create().id });
    const save = (input: unknown) => tools.memory_save!.execute!(input, { toolCallId: 'c', messages: [] } as never) as Promise<string>;
    interests.pause(true);

    // The defaults spelled out, as such a model writes them — with or without a topic it made up.
    const plain = await save({ content: 'Maya studies at Westbrook University.', kind: 'fact', interest_action: 'none', interest_topic: '', proactive_updates: 'unchanged' });
    await save({ content: 'Jordan works at Northwind Supply.', interest_action: 'none', interest_topic: 'work profile', proactive_updates: 'unchanged' });
    assert.match(plain, /^Saved as mem_[\w-]+$/);
    assert.equal(memory.count(), 2);
    assert.deepEqual(interests.list(), [], 'no topic was registered');
    assert.equal(interests.preferences().paused, true, 'the pause the user asked for still holds');

    // The same arguments still do their work when the user did ask.
    await save({ content: 'The user follows Formula 1.', interest_action: 'remember', interest_topic: 'Formula 1', proactive_updates: 'unchanged' });
    assert.deepEqual(interests.list().map((i) => [i.topic, i.status]), [['Formula 1', 'active']]);
    assert.equal(interests.preferences().paused, true);
    await save({ content: 'The user wants interest updates again.', interest_action: 'none', interest_topic: '', proactive_updates: 'resume' });
    assert.equal(interests.preferences().paused, false);
    await assert.rejects(save({ content: 'x', interest_action: 'mute', interest_topic: '' }), /Give interest_topic/);

    // What the model is offered says which value means "nothing".
    const schema = JSON.stringify(z.toJSONSchema(tools.memory_save!.inputSchema as z.ZodType));
    assert.match(schema, /"none","remember","mute","resume"/);
    assert.match(schema, /"unchanged","pause","resume"/);
  } finally { await sunnie.close(); }
});

test('heartbeat can stay quiet and share on its next tick without waiting for a daily deadline', async () => {
  const finding = 'A useful new Wuthering Waves guide: https://example.com/guide';
  const model = new MockLanguageModelV4({ doStream: [textStep('NOTHING_TO_SHARE'), textStep(finding)] });
  const sunnie = testSunnie({ skills: { enabled: false } }, { models: registryOf(model) });
  try {
    const now = new Date();
    const topic = sunnie.deps.interests.remember('Wuthering Waves', 'm', 'remember', now);
    // An older version's pending daily deadline must not delay the heartbeat.
    sunnie.db.prepare('UPDATE interest_preferences SET next_digest_at = ? WHERE id = 1').run('2099-01-01T00:00:00.000Z');
    const run = sunnie.heartbeat.tick(now)!;
    assert.ok(run);
    assert.equal(sunnie.heartbeat.tick(now), null);
    await run.done;
    assert.equal(run.status, 'completed');
    assert.equal(sunnie.deps.interests.preferences().nextDigestAt, null);
    const assistant = sunnie.deps.conversations.messagesForRun(run.id).find((m) => m.role === 'assistant')!;
    assert.equal(assistant.text, '');
    assert.equal(toMessageDto(assistant).parts.some((p) => p.type === 'text'), false);
    assert.equal(toMessageDto({ ...assistant, content: 'NOTHING_TO_SHARE' }).parts.some((p) => p.type === 'text'), false);
    assert.match(JSON.stringify(assistant.content), /NOTHING_TO_SHARE/);
    assert.equal(sunnie.deps.interests.get(topic.id)!.lastReport, '');
    // A topic is not looked at again on the very next tick, only once its own interval has passed.
    const { intervalMinutes, interestMinutes } = sunnie.deps.config.heartbeat;
    assert.equal(interestMinutes, 240);
    assert.equal(sunnie.heartbeat.tick(new Date(now.getTime() + intervalMinutes * 60_000)), null);
    assert.equal(sunnie.heartbeat.tick(new Date(now.getTime() + (interestMinutes - 1) * 60_000)), null);
    assert.equal(model.doStreamCalls.length, 1, 'the ticks in between called no model');
    // A topic registered meanwhile has never been looked at, so it is due at once and goes alone.
    const fresh = sunnie.deps.interests.remember('Formula 1', 'm2', 'remember', now);
    assert.deepEqual(sunnie.deps.interests.forHeartbeat(new Date(now.getTime() + 60_000), interestMinutes).map((i) => i.id), [fresh.id]);
    sunnie.deps.interests.setStatus(fresh.id, 'muted');
    const nextTick = new Date(now.getTime() + interestMinutes * 60_000);
    const next = sunnie.heartbeat.tick(nextTick)!;
    assert.ok(next);
    await next.done;
    assert.equal(next.status, 'completed');
    assert.ok(sunnie.deps.conversations.messagesForRun(next.id).some((m) => m.text === finding));
    assert.equal(sunnie.deps.interests.get(topic.id)!.lastCheckedAt, nextTick.toISOString());
    sunnie.deps.interests.pause(true);
    assert.equal(sunnie.heartbeat.tick(new Date(nextTick.getTime() + 60_000)), null);
    assert.equal(model.doStreamCalls.length, 2);
  } finally { await sunnie.close(); }
});

test('an automatic interest run cannot create its own schedule instead of using the heartbeat', async () => {
  const model = new MockLanguageModelV4({ doStream: [
    toolStep('task_add', { content: 'Check Wuthering Waves every minute', wait_minutes: 1 }),
    textStep('NOTHING_TO_SHARE'),
  ] });
  const sunnie = testSunnie({ skills: { enabled: false } }, { models: registryOf(model) });
  try {
    const now = new Date();
    sunnie.deps.interests.remember('Wuthering Waves', 'm', 'remember', now);
    const run = sunnie.heartbeat.tick(now)!;
    await run.done;
    assert.equal(sunnie.deps.tasks.countOpen(), 0);
    assert.match(promptText(model.doStreamCalls[1]), /read-only research only/);
  } finally { await sunnie.close(); }
});

test('a quiet interest wrap-up does not replace silence with a step-limit message', async () => {
  const model = new MockLanguageModelV4({ doStream: [
    toolStep('memory_search', { query: 'Wuthering Waves' }),
    textStep('NOTHING_TO_SHARE'),
  ] });
  const sunnie = testSunnie({ skills: { enabled: false }, agent: { maxSteps: 1 } }, { models: registryOf(model) });
  try {
    const now = new Date();
    sunnie.deps.interests.remember('Wuthering Waves', 'm', 'remember', now);
    const run = sunnie.heartbeat.tick(now)!;
    await run.done;
    assert.equal(run.status, 'completed');
    const replies = sunnie.deps.conversations.messagesForRun(run.id).filter((m) => m.role === 'assistant');
    assert.ok(replies.length);
    assert.ok(replies.every((m) => m.text === ''));
  } finally { await sunnie.close(); }
});

test('interest settings require authentication and native opt-outs persist independently of model recall', async () => {
  const sunnie = testSunnie();
  try {
    assert.equal((await sunnie.app.request('/v1/interests')).status, 401);
    const topic = sunnie.deps.interests.remember('Wuthering Waves', 'm');
    const response = await sunnie.app.request(`/v1/interests/${topic.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'muted' }),
    });
    assert.equal(response.status, 200);
    const prefs = await sunnie.app.request('/v1/interests/settings', {
      method: 'PATCH', headers, body: JSON.stringify({ paused: true }),
    });
    assert.equal(prefs.status, 200);
    assert.equal(sunnie.deps.interests.get(topic.id)!.status, 'muted');
    assert.equal(sunnie.deps.interests.preferences().paused, true);
  } finally { await sunnie.close(); }
});
