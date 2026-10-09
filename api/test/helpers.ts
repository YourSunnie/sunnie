import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createSunnie, type Sunnie, type SunnieOverrides } from '../src/app.ts';
import type { AgentEvent } from '../src/agent/events.ts';
import { parseConfig, type Config } from '../src/config.ts';
import type { ModelRegistry, ResolvedModel } from '../src/models/registry.ts';

export const TEST_API_KEY = 'test-key';

export function testConfig(raw: Record<string, unknown> = {}): Config {
  const home = mkdtempSync(join(tmpdir(), 'sunnie-test-'));
  // Tests must never reach the real routing service, even if its key is in the environment.
  const memory = (raw.memory ?? {}) as Record<string, unknown>;
  return parseConfig(
    {
      logLevel: 'silent',
      router: { type: 'none' },
      approvals: { type: 'none' },
      // Nor the real search service; search tests inject a fake.
      search: { type: 'none' },
      // No windows on the desk of whoever runs the tests.
      browser: { headless: true },
      ...raw,
      // Nor an embedding provider; semantic recall tests inject a fake embedder.
      memory: { ...memory, recall: { type: 'none', ...(memory.recall as object | undefined) }, embedding: { model: 'none', ...(memory.embedding as object | undefined) } },
    },
    { home, apiKey: TEST_API_KEY },
  );
}

/** A Sunnie instance on an in-memory database with a throwaway workspace. */
export function testSunnie(raw: Record<string, unknown> = {}, overrides: SunnieOverrides = {}): Sunnie {
  return createSunnie(testConfig(raw), { dbPath: ':memory:', ...overrides });
}

export function registryOf(
  model: LanguageModel,
  contextWindow = 128_000,
  byHint = false,
  extras: Partial<Pick<ResolvedModel, 'cacheMarks' | 'systemNotes' | 'providerTools' | 'verdicts'>> = {},
): ModelRegistry {
  const steer = { byHint };
  return {
    defaultSpec: 'mock/model',
    resolve: (spec) => ({
      spec: spec || 'mock/model',
      providerId: 'mock',
      modelId: 'model',
      model,
      contextWindow,
      maxOutputTokens: undefined,
      ...extras,
      callOptions: () => ({}),
      steer,
    }),
    embedder: () => { throw new Error('the mock registry has no embedding models'); },
    listProviders: () => [{ id: 'mock', type: 'mock', configured: true }],
    listModels: () => [{ spec: 'mock/model', contextWindow, isDefault: true }],
  };
}

const usage = (input = 10, output = 5) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/** A streamed model step that answers with text. */
export function textStep(text: string, inputTokens = 10): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 't1' },
        ...text.match(/.{1,8}/gs)!.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(inputTokens) },
      ],
    }),
  };
}

/** A streamed model step that asks for one tool call. */
export function toolStep(toolName: string, input: unknown, toolCallId = 'call-1'): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usage() },
      ],
    }),
  };
}

export function generated(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: usage(),
    warnings: [],
  };
}

/** Collects the events of one turn run directly against the agent (no HTTP). */
export function eventSink(): { events: AgentEvent[]; emit: (e: AgentEvent) => void; types: () => string[] } {
  const events: AgentEvent[] = [];
  return { events, emit: (e) => events.push(e), types: () => events.map((e) => e.type) };
}

/** The prompt of a recorded mock call, flattened to a string for assertions. */
export function promptText(call: unknown): string {
  return JSON.stringify((call as { prompt: unknown }).prompt);
}
