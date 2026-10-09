import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { BRIEF_OPENER } from '../src/agent/heartbeat.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drivePaths, NODE_TYPES } from '../src/home/widgets.ts';
import { TEST_API_KEY, promptText, registryOf, testSunnie, textStep, toolStep } from './helpers.ts';

const hours = (n: number) => n * 3_600_000;
const auth = { authorization: `Bearer ${TEST_API_KEY}` };

test('a widget is written whole, keeps its place when rewritten, and goes away by itself', () => {
  const sunnie = testSunnie();
  const { home } = sunnie.deps;
  const now = new Date('2026-10-04T00:00:00Z');
  const ids = (at = now) => home.widgets(at).map((w) => w.id);

  assert.deepEqual(ids(), [], 'a new Home is empty: the app has no widgets of its own');
  home.set({ id: 'trip', title: 'Jakarta', body: { type: 'stat', value: '27°' }, hours: 14, source: 'agent' }, now);
  home.set({ id: 'note-rain', body: '{"type":"markdown","text":"Rain after three."}', hours: 14, source: 'agent' }, now);
  home.set({ id: 'steps', title: 'Steps', body: { type: 'row', children: [{ type: 'stat', value: 8412, label: 'Today' }, { type: 'progress', value: 0.84 }] }, source: 'api' }, now);
  home.set({ id: 'note-passport', title: 'Passport', body: { type: 'markdown', text: 'Slot opens at 9.' }, hours: 48, before: 'steps', source: 'agent' }, now);
  assert.deepEqual(ids(), ['trip', 'note-rain', 'note-passport', 'steps']);
  const steps = home.widgets(now).find((w) => w.id === 'steps')!;
  assert.deepEqual(steps.body, { type: 'row', children: [{ type: 'stat', value: '8412', label: 'Today', key: 'stat' }, { type: 'progress', value: 0.84, key: 'progress' }] },
    'numbers are taken where text is meant, and every part that shows data gets a key');
  assert.equal(steps.expiresAt, null);

  // The user arranges Home; what is written afterwards respects it.
  home.layout({ order: ['steps', 'trip'], hidden: ['note-passport'] }, now);
  home.set({ id: 'trip', title: 'Bandung', body: { type: 'stat', value: '21°' }, hours: 14, source: 'agent' }, now);
  assert.deepEqual(ids(), ['steps', 'trip', 'note-rain', 'note-passport']);
  assert.equal(home.widgets(now).find((w) => w.id === 'trip')!.title, 'Bandung');
  assert.equal(home.widgets(now).find((w) => w.id === 'note-passport')!.hidden, true);

  const next = new Date(now.getTime() + hours(15));
  assert.deepEqual(ids(next), ['steps', 'note-passport'], 'widgets with hours expire');
  home.set({ id: 'trip', body: { type: 'stat', value: '20°' }, hours: 14, source: 'agent' }, next);
  assert.deepEqual(ids(next).slice(0, 2), ['steps', 'trip'], 'and written again, return to where the user put them');

  home.remove('note-passport', now);
  assert.ok(!ids().includes('note-passport'));
  assert.throws(() => home.remove('note-passport', now), /no widget/);
  home.move('steps', undefined, now);
  assert.equal(ids().at(-1), 'steps');
  home.move('steps', 'note-rain', now);
  assert.equal(ids()[ids().indexOf('note-rain') - 1], 'steps');
  sunnie.db.close();
});

test('a widget body is checked, and the app\'s old widget types are not widgets any more', () => {
  const sunnie = testSunnie();
  const { home } = sunnie.deps;
  const set = (id: string, body: unknown) => home.set({ id, body, source: 'agent' });
  assert.throws(() => set('x', '{not json'), /not valid JSON/);
  assert.throws(() => set('x', { text: 'no type' }), /"type"/);
  assert.throws(() => set('x', { type: 'video', url: 'https://example.com' }), /Types: text, markdown/);
  assert.throws(() => set('x', { type: 'progress', value: 84 }), /not right/);
  assert.throws(() => set('x', { type: 'weather', place: 'Here' }), /Types: text/, 'the brief\'s old weather is retired');
  assert.throws(() => set('x', { type: 'headline', text: 'Hi' }), /Types: text/, 'and so is its headline');
  assert.throws(() => set('Bad Id!', { type: 'text', text: 'x' }), /widget id/);
  for (const type of ['upnext', 'updates', 'following']) assert.throws(() => set('mine', { type }), /not right/);
  let deep: unknown = { type: 'text', text: 'x' };
  for (let i = 0; i < 9; i++) deep = { type: 'stack', children: [deep] };
  assert.throws(() => set('deep', deep), /levels deep/);
  assert.equal(home.widgets().length, 0, 'nothing was written');
  sunnie.db.close();
});

test('a widget can be composed and styled, and bad styling is explained', () => {
  const sunnie = testSunnie();
  const { home } = sunnie.deps;
  const pass = home.set({
    id: 'boarding',
    source: 'agent',
    body: {
      type: 'stack', gradient: ['#0B3D91', '#1F6FEB'], direction: 'diagonal', color: 'White', padding: 16, spacing: 12,
      children: [
        { type: 'row', valign: 'center', children: [
          { type: 'text', text: 'CGK', size: 40, weight: 'heavy', design: 'rounded' },
          { type: 'icon', name: 'airplane', size: 24, fit: true },
          { type: 'text', text: 'FCO', size: 40, weight: 'heavy', design: 'rounded', align: 'trailing' },
        ] },
        { type: 'grid', columns: 3, children: [
          { type: 'stat', label: 'Gate', value: 'B12' },
          { type: 'gauge', value: 0.4, label: '40%', size: 64 },
          { type: 'layer', anchor: 'bottomLeading', corner: 12, height: 80, action: { type: 'open_file', path: 'Drive/Trips/ticket.pdf' }, children: [
            { type: 'image', path: 'Trips/map.png', mode: 'fill' },
            { type: 'badge', text: 'On time', background: 'green' },
          ] },
        ] },
        { type: 'countdown', to: '2026-10-12T07:15:00+07:00', label: 'until boarding', style: 'title3' },
        { type: 'spacer' },
        { type: 'chart', kind: 'area', values: [1, 3, 2], height: 40 },
        { type: 'file', path: '~/Drive/Trips/ticket.pdf', title: 'Travel ticket' },
      ],
    },
  });
  const body = pass.body as any;
  assert.equal(body.color, 'white', 'colour names are case-blind');
  assert.equal(body.children[1].children[2].action.path, 'Trips/ticket.pdf', 'a Drive prefix is dropped');
  assert.deepEqual(drivePaths(pass).sort(), ['Trips/map.png', 'Trips/ticket.pdf']);

  const set = (body: unknown) => home.set({ id: 'x', body, source: 'agent' });
  assert.throws(() => set({ type: 'text', text: 'x', color: 'chartreuse' }), /a colour is one of/);
  assert.throws(() => set({ type: 'text', text: 'x', background: '#12' }), /a colour is one of/);
  assert.throws(() => set({ type: 'file', path: '../etc/passwd' }), /relative to ~\/Drive/);
  assert.throws(() => set({ type: 'image', path: 'https://example.com/a.png' }), /relative to ~\/Drive/);
  assert.throws(() => set({ type: 'countdown', to: 'next Tuesday' }), /not right/);
  assert.throws(() => set({ type: 'stack', gradient: ['red'], children: [{ type: 'divider' }] }), /not right/);
  sunnie.db.close();
});

test('a widget can have buttons and a picture behind it, and no serif type', () => {
  const sunnie = testSunnie();
  const { home } = sunnie.deps;
  const card = home.set({
    id: 'rome',
    source: 'agent',
    body: {
      type: 'stack', backgroundImage: '/home/sunnie/Drive/Uploads/att_1/rome.jpg', gradient: ['#00000000', '#000000B3'],
      color: 'white', padding: 20, height: 200,
      children: [
        { type: 'text', text: 'Rome', style: 'largeTitle', design: 'serif' },
        { type: 'row', children: [
          { type: 'button', text: 'Open ticket', icon: 'ticket', action: { type: 'open_file', path: 'Trips/ticket.pdf' } },
          { type: 'button', text: 'Hotel', variant: 'tinted', action: { type: 'open_url', url: 'https://example.com/hotel' } },
        ] },
      ],
    },
  });
  const body = card.body as any;
  assert.equal(body.backgroundImage, 'Uploads/att_1/rome.jpg', 'an absolute Drive path is made relative');
  assert.equal(body.children[0].design, undefined, 'serif is dropped');
  assert.equal(JSON.stringify(body).includes('serif'), false);
  assert.deepEqual(body.children[1].children[1], { type: 'button', key: 'button-2', text: 'Hotel', variant: 'tinted', action: { type: 'open_url', url: 'https://example.com/hotel' } });
  assert.deepEqual(drivePaths(card).sort(), ['Trips/ticket.pdf', 'Uploads/att_1/rome.jpg']);

  const set = (body: unknown) => home.set({ id: 'x', body, source: 'agent' });
  assert.throws(() => set({ type: 'button', text: 'Go' }), /not right/, 'a button needs its action');
  assert.throws(() => set({ type: 'button', text: 'Go', action: { type: 'open_url', url: 'http://example.com' } }), /not right/);
  assert.throws(() => set({ type: 'button', text: 'Go', variant: 'huge', action: { type: 'ask', prompt: 'Hi' } }), /not right/);
  assert.throws(() => set({ type: 'stack', backgroundImage: 'https://example.com/a.jpg', children: [{ type: 'divider' }] }), /relative to ~\/Drive/);
  sunnie.db.close();
});

test('pinning a Drive file checks that it is there', async () => {
  const steps = [
    toolStep('home_widget', { id: 'ticket', title: 'Travel ticket', body: { type: 'file', path: 'Trips/tiket.pdf' } }, 'c1'),
    toolStep('home_widget', { id: 'ticket', title: 'Travel ticket', body: { type: 'file', path: 'Trips/ticket.pdf', title: 'Flight to Rome' } }, 'c2'),
    toolStep('home_widget', { id: 'trip', body: { type: 'text', text: 'Rome' }, file: 'Trips' }, 'c3'),
    textStep('Pinned.'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift()! });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const drive = join(sunnie.deps.computer.workspace, 'Drive', 'Trips');
  mkdirSync(drive, { recursive: true });
  writeFileSync(join(drive, 'ticket.pdf'), '%PDF-1.4');
  const conversation = sunnie.deps.conversations.create({});
  const run = sunnie.runs.start({ conversationId: conversation.id, text: 'Pin my travel ticket to Home' });
  await run.done;
  assert.equal(run.status, 'completed');
  assert.match(promptText(model.doStreamCalls[1]), /Trips\/tiket\.pdf\S+ could not be found in Drive/, 'a guessed path comes back as something to fix');
  const widgets = sunnie.deps.home.widgets();
  assert.deepEqual(widgets.find((w) => w.id === 'ticket')!.body, { type: 'file', key: 'file', path: 'Trips/ticket.pdf', title: 'Flight to Rome' });
  assert.deepEqual(widgets.find((w) => w.id === 'trip')!.action, { type: 'open_file', path: 'Trips' });
  await sunnie.close();
});

test('the app and programs write, arrange and remove widgets over the API', async () => {
  const sunnie = testSunnie();
  const call = (method: string, path: string, body?: unknown) => sunnie.app.request(path, {
    method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const put = await call('PUT', '/v1/home/widgets/steps', {
    title: 'Steps', body: { type: 'stat', value: '8,412', label: 'Today' }, action: { type: 'ask', prompt: 'How was my week?' },
  });
  assert.equal(put.status, 200);
  const widget = await put.json() as any;
  assert.deepEqual([widget.id, widget.source, widget.hidden, widget.expiresAt, widget.action.type], ['steps', 'api', false, null, 'ask']);
  assert.equal((await call('PUT', '/v1/home/widgets/steps', { body: { type: 'nope' } })).status, 400);
  assert.equal((await call('PUT', '/v1/home/widgets/steps', { body: { type: 'text', text: 'x' }, action: { type: 'open_url', url: 'http://example.com' } })).status, 400, 'links are https');
  assert.equal((await call('PUT', '/v1/home/widgets/upnext', { body: { type: 'upnext' } })).status, 400, 'the app draws nothing of its own');
  assert.equal((await call('PUT', '/v1/home/widgets/trip', { body: { type: 'text', text: 'Rome' } })).status, 200);
  assert.equal((await call('PUT', '/v1/home/widgets/quote', { body: { type: 'text', text: 'Hi' } })).status, 200);

  const layout = await (await call('PUT', '/v1/home/layout', { order: ['quote', 'steps', 'gone'], hidden: ['trip'] })).json() as any;
  assert.deepEqual(layout.widgets.map((w: any) => [w.id, w.hidden]), [['quote', false], ['steps', false], ['trip', true]]);
  const feed = await (await call('GET', '/v1/home')).json() as any;
  assert.deepEqual(feed.widgets.map((w: any) => w.id), ['quote', 'steps', 'trip']);
  assert.deepEqual(Object.keys(feed).sort(), ['brief', 'checkIns', 'timeZone', 'widgets']);

  assert.equal((await call('DELETE', '/v1/home/widgets/steps')).status, 204);
  assert.equal((await call('DELETE', '/v1/home/widgets/steps')).status, 404);
  await sunnie.close();
});

test('the agent changes Home with home_widget and reads it with home_list', async () => {
  const steps = [
    toolStep('home_widget', { id: 'trip', title: 'Rome', body: '{"type":"fields","items":[{"label":"Gate","value":"B12"}]}', link: 'https://example.com/trip', before: 'steps' }, 'c1'),
    toolStep('home_widget', { action: 'hide', id: 'steps' }, 'c2'),
    toolStep('home_widget', { id: 'broken', body: '{"type":"chart","values":[1]}' }, 'c3'),
    toolStep('home_list', {}, 'c4'),
    textStep('Done.'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift()! });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  sunnie.deps.home.set({ id: 'steps', title: 'Steps', body: { type: 'stat', value: '8,412' }, source: 'api' });
  const conversation = sunnie.deps.conversations.create({});
  const run = sunnie.runs.start({ conversationId: conversation.id, text: 'Put my trip on Home' });
  await run.done;
  assert.equal(run.status, 'completed');
  const widgets = sunnie.deps.home.widgets();
  assert.deepEqual(widgets.map((w) => [w.id, w.hidden]), [['trip', false], ['steps', true]]);
  assert.deepEqual(widgets[0]!.action, { type: 'open_url', url: 'https://example.com/trip' });
  const seen = promptText(model.doStreamCalls.at(-1));
  assert.match(seen, /- trip \S+Rome\S+ \(stays, full width, keys: fields\): \{\S+type\S+fields/);
  assert.match(seen, /- steps \S+Steps\S+ \(stays, full width, hidden, keys: stat\): \{/);
  assert.match(seen, /not right/, 'a bad body comes back as something to fix');
  await sunnie.close();
});

test('a widget\'s data changes apart from its design, and it spans one to four columns', () => {
  const sunnie = testSunnie();
  const { home } = sunnie.deps;
  const now = new Date('2026-10-06T00:00:00Z');
  const design = {
    type: 'stack', gradient: ['#0b3d91', '#1f6feb'], color: 'white', padding: 16, children: [
      { type: 'stat', key: 'steps', value: '8,412', label: 'Steps', caption: 'goal 10,000' },
      { type: 'progress', key: 'goal', value: 0.84 },
      { type: 'list', key: 'Walks', items: [{ title: 'Morning' }] },
    ],
  };
  home.set({ id: 'steps', title: 'Today', body: design, columns: 2, source: 'agent' }, now);
  home.set({ id: 'other', body: { type: 'text', text: 'x' }, source: 'agent' }, now);
  home.layout({ order: ['other', 'steps'], hidden: ['steps'] }, now);

  const later = new Date(now.getTime() + hours(2));
  const w = home.update({ id: 'steps', values: { steps: { value: 9120, caption: null }, goal: { value: 0.91 }, walks: { items: [{ title: 'Evening', value: '2 km' }] } }, hours: 6, source: 'agent' }, later);
  assert.deepEqual(w.body, {
    ...design,
    children: [
      { type: 'stat', key: 'steps', value: '9120', label: 'Steps' },
      { type: 'progress', key: 'goal', value: 0.91 },
      { type: 'list', key: 'walks', items: [{ title: 'Evening', value: '2 km' }] },
    ],
  }, 'only the data changed: keys are lowercase, null clears a field');
  assert.deepEqual([w.title, w.columns, w.hidden, w.expiresAt, w.updatedAt], ['Today', 2, true, new Date(later.getTime() + hours(6)).toISOString(), later.toISOString()]);
  assert.deepEqual(home.widgets(later).map((x) => x.id), ['other', 'steps'], 'and it kept its place');

  const update = (values: Record<string, Record<string, unknown>>) => home.update({ id: 'steps', values, source: 'agent' }, later);
  assert.throws(() => update({ steps: { color: 'red' } }), /how "steps" looks[\s\S]*value, label, unit, caption, icon/);
  assert.throws(() => update({ goal: { value: 2 } }), /not right/, 'new data is checked like any body');
  assert.throws(() => update({ nope: { value: '1' } }), /Its keys: steps, goal, walks/);
  assert.throws(() => update({}), /needs `values`/);
  assert.equal(home.update({ id: 'other', values: { text: { text: 'y' } }, source: 'agent' }, later).body.type, 'text', 'a part nobody named is named after its type');
  assert.throws(() => home.update({ id: 'other', values: { x: { text: 'y' } }, source: 'agent' }, later), /Its keys: text\./);
  assert.throws(() => home.update({ id: 'gone', values: { x: { text: 'y' } }, source: 'agent' }, later), /no widget/);
  assert.throws(() => home.set({ id: 'twice', body: { type: 'row', children: [{ type: 'text', key: 'a', text: '1' }, { type: 'text', key: 'A', text: '2' }] }, source: 'agent' }), /key "a"/);
  assert.equal(home.widgets(later).find((x) => x.id === 'steps')!.body.type, 'stack', 'a refused update changes nothing');

  assert.equal(home.widgets(later).find((x) => x.id === 'other')!.columns, 4, 'a widget is the full width unless it says');
  home.set({ id: 'steps', body: { type: 'stat', key: 'steps', value: '1' }, source: 'agent' }, later);
  assert.equal(home.widgets(later).find((x) => x.id === 'steps')!.columns, 2, 'written again, it keeps its width');
  home.set({ id: 'steps', body: { type: 'stat', value: '1' }, columns: 1, source: 'agent' }, later);
  assert.equal(home.widgets(later).find((x) => x.id === 'steps')!.columns, 1);
  assert.throws(() => home.set({ id: 'wide', body: { type: 'text', text: 'x' }, columns: 5, source: 'agent' }), /1 to 4 columns/);
  sunnie.db.close();
});

test('a small widget holds only a little: each size has a budget, and too much is refused with what to cut', () => {
  const sunnie = testSunnie();
  const { home } = sunnie.deps;
  const set = (id: string, columns: number | undefined, body: unknown) => home.set({ id, columns, body, source: 'agent' });
  set('ring', 1, { type: 'stack', children: [{ type: 'gauge', value: 0.7, label: '7h' }, { type: 'spacer' }, { type: 'text', text: 'Sleep' }] });
  assert.throws(() => set('tiny', 1, { type: 'list', items: [{ title: 'Run' }] }), /too much for a small widget[\s\S]*no list/);
  assert.throws(() => set('tiny', 1, { type: 'stack', children: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }, { type: 'text', text: 'd' }] }), /at most 3 parts \(it has 4\)/);
  assert.throws(() => set('tiny', 1, { type: 'text', text: 'A sentence that is far too long for a tile.' }), /at most 30 characters/);
  assert.throws(() => set('tiny', 1, { type: 'stack', children: [{ type: 'text', text: 'Steps today' }, { type: 'stat', value: '8,412' }] }),
    /no heading, title or stat label[\s\S]*"Steps today" would wrap/);
  assert.throws(() => set('tile', 1, { type: 'stat', value: '8,412', label: 'Steps' }), /no heading, title or stat label/, 'a stat\'s label sits above it');
  set('tile', 1, { type: 'stack', children: [{ type: 'stat', value: '8,412', caption: 'steps' }] });
  set('date', 1, { type: 'stack', children: [{ type: 'text', text: 'TUE' }, { type: 'text', text: '6', size: 34 }] });
  assert.throws(() => set('mid', 2, { type: 'fields', items: [1, 2, 3, 4].map((n) => ({ label: `L${n}`, value: `${n}` })) }), /medium widget[\s\S]*at most 3 list or field lines \(it has 4\)/);
  set('mid', 2, { type: 'list', key: 'runs', items: [{ title: 'Mon' }, { title: 'Tue' }] });
  assert.throws(() => home.update({ id: 'mid', values: { runs: { items: [{ title: 'Mon' }, { title: 'Tue' }, { title: 'Wed' }, { title: 'Thu' }] } }, source: 'agent' }),
    /at most 3 list or field lines/, 'new data must fit too');
  set('wide', undefined, { type: 'fields', items: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `L${n}`, value: `${n}` })) });
  assert.throws(() => home.set({ id: 'wide', columns: 1, body: { type: 'fields', items: [{ label: 'a', value: 'b' }] }, source: 'agent' }), /small widget/,
    'the width it is written at decides');
  assert.equal(home.widgets().length, 5);
  sunnie.db.close();
});

test('programs refresh a widget\'s data over the API, and Sunnie with "update"', async () => {
  const steps = [
    toolStep('home_widget', { id: 'mood', columns: 1, body: { type: 'gauge', key: 'mood', value: 0.5, label: '50%' } }, 'c1'),
    toolStep('home_widget', { action: 'update', id: 'mood', values: { mood: { value: 0.8, label: '80%', size: 120 } } }, 'c2'),
    toolStep('home_widget', { action: 'update', id: 'mood', values: { mood: { value: 0.7, label: '70%' } } }, 'c3'),
    textStep('Done.'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift()! });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const call = (method: string, path: string, body?: unknown) => sunnie.app.request(path, {
    method, headers: { ...auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const put = await (await call('PUT', '/v1/home/widgets/steps', { body: { type: 'stat', key: 'n', value: '1', color: 'green' }, columns: 2 })).json() as any;
  assert.equal(put.columns, 2);
  const patched = await call('PATCH', '/v1/home/widgets/steps', { values: { n: { value: '2' } }, title: 'Steps' });
  assert.equal(patched.status, 200);
  assert.deepEqual(((await patched.json()) as any).body, { type: 'stat', key: 'n', value: '2', color: 'green' });
  assert.equal((await call('PATCH', '/v1/home/widgets/steps', { values: { n: { color: 'red' } } })).status, 400);
  assert.equal((await call('PATCH', '/v1/home/widgets/nope', { values: { n: { value: '3' } } })).status, 404);
  assert.equal((await call('PUT', '/v1/home/widgets/steps', { body: { type: 'text', text: 'x' }, columns: 0 })).status, 400);

  const conversation = sunnie.deps.conversations.create({});
  const run = sunnie.runs.start({ conversationId: conversation.id, text: 'Put a small mood gauge on Home' });
  await run.done;
  const mood = sunnie.deps.home.widgets().find((w) => w.id === 'mood')!;
  assert.deepEqual([mood.columns, mood.body], [1, { type: 'gauge', key: 'mood', value: 0.7, label: '70%' }]);
  const seen = promptText(model.doStreamCalls.at(-1));
  assert.match(seen, /1 of 4 columns wide\S* Refresh it with \S*update\S* on mood/);
  assert.match(seen, /how \S*mood\S* looks/, 'a size is design: the model is told to leave it');
  assert.match(seen, /design is unchanged/);
  await sunnie.close();
});

test('the brief refreshes the user\'s widgets only through their data', async () => {
  const steps = [
    toolStep('home_widget', { id: 'steps', body: { type: 'text', text: 'Redesigned' } }, 'c1'),
    toolStep('home_widget', { action: 'hide', id: 'steps' }, 'c2'),
    toolStep('home_widget', { action: 'update', id: 'steps', values: { n: { value: '9,000' } } }, 'c3'),
    toolStep('home_widget', { id: 'note-rain', title: 'Rain', hours: 48, body: { type: 'markdown', text: 'Take an umbrella.' } }, 'c4'),
    textStep('NOTHING_TO_SHARE'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift()! });
  const sunnie = testSunnie({ heartbeat: { briefHour: 6 } }, { models: registryOf(model) });
  const { home } = sunnie.deps;
  home.set({ id: 'steps', body: { type: 'stat', key: 'n', value: '8,000', color: 'green' }, columns: 2, source: 'api' });
  home.setTimeZone('Asia/Jakarta');
  const run = sunnie.heartbeat.tick(new Date('2026-10-03T23:30:00Z'))!;
  await run.done;
  assert.match(promptText(model.doStreamCalls[0]), /- steps \(stays, 2 of 4 columns, keys: n\)/);
  assert.match(promptText(model.doStreamCalls[1]), /the user's widget: a Home brief may only refresh what it shows/);
  const widgets = home.widgets();
  assert.deepEqual(widgets.map((w) => [w.id, w.hidden, w.columns]), [['steps', false, 2], ['note-rain', false, 4]]);
  assert.deepEqual(widgets[0]!.body, { type: 'stat', key: 'n', value: '9,000', color: 'green' });
  await sunnie.close();
});

test('resizing a widget on Home applies at once and has Sunnie redesign only that widget, quietly', async () => {
  const steps = [
    toolStep('home_widget', { id: 'other', body: { type: 'text', text: 'Sneaky' } }, 'c1'),
    toolStep('home_widget', { id: 'steps', columns: 2, body: { type: 'stat', key: 'n', value: '8,000', color: 'green', label: 'Steps' } }, 'c2'),
    textStep('NOTHING_TO_SHARE'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift()! });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  const { home, conversations } = sunnie.deps;
  home.set({ id: 'steps', title: 'Steps', columns: 4, source: 'api',
    body: { type: 'row', color: 'green', children: [{ type: 'stat', key: 'n', value: '8,000' }, { type: 'text', key: 'goal', text: 'Goal 10,000' }] } });
  home.set({ id: 'other', body: { type: 'text', text: 'Mine' }, source: 'api' });
  const call = (path: string, body: unknown) => sunnie.app.request(path, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const res = await call('/v1/home/widgets/steps/resize', { columns: 2 });
  assert.equal(res.status, 202);
  const started = await res.json() as any;
  assert.deepEqual([started.widget.columns, started.widget.resizing], [2, true], 'the new width applies at once, drawn as resizing');
  const feed = await (await sunnie.app.request('/v1/home', { headers: auth })).json() as any;
  assert.equal(feed.widgets.find((w: any) => w.id === 'steps').resizing, true);
  assert.equal((await call('/v1/home/widgets/other/resize', { columns: 2 })).status, 409, 'one at a time');

  await sunnie.runs.get(started.run.id)!.done;
  const preamble = promptText(model.doStreamCalls[0]);
  assert.match(preamble, /<home_resize>[\s\S]*from 4 to 2 of Home's 4 columns[\s\S]*Keep its aesthetics/);
  assert.match(promptText(model.doStreamCalls[1]), /may only write widget \S*steps/, 'another widget is refused');
  const widgets = home.widgets();
  assert.equal(widgets.find((w) => w.id === 'other')!.body.type, 'text');
  assert.deepEqual(widgets.find((w) => w.id === 'other')!.body, { type: 'text', text: 'Mine', key: 'text' });
  const resized = widgets.find((w) => w.id === 'steps')!;
  assert.deepEqual([resized.columns, resized.body.type, resized.title], [2, 'stat', 'Steps']);
  const after = await (await sunnie.app.request('/v1/home', { headers: auth })).json() as any;
  assert.equal(after.widgets.find((w: any) => w.id === 'steps').resizing, false);
  const checkIns = conversations.findByKind('heartbeat')!;
  assert.equal(conversations.listMessages(checkIns.id, { hideQuiet: { activeRunId: null } }).length, 0, 'a resize is not shown in Check-ins');

  assert.equal((await call('/v1/home/widgets/steps/resize', { columns: 2 })).status, 409, 'already that wide');
  assert.equal((await call('/v1/home/widgets/nope/resize', { columns: 2 })).status, 404);
  assert.equal((await call('/v1/home/widgets/steps/resize', { columns: 5 })).status, 400);
  await sunnie.close();
});

test('the brief is due once a day, after its hour on the user\'s clock', () => {
  const sunnie = testSunnie();
  const { home } = sunnie.deps;
  // 05:30 in Jakarta.
  const early = new Date('2026-10-03T22:30:00Z');
  assert.equal(home.briefDue(early, 6), false, 'no zone, no brief');
  home.setTimeZone('Not/AZone');
  assert.equal(home.state().timeZone, null);
  home.setTimeZone('Asia/Jakarta');
  assert.equal(home.briefDue(early, 6), false, 'before the hour');
  const morning = new Date(early.getTime() + hours(1));
  assert.equal(home.briefDue(morning, 6), true);
  home.markBrief('run_x', morning.toISOString());
  assert.equal(home.briefDue(new Date(morning.getTime() + hours(12)), 6), false, 'once that day');
  assert.equal(home.briefDue(new Date(morning.getTime() + hours(24)), 6), true, 'again the next morning');
  sunnie.db.close();
});

test('a check-in that came to nothing is left out on request, and only real news counts as new', async () => {
  const sunnie = testSunnie();
  const { conversations } = sunnie.deps;
  const checkIns = conversations.create({ kind: 'heartbeat', title: 'Check-ins' });
  const turn = (runId: string, opener: string, replies: string[], typed?: string) => conversations.appendMessages(checkIns.id, [
    { role: 'user', content: opener, text: opener, origin: 'heartbeat', runId },
    ...(typed ? [{ role: 'user' as const, content: typed, text: typed, runId }] : []),
    ...replies.map((text) => ({ role: 'assistant' as const, content: text || 'NOTHING_TO_SHARE', text, origin: 'heartbeat' as const, runId })),
  ]);
  turn('run_quiet', 'Exploring your interests: F1', ['']);
  turn('run_news', 'Exploring your interests: F1, Rust', ['', 'A new F1 calendar is out: https://example.com']);
  turn('run_nothing', 'Check-in on a follow-up:\n- Water the plants', ['Let me look.', 'Nothing to report.']);
  turn('run_joined', 'Exploring your interests: Rust', [''], 'What about Rust 2.0?');
  turn('run_brief', BRIEF_OPENER, ['']);

  const get = async (path: string) => (await sunnie.app.request(path, { headers: auth })).json() as Promise<any>;
  const all = (await get(`/v1/conversations/${checkIns.id}/messages`)).messages;
  const shown = (await get(`/v1/conversations/${checkIns.id}/messages?quiet=hide`)).messages;
  assert.equal(all.length, 13, 'without the parameter nothing changes');
  assert.deepEqual([...new Set(shown.map((m: any) => m.runId))], ['run_news', 'run_joined']);
  // Paging stays full: the limit counts what is shown.
  assert.equal((await get(`/v1/conversations/${checkIns.id}/messages?quiet=hide&limit=2`)).messages.length, 2);

  const status = await get('/v1/check-ins');
  const news = all.find((m: any) => m.text.startsWith('A new F1'));
  assert.deepEqual(status, { conversationId: checkIns.id, latestSeq: news.seq, latestAt: news.createdAt, running: false });

  await get('/v1/home?timezone=Asia/Jakarta');
  assert.equal(sunnie.deps.home.state().timeZone, 'Asia/Jakarta', 'the app tells the server its zone');
  await sunnie.close();
});

test('the morning brief writes no headline or weather of its own, stays out of Check-ins, and may only look and write to Home', async () => {
  const steps = [
    toolStep('task_add', { content: 'Brief again tomorrow' }, 'c0'),
    toolStep('home_widget', { id: 'headline', hours: 14, body: { type: 'headline', text: 'Rain after three.' } }, 'c1'),
    toolStep('home_widget', { id: 'note-dentist', title: 'Dentist', hours: 48, body: { type: 'markdown', text: 'At four; take an umbrella.' } }, 'c2'),
    textStep('NOTHING_TO_SHARE'),
  ];
  const model = new MockLanguageModelV4({ doStream: async () => steps.shift()! });
  const sunnie = testSunnie({ heartbeat: { briefHour: 6 } }, { models: registryOf(model) });
  const { home, conversations, tasks } = sunnie.deps;
  home.setTimeZone('Asia/Jakarta');
  const now = new Date('2026-10-03T23:30:00Z'); // 06:30 in Jakarta

  const run = sunnie.heartbeat.tick(now)!;
  assert.ok(run, 'the brief starts at its hour');
  assert.equal(home.state().briefRunId, run.id);
  await run.done;
  assert.equal(run.status, 'completed');
  const preamble = promptText(model.doStreamCalls[0]);
  assert.match(preamble, /<home_brief>[\s\S]*Notes: at most two/);
  assert.doesNotMatch(preamble, /id "weather"|id "headline"/, 'it is not told to write either');
  assert.match(promptText(model.doStreamCalls[2]), /Types: text/, 'and the old headline type is refused');
  assert.equal(tasks.countOpen(), 0, 'a brief cannot add follow-ups');
  assert.deepEqual(home.widgets().map((w) => w.id), ['note-dentist']);
  assert.match(promptText(model.doStreamCalls[0]), /On Home now, top to bottom:\S+- nothing/, 'Home starts empty');

  const checkIns = conversations.findByKind('heartbeat')!;
  assert.equal(conversations.listMessages(checkIns.id, { hideQuiet: { activeRunId: null } }).length, 0, 'a quiet brief is not shown');
  assert.equal(sunnie.heartbeat.tick(new Date(now.getTime() + hours(3))), null, 'one brief a day');

  home.markBrief(run.id, new Date().toISOString());
  const res = await sunnie.app.request('/v1/home/brief', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 409, 'not again a few minutes later');
  const body = await (await sunnie.app.request('/v1/home', { headers: auth })).json() as any;
  assert.deepEqual(body.brief, { enabled: true, running: false, lastAt: home.state().lastBriefAt, hour: 6 });
  assert.deepEqual(body.widgets.map((w: any) => w.body.type), ['markdown']);
  const del = await sunnie.app.request('/v1/home/widgets/note-dentist', { method: 'DELETE', headers: auth });
  assert.equal(del.status, 204);
  assert.equal(home.widgets().length, 0);
  await sunnie.close();
});

test('due follow-ups go before the brief, and briefs can be turned off', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => textStep('Nothing to report.') });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  sunnie.deps.home.setTimeZone('UTC');
  sunnie.deps.tasks.add({ content: 'Due now' });
  const now = new Date('2026-10-04T09:00:00Z');
  const run = sunnie.heartbeat.tick(now)!;
  assert.notEqual(sunnie.deps.home.state().briefRunId, run.id);
  await run.done;
  const brief = sunnie.heartbeat.tick(now)!;
  assert.equal(sunnie.deps.home.state().briefRunId, brief.id, 'the brief follows on the next tick');
  await brief.done;
  await sunnie.close();

  const off = testSunnie({ heartbeat: { brief: false } }, { models: registryOf(model) });
  off.deps.home.setTimeZone('UTC');
  assert.equal(off.heartbeat.tick(now), null);
  const info = await (await off.app.request('/v1/info', { headers: auth })).json() as any;
  assert.deepEqual({ ...info.home, widgetTypes: info.home.widgetTypes.length }, { enabled: true, brief: false, briefHour: 6, widgetTypes: NODE_TYPES.length });
  const res = await off.app.request('/v1/home/brief', { method: 'POST', headers: auth });
  assert.equal(res.status, 409);
  await off.close();
});
