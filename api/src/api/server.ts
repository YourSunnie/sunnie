import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AGENT_NAME, reasoningSchema } from '../config.ts';
import { compactConversation, contextBudget, estimateContextTokens } from '../agent/compaction.ts';
import { toMessageDto } from '../agent/events.ts';
import { buildInstructions } from '../agent/prompt.ts';
import { toRunDto, type Run, type RunManager } from '../agent/runs.ts';
import { heartbeatMinutes, helperLimit, type AgentDeps } from '../agent/agent.ts';
import { finishIntroduction, greetingPending, introducing, startGreeting } from '../agent/greeting.ts';
import { startBrief, startResize } from '../agent/heartbeat.ts';
import type { HomeWidget } from '../home/home-store.ts';
import { WidgetNotFound } from '../home/home-store.ts';
import { CardNotFound } from '../home/card-store.ts';
import { cardBody, pinnable } from '../home/cards.ts';
import { NODE_TYPES, widgetAction } from '../home/widgets.ts';
import { PHONE_SOURCES, phoneSnapshot } from '../phone/phone-store.ts';
import { LoginError, toLoginDto } from '../logins/login-store.ts';
import { CORE_BLOCKS, isCoreBlock } from '../memory/core-memory.ts';
import { quotesSchema, type MessageQuote } from '../store/quotes.ts';
import { MEMORY_KINDS } from '../memory/memory-store.ts';
import type { Conversation } from '../store/conversations.ts';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_PREVIEW_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES } from '../store/attachments.ts';
import { TASK_STATUSES } from '../tasks/task-store.ts';
import { PUSH_ENVIRONMENTS, type DeviceStore } from '../push/devices.ts';
import type { Notifier } from '../push/notifier.ts';
import { HttpError, badRequest, conflict, notFound } from '../util/errors.ts';
import { errorMessage } from '../util/log.ts';
import { knownTimeZone } from '../util/time.ts';
import { skillRepository } from '../../skills/protocol.ts';
import type { Screen } from '../../browser/protocol.ts';
import { attachmentDrivePath, MAX_DRIVE_FILE_BYTES, MAX_DRIVE_TEXT_BYTES, type DriveEntry } from '../drive/protocol.ts';

export const VERSION = '0.1.0';

/** Interval between SSE comments that keep idle connections open through proxies. */
const SSE_PING_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PHONE_BYTES = 8 * 1024 * 1024;

const intParam = z.coerce.number().int().min(0).optional();

/** An APNs device token as the app hex-encodes it. */
const deviceToken = z.string().regex(/^[0-9a-f]{64,200}$/, 'A device token is 64 or more lowercase hex characters');

const loginFields = {
  name: z.string().trim().max(100).optional(),
  username: z.string().max(500).optional(),
  password: z.string().max(2000).optional(),
  totpSecret: z.string().max(2000).optional(),
};

const messageFields = {
  quotes: quotesSchema.default([]),
  text: z.string().trim().max(100_000).default(''),
  attachmentIds: z.array(z.string().min(1).max(200)).max(MAX_MESSAGE_ATTACHMENTS).default([]),
};
const hasMessage = (input: { text: string; attachmentIds: string[]; quotes: MessageQuote[] }) => input.text.length > 0 || input.attachmentIds.length > 0 || input.quotes.length > 0;

const schemas = {
  createConversation: z.object({ title: z.string().max(200).nullish(), model: z.string().nullish() }),
  updateConversation: z.object({ title: z.string().max(200).nullish(), model: z.string().nullish() }),
  sendMessage: z.object({
    ...messageFields,
    model: z.string().optional(),
    timezone: z.string().optional(),
    /** The client's id for this send; repeating it returns the run the first one started. */
    requestId: z.string().min(1).max(200).optional(),
    /** false waits for the whole turn and answers with JSON instead of an event stream. */
    stream: z.boolean().default(true),
    /** With stream:false, false acknowledges the accepted run without waiting for its answer. */
    wait: z.boolean().default(true),
  }).refine(hasMessage, { message: 'A message needs text, an attachment or a quote' })
    .refine((input) => input.wait || !input.stream, { message: 'wait:false requires stream:false' }),
  createMemory: z.object({ content: z.string().trim().min(1).max(2000), kind: z.enum(MEMORY_KINDS).optional() }),
  updateMemory: z.object({ content: z.string().trim().min(1).max(2000).optional(), kind: z.enum(MEMORY_KINDS).optional() }),
  resolveApproval: z.object({ approved: z.boolean() }),
  /** The size of the user's screen, so the page can be laid out for it; both or neither. */
  handoffViewport: z.union([
    z.object({ width: z.coerce.number().min(100).max(10_000), height: z.coerce.number().min(100).max(10_000) }),
    z.object({ width: z.undefined(), height: z.undefined() }),
  ]),
  endHandoff: z.object({ outcome: z.enum(['done', 'declined']).default('done'), note: z.string().trim().max(500).optional() }),
  handoffInput: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tap'), x: z.number().min(0).max(20_000), y: z.number().min(0).max(20_000) }),
    z.object({
      kind: z.literal('scroll'),
      x: z.number().min(0).max(20_000),
      y: z.number().min(0).max(20_000),
      dx: z.number().min(-20_000).max(20_000),
      dy: z.number().min(-20_000).max(20_000),
    }),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(4000), secret: z.boolean().optional() }),
    z.object({ kind: z.literal('key'), key: z.string().trim().min(1).max(40) }),
  ]),
  registerDevice: z.object({ token: deviceToken, environment: z.enum(PUSH_ENVIRONMENTS) }),
  steer: z.object({
    ...messageFields,
    timezone: z.string().optional(),
    requestId: z.string().min(1).max(200).optional(),
  }).refine(hasMessage, { message: 'A message needs text, an attachment or a quote' }),
  setCoreMemory: z.object({ content: z.string() }),
  createLogin: z.object({ site: z.string().trim().min(1).max(255), ...loginFields }),
  updateLogin: z.object({ site: z.string().trim().min(1).max(255).optional(), ...loginFields }),
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(z.prettifyError(result.error));
  return result.data;
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(deps: AgentDeps, runs: RunManager, push: { devices: DeviceStore; notifier: Notifier }): Hono {
  const { config, conversations, attachments, memory, core, logins, tasks, models, computer } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    deps.log.error('unhandled error', { path: c.req.path, error: errorMessage(err) });
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

  app.get('/health', (c) => c.json({ ok: true, name: AGENT_NAME, version: VERSION }));

  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !tokenMatches(token, config.apiKey)) {
      throw new HttpError(401, 'unauthorized', 'Missing or invalid bearer token');
    }
    await next();
  });
  app.use(
    '/v1/*',
    async (c, next) => {
      const previewUpload = c.req.method === 'PUT' && /^\/v1\/attachments\/[^/]+\/preview$/.test(c.req.path);
      const maxSize = previewUpload ? MAX_ATTACHMENT_PREVIEW_BYTES
        : c.req.method === 'POST' && c.req.path === '/v1/drive/content' ? MAX_DRIVE_FILE_BYTES
        : c.req.method === 'PUT' && c.req.path === '/v1/drive/text' ? MAX_DRIVE_TEXT_BYTES * 6 + 8192
        : c.req.method === 'POST' && c.req.path === '/v1/attachments' ? MAX_ATTACHMENT_BYTES
        // A quarter of every Health type, a day at a time, is more than a megabyte.
        : c.req.method === 'PUT' && c.req.path.startsWith('/v1/phone/') ? MAX_PHONE_BYTES : MAX_BODY_BYTES;
      return bodyLimit({
        maxSize,
        onError: () => { throw new HttpError(413, 'payload_too_large', `Request body is larger than ${maxSize} bytes`); },
      })(c, next);
    },
  );

  const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => ({}));
  const requireConversation = (id: string): Conversation => {
    const conversation = conversations.get(id);
    if (!conversation) throw notFound('Conversation');
    return conversation;
  };
  /** A helper's transcript can be read, and goes when its parent is deleted; nothing else is done to it. */
  const requireOwn = (id: string): Conversation => {
    const conversation = requireConversation(id);
    if (conversation.kind === 'subagent') throw badRequest("This is a helper's transcript; it is read-only");
    return conversation;
  };
  const conversationDto = (c: Conversation) => ({
    id: c.id,
    kind: c.kind,
    parentId: c.parentId,
    title: c.title,
    model: c.model,
    reasoning: c.reasoning ?? null,
    hasSummary: c.summary !== null,
    activeRunId: runs.activeFor(c.id)?.id ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });

  // ── Instance ────────────────────────────────────────────────────────────────────────────

  const modelDefaults = () => conversations.modelDefaults() ?? {
    model: models.defaultSpec,
    reasoning: config.models[models.defaultSpec]?.reasoning ?? config.agent.reasoning,
  };
  app.get('/v1/info', (c) =>
    c.json({
      name: AGENT_NAME,
      version: VERSION,
      defaultModel: models.defaultSpec,
      modelSettings: { enabled: true },
      newChatDefaults: modelDefaults(),
      models: models.listModels(),
      providers: models.listProviders(),
      router: { type: deps.router.name, mode: config.router.mode },
      approvals: { type: deps.risk.name },
      computer: computer.describe(),
      browser: { enabled: config.browser.enabled, handoff: config.browser.enabled },
      skills: { enabled: config.skills.enabled },
      drive: { enabled: true, maxFileBytes: MAX_DRIVE_FILE_BYTES, maxTextBytes: MAX_DRIVE_TEXT_BYTES },
      quoting: { enabled: true },
      push: { enabled: push.notifier.enabled },
      phone: { enabled: true, sources: PHONE_SOURCES },
      home: { enabled: true, brief: config.heartbeat.enabled && config.heartbeat.brief, briefHour: config.heartbeat.briefHour, widgetTypes: NODE_TYPES },
      interests: { enabled: config.heartbeat.enabled },
      heartbeat: { enabled: config.heartbeat.enabled, intervalMinutes: config.heartbeat.intervalMinutes },
      subagents: { enabled: config.subagents.enabled, maxTasks: config.subagents.maxTasks, concurrency: config.subagents.concurrency },
      memoryCount: memory.count(),
      greeting: { pending: greetingPending(deps, runs), introducing: introducing(deps) },
      attachments: { maxFileBytes: MAX_ATTACHMENT_BYTES, maxPerMessage: MAX_MESSAGE_ATTACHMENTS, maxMessageBytes: MAX_MESSAGE_ATTACHMENT_BYTES },
      usage: { enabled: Boolean(config.usage.url) },
    }),
  );

  // The allowance the hosting service gives this instance, as the service reports it. The server
  // asks on the app's behalf: the service and its token stay out of the app (invariant 3 applies
  // to the agent, but the gateway token is a server secret all the same).
  app.get('/v1/usage', async (c) => {
    const { url, apiKeyEnv, apiKey, timeoutMs } = config.usage;
    if (!url) throw notFound('A usage allowance');
    const token = apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined);
    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HttpError(502, 'usage_unavailable', `The usage service could not be reached (${errorMessage(err)}).`);
    }
    if (!res.ok) throw new HttpError(502, 'usage_unavailable', `The usage service answered HTTP ${res.status}.`);
    const body = parse(z.object({
      used: z.number().min(0),
      limit: z.number().min(0),
      resetsAt: z.string().optional(),
    }), await res.json().catch(() => undefined));
    const percent = body.limit > 0 ? Math.min(100, Math.round((body.used / body.limit) * 1000) / 10) : 100;
    return c.json({ used: body.used, limit: body.limit, percent, ...(body.resetsAt ? { resetsAt: body.resetsAt } : {}) });
  });

  app.get('/v1/settings/model', (c) => c.json(modelDefaults()));
  app.patch('/v1/settings/model', async (c) => {
    const input = parse(z.object({
      model: z.string().trim().min(1).max(300).regex(/^\S+\/\S+$/),
      reasoning: reasoningSchema,
    }).strict(), await body(c));
    models.resolve(input.model, input.reasoning);
    conversations.setModelDefaults(input);
    return c.json(modelDefaults());
  });

  app.get('/v1/skills', async (c) => {
    const sources = deps.skillSources.list();
    if (!config.skills.enabled) return c.json({ skills: [], warnings: [], sources });
    try { return c.json({ ...await deps.skills.catalog(c.req.raw.signal), sources }); }
    catch { throw new HttpError(502, 'skills_unavailable', 'The skill catalog could not be read. Try again or check the skills client.'); }
  });

  // Only the skills shipped with Sunnie can be turned on and off; they start off.
  app.patch('/v1/skills/:name', async (c) => {
    const input = parse(z.object({ enabled: z.boolean() }).strict(), await body(c));
    const name = c.req.param('name');
    let catalog: Awaited<ReturnType<typeof deps.skills.catalog>>;
    try { catalog = await deps.skills.catalog(c.req.raw.signal); }
    catch { throw new HttpError(502, 'skills_unavailable', 'The skill catalog could not be read. Try again or check the skills client.'); }
    const skill = catalog.skills.find((s) => s.name === name && s.bundled);
    if (!skill) throw notFound('Skill');
    deps.skills.setEnabled(name, input.enabled);
    return c.json({ ...skill, enabled: input.enabled });
  });

  app.delete('/v1/skills/sources', (c) => {
    let repository: string;
    try { repository = skillRepository(c.req.query('repository') ?? ''); }
    catch { throw badRequest('Give the HTTPS repository URL in the repository query parameter.'); }
    deps.skillSources.revoke(repository);
    return c.json({ ok: true });
  });

  // ── Attachments ─────────────────────────────────────────────────────────────────────────

  app.post('/v1/attachments', async (c) => {
    const header = c.req.header('x-filename');
    if (!header) throw badRequest('X-Filename is required (percent-encoded UTF-8)');
    let filename: string;
    try {
      filename = decodeURIComponent(header);
    } catch {
      throw badRequest('X-Filename must be valid percent-encoded UTF-8');
    }
    const result = attachments.create({
      filename,
      mediaType: c.req.header('content-type') ?? 'application/octet-stream',
      data: new Uint8Array(await c.req.arrayBuffer()),
      requestId: c.req.header('x-request-id'),
    });
    if (!result.attachment.drivePath) {
      const path = attachmentDrivePath(result.attachment);
      await deps.drive.request({ action: 'import', path, data: Buffer.from(attachments.getBytes(result.attachment.id)!).toString('base64') });
      attachments.markDriveCopy(result.attachment.id, path);
    }
    c.header('Cache-Control', 'no-store');
    return c.json(attachments.get(result.attachment.id)!, result.created ? 201 : 200);
  });

  app.get('/v1/attachments/:id', (c) => {
    const attachment = attachments.get(c.req.param('id'));
    if (!attachment) throw notFound('Attachment');
    c.header('Cache-Control', 'no-store');
    return c.json(attachment);
  });

  app.put('/v1/attachments/:id/preview', async (c) => {
    const result = attachments.createPreview(c.req.param('id'), {
      mediaType: c.req.header('content-type') ?? '',
      data: new Uint8Array(await c.req.arrayBuffer()),
    });
    c.header('Cache-Control', 'no-store');
    return c.body(null, result.created ? 201 : 200);
  });

  app.get('/v1/attachments/:id/content', (c) => {
    const attachment = attachments.get(c.req.param('id'));
    const bytes = attachment && attachments.getBytes(attachment.id);
    if (!attachment || !bytes) throw notFound('Attachment');
    const filename = encodeURIComponent(attachment.filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': attachment.mediaType,
      'Content-Length': String(attachment.sizeBytes),
      'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${filename}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
  });

  // ── Drive ───────────────────────────────────────────────────────────────────────────────

  const drivePath = z.string().max(4096);
  const driveRevision = z.string().regex(/^[a-f0-9]{64}$/);
  app.use('/v1/drive/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/v1/drive/entries', async (c) => c.json(await deps.drive.list(
    parse(drivePath, c.req.query('path') ?? ''),
    parse(z.coerce.number().int().min(0).max(10000).default(0), c.req.query('offset')),
  )));
  app.get('/v1/drive/entry', async (c) => c.json(await deps.drive.stat(parse(drivePath, c.req.query('path') ?? ''))));
  app.get('/v1/drive/text', async (c) => c.json(await deps.drive.text(parse(drivePath, c.req.query('path')))));
  app.get('/v1/drive/content', async (c) => {
    const expected = c.req.query('revision');
    if (expected !== undefined) parse(driveRevision, expected);
    const { entry, data } = await deps.drive.read(parse(drivePath, c.req.query('path')));
    if (expected !== undefined && entry.revision !== expected) throw conflict('This file changed. Open it again.');
    const filename = encodeURIComponent(entry.name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return c.body(new Uint8Array(Buffer.from(data, 'base64')), 200, {
      'X-Drive-Revision': entry.revision,
      'Content-Type': entry.mediaType,
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
  });
  app.post('/v1/drive/content', async (c) => {
    const path = parse(drivePath, c.req.query('path'));
    const data = Buffer.from(await c.req.arrayBuffer()).toString('base64');
    return c.json(await deps.drive.request<DriveEntry>({ action: 'upload', path, data }), 201);
  });
  app.post('/v1/drive/folders', async (c) => {
    const { path } = parse(z.object({ path: drivePath }), await body(c));
    return c.json(await deps.drive.request<DriveEntry>({ action: 'mkdir', path }), 201);
  });
  app.put('/v1/drive/text', async (c) => {
    const input = parse(z.object({ path: drivePath, text: z.string().max(MAX_DRIVE_TEXT_BYTES), revision: driveRevision }), await body(c));
    return c.json(await deps.drive.request<DriveEntry>({ action: 'write', ...input }));
  });
  app.patch('/v1/drive/entry', async (c) => {
    const input = parse(z.object({ path: drivePath, destination: drivePath, revision: driveRevision }), await body(c));
    return c.json(await deps.drive.request<{ path: string }>({ action: 'move', ...input }));
  });
  app.delete('/v1/drive/entry', async (c) => {
    const path = parse(drivePath, c.req.query('path'));
    const revision = parse(driveRevision, c.req.query('revision'));
    await deps.drive.request({ action: 'delete', path, revision });
    return c.body(null, 204);
  });

  // ── Conversations ───────────────────────────────────────────────────────────────────────

  app.post('/v1/conversations', async (c) => {
    const input = parse(schemas.createConversation, await body(c));
    if (input.model) models.resolve(input.model);
    const defaults = modelDefaults();
    const model = input.model || defaults.model;
    const reasoning = input.model ? (config.models[model]?.reasoning ?? config.agent.reasoning) : defaults.reasoning;
    return c.json(conversationDto(conversations.create({ ...input, model, reasoning })), 201);
  });

  /** A new user's first chat, in which the agent speaks first. Once only: `409` after that. */
  app.post('/v1/greeting', async (c) => {
    const input = parse(z.object({ timezone: z.string().optional() }), await body(c));
    deps.home.setTimeZone(input.timezone);
    const { conversationId, run } = startGreeting(deps, runs, { timeZone: input.timezone });
    return c.json({ conversation: conversationDto(conversations.get(conversationId)!), run: toRunDto(run) }, 202);
  });

  /** Ends the introduction early: the user skipped it. */
  app.post('/v1/greeting/done', (c) => {
    finishIntroduction(deps);
    return c.body(null, 204);
  });

  app.get('/v1/conversations', (c) => {
    const limit = parse(intParam, c.req.query('limit'));
    const list = conversations.list({ limit, before: c.req.query('before') });
    return c.json({ conversations: list.map(conversationDto) });
  });

  app.get('/v1/conversations/:id', (c) => c.json(conversationDto(requireConversation(c.req.param('id')))));

  app.patch('/v1/conversations/:id', async (c) => {
    const input = parse(schemas.updateConversation, await body(c));
    if (input.model) models.resolve(input.model);
    const updated = conversations.update(requireOwn(c.req.param('id')).id, input);
    return c.json(conversationDto(updated!));
  });

  app.delete('/v1/conversations/:id', (c) => {
    const conversation = requireOwn(c.req.param('id'));
    if (runs.activeFor(conversation.id)) throw conflict('Cancel the active run before deleting');
    conversations.delete(conversation.id);
    return c.body(null, 204);
  });

  // What the user set in the interactive cards of this conversation's replies.
  app.get('/v1/conversations/:id/cards', (c) => {
    const conversation = requireConversation(c.req.param('id'));
    return c.json({ cards: deps.cards.list(conversation.id) });
  });

  app.put('/v1/messages/:id/cards/:card', async (c) => {
    const input = parse(z.object({ state: z.record(z.string(), z.unknown()) }).strict(), await body(c));
    const card = Number(c.req.param('card'));
    if (!Number.isInteger(card) || card < 0 || card > 50) throw badRequest('The card is its place in the message, from 0.');
    try { return c.json(deps.cards.set(c.req.param('id'), card, input.state)); }
    catch (err) {
      if (err instanceof CardNotFound) throw notFound('Card');
      throw badRequest(errorMessage(err));
    }
  });

  app.get('/v1/conversations/:id/messages', (c) => {
    const conversation = requireConversation(c.req.param('id'));
    const hideQuiet = parse(z.enum(['show', 'hide']).default('show'), c.req.query('quiet')) === 'hide';
    const messages = conversations.listMessages(conversation.id, {
      afterSeq: parse(intParam, c.req.query('after_seq')),
      beforeSeq: parse(intParam, c.req.query('before_seq')),
      limit: parse(intParam, c.req.query('limit')),
      hideQuiet: hideQuiet ? { activeRunId: runs.activeFor(conversation.id)?.id ?? null } : undefined,
    });
    return c.json({ messages: messages.map(toMessageDto) });
  });

  /** Streams a run's events as SSE, starting after `afterSeq`. Disconnecting does not stop the run. */
  const streamRun = (c: Parameters<typeof streamSSE>[0], run: Run, afterSeq: number) =>
    streamSSE(c, async (stream) => {
      const disconnected = new AbortController();
      stream.onAbort(() => disconnected.abort());
      const ping = setInterval(() => void stream.write(': ping\n\n').catch(() => {}), SSE_PING_MS);
      try {
        for await (const event of runs.subscribe(run.id, afterSeq, disconnected.signal)) {
          await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
        }
      } finally {
        clearInterval(ping);
      }
    });

  app.get('/v1/conversations/:id/helpers', (c) => {
    const conversation = requireConversation(c.req.param('id'));
    return c.json({ helpers: conversations.children(conversation.id).map(conversationDto) });
  });

  app.post('/v1/conversations/:id/messages', async (c) => {
    const conversation = requireOwn(c.req.param('id'));
    const input = parse(schemas.sendMessage, await body(c));
    deps.home.setTimeZone(input.timezone);
    const run = runs.start({
      conversationId: conversation.id,
      text: input.text,
      attachmentIds: input.attachmentIds,
      quotes: input.quotes,
      model: input.model,
      timeZone: input.timezone,
      requestId: input.requestId,
    });
    if (input.stream) return streamRun(c, run, 0);
    if (!input.wait) return c.json({ run: toRunDto(run), messages: [] }, 202);

    await run.done;
    return c.json({
      run: toRunDto(run),
      messages: conversations.messagesForRun(run.id).map(toMessageDto),
    });
  });

  app.post('/v1/conversations/:id/compact', async (c) => {
    const { id } = requireOwn(c.req.param('id'));
    const outcome = await runs.exclusive(id, async () => {
      const conversation = requireConversation(id);
      const model = models.resolve(conversation.model, conversation.reasoning);
      const instructions = buildInstructions({
        name: AGENT_NAME,
        computer,
        browser: config.browser.enabled,
        skills: config.skills.enabled,
        heartbeatMinutes: heartbeatMinutes(config),
        maxAttempts: config.agent.maxAttempts,
        maxSteps: config.agent.maxSteps,
        helpers: helperLimit(config),
        blocks: conversation.coreSnapshot ?? core.all(),
      });
      const contextTokens = estimateContextTokens(conversation, conversations.liveMessages(conversation), instructions);
      const result = await compactConversation(deps, conversation, model, { contextTokens }).catch((err) => {
        // The summariser is an upstream model; say what it said rather than a bare 500.
        throw new HttpError(502, 'upstream_error', errorMessage(err));
      });
      return { result, contextTokens, budget: contextBudget(config, model) };
    });
    return c.json({
      compacted: outcome.result !== null,
      summarizedMessages: outcome.result?.summarizedMessages ?? 0,
      memoriesSaved: outcome.result?.memoriesSaved ?? 0,
      contextTokensBefore: outcome.contextTokens,
      contextBudget: outcome.budget,
    });
  });

  // ── Runs ────────────────────────────────────────────────────────────────────────────────

  const requireRun = (id: string): Run => {
    const run = runs.get(id);
    if (!run) throw notFound('Run');
    return run;
  };

  app.get('/v1/runs/:id', (c) => c.json(toRunDto(requireRun(c.req.param('id')))));

  app.get('/v1/runs/:id/events', (c) => {
    const run = requireRun(c.req.param('id'));
    const after = parse(intParam, c.req.query('after') ?? c.req.header('last-event-id'));
    return streamRun(c, run, after ?? 0);
  });

  app.post('/v1/runs/:id/cancel', (c) => {
    const run = requireRun(c.req.param('id'));
    runs.cancel(run.id);
    return c.json(toRunDto(run));
  });

  app.post('/v1/runs/:id/messages', async (c) => {
    const run = requireRun(c.req.param('id'));
    const input = parse(schemas.steer, await body(c));
    const accepted = runs.steer(run.id, { text: input.text, quotes: input.quotes, attachmentIds: input.attachmentIds, timeZone: input.timezone, requestId: input.requestId });
    return c.json(toRunDto(accepted), 202);
  });

  app.post('/v1/runs/:id/approvals/:toolCallId', async (c) => {
    const run = requireRun(c.req.param('id'));
    const { approved } = parse(schemas.resolveApproval, await body(c));
    if (!runs.resolveApproval(run.id, c.req.param('toolCallId'), approved)) throw notFound('Pending approval');
    return c.json(toRunDto(run));
  });

  // ── Browser hand-off ────────────────────────────────────────────────────────────────────
  // The user takes the agent's browser over for a moment (a CAPTCHA, a sign-in) and hands it back.

  app.get('/v1/browser/handoff', (c) => c.json({ handoff: deps.handoff.state }));

  /** Takes the browser: the agent's pending request, or a hand-off of the user's own. */
  app.post('/v1/browser/handoff', (c) => c.json({ handoff: deps.handoff.take() }));

  /** A picture of the page, with where it is in the headers (percent-encoded: titles are not ASCII). */
  const screenResponse = (c: { body: (data: Uint8Array, status: 200, headers: Record<string, string>) => Response }, screen: Screen) =>
    c.body(new Uint8Array(Buffer.from(screen.image, 'base64')), 200, {
      'Content-Type': 'image/jpeg',
      'X-Screen-Width': String(screen.width),
      'X-Screen-Height': String(screen.height),
      'X-Page-Url': encodeURIComponent(screen.url),
      'X-Page-Title': encodeURIComponent(screen.title),
      // The field the page has the focus on, so the app can bring up its keyboard for it.
      ...(screen.focus ? { 'X-Focus-Secret': screen.focus.secret ? '1' : '0', 'X-Focus-Label': encodeURIComponent(screen.focus.label) } : {}),
      'Cache-Control': 'no-store',
    });
  /** A browser that cannot be pictured is the computer's trouble, not a bad request or a server bug. */
  const pictured = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'browser_unavailable', errorMessage(err));
    }
  };

  /** `?width=&height=`: the user's screen in points; the page is laid out for it while they hold it. */
  app.get('/v1/browser/handoff/screen', async (c) => {
    const size = parse(schemas.handoffViewport, { width: c.req.query('width'), height: c.req.query('height') });
    const viewport = size.width !== undefined ? { width: size.width, height: size.height } : undefined;
    return screenResponse(c, await pictured(deps.handoff.screen(c.req.raw.signal, viewport)));
  });

  /** The user's touch or typing on the page; answers with the page afterwards, like `screen`. */
  app.post('/v1/browser/handoff/input', async (c) => {
    const input = parse(schemas.handoffInput, await body(c));
    return screenResponse(c, await pictured(deps.handoff.input(input, c.req.raw.signal)));
  });

  /** Hands the browser back (`done`), or declines to take it (`declined`). `404` when there is no hand-off. */
  app.post('/v1/browser/handoff/end', async (c) => {
    const input = parse(schemas.endHandoff, await body(c));
    if (!deps.handoff.end(input)) throw notFound('Hand-off');
    return c.body(null, 204);
  });

  // ── Memory ──────────────────────────────────────────────────────────────────────────────

  app.get('/v1/memories', (c) => {
    const q = c.req.query('q');
    const limit = parse(intParam, c.req.query('limit'));
    const offset = parse(intParam, c.req.query('offset'));
    const memories = q ? memory.search(q, { limit }) : memory.list({ limit, offset });
    return c.json({ memories, total: memory.count() });
  });

  app.post('/v1/memories', async (c) => {
    const input = parse(schemas.createMemory, await body(c));
    const { memory: saved, created } = memory.add({ ...input, source: 'api' });
    return c.json(saved, created ? 201 : 200);
  });

  app.patch('/v1/memories/:id', async (c) => {
    const updated = memory.update(c.req.param('id'), parse(schemas.updateMemory, await body(c)));
    if (!updated) throw notFound('Memory');
    return c.json(updated);
  });

  app.delete('/v1/memories/:id', (c) => {
    deps.interests.muteForMemory(c.req.param('id'));
    if (!memory.delete(c.req.param('id'))) throw notFound('Memory');
    return c.body(null, 204);
  });

  app.get('/v1/core-memory', (c) => c.json({ blocks: core.all(), blockLimit: core.blockLimit }));

  app.put('/v1/core-memory/:block', async (c) => {
    const block = c.req.param('block');
    if (!isCoreBlock(block)) throw badRequest(`block must be one of: ${CORE_BLOCKS.join(', ')}`);
    const { content } = parse(schemas.setCoreMemory, await body(c));
    try {
      return c.json({ block, content: core.set(block, content) });
    } catch (err) {
      throw badRequest(errorMessage(err));
    }
  });

  // ── Tasks ───────────────────────────────────────────────────────────────────────────────
  // Read-only: the agent keeps its own follow-ups; ask it in chat to add, move or drop one.

  app.get('/v1/interests', (c) => c.json({
    ...deps.interests.preferences(), enabled: config.heartbeat.enabled,
    interests: deps.interests.list().map(({ seenUrls: _seen, lastReport: _report, ...interest }) => interest),
  }));

  app.patch('/v1/interests/settings', async (c) => {
    const input = parse(z.object({ paused: z.boolean() }), await body(c));
    deps.interests.pause(input.paused);
    return c.json(deps.interests.preferences());
  });

  app.patch('/v1/interests/:id', async (c) => {
    const input = parse(z.object({ status: z.enum(['active', 'muted']) }), await body(c));
    const interest = deps.interests.setStatus(c.req.param('id'), input.status);
    if (!interest) throw notFound('Interest');
    const { seenUrls: _seen, lastReport: _report, ...visible } = interest;
    return c.json(visible);
  });

  // ── Home ────────────────────────────────────────────────────────────────────────────────
  // What the app shows on its first screen: a list of widgets. Sunnie and programs write them
  // (the app's editor only arranges, hides and removes); the app has none of its own.

  /** The Check-ins conversation as the app's toolbar shows it: does it hold anything new? */
  const checkInStatus = () => {
    const conversation = conversations.findByKind('heartbeat');
    if (!conversation) return { conversationId: null, latestSeq: null, latestAt: null, running: false };
    const active = runs.activeFor(conversation.id);
    const [latest] = conversations.checkInNews(conversation.id, { limit: 1, activeRunId: active?.id ?? null });
    return {
      conversationId: conversation.id,
      latestSeq: latest?.message.seq ?? null,
      latestAt: latest?.message.createdAt ?? null,
      running: !!active,
    };
  };

  app.get('/v1/check-ins', (c) => c.json(checkInStatus()));

  app.get('/v1/home', (c) => {
    deps.home.setTimeZone(c.req.query('timezone'));
    const now = new Date();
    const state = deps.home.state();
    const zone = knownTimeZone(c.req.query('timezone') ?? state.timeZone);
    const checkIns = checkInStatus();
    const heartbeat = checkIns.conversationId ? conversations.get(checkIns.conversationId) : null;
    const activeRun = heartbeat ? runs.activeFor(heartbeat.id) : undefined;
    return c.json({
      timeZone: zone,
      widgets: withResizing(deps.home.widgets(now)),
      checkIns,
      brief: {
        enabled: config.heartbeat.enabled && config.heartbeat.brief,
        running: !!activeRun && activeRun.id === state.briefRunId,
        lastAt: state.lastBriefAt,
        hour: config.heartbeat.briefHour,
      },
    });
  });

  /** A widget whose resize run is still going is drawn as resizing. */
  const withResizing = (widgets: HomeWidget[]) => {
    const resizes = deps.home.resizeRuns();
    return widgets.map((w) => {
      const runId = resizes.get(w.id);
      return { ...w, resizing: !!runId && runs.get(runId)?.status === 'running' };
    });
  };

  /** The user picked a new width on Home: it applies at once, and Sunnie redesigns the widget for it. */
  app.post('/v1/home/widgets/:id/resize', async (c) => {
    const input = parse(z.object({ columns: z.number().int().min(1).max(4), timezone: z.string().optional() }), await body(c));
    deps.home.setTimeZone(input.timezone);
    const { widget, run } = startResize(deps, runs, { id: c.req.param('id'), columns: input.columns });
    return c.json({ widget: withResizing([widget])[0], run: toRunDto(run) }, 202);
  });

  app.post('/v1/home/brief', async (c) => {
    const input = parse(z.object({ timezone: z.string().optional() }), await body(c));
    deps.home.setTimeZone(input.timezone);
    return c.json({ run: toRunDto(startBrief(deps, runs, { fromApp: true })) }, 202);
  });

  /** The store explains itself in words meant for whoever wrote the widget; here they become a status. */
  const widgetCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof WidgetNotFound) throw notFound('Widget');
      if (err instanceof HttpError) throw err;
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  };

  app.put('/v1/home/widgets/:id', async (c) => {
    const input = parse(z.object({
      title: z.string().max(80).optional(),
      body: z.unknown(),
      action: widgetAction.nullish(),
      hours: z.number().positive().max(8760).optional(),
      before: z.string().max(40).optional(),
      columns: z.number().int().min(1).max(4).optional(),
    }), await body(c));
    return c.json(widgetCall(() => deps.home.set({ ...input, id: c.req.param('id'), source: 'api' })));
  });

  /** New data for a widget's keyed parts; its design stays. */
  app.patch('/v1/home/widgets/:id', async (c) => {
    const input = parse(z.object({
      values: z.record(z.string(), z.record(z.string(), z.unknown())),
      title: z.string().max(80).optional(),
      hours: z.number().positive().max(8760).optional(),
    }), await body(c));
    return c.json(widgetCall(() => deps.home.update({ ...input, id: c.req.param('id'), source: 'api' })));
  });

  /** A reply's card, as it stands, put on Home: it goes on working there, and Sunnie can keep it current. */
  app.post('/v1/home/widgets/from-card', async (c) => {
    const input = parse(z.object({ messageId: z.string().max(80), card: z.number().int().min(0).max(50), columns: z.number().int().min(1).max(4).optional() }), await body(c));
    const message = conversations.getMessage(input.messageId);
    const cardBodyNow = message?.role === 'assistant' ? cardBody(message.text, input.card) : null;
    if (!message || !cardBodyNow) throw notFound('Card');
    const saved = deps.cards.list(message.conversationId).find((s) => s.messageId === input.messageId && s.card === input.card)?.state ?? {};
    const { body: pinned, title } = pinnable(cardBodyNow, saved);
    const id = `card-${input.messageId.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}-${input.card}`;
    return c.json(widgetCall(() => deps.home.set({ id, title, body: pinned, columns: input.columns, source: 'agent' })), 201);
  });

  app.put('/v1/home/widgets/:id/state', async (c) => {
    const input = parse(z.object({ state: z.record(z.string(), z.unknown()) }).strict(), await body(c));
    return c.json(widgetCall(() => deps.home.setState(c.req.param('id'), input.state)));
  });

  app.delete('/v1/home/widgets/:id', (c) => {
    widgetCall(() => deps.home.remove(c.req.param('id')));
    return c.body(null, 204);
  });

  app.put('/v1/home/layout', async (c) => {
    const ids = z.array(z.string().max(40)).max(200);
    const input = parse(z.object({ order: ids.optional(), hidden: ids.optional() }), await body(c));
    return c.json({ widgets: deps.home.layout(input) });
  });

  // ── Phone data ──────────────────────────────────────────────────────────────────────────
  // The app sends a copy of what the user chose to share; turning a source off deletes it.

  const phoneSource = z.enum(PHONE_SOURCES);

  app.get('/v1/phone', (c) => c.json({ sources: deps.phone.list() }));

  app.put('/v1/phone/:source', async (c) => {
    const source = parse(phoneSource, c.req.param('source'));
    const input = parse(phoneSnapshot, await body(c));
    try {
      return c.json(deps.phone.put(source, input));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  app.delete('/v1/phone/:source', (c) => {
    deps.phone.remove(parse(phoneSource, c.req.param('source')));
    return c.body(null, 204);
  });

  // ── Notifications ───────────────────────────────────────────────────────────────────────
  // Devices are kept even while notifications are off, so they start arriving once APNs is set up.

  app.post('/v1/devices', async (c) => {
    const input = parse(schemas.registerDevice, await body(c));
    const device = push.devices.register(input.token, input.environment);
    return c.json({ token: device.token, environment: device.environment, pushEnabled: push.notifier.enabled });
  });

  app.delete('/v1/devices/:token', (c) => {
    push.devices.remove(parse(deviceToken, c.req.param('token')));
    return c.body(null, 204);
  });

  app.get('/v1/tasks', (c) => {
    const status = parse(z.enum(TASK_STATUSES).optional(), c.req.query('status'));
    return c.json({ tasks: tasks.list({ status, limit: parse(intParam, c.req.query('limit')) }) });
  });

  // ── Logins ──────────────────────────────────────────────────────────────────────────────
  // Write-only for secrets: a password or one-time-code secret goes in and never comes back out.

  const loginFailure = (err: unknown) => {
    if (err instanceof LoginError) return err.conflict ? conflict(err.message) : badRequest(err.message);
    return err;
  };

  app.get('/v1/logins', (c) => c.json({ logins: logins.list().map(toLoginDto) }));

  app.post('/v1/logins', async (c) => {
    const input = parse(schemas.createLogin, await body(c));
    try {
      return c.json(toLoginDto(logins.create(input)), 201);
    } catch (err) {
      throw loginFailure(err);
    }
  });

  app.patch('/v1/logins/:id', async (c) => {
    const input = parse(schemas.updateLogin, await body(c));
    try {
      const updated = logins.update(c.req.param('id'), input);
      if (!updated) throw notFound('Login');
      return c.json(toLoginDto(updated));
    } catch (err) {
      throw loginFailure(err);
    }
  });

  app.delete('/v1/logins/:id', (c) => {
    if (!logins.delete(c.req.param('id'))) throw notFound('Login');
    return c.body(null, 204);
  });

  return app;
}
