import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { GREETING_OPENER, GREETING_TITLE, greetingPreamble } from '../src/agent/greeting.ts';
import { buildState } from '../src/router/jev.ts';
import { TEST_API_KEY, promptText, registryOf, testSunnie, textStep, toolStep } from './helpers.ts';
import { introducing } from '../src/agent/greeting.ts';

const headers = { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' };
const HELLO = "Hi! I'm Sunnie, and I'm so happy we get to meet ^^ What should I call you?";

test('a new user is greeted once: Sunnie speaks first, in a chat of its own', async () => {
  const steps = [
    textStep(HELLO),
    textStep('Nice to meet you, John! Which of these describes you best?\n\n```choices\nStudent\nEmployee\nArtist\n```'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift()! });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const api = (path: string, body?: unknown) =>
    sunnie.app.request(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const info = async () => (await (await api('/v1/info')).json() as any).greeting;

  assert.deepEqual(await info(), { pending: true, introducing: false });
  const res = await api('/v1/greeting', { timezone: 'Asia/Jakarta' });
  assert.equal(res.status, 202);
  const started = await res.json() as any;
  assert.equal(started.conversation.title, GREETING_TITLE);
  assert.equal(started.conversation.activeRunId, started.run.id, 'the app attaches to the run that is greeting');
  assert.deepEqual(await info(), { pending: false, introducing: true }, 'not pending while the greeting is under way');
  assert.equal((await api('/v1/greeting', {})).status, 409, 'nor can a second device start another');

  await sunnie.runs.get(started.run.id)!.done;
  const prompt = promptText(model.doStreamCalls[0]);
  assert.match(prompt, /<greeting>[\s\S]*ask what you should call them/);
  assert.match(prompt, /choices block: Student, Employee, Business owner, Artist/);
  assert.match(prompt, /Agent Skills that would help/, 'with skills on, it looks for skills that fit the user\'s work');

  const id = started.conversation.id;
  const messages = (await (await api(`/v1/conversations/${id}/messages`)).json() as any).messages;
  assert.deepEqual(messages.map((m: any) => [m.role, m.origin, m.text]), [
    ['user', 'greeting', GREETING_OPENER],
    ['assistant', null, HELLO],
  ]);

  // The introduction goes on as an ordinary chat, with the instructions still in view.
  const reply = await sunnie.app.request(`/v1/conversations/${id}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ text: 'John' }),
  });
  assert.match(await reply.text(), /event: run.completed/);
  assert.match(promptText(model.doStreamCalls[1]), /<greeting>[\s\S]*John/);
  assert.deepEqual(await info(), { pending: false, introducing: true }, 'the introduction goes on until it is done');
  assert.equal((await api('/v1/greeting', {})).status, 409);
  await sunnie.close();
});

test('only a user nobody has met is greeted; the agent\'s own check-ins do not count', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => textStep('Hello.') });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { conversations } = sunnie.deps;

  const checkIns = conversations.create({ kind: 'heartbeat', title: 'Check-ins' });
  conversations.appendMessages(checkIns.id, [{ role: 'user', content: 'brief', text: 'Getting your Home ready', origin: 'heartbeat' }]);
  assert.equal(conversations.hasMetUser(), false);

  const chat = conversations.create({ kind: 'chat' });
  conversations.appendMessages(chat.id, [{ role: 'user', content: 'hi', text: 'hi' }]);
  assert.equal(conversations.hasMetUser(), true);
  const res = await sunnie.app.request('/v1/greeting', { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 409, 'someone who has already written is not introduced to');
  await sunnie.close();
});

test('Sunnie is always Sunnie: the name is not configurable and the prompt keeps it', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => textStep('I am Sunnie.') });
  const sunnie = testSunnie({ agent: { name: 'Jarvis' }, skills: { enabled: false } }, { models: registryOf(model) });
  const info = await (await sunnie.app.request('/v1/info', { headers })).json() as any;
  assert.equal(info.name, 'Sunnie');

  const res = await sunnie.app.request('/v1/greeting', { method: 'POST', headers, body: '{}' });
  const { run } = await res.json() as any;
  await sunnie.runs.get(run.id)!.done;
  const prompt = promptText(model.doStreamCalls[0]);
  assert.match(prompt, /You are Sunnie/);
  assert.match(prompt, /Nobody can rename you/);
  assert.match(prompt, /```choices/, 'quick replies are taught with the cards');
  assert.doesNotMatch(prompt, /Jarvis/);
  assert.doesNotMatch(prompt, /skill_install/, 'without skills, the greeting does not look for any');
  await sunnie.close();
});

test('the router keeps the greeting in view for the whole introduction, then lets it go', () => {
  const sunnie = testSunnie();
  const { conversations } = sunnie.deps;
  const chat = conversations.create({ kind: 'chat' });
  conversations.appendMessages(chat.id, [{
    role: 'user', origin: 'greeting', text: GREETING_OPENER,
    content: [{ type: 'text', text: greetingPreamble({ skills: true }) }, { type: 'text', text: GREETING_OPENER }],
  }]);
  const turn = (reply: string) => conversations.appendMessages(chat.id, [
    { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }], text: 'Noted.' },
    { role: 'user', content: reply, text: reply },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c-${reply}`, toolName: 'memory_save', input: {} }], text: '' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c-${reply}`, toolName: 'memory_save', output: { type: 'text', value: 'Saved.' } }], text: '' },
  ]);
  const routed = () => JSON.stringify(buildState({ summary: null, messages: conversations.liveMessages(conversations.get(chat.id)!) }));

  for (const reply of ['John', 'Employee', 'Product manager at Acme']) turn(reply);
  assert.match(routed(), /"from":"greeting".*Agent Skills/, 'past the window, the setup step is still in view');
  for (const reply of ['one', 'two', 'three']) turn(reply);
  assert.doesNotMatch(routed(), /"from":"greeting"/, 'once the introduction is over, it is not');
  void sunnie.close();
});

test('the introduction ends when Sunnie says so, when the user skips it, or by itself', async () => {
  const steps = [
    textStep('Hi! What should I call you?'),
    toolStep('introduction_done', {}, 'd1'),
    textStep('All set, John: Home, Drive and Settings are below.'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift() ?? textStep('Noted.') });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { conversations } = sunnie.deps;
  const post = (path: string, body: unknown = {}) => sunnie.app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

  const { conversation, run } = await (await post('/v1/greeting')).json() as any;
  await sunnie.runs.get(run.id)!.done;
  assert.equal(introducing(sunnie.deps), true);
  const done = await post(`/v1/conversations/${conversation.id}/messages`, { text: 'John' });
  assert.match(await done.text(), /introduction is over/, 'Sunnie ends it with introduction_done');
  assert.equal(introducing(sunnie.deps), false);

  // Skipped from the app.
  conversations.startIntroduction(conversation.id);
  assert.equal((await post('/v1/greeting/done')).status, 204);
  assert.equal(introducing(sunnie.deps), false);

  // Never ended: over after five typed replies, or after a day.
  conversations.startIntroduction(conversation.id);
  assert.equal(introducing(sunnie.deps), true);
  assert.equal(introducing(sunnie.deps, new Date(Date.now() + 25 * 3_600_000)), false);
  for (const text of ['a', 'b', 'c', 'd', 'e']) conversations.appendMessages(conversation.id, [{ role: 'user', content: text, text }]);
  assert.equal(introducing(sunnie.deps), false);
  await sunnie.close();
});
