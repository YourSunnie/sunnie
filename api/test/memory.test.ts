import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { CoreMemory } from '../src/memory/core-memory.ts';
import { toFtsQuery } from '../src/memory/fts.ts';
import { MemoryStore } from '../src/memory/memory-store.ts';
import { recallContext, recallMemories } from '../src/memory/recall.ts';
import { createMemoryTools } from '../src/tools/memory-tools.ts';
import { ConversationStore } from '../src/store/conversations.ts';

test('toFtsQuery keeps meaningful terms and neutralises FTS syntax', () => {
  assert.equal(toFtsQuery('What is my sister\'s name?'), '"sister" OR "name"');
  assert.equal(toFtsQuery('NEAR("a" AND b*) -- DROP'), '"near" OR "drop"');
  assert.equal(toFtsQuery('the of and'), null);
  assert.equal(toFtsQuery('   '), null);
});

test('archival memory: save, dedupe, search by relevance, update, delete', () => {
  const memory = new MemoryStore(openDatabase(':memory:'));

  const coffee = memory.add({ content: 'Aditya drinks oat-milk flat whites', kind: 'preference', source: 'agent' });
  memory.add({ content: 'Aditya\'s sister Rani lives in Bandung', source: 'agent' });
  memory.add({ content: 'The Sunnie server is written in TypeScript', source: 'api' });
  assert.equal(coffee.created, true);

  const again = memory.add({ content: '  aditya drinks OAT-MILK flat whites ', source: 'compaction' });
  assert.equal(again.created, false);
  assert.equal(again.memory.id, coffee.memory.id);
  assert.equal(memory.count(), 3);

  // Stemming: "living" should find "lives".
  const hits = memory.search('where is my sister living these days?');
  assert.equal(hits[0]?.content, 'Aditya\'s sister Rani lives in Bandung');
  assert.deepEqual(memory.search('quantum chromodynamics'), []);

  memory.update(coffee.memory.id, { content: 'Aditya switched to black coffee in 2026' });
  assert.equal(memory.search('oat milk').length, 0);
  assert.equal(memory.search('black coffee')[0]?.id, coffee.memory.id);

  assert.equal(memory.delete(coffee.memory.id), true);
  assert.equal(memory.search('coffee').length, 0);
});

test('a message that names nothing is searched with the turns before it', () => {
  const memory = new MemoryStore(openDatabase(':memory:'));
  const seat = memory.add({ content: 'On flights the user wants an aisle seat', source: 'agent' }).memory;
  memory.add({ content: 'The user plays badminton on Thursdays', source: 'agent' });

  assert.deepEqual(memory.search('ok book it'), []);
  const context = recallContext([
    { role: 'user', text: 'find me flights to Tokyo in May' },
    { role: 'tool', text: 'ignored' },
    { role: 'assistant', text: 'The 09:40 direct flight is the cheapest.' },
  ]);
  assert.equal(context.split('\n')[0], 'The 09:40 direct flight is the cheapest.', 'newest first');
  const { memories, matched } = recallMemories(memory, { text: 'ok book it', context, limit: 3, topUp: true });
  assert.equal(memories[0]!.id, seat.id);
  // The badminton memory rides along as a top-up, which is not a match.
  assert.deepEqual([memories.length, matched], [2, 1]);

  // What the message itself names outranks what only the context names.
  const direct = memory.search('when do I play badminton?', { context });
  assert.match(direct[0]!.content, /badminton/);
});

test('of two memories that match alike, the one touched later leads', () => {
  const db = openDatabase(':memory:');
  const memory = new MemoryStore(db);
  const old = memory.add({ content: 'The user works at Tokopedia as an engineer', source: 'agent' }).memory;
  const current = memory.add({ content: 'The user works at Acme as an engineer', source: 'agent' }).memory;
  db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run('2024-01-01T00:00:00.000Z', old.id);
  assert.deepEqual(memory.search('where do I work as an engineer').map((m) => m.id), [current.id, old.id]);
});

test('saving a memory names the stored ones it may repeat or replace', async () => {
  const db = openDatabase(':memory:');
  const memory = new MemoryStore(db);
  const tools = createMemoryTools({
    memory, core: new CoreMemory(db, 2000), conversations: new ConversationStore(db), conversationId: 'conv_x',
  });
  const save = (content: string) =>
    tools.memory_save!.execute!({ content }, { toolCallId: 'c', messages: [] } as never) as Promise<string>;

  assert.match(await save('The user lives in Jakarta, in Kemang'), /^Saved as mem_\S+$/);
  assert.match(await save('The user plays badminton on Thursdays'), /^Saved as mem_\S+$/);
  const moved = await save('The user lives in Singapore since March 2026, no longer in Jakarta');
  assert.match(moved, /Similar memories already stored:\nmem_\S+ \[\d{4}-\d\d-\d\d\] The user lives in Jakarta, in Kemang\n/);
  assert.doesNotMatch(moved, /badminton/);
  assert.match(moved, /memory_delete/);
});

test('core memory: append, exact replace, and the size limit', () => {
  const core = new CoreMemory(openDatabase(':memory:'), 60);

  core.append('user', 'Name: Aditya');
  core.append('user', 'Works at Acme');
  assert.equal(core.get('user'), 'Name: Aditya\nWorks at Acme');

  core.replace('user', 'Works at Acme', 'Founder of Acme');
  assert.equal(core.get('user'), 'Name: Aditya\nFounder of Acme');
  assert.equal(core.get('persona'), '');

  assert.throws(() => core.replace('user', 'not there', 'x'), /not found/);
  assert.throws(() => core.append('user', 'x'.repeat(60)), /limit is 60/);
  assert.equal(core.get('user'), 'Name: Aditya\nFounder of Acme', 'a rejected edit leaves the block untouched');
});

test('conversation history stays searchable and pages from the newest message', () => {
  const conversations = new ConversationStore(openDatabase(':memory:'));
  const conv = conversations.create({ title: 'Trip planning' });
  const stored = conversations.appendMessages(
    conv.id,
    Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: [{ type: 'text' as const, text: `message ${i}` }],
      text: i === 3 ? 'The ferry to Lombok leaves at 9am' : `message ${i}`,
    })),
  );
  assert.deepEqual(stored.map((m) => m.seq), [1, 2, 3, 4, 5]);

  assert.deepEqual(conversations.listMessages(conv.id, { limit: 2 }).map((m) => m.seq), [4, 5]);
  assert.deepEqual(conversations.listMessages(conv.id, { beforeSeq: 4, limit: 2 }).map((m) => m.seq), [2, 3]);
  assert.deepEqual(conversations.listMessages(conv.id, { afterSeq: 3 }).map((m) => m.seq), [4, 5]);

  const [hit] = conversations.searchMessages('when does the ferry leave');
  assert.equal(hit?.seq, 4);
  assert.equal(hit?.conversationTitle, 'Trip planning');

  conversations.delete(conv.id);
  assert.deepEqual(conversations.searchMessages('ferry'), []);
});
