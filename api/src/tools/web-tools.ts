import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { shq, type Computer } from '../computer/computer.ts';
import type { SearchHit, WebSearch } from '../search/search.ts';

const MAX_CHARS = 20_000;
const MAX_DOWNLOAD_BYTES = 2_000_000;
const TIMEOUT_SEC = 30;
const USER_AGENT = 'Sunnie/0.1 (personal agent)';
const META_MARKER = '__SUNNIE_FETCH_META__';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** A rough HTML-to-text pass: good enough to read an article, not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Statuses with which sites commonly turn away a datacenter address or an unknown client. */
const BLOCKED = new Set([403, 429, 503]);
const MAX_RESULTS = 10;
const MAX_SEARCH_CHARS = 12_000;

function clip(text: string, max: number, total = text.length): string {
  return total > max ? `${text.slice(0, max)}\n\n[truncated: ${total} characters total]` : text;
}

function formatHits(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `No results for "${query}". Try other words, a wider date range, or no site filter.`;
  const lines = hits.map((h, i) =>
    [`${i + 1}. ${h.title}`, `   ${h.url}${h.published ? ` (published ${h.published})` : ''}`, h.text ? h.text.replace(/^/gm, '   ') : '']
      .filter(Boolean)
      .join('\n'),
  );
  return clip(`${lines.join('\n\n')}\n\nRead a result in full with web_fetch.`, MAX_SEARCH_CHARS);
}

export function createWebTools(
  computer: Computer,
  search?: WebSearch,
  options: { defaultResults: number; fetchFallback: boolean } = { defaultResults: 5, fetchFallback: true },
): ToolSet {
  const fallback = options.fetchFallback ? search : undefined;
  /** The page read through the search service, or null when that failed too. */
  const readElsewhere = async (url: string, why: string, signal?: AbortSignal) => {
    if (!fallback) return { text: null, error: undefined };
    try {
      const page = await fallback.read(url, MAX_CHARS, signal);
      const head = `Read through ${fallback.name}, because ${why}: ${page.url}${page.title ? `\n${page.title}` : ''}`;
      return { text: `${head}\n\n${clip(page.text, MAX_CHARS)}`, error: undefined };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { text: null, error: (err as Error).message };
    }
  };

  return {
    web_fetch: tool({
      description:
        'Fetch a URL and return its content as text (HTML is reduced to readable text). The quick way to ' +
        'read a public page or API. It runs no JavaScript and has no sign-ins: for pages that need either, ' +
        'use the browser. For requests with headers, or downloads, use curl in the shell.' +
        (fallback ? ' When a site turns the direct fetch away, the page is read through a crawler instead.' : ''),
      inputSchema: z.object({ url: z.url({ protocol: /^https?$/ }) }),
      execute: async ({ url }, { abortSignal }) => {
        // Goes through the agent's computer rather than the server's own network stack, so
        // whatever network boundary the computer has applies to fetches too.
        const res = await computer.exec(
          `curl -sSL --compressed --max-time ${TIMEOUT_SEC} --max-filesize ${MAX_DOWNLOAD_BYTES} ` +
            `-A ${shq(USER_AGENT)} -w ${shq(`\n${META_MARKER} %{http_code} %{url_effective} %{content_type}`)} -- ${shq(url)}`,
          { timeoutMs: (TIMEOUT_SEC + 5) * 1000, maxOutputChars: MAX_DOWNLOAD_BYTES, signal: abortSignal },
        );
        const marker = res.stdout.lastIndexOf(`\n${META_MARKER} `);
        if (res.exitCode !== 0 || marker === -1) {
          const failure = res.stderr.trim() || `curl exited with code ${res.exitCode}`;
          const other = await readElsewhere(url, `the direct fetch failed (${failure})`, abortSignal);
          if (other.text) return other.text;
          throw new Error(other.error ? `${failure}. Reading it through ${fallback!.name} failed too: ${other.error}` : failure);
        }
        const body = res.stdout.slice(0, marker);
        const [status, finalUrl, ...typeParts] = res.stdout.slice(marker + META_MARKER.length + 2).split(' ');
        const type = typeParts.join(' ');
        const isPdf = /^application\/pdf/i.test(type);
        if (BLOCKED.has(Number(status)) || isPdf) {
          const why = isPdf ? 'it is a PDF' : `the site answered the direct fetch with HTTP ${status}`;
          const other = await readElsewhere(url, why, abortSignal);
          if (other.text) return other.text;
          if (other.error) {
            const note = `(${fallback!.name} could not read it either: ${other.error})`;
            if (isPdf) return `HTTP ${status}. A PDF; ${note.slice(1, -1)}. Download it with curl in the shell instead.`;
            return `HTTP ${status} ${finalUrl} ${note}\n\n${clip(/html/i.test(type) ? htmlToText(body) : body, MAX_CHARS)}`;
          }
        }
        if (type && !/^(text\/|application\/(json|xml|xhtml|javascript|rss|atom))/i.test(type)) {
          return `HTTP ${status}. Content type ${type} is not text; download it with curl in the shell instead.`;
        }
        const text = /html/i.test(type) ? htmlToText(body) : body;
        return `HTTP ${status} ${finalUrl}\n\n${clip(text, MAX_CHARS)}`;
      },
    }),
    ...(search
      ? {
          web_search: tool({
            description:
              'Search the web. Returns the best-matching pages, each with its title, link, date and the ' +
              'passages that match. The right first step when you do not know which page holds the ' +
              'answer — news, facts, products, places, people, prices, documentation. Then read a ' +
              'promising result in full with web_fetch, or open it in the browser to act on it.',
            inputSchema: z.object({
              query: z
                .string()
                .trim()
                .min(1)
                .max(500)
                .describe('What to find, written as a description of the page you want, e.g. "ferry timetable Singapore to Batam".'),
              max_results: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many results, 1–${MAX_RESULTS}. Default ${options.defaultResults}.`),
              site: z.string().trim().optional().describe('Only results from this site, e.g. "reddit.com".'),
              since: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, 'Write the date as YYYY-MM-DD')
                .optional()
                .describe('Only pages published on or after this date, YYYY-MM-DD. For news and recent events.'),
            }),
            execute: async ({ query, max_results, site, since }, { abortSignal }) => {
              const domain = site?.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || undefined;
              let hits: SearchHit[];
              try {
                hits = await search.search(
                  { query, maxResults: max_results ?? options.defaultResults, domain, since },
                  abortSignal,
                );
              } catch (err) {
                if (abortSignal?.aborted) throw err;
                throw new Error(
                  `Web search failed: ${(err as Error).message}. Read a site you know with web_fetch, or search in the browser.`,
                );
              }
              return formatHits(query, hits);
            },
          }),
        }
      : {}),
  };
}
