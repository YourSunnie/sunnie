import { MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentStore } from '../store/attachments.ts';
import { MAX_QUOTES, MAX_QUOTED_CHARS } from '../store/quotes.ts';
import type { Steer } from '../store/runs.ts';

export function steerAttachmentIds(steers: Steer[]): string[] {
  return [...new Set(steers.flatMap((steer) => steer.attachmentIds))];
}

/** Several valid sends can exceed one message's file or quote budget; leave the rest queued. */
export function steerBatch(pending: Steer[], attachments: AttachmentStore): Steer[] {
  const batch: Steer[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  const quoteIds = new Set<string>();
  let quoteCount = 0;
  let quoteChars = 0;
  for (const steer of pending) {
    const quotes = steer.quotes ?? [];
    const chars = quotes.reduce((n, q) => n + q.text.length, 0);
    if (batch.length && (quoteCount + quotes.length > MAX_QUOTES || quoteChars + chars > MAX_QUOTED_CHARS || quotes.some((q) => quoteIds.has(q.id)))) break;
    const additions = attachments.resolve(steer.attachmentIds.filter((id) => !ids.has(id)));
    const addedBytes = additions.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
    if (batch.length && (ids.size + additions.length > MAX_MESSAGE_ATTACHMENTS || bytes + addedBytes > MAX_MESSAGE_ATTACHMENT_BYTES)) break;
    for (const attachment of additions) ids.add(attachment.id);
    bytes += addedBytes;
    batch.push(steer);
    for (const quote of quotes) quoteIds.add(quote.id);
    quoteCount += quotes.length;
    quoteChars += chars;
  }
  return batch;
}
