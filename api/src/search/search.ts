/**
 * A web search service that the server calls on the agent's behalf. Unlike everything else the
 * agent does, these calls leave from the server process rather than through `Computer.exec`: the
 * service's key is a server secret (invariant 3), and the server only ever talks to the service's
 * own endpoint, so the agent gains no way to reach anything else through it.
 */
export interface WebSearch {
  /** The service's name, as the model is told when a page was read through it. */
  readonly name: string;
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
  /** Reads a public page through the service's own crawler. Throws when it cannot. */
  read(url: string, maxChars: number, signal?: AbortSignal): Promise<PageText>;
}

export interface SearchQuery {
  query: string;
  maxResults: number;
  /** Only results from this site. */
  domain?: string;
  /** Only pages published on or after this date (YYYY-MM-DD). */
  since?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  /** YYYY-MM-DD, when the service knows it. */
  published?: string;
  /** The passages that answer the query. */
  text: string;
}

export interface PageText {
  url: string;
  title?: string;
  text: string;
}
