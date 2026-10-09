import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import { buildInstructions } from '../src/agent/prompt.ts';
import { widgetBlocks } from '../src/home/cards.ts';
import { parseWidgetBody } from '../src/home/widgets.ts';
import { describeWidget } from '../src/tools/home-tools.ts';
import { generated, registryOf, TEST_API_KEY, testSunnie, textStep } from './helpers.ts';

const card = '{"type":"stack","children":[{"type":"stepper","bind":"people","value":4,"min":2,"max":16,"label":"People"},' +
  '{"type":"checklist","bind":"done","items":[{"time":"13:30","title":"Start roasting"},{"time":"16:45","title":"Carve and serve"}]},' +
  '{"type":"text","text":"{round(people * 0.4, 1)} kg of lamb"}]}';
const reply = (json: string) => `Here is your plan.\n\n\`\`\`widget\n${json}\n\`\`\`\n\nAdjust the guests above.`;

test('the interactive card the prompt teaches is a valid widget', (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const prompt = buildInstructions({ name: 'Sunnie', computer: sunnie.deps.computer, browser: false, blocks: {} } as unknown as Parameters<typeof buildInstructions>[0]);
  const blocks = widgetBlocks(prompt);
  assert.ok(blocks.length >= 1);
  for (const block of blocks) parseWidgetBody(block.json);
});

test('what the user sets in a card is checked, kept, listed and told to Sunnie once', async (t) => {
  const model = new MockLanguageModelV4({ doStream: [textStep(reply(card)), textStep('Noted.'), textStep('Again.')] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  t.after(() => sunnie.close());
  const conversation = sunnie.deps.conversations.create();
  const turn = (id: string, text: string) => runTurn(sunnie.deps, {
    conversationId: conversation.id, runId: id, text, signal: new AbortController().signal, emit: () => {},
  });
  await turn('r1', 'Plan a roast.');
  const message = sunnie.deps.conversations.listMessages(conversation.id).find((m) => m.role === 'assistant')!;
  const headers = { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' };
  const put = (path: string, state: unknown) => sunnie.app.request(path, { method: 'PUT', headers, body: JSON.stringify({ state }) });

  assert.equal((await sunnie.app.request(`/v1/messages/${message.id}/cards/0`, { method: 'PUT', body: '{}' })).status, 401);
  assert.equal((await put(`/v1/messages/${message.id}/cards/1`, { people: 5 })).status, 404);
  assert.equal((await put(`/v1/messages/nope/cards/0`, { people: 5 })).status, 404);
  for (const wrong of [{ guests: 3 }, { people: 40 }, { people: 'six' }, { done: [true] }]) {
    assert.equal((await put(`/v1/messages/${message.id}/cards/0`, wrong)).status, 400, JSON.stringify(wrong));
  }
  const saved = await put(`/v1/messages/${message.id}/cards/0`, { people: 6, done: [true, false] });
  assert.equal(saved.status, 200);
  const listed = await (await sunnie.app.request(`/v1/conversations/${conversation.id}/cards`, { headers })).json() as { cards: Array<{ messageId: string; card: number; state: unknown }> };
  assert.deepEqual(listed.cards.map((c) => [c.messageId, c.card, c.state]), [[message.id, 0, { people: 6, done: [true, false] }]]);

  await turn('r2', 'What now?');
  await turn('r3', 'And now?');
  const users = sunnie.deps.conversations.listMessages(conversation.id).filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
  assert.match(users[1]!, /people \(People\): 6; done: 1 of 2 ticked \(Start roasting\)/);
  assert.doesNotMatch(users[2]!, /Interactive cards/, 'told once, until it changes again');
});

test('a broken card is fixed before the reply is stored: slips by hand, the rest by the model', async (t) => {
  // A trailing comma and the end cut off: slips fixed without a model.
  const broken = `${card.replace(/\]\}$/, '')},`;
  const unknown = card.replace('people * 0.4', 'guests * 0.4');
  const model = new MockLanguageModelV4({
    doStream: [textStep(reply(broken)), textStep(reply(unknown))],
    doGenerate: async () => generated(card),
  });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  t.after(() => sunnie.close());
  for (const id of ['a', 'b']) {
    const conversation = sunnie.deps.conversations.create();
    const events: Array<{ type: string; message?: { text: string } }> = [];
    await runTurn(sunnie.deps, {
      conversationId: conversation.id, runId: id, text: 'Plan a roast.', signal: new AbortController().signal,
      emit: (e) => events.push(e as never),
    });
    const stored = sunnie.deps.conversations.listMessages(conversation.id).find((m) => m.role === 'assistant')!;
    const [block] = widgetBlocks(stored.text);
    parseWidgetBody(block!.json);
    assert.match(stored.text, /^Here is your plan\.[\s\S]*Adjust the guests above\.$/);
    assert.match(JSON.stringify(stored.content), /people \* 0\.4/);
    assert.ok(events.some((e) => e.type === 'message' && e.message?.text === stored.text), 'the client gets the fixed reply');
  }
  const repairs = model.doGenerateCalls.filter((call) => JSON.stringify(call.prompt).includes('What is wrong'));
  assert.equal(repairs.length, 1, 'only the formula problem needed the model');
});

test('a card hands off with reply, copy and calendar; only chat cards may reply', (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const body = {
    type: 'stack', children: [
      { type: 'stepper', bind: 'people', value: 4 },
      { type: 'button', text: 'Book for {people}', action: { type: 'reply', text: 'Book a table for {people}' } },
      { type: 'button', text: 'Copy', action: { type: 'copy', text: '{people * 300} g potatoes' } },
      { type: 'button', text: 'Add', action: { type: 'calendar', title: 'Roast', start: '2026-10-11 17:00', place: 'Home' } },
    ],
  };
  parseWidgetBody(body);
  assert.throws(() => parseWidgetBody({ ...body, children: [...body.children, { type: 'button', text: 'x', action: { type: 'copy', text: '{guests}' } }] }), /"guests"/);
  assert.throws(() => sunnie.deps.home.set({ id: 'roast', body, source: 'agent' }), /works only in a card in a reply[\s\S]*"ask"/);
});

test('a card pinned to Home starts where the user left it and keeps working there', async (t) => {
  const parsed = JSON.parse(card) as { children: unknown[] };
  parsed.children.push({ type: 'button', text: 'Remind me', action: { type: 'reply', text: 'Remind me at each step' } });
  const withReply = JSON.stringify(parsed);
  const model = new MockLanguageModelV4({ doStream: [textStep(reply(withReply))] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  t.after(() => sunnie.close());
  const conversation = sunnie.deps.conversations.create();
  await runTurn(sunnie.deps, { conversationId: conversation.id, runId: 'p', text: 'Plan a roast.', signal: new AbortController().signal, emit: () => {} });
  const message = sunnie.deps.conversations.listMessages(conversation.id).find((m) => m.role === 'assistant')!;
  sunnie.deps.cards.set(message.id, 0, { people: 6, done: [true, false] });
  const headers = { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' };

  const pinned = await sunnie.app.request('/v1/home/widgets/from-card', { method: 'POST', headers, body: JSON.stringify({ messageId: message.id, card: 0 }) });
  assert.equal(pinned.status, 201);
  const widget = await pinned.json() as { id: string; title: string; body: { children: Array<Record<string, unknown>> } };
  assert.equal(widget.title, '2.4 kg of lamb');
  assert.equal(widget.body.children[0]!.value, 6);
  assert.deepEqual(widget.body.children[1]!.value, [true, false]);
  assert.deepEqual(widget.body.children[3]!.action, { type: 'ask', prompt: 'Remind me at each step' });
  assert.equal((await sunnie.app.request('/v1/home/widgets/from-card', { method: 'POST', headers, body: JSON.stringify({ messageId: message.id, card: 3 }) })).status, 404);

  const changed = await sunnie.app.request(`/v1/home/widgets/${widget.id}/state`, { method: 'PUT', headers, body: JSON.stringify({ state: { people: 8 } }) });
  assert.equal(changed.status, 200);
  assert.equal((await sunnie.app.request(`/v1/home/widgets/${widget.id}/state`, { method: 'PUT', headers, body: JSON.stringify({ state: { people: 99 } }) })).status, 400);
  const home = await (await sunnie.app.request('/v1/home', { headers })).json() as { widgets: Array<{ id: string; state: unknown }> };
  assert.deepEqual(home.widgets.find((w) => w.id === widget.id)!.state, { people: 8 });
  assert.match(describeWidget(sunnie.deps.home.widgets()[0]!), /The user has set: people \(People\): 8/);
  // A new design keeps what the user set while it still fits.
  sunnie.deps.home.set({ id: widget.id, body: { type: 'stack', children: [{ type: 'stepper', bind: 'people', value: 2, max: 20 }] }, source: 'agent' });
  assert.deepEqual(sunnie.deps.home.widgets()[0]!.state, { people: 8 });
  sunnie.deps.home.set({ id: widget.id, body: { type: 'text', text: 'Gone' }, source: 'agent' });
  assert.equal(sunnie.deps.home.widgets()[0]!.state, null);
});
