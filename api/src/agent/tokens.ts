/**
 * Sunnie talks to arbitrary models, so there is no tokenizer to call. This estimate errs high
 * for English prose (~4 chars/token) to keep compaction on the safe side, and is corrected by
 * provider-reported usage whenever a model call has happened (see estimateContextTokens).
 */
const CHARS_PER_TOKEN = 3.5;
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: { content: unknown }): number {
  if (typeof message.content === 'string') return estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;
  if (!Array.isArray(message.content)) return estimateTokens(JSON.stringify(message.content)) + PER_MESSAGE_OVERHEAD;
  return message.content.reduce((sum, part: unknown) => sum + estimatePartTokens(part), PER_MESSAGE_OVERHEAD);
}

function estimatePartTokens(part: unknown): number {
  if (!part || typeof part !== 'object') return estimateTokens(JSON.stringify(part));
  const value = part as Record<string, unknown>;
  // A tool result that shows the model a picture (`view_image`): the picture's reserve, not its bytes.
  if (value.type === 'tool-result' && value.output && typeof value.output === 'object') {
    const output = value.output as Record<string, unknown>;
    if (output.type === 'content' && Array.isArray(output.value)) {
      return output.value.reduce((sum: number, inner: unknown) => sum + estimatePartTokens(inner), 0);
    }
  }
  if (value.type !== 'file' && value.type !== 'image') return estimateTokens(JSON.stringify(part));
  let data = value.data ?? value.image;
  if (data && typeof data === 'object' && 'type' in data) {
    const tagged = data as Record<string, unknown>;
    if (tagged.type === 'text') return estimateTokens(String(tagged.text ?? ''));
    data = tagged.data;
  }
  // Base64 is transport, not text tokens. Images use a reserve; PDFs also scale by file size.
  // Neither replaces the provider's count: page content and image resolution vary by model.
  if (value.type === 'image' || String(value.mediaType ?? '').startsWith('image')) return 4096;
  const bytes = typeof data === 'string' ? Math.ceil(data.length * 0.75) : data instanceof Uint8Array ? data.byteLength : 0;
  return Math.max(4096, Math.ceil(bytes / 64));
}
