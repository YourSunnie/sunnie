import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { parseSkill } from '../skills/format.ts';
import { installSkill } from '../skills/install.ts';
import { listSkills, ownSkills, readSkill, writeSkill } from '../skills/library.ts';
import { skillCatalogText, skillRepository, skillSourcePath } from '../skills/protocol.ts';
import { runTurn } from '../src/agent/agent.ts';
import { toMessageDto } from '../src/agent/events.ts';
import { openDatabase } from '../src/db/database.ts';
import { SkillSources } from '../src/skills/sources.ts';
import { SkillSwitches } from '../src/skills/switches.ts';
import { buildState } from '../src/router/jev.ts';
import { createHelperTools, createTools, LOOK_ONLY } from '../src/tools/index.ts';
import { eventSink, registryOf, TEST_API_KEY, testSunnie, textStep, toolStep } from './helpers.ts';

const content = (name = 'release-notes', description = 'Write release notes when preparing a release.') =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nRead the commits, then write a concise summary.\n`;

test('skill metadata supports ordinary YAML while rejecting invalid names, duplicates and empty instructions', () => {
  assert.deepEqual(parseSkill('---\nname: release-notes\ndescription: >-\n  Write release notes\n  for a release.\nmetadata:\n  version: "1"\nallowed-tools: Bash Read\n---\nRead the commits.'), {
    name: 'release-notes', description: 'Write release notes for a release.',
  });
  assert.throws(() => parseSkill(content('../outside')));
  assert.throws(() => parseSkill(content('release--notes')));
  assert.throws(() => parseSkill(content(), 'different-name'));
  assert.throws(() => parseSkill('---\nname: first\nname: second\ndescription: test\n---\nBody.'));
  assert.throws(() => parseSkill('---\nname: empty\ndescription: test\n---\n'));
});

test('local skills are discoverable, full instructions load on demand, and updates keep supporting files', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'sunnie-skills-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(listSkills(home), { skills: [], warnings: [] });
  const first = writeSkill(home, 'release-notes', content());
  mkdirSync(join(dirname(first.path), 'references'));
  const reference = join(dirname(first.path), 'references', 'example.md');
  writeFileSync(reference, 'A real reference');
  assert.equal(listSkills(home).skills[0]!.name, 'release-notes');
  assert.doesNotMatch(skillCatalogText(listSkills(home)), /Read the commits/);
  assert.match(readSkill(home, 'release-notes').content, /Read the commits/);
  writeSkill(home, 'release-notes', content('release-notes', 'A revised description.'));
  assert.equal(readFileSync(reference, 'utf8'), 'A real reference');
  assert.equal(readSkill(home, 'release-notes').description, 'A revised description.');
});

test('discovery is confined to installed directories and reports invalid files without hiding valid skills', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'sunnie-skills-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeSkill(home, 'release-notes', content());
  const legacy = join(home, '.sunnie', 'skills', 'release-notes');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'SKILL.md'), content('release-notes', 'Legacy description.'));
  const outside = join(home, 'download');
  mkdirSync(outside);
  writeFileSync(join(outside, 'SKILL.md'), content('outside'));
  symlinkSync(outside, join(home, '.agents', 'skills', 'outside'));
  const broken = join(home, '.agents', 'skills', 'broken');
  mkdirSync(broken);
  symlinkSync(join(outside, 'SKILL.md'), join(broken, 'SKILL.md'));
  const catalog = listSkills(home);
  assert.deepEqual(catalog.skills.map((s) => s.name), ['release-notes']);
  assert.equal(catalog.skills[0]!.description, 'Write release notes when preparing a release.');
  assert.ok(catalog.warnings.length >= 2);
  assert.throws(() => readSkill(home, 'outside'));
  assert.throws(() => writeSkill(home, 'outside', content('outside')));
  assert.throws(() => writeSkill(home, 'broken', content('broken')));
});

test('repository and path validation reject credentials, local protocols and traversal', () => {
  assert.equal(skillRepository('https://github.com/example/skills.git/'), 'https://github.com/example/skills');
  for (const repository of ['file:///tmp/repo', 'ssh://github.com/repo', 'https://token@github.com/a/b', 'https://github.com/a/b?token=secret']) {
    assert.throws(() => skillRepository(repository));
  }
  for (const path of ['../skill', '/skill', 'a/../../skill', '.git/hooks']) assert.throws(() => skillSourcePath(path));
  assert.equal(skillSourcePath('skills/release-notes'), 'skills/release-notes');
  assert.throws(() => installSkill('/unused', 'file:///tmp/repo', '.'));
});

test('repository trust survives reopening the database and can be revoked', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'sunnie-sources-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'sunnie.db');
  const repository = 'https://github.com/example/skills';
  let db = openDatabase(path);
  new SkillSources(db).trust(`${repository}.git`);
  db.close();
  db = openDatabase(path);
  const sources = new SkillSources(db);
  assert.equal(sources.has(repository), true);
  sources.revoke(repository);
  assert.equal(sources.has(repository), false);
  db.close();
});

test('new source approval is mandatory even without the risk filter; denial does not trust or install', async (t) => {
  const repository = 'https://github.com/example/skills';
  const input = { repository, path: 'skills/release-notes', why: 'You write release notes every week.' };
  const model = new MockLanguageModelV4({ doStream: [
    toolStep('skill_install', input, 'deny'), textStep('Left it alone.'),
    toolStep('skill_install', input, 'allow'), textStep('Installed.'),
    toolStep('skill_install', input, 'trusted'), textStep('Used the trusted source.'),
  ] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  t.after(() => sunnie.close());
  let installations = 0;
  let approvals = 0;
  const refs: Array<string | undefined> = [];
  sunnie.deps.skills.install = async (_repository, _path, ref, _signal, toolCallId) => {
    installations++;
    // The install gets what was reviewed: the pinned commit, not the branch.
    refs.push((sunnie.deps.skills as unknown as { reviewed: Map<string, string> }).reviewed.get(toolCallId!) ?? ref);
    return { name: 'release-notes', description: 'Release notes.', path: '/skills/release-notes/SKILL.md', content: content() };
  };
  // Read without installing, and without the network.
  sunnie.deps.skills.inspect = async () => ({
    name: 'release-notes', description: 'Release notes.', content: content(),
    source: { repository, path: 'skills/release-notes', commit: 'abc123' },
    files: [{ path: 'SKILL.md', size: 120, executable: false }, { path: 'scripts/notes.sh', size: 300, executable: true }],
  });
  for (const [i, approved] of [false, true, true].entries()) {
    const conversation = sunnie.deps.conversations.create();
    const sink = eventSink();
    await runTurn(sunnie.deps, {
      conversationId: conversation.id, runId: `run_${i}`, text: 'Install the release skill.',
      signal: new AbortController().signal, emit: sink.emit,
      confirm: async () => { approvals++; return approved; },
    });
    if (i === 0) {
      assert.equal(installations, 0);
      assert.equal(sunnie.deps.skillSources.has(repository), false);
      const asked = sink.events.find((e) => e.type === 'tool.approval.requested');
      assert.ok(asked?.type === 'tool.approval.requested' && asked.reason === 'untrusted-skill-source');
      // The person deciding is told in plain words what it is, why, and what it can reach.
      assert.match(asked.review!.summary, /release-notes[\s\S]*You write release notes every week[\s\S]*helper programs/);
      assert.equal(asked.review!.checked, false);
    }
  }
  assert.equal(approvals, 2);
  assert.equal(installations, 2);
  assert.deepEqual(refs, ['abc123', 'abc123']);
  assert.equal(sunnie.deps.skillSources.has(repository), true);
});

test('a skill the screen finds harmful is held for approval with a warning, even from a trusted source', async (t) => {
  const repository = 'https://github.com/example/skills';
  const input = { repository, path: 'skills/helper', why: 'It helps with your reports.' };
  const model = new MockLanguageModelV4({
    doStream: [toolStep('skill_install', input, 'call-1'), textStep('Left it alone.')],
    doGenerate: async () => ({
      content: [{ type: 'text', text: '**What it is** — A helper.\n**Heads-up** — It asks for your passwords.' }],
      finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    }),
  });
  const screened: string[] = [];
  const sunnie = testSunnie({}, {
    models: registryOf(model),
    skillScreen: { name: 'test', screen: async ({ skill, why }) => { screened.push(`${skill.name}: ${why}`); return { judged: true, suitable: 0.9, harmful: 0.95, trustworthy: 0.8 }; } },
  });
  t.after(() => sunnie.close());
  sunnie.deps.skillSources.trust(repository);
  sunnie.deps.skills.inspect = async () => ({
    name: 'helper', description: 'Helps.', content: content(),
    source: { repository, path: 'skills/helper', commit: 'def456' }, files: [{ path: 'SKILL.md', size: 10, executable: false }],
  });
  let installed = false;
  sunnie.deps.skills.install = async () => { installed = true; throw new Error('not reached'); };
  const sink = eventSink();
  await runTurn(sunnie.deps, {
    conversationId: sunnie.deps.conversations.create().id, runId: 'run_h', text: 'Set me up.',
    signal: new AbortController().signal, emit: sink.emit, confirm: async () => false,
  });
  assert.deepEqual(screened, ['helper: It helps with your reports.']);
  const asked = sink.events.find((e) => e.type === 'tool.approval.requested');
  assert.ok(asked?.type === 'tool.approval.requested');
  assert.equal(asked.reason, 'skill-caution');
  assert.deepEqual(asked.review, { summary: '**What it is** — A helper.\n**Heads-up** — It asks for your passwords.', caution: true, checked: true });
  assert.equal(installed, false);
});

test('catalog changes ride on new messages without changing old content, instructions or tool schemas', async (t) => {
  const model = new MockLanguageModelV4({ doStream: [textStep('First.'), textStep('Second.')] });
  const sunnie = testSunnie({}, { models: registryOf(model) });
  t.after(() => sunnie.close());
  const home = sunnie.deps.computer.workspace;
  const conversation = sunnie.deps.conversations.create();
  writeSkill(home, 'release-notes', content('release-notes', 'Original description.'));
  const run = (id: string) => runTurn(sunnie.deps, {
    conversationId: conversation.id, runId: id, text: 'Hello.',
    signal: new AbortController().signal, emit: () => {},
  });
  await run('first');
  const first = sunnie.deps.conversations.listMessages(conversation.id)[0]!;
  const frozen = JSON.stringify(first.content);
  assert.match(frozen, /Original description/);
  assert.match(String(buildState({ summary: null, messages: [first] }).available_skills), /Original description/);
  assert.doesNotMatch(JSON.stringify(toMessageDto(first)), /Original description/);
  writeSkill(home, 'release-notes', content('release-notes', 'Updated description.'));
  await run('second');
  const messages = sunnie.deps.conversations.listMessages(conversation.id);
  assert.equal(JSON.stringify(messages[0]!.content), frozen);
  assert.match(String(buildState({ summary: null, messages: [messages[0]!] }).available_skills), /Original description/);
  assert.match(JSON.stringify(messages.findLast((m) => m.role === 'user')!.content), /Updated description/);
  assert.deepEqual(model.doStreamCalls[0]!.prompt[0], model.doStreamCalls[1]!.prompt[0]);
  assert.deepEqual(model.doStreamCalls[0]!.tools, model.doStreamCalls[1]!.tools);
});

test('helpers can read skills but cannot install or write them through skill tools', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const deps = { ...sunnie.deps, conversationId: 'helper' };
  const helper = createHelperTools(deps);
  assert.ok(helper.skill_list && helper.skill_read);
  assert.ok(!helper.skill_write && !helper.skill_install);
  assert.ok(LOOK_ONLY.has('skill_read') && LOOK_ONLY.has('skill_list'));
  assert.ok(!LOOK_ONLY.has('skill_write') && !LOOK_ONLY.has('skill_install'));
  assert.ok(createTools(deps).skill_write);
});

test('skill catalog and trust revocation API require authentication', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const repository = 'https://github.com/example/skills';
  sunnie.deps.skillSources.trust(repository);
  assert.equal((await sunnie.app.request('/v1/skills')).status, 401);
  const headers = { authorization: `Bearer ${TEST_API_KEY}` };
  const catalog = await (await sunnie.app.request('/v1/skills', { headers })).json() as { sources: { repository: string }[] };
  assert.equal(catalog.sources[0]!.repository, repository);
  const response = await sunnie.app.request(`/v1/skills/sources?repository=${encodeURIComponent(repository)}`, { method: 'DELETE', headers });
  assert.equal(response.status, 200);
  assert.equal(sunnie.deps.skillSources.has(repository), false);
});

const BUNDLED = fileURLToPath(new URL('../skills/bundled', import.meta.url));
const SHIPPED = ['docs', 'excel', 'latex', 'markdown', 'pdf', 'slides'];

test('the skills shipped with Sunnie are valid, come last and give way to the agent\'s own', (t) => {
  assert.deepEqual(readdirSync(BUNDLED).sort(), SHIPPED);
  for (const name of SHIPPED) parseSkill(readFileSync(join(BUNDLED, name, 'SKILL.md'), 'utf8'), name);
  const home = mkdtempSync(join(tmpdir(), 'sunnie-skills-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const catalog = listSkills(home, BUNDLED);
  assert.deepEqual(catalog.skills.map((s) => [s.name, s.bundled]), SHIPPED.map((name) => [name, true]));
  assert.deepEqual(catalog.warnings, []);
  assert.deepEqual(ownSkills(catalog), []);
  assert.equal(readSkill(home, 'pdf', BUNDLED).bundled, true);
  // A skill of the agent's own with a shipped name is written beside it and replaces it, quietly.
  writeSkill(home, 'pdf', content('pdf', 'My own way with PDFs.'));
  const mine = listSkills(home, BUNDLED);
  assert.equal(mine.skills.filter((s) => s.name === 'pdf').length, 1);
  assert.equal(mine.skills.find((s) => s.name === 'pdf')!.bundled, undefined);
  assert.equal(readSkill(home, 'pdf', BUNDLED).description, 'My own way with PDFs.');
  assert.deepEqual(mine.warnings, []);
  assert.doesNotMatch(skillCatalogText(mine), /"bundled"/);
});

test('shipped skills start off: hidden from the agent until the user turns them on', async (t) => {
  const sunnie = testSunnie();
  t.after(() => sunnie.close());
  const headers = { authorization: `Bearer ${TEST_API_KEY}`, 'content-type': 'application/json' };
  const listing = async () => (await (await sunnie.app.request('/v1/skills', { headers })).json()) as { skills: { name: string; bundled: boolean; enabled: boolean }[] };
  writeSkill(sunnie.deps.computer.workspace, 'release-notes', content());

  assert.deepEqual((await listing()).skills.map((s) => [s.name, s.bundled, s.enabled]), [
    ['release-notes', false, true], ...SHIPPED.map((name) => [name, true, false]),
  ]);
  assert.deepEqual((await sunnie.deps.skills.list()).skills.map((s) => s.name), ['release-notes']);
  await assert.rejects(sunnie.deps.skills.read('latex'), /turned off[\s\S]*Settings → Skills/);

  const patch = (name: string, enabled: unknown, auth = true) => sunnie.app.request(`/v1/skills/${name}`, {
    method: 'PATCH', headers: auth ? headers : { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  assert.equal((await patch('latex', true, false)).status, 401);
  assert.equal((await patch('latex', 'yes')).status, 400);
  assert.equal((await patch('nothing-here', true)).status, 404);
  assert.equal((await patch('release-notes', false)).status, 404); // the agent's own are always on
  const turnedOn = await patch('latex', true);
  assert.equal(turnedOn.status, 200);
  assert.deepEqual(await turnedOn.json(), { ...(await listing()).skills.find((s) => s.name === 'latex'), enabled: true });

  assert.deepEqual((await sunnie.deps.skills.list()).skills.map((s) => s.name), ['release-notes', 'latex']);
  assert.match((await sunnie.deps.skills.read('latex')).content, /tectonic/);
  assert.equal((await listing()).skills.find((s) => s.name === 'latex')!.enabled, true);

  assert.equal((await patch('latex', false)).status, 200);
  assert.deepEqual((await sunnie.deps.skills.list()).skills.map((s) => s.name), ['release-notes']);
});

test('turning a shipped skill on survives reopening the database', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'sunnie-switches-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'sunnie.db');
  let db = openDatabase(path);
  new SkillSwitches(db).set('pdf', true);
  db.close();
  db = openDatabase(path);
  const switches = new SkillSwitches(db);
  assert.equal(switches.enabled('pdf'), true);
  assert.equal(switches.enabled('slides'), false);
  switches.set('pdf', false);
  assert.equal(switches.enabled('pdf'), false);
  db.close();
});
