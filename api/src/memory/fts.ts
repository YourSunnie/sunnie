const STOPWORDS = new Set(
  `a an and are as at be but by can did do does for from had has have how i if in into is it its
   me my of on or our so that the their them then there these they this to was we were what when
   where which who why will with would you your about just like also could should please tell`.split(
    /\s+/,
  ),
);

const MAX_TERMS = 24;

/** The distinct searchable words of a text, in order of appearance. */
export function searchTerms(text: string, max = MAX_TERMS): string[] {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0];
    if (term.length < 2 || STOPWORDS.has(term)) continue;
    terms.add(term);
    if (terms.size >= max) break;
  }
  return [...terms];
}

/**
 * Turns free text into a safe FTS5 MATCH expression: distinct, quoted terms OR-ed together,
 * leaving relevance to BM25. Returns null when the text has no searchable terms.
 */
export function toFtsQuery(text: string): string | null {
  const terms = searchTerms(text);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}
