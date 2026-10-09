import type { Logger } from '../util/log.ts';
import type { PageText, SearchHit, SearchQuery, WebSearch } from './search.ts';

/** Characters of matching passages Exa returns per result. */
const HIGHLIGHT_CHARS = 1500;

interface ExaResult {
  title?: string | null;
  url: string;
  publishedDate?: string | null;
  highlights?: string[];
  summary?: string;
  text?: string;
}

interface ExaResponse {
  results?: ExaResult[];
  statuses?: Array<{ id: string; status: string; error?: { tag?: string; httpStatusCode?: number } }>;
  costDollars?: { total?: number };
}

export interface ExaOptions {
  /** https://api.exa.ai, or a gateway that speaks the same API. */
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  log?: Logger;
}

/** Exa (exa.ai): search with the matching passages of each result, and a crawler that reads pages. */
export class ExaSearch implements WebSearch {
  readonly name = 'Exa';
  readonly #opts: ExaOptions;

  constructor(opts: ExaOptions) {
    this.#opts = { ...opts, baseURL: opts.baseURL.replace(/\/+$/, '') };
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
    const body = await this.#post(
      '/search',
      {
        query: q.query,
        type: 'auto',
        numResults: q.maxResults,
        ...(q.domain ? { includeDomains: [q.domain] } : {}),
        ...(q.since ? { startPublishedDate: `${q.since}T00:00:00.000Z` } : {}),
        contents: { highlights: { maxCharacters: HIGHLIGHT_CHARS } },
      },
      signal,
    );
    return (body.results ?? []).map((r) => ({
      title: r.title?.trim() || r.url,
      url: r.url,
      published: r.publishedDate?.slice(0, 10) || undefined,
      text: (r.highlights?.length ? r.highlights.join('\n…\n') : (r.summary ?? r.text ?? '')).trim(),
    }));
  }

  async read(url: string, maxChars: number, signal?: AbortSignal): Promise<PageText> {
    const body = await this.#post('/contents', { urls: [url], text: { maxCharacters: maxChars } }, signal);
    const status = body.statuses?.[0];
    if (status?.status === 'error') {
      const code = status.error?.httpStatusCode ? ` (HTTP ${status.error.httpStatusCode})` : '';
      throw new Error(`Exa could not read the page: ${status.error?.tag ?? 'unknown error'}${code}`);
    }
    const page = body.results?.[0];
    if (!page?.text?.trim()) throw new Error('Exa found no text on the page');
    return { url: page.url || url, title: page.title ?? undefined, text: page.text.trim() };
  }

  async #post(path: string, payload: unknown, signal?: AbortSignal): Promise<ExaResponse> {
    const signals = [AbortSignal.timeout(this.#opts.timeoutMs)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await fetch(`${this.#opts.baseURL}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': this.#opts.apiKey, 'content-type': 'application/json' },
        signal: AbortSignal.any(signals),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`Exa could not be reached: ${(err as Error).name === 'TimeoutError' ? 'it timed out' : (err as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new Error(`Exa refused the search key (HTTP ${res.status})`);
      if (res.status === 402 || res.status === 429) throw new Error(`Exa is out of credit or rate-limited (HTTP ${res.status})`);
      throw new Error(`Exa answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const body = (await res.json()) as ExaResponse;
    this.#opts.log?.debug('exa', { path, costDollars: body.costDollars?.total });
    return body;
  }
}
