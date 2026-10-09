import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { runTurn } from '../src/agent/agent.ts';
import { toMessageDto } from '../src/agent/events.ts';
import { createSearch } from '../src/app.ts';
import { ExaSearch } from '../src/search/exa.ts';
import type { PageText, SearchHit, SearchQuery, WebSearch } from '../src/search/search.ts';
import { LOOK_ONLY, createHelperTools } from '../src/tools/index.ts';
import { createLogger } from '../src/util/log.ts';
import { eventSink, promptText, registryOf, testConfig, testSunnie, textStep, toolStep } from './helpers.ts';

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

/** A search service that answers from a script and remembers what it was asked. */
function fakeSearch(opts: { hits?: SearchHit[]; page?: PageText | Error } = {}) {
  const searches: SearchQuery[] = [];
  const reads: string[] = [];
  const search: WebSearch = {
    name: 'Fake',
    async search(q) {
      searches.push(q);
      return opts.hits ?? [];
    },
    async read(url) {
      reads.push(url);
      const page = opts.page ?? { url, text: 'Text from the crawler' };
      if (page instanceof Error) throw page;
      return page;
    },
  };
  return { search, searches, reads };
}

async function turnWith(search: WebSearch | null, steps: ReturnType<typeof toolStep>[], raw: Record<string, unknown> = {}) {
  const model = new MockLanguageModelV4({ doStream: [...steps, textStep('Done.')] });
  const sunnie = testSunnie(raw, { models: registryOf(model), search });
  const conv = sunnie.deps.conversations.create();
  const result = await runTurn(sunnie.deps, {
    conversationId: conv.id,
    runId: 'run_test',
    text: 'Look it up',
    signal: new AbortController().signal,
    emit: eventSink().emit,
  });
  assert.equal(result.status, 'completed');
  const outputs = sunnie.deps.conversations
    .listMessages(conv.id)
    .filter((m) => m.role === 'tool')
    .map((m) => toMessageDto(m).parts.map((p) => (p.type === 'tool_result' ? p.output : '')).join(''));
  await sunnie.close();
  return { model, outputs };
}

test('ExaSearch sends the documented request and reads results and pages', async () => {
  const seen: Array<{ path: string; key: string; body: any }> = [];
  const { server, url } = await listen(async (req, res) => {
    seen.push({ path: req.url!, key: String(req.headers['x-api-key']), body: await bodyOf(req) });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/search') {
      res.end(JSON.stringify({
        results: [
          { title: 'Ferry times', url: 'https://ferry.example/times', publishedDate: '2026-09-30T08:00:00.000Z', highlights: ['Departs 9am', 'and 2pm'] },
          { title: null, url: 'https://other.example/', summary: 'A summary' },
        ],
        costDollars: { total: 0.008 },
      }));
    } else {
      res.end(JSON.stringify({ results: [{ url: 'https://ferry.example/times', title: 'Ferry', text: ' Full text ' }], statuses: [{ id: 'x', status: 'success' }] }));
    }
  });
  const exa = new ExaSearch({ baseURL: `${url}/`, apiKey: 'exa-key', timeoutMs: 5000 });

  const hits = await exa.search({ query: 'ferry', maxResults: 3, domain: 'ferry.example', since: '2026-09-01' });
  assert.deepEqual(hits, [
    { title: 'Ferry times', url: 'https://ferry.example/times', published: '2026-09-30', text: 'Departs 9am\n…\nand 2pm' },
    { title: 'https://other.example/', url: 'https://other.example/', published: undefined, text: 'A summary' },
  ]);
  const page = await exa.read('https://ferry.example/times', 1000);
  assert.deepEqual(page, { url: 'https://ferry.example/times', title: 'Ferry', text: 'Full text' });

  assert.deepEqual(seen[0], {
    path: '/search',
    key: 'exa-key',
    body: {
      query: 'ferry',
      type: 'auto',
      numResults: 3,
      includeDomains: ['ferry.example'],
      startPublishedDate: '2026-09-01T00:00:00.000Z',
      contents: { highlights: { maxCharacters: 1500 } },
    },
  });
  assert.deepEqual(seen[1]!.body, { urls: ['https://ferry.example/times'], text: { maxCharacters: 1000 } });
  server.close();
});

test('ExaSearch turns refusals and crawl errors into messages the model can act on', async () => {
  let answer: { status: number; body: unknown } = { status: 401, body: { error: 'bad key' } };
  const { server, url } = await listen((_req, res) => {
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  const exa = new ExaSearch({ baseURL: url, apiKey: 'k', timeoutMs: 5000 });

  await assert.rejects(exa.search({ query: 'q', maxResults: 1 }), /refused the search key \(HTTP 401\)/);
  answer = { status: 429, body: {} };
  await assert.rejects(exa.search({ query: 'q', maxResults: 1 }), /out of credit or rate-limited/);
  answer = { status: 200, body: { results: [], statuses: [{ id: 'u', status: 'error', error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 } }] } };
  await assert.rejects(exa.read('https://gone.example/', 100), /could not read the page: CRAWL_NOT_FOUND \(HTTP 404\)/);
  server.close();
  await assert.rejects(exa.search({ query: 'q', maxResults: 1 }), /Exa could not be reached/);
});

test('the search service exists only with a key, which comes from the environment', () => {
  const log = createLogger('silent');
  const config = testConfig({ search: {} });
  assert.equal(createSearch(config, log, {}), undefined);
  assert.ok(createSearch(config, log, { EXA_API_KEY: 'k' }) instanceof ExaSearch);
  assert.equal(createSearch(testConfig({ search: { type: 'none' } }), log, { EXA_API_KEY: 'k' }), undefined);
});

test('web_search lists results with their passages; without a service there is no such tool', async () => {
  const fake = fakeSearch({
    hits: [
      { title: 'Ferry times', url: 'https://ferry.example/times', published: '2026-09-30', text: 'Departs 9am\nand 2pm' },
      { title: 'Other', url: 'https://other.example/', text: '' },
    ],
  });
  const { model, outputs } = await turnWith(fake.search, [
    toolStep('web_search', { query: 'ferry Batam', max_results: 2, site: 'https://ferry.example/path', since: '2026-09-01' }),
  ]);
  assert.deepEqual(fake.searches, [{ query: 'ferry Batam', maxResults: 2, domain: 'ferry.example', since: '2026-09-01' }]);
  assert.equal(
    outputs[0],
    '1. Ferry times\n   https://ferry.example/times (published 2026-09-30)\n   Departs 9am\n   and 2pm\n\n' +
      '2. Other\n   https://other.example/\n\nRead a result in full with web_fetch.',
  );
  assert.ok(model.doStreamCalls[0]!.tools!.some((t) => t.name === 'web_search'));
  assert.match(promptText(model.doStreamCalls[0]), /`web_search` finds pages on the web/);
  // Searching only looks: a resumed turn need not worry about having done it.
  assert.ok(LOOK_ONLY.has('web_search'));

  const without = await turnWith(null, []);
  assert.ok(!without.model.doStreamCalls[0]!.tools!.some((t) => t.name === 'web_search'));
  assert.doesNotMatch(promptText(without.model.doStreamCalls[0]), /web_search/);
});

test('web_search failures and empty results tell the model what to try instead', async () => {
  const failing: WebSearch = {
    name: 'Fake',
    search: async () => { throw new Error('Exa is out of credit or rate-limited (HTTP 402)'); },
    read: async () => { throw new Error('unused'); },
  };
  const failed = await turnWith(failing, [toolStep('web_search', { query: 'anything' })]);
  assert.match(failed.outputs[0]!, /Web search failed: Exa is out of credit.*web_fetch.*browser/);

  const fake = fakeSearch();
  const empty = await turnWith(fake.search, [toolStep('web_search', { query: 'nothing at all' })], { search: { type: 'none', defaultResults: 7 } });
  assert.equal(fake.searches[0]!.maxResults, 7);
  assert.match(empty.outputs[0]!, /^No results for "nothing at all"/);
});

test('web_fetch reads a page through the search service when the site turns it away, and says so', async () => {
  const { server, url } = await listen((req, res) => {
    if (req.url === '/doc.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.7');
      return;
    }
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<p>Access denied</p>');
  });

  const fake = fakeSearch({ page: { url: `${url}/blocked`, title: 'The page', text: 'The real content' } });
  const blocked = await turnWith(fake.search, [
    toolStep('web_fetch', { url: `${url}/blocked` }, 'c1'),
    toolStep('web_fetch', { url: `${url}/doc.pdf` }, 'c2'),
    toolStep('web_fetch', { url: 'http://nowhere.invalid/' }, 'c3'),
  ]);
  assert.deepEqual(fake.reads, [`${url}/blocked`, `${url}/doc.pdf`, 'http://nowhere.invalid/']);
  assert.equal(blocked.outputs[0], `Read through Fake, because the site answered the direct fetch with HTTP 403: ${url}/blocked\nThe page\n\nThe real content`);
  assert.match(blocked.outputs[1]!, /^Read through Fake, because it is a PDF/);
  assert.match(blocked.outputs[2]!, /^Read through Fake, because the direct fetch failed \(curl: \(6\)/);

  // When the crawler fails too, the model gets what the site said and both reasons.
  const failing = fakeSearch({ page: new Error('Exa could not read the page: CRAWL_NOT_FOUND') });
  const both = await turnWith(failing.search, [
    toolStep('web_fetch', { url: `${url}/blocked` }, 'c1'),
    toolStep('web_fetch', { url: 'http://nowhere.invalid/' }, 'c2'),
  ]);
  assert.equal(both.outputs[0], `HTTP 403 ${url}/blocked (Fake could not read it either: Exa could not read the page: CRAWL_NOT_FOUND)\n\nAccess denied`);
  assert.match(both.outputs[1]!, /curl: \(6\).*Reading it through Fake failed too: Exa could not read the page/);

  // With the fallback off, web_fetch is what it always was.
  const off = fakeSearch();
  const plain = await turnWith(off.search, [toolStep('web_fetch', { url: `${url}/blocked` })], { search: { type: 'none', fetchFallback: false } });
  assert.deepEqual(off.reads, []);
  assert.equal(plain.outputs[0], `HTTP 403 ${url}/blocked\n\nAccess denied`);
  const fetchTool = plain.model.doStreamCalls[0]!.tools!.find((t) => t.name === 'web_fetch')!;
  assert.doesNotMatch(fetchTool.type === 'function' ? (fetchTool.description ?? '') : '', /crawler/);
  server.close();
});

test('helpers can search too', async () => {
  const sunnie = testSunnie();
  const { config, computer, logins, skills } = sunnie.deps;
  const tools = createHelperTools({ config, computer, logins, skills, conversationId: 'c', search: fakeSearch().search });
  assert.ok('web_search' in tools);
  await sunnie.close();
});
