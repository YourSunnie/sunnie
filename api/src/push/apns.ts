import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { errorMessage, type Logger } from '../util/log.ts';
import type { PushDevice, PushEnvironment } from './devices.ts';

/** What a notification says. `data` rides along for the app (which chat to open). */
export interface PushMessage {
  title: string;
  body: string;
  /** Groups notifications in Notification Center: one thread per conversation. */
  threadId?: string;
  /** A later notification with the same id replaces the earlier one. */
  collapseId?: string;
  data: Record<string, string>;
}

/** `gone`: the token is no longer valid for this app, so it should be forgotten. */
export type PushResult = 'sent' | 'gone' | 'failed';

export interface PushSender {
  readonly name: string;
  /** Never throws: a failed notification must not affect the run that caused it. */
  send(device: PushDevice, message: PushMessage): Promise<PushResult>;
  close(): void;
}

/** Notifications are off: nothing is sent. */
export const noPush: PushSender = {
  name: 'none',
  send: async () => 'failed',
  close: () => {},
};

export interface ApnsOptions {
  teamId: string;
  keyId: string;
  /** The contents of the .p8 key from Apple's developer site. */
  key: string;
  /** The app's bundle id. */
  topic: string;
  /** Replaces both of Apple's hosts; for tests. */
  endpoint?: string;
  timeoutMs: number;
  log: Logger;
}

const HOSTS: Record<PushEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple rejects a provider token older than an hour, and one refreshed more than every 20 minutes. */
const TOKEN_LIFETIME_MS = 50 * 60_000;

/** Reasons Apple gives for a token that will never work again for this app. */
const GONE_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

/** Apple's limit on a notification's payload. */
const MAX_PAYLOAD_BYTES = 4096;

/** Sends alerts straight to Apple Push Notification service over HTTP/2, signed with the team's key. */
export class ApnsSender implements PushSender {
  readonly name = 'apns';
  private readonly opts: ApnsOptions;
  private readonly key: KeyObject;
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private token: { value: string; issuedAt: number } | null = null;

  constructor(opts: ApnsOptions) {
    this.opts = opts;
    // Parsed up front, so a broken key is a startup error rather than a silent failure per push.
    this.key = createPrivateKey(opts.key);
  }

  async send(device: PushDevice, message: PushMessage): Promise<PushResult> {
    try {
      const { status, reason } = await this.post(device, message);
      if (status === 200) return 'sent';
      if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') this.token = null;
      if (status === 410 || GONE_REASONS.has(reason)) return 'gone';
      this.opts.log.warn('notification refused', { status, reason });
      return 'failed';
    } catch (err) {
      this.opts.log.warn('notification not sent', { error: errorMessage(err) });
      return 'failed';
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private post(device: PushDevice, message: PushMessage): Promise<{ status: number; reason: string }> {
    const body = JSON.stringify(payload(message));
    const headers: Record<string, string> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': this.opts.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    };
    if (message.collapseId) headers['apns-collapse-id'] = message.collapseId.slice(0, 64);

    return new Promise((resolve, reject) => {
      const req = this.session(device.environment).request(headers);
      req.setTimeout(this.opts.timeoutMs, () => req.close(constants.NGHTTP2_CANCEL));
      let status = 0;
      let raw = '';
      req.on('response', (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS])));
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (raw += chunk));
      req.on('end', () => {
        let reason = '';
        try {
          reason = raw ? String((JSON.parse(raw) as { reason?: string }).reason ?? '') : '';
        } catch {
          reason = raw.slice(0, 200);
        }
        resolve({ status, reason });
      });
      req.on('close', () => {
        if (!status) reject(new Error(`no answer from APNs within ${this.opts.timeoutMs} ms`));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  /** One long-lived connection per host, as Apple asks; a dropped one is opened again on the next push. */
  private session(environment: PushEnvironment): ClientHttp2Session {
    const origin = this.opts.endpoint ?? HOSTS[environment];
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;

    const session = connect(origin);
    const forget = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on('error', (err) => {
      this.opts.log.warn('APNs connection failed', { error: errorMessage(err) });
      forget();
    });
    session.on('goaway', forget);
    session.on('close', forget);
    // An idle connection must not keep the process alive at shutdown.
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private providerToken(): string {
    const now = Date.now();
    if (this.token && now - this.token.issuedAt < TOKEN_LIFETIME_MS) return this.token.value;
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.opts.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.opts.teamId, iat: Math.floor(now / 1000) }));
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    this.token = { value: `${header}.${claims}.${signature.toString('base64url')}`, issuedAt: now };
    return this.token.value;
  }
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url');
}

/** The APNs body. The text is cut until it fits Apple's size limit, never the routing data. */
export function payload(message: PushMessage): Record<string, unknown> {
  let body = message.body;
  for (;;) {
    const built = {
      aps: {
        alert: { title: message.title, body },
        sound: 'default',
        ...(message.threadId ? { 'thread-id': message.threadId } : {}),
      },
      ...message.data,
    };
    if (Buffer.byteLength(JSON.stringify(built)) <= MAX_PAYLOAD_BYTES || body.length === 0) return built;
    body = `${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}…`;
  }
}
