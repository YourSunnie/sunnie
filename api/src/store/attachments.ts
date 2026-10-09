import { createHash } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { badRequest, conflict, HttpError, notFound } from '../util/errors.ts';
import { newId, nowIso } from '../util/ids.ts';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_PREVIEW_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;

/** Immutable metadata shared by upload responses and the message that used the file. */
export interface Attachment {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
  /** Initial editable copy in Drive; moving/deleting it does not change the original. */
  drivePath?: string;
}

export interface AttachmentPreview {
  data: Uint8Array;
  mediaType: string;
}

type Row = Record<string, unknown>;
const COLUMNS = 'id, filename, media_type, size_bytes, created_at, drive_path';

function toAttachment(row: Row): Attachment {
  return {
    id: row.id as string,
    filename: row.filename as string,
    mediaType: row.media_type as string,
    sizeBytes: row.size_bytes as number,
    createdAt: row.created_at as string,
    ...(typeof row.drive_path === 'string' ? { drivePath: row.drive_path } : {}),
  };
}

/**
 * Originals live with server state, separate from the working copies on the agent's computer.
 * One upload can be used in several conversations; no deletion of a chat removes its original.
 */
export class AttachmentStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(input: { filename: string; mediaType: string; data: Uint8Array; requestId?: string }): { attachment: Attachment; created: boolean } {
    const filename = input.filename.normalize('NFC').split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
    if (!filename || filename === '.' || filename === '..' || filename.length > 255) {
      throw badRequest('Filename must be between 1 and 255 characters');
    }
    const mediaType = input.mediaType.split(';')[0]!.trim().toLowerCase();
    if (mediaType.length > 120 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
      throw badRequest('Content-Type must be a valid media type');
    }
    if (input.requestId !== undefined && (!input.requestId || input.requestId.length > 200)) {
      throw badRequest('X-Request-ID must be between 1 and 200 characters');
    }
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(413, 'payload_too_large', `An attachment may be at most ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    if (input.requestId) {
      const earlier = this.db.prepare(`SELECT ${COLUMNS}, sha256 FROM attachments WHERE request_id = ?`).get(input.requestId);
      if (earlier) {
        if (earlier.sha256 !== sha256 || earlier.filename !== filename || earlier.media_type !== mediaType) {
          throw conflict('This upload request ID was already used for a different file');
        }
        return { attachment: toAttachment(earlier), created: false };
      }
    }
    const attachment: Attachment = { id: newId('att'), filename, mediaType, sizeBytes: input.data.byteLength, createdAt: nowIso() };
    this.db.prepare(
      'INSERT INTO attachments (id, filename, media_type, size_bytes, data, sha256, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(attachment.id, filename, mediaType, attachment.sizeBytes, input.data, sha256, input.requestId ?? null, attachment.createdAt);
    return { attachment, created: true };
  }

  get(id: string): Attachment | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`).get(id);
    return row ? toAttachment(row) : null;
  }

  getBytes(id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT data FROM attachments WHERE id = ?').get(id);
    return row ? row.data as Uint8Array : null;
  }

  markDriveCopy(id: string, path: string): void {
    this.db.prepare('UPDATE attachments SET drive_path = ? WHERE id = ? AND drive_path IS NULL').run(path, id);
  }

  /** A bounded interpretation copy, immutable after upload; the original is never replaced. */
  createPreview(id: string, input: AttachmentPreview): { created: boolean } {
    const original = this.get(id);
    if (!original) throw notFound('Attachment');
    if (!original.mediaType.startsWith('image/')) throw badRequest('Only an image attachment can have an interpretation preview');
    const mediaType = input.mediaType.split(';')[0]!.trim().toLowerCase();
    if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') throw badRequest('A preview must be image/jpeg or image/png');
    if (input.data.byteLength > MAX_ATTACHMENT_PREVIEW_BYTES) {
      throw new HttpError(413, 'payload_too_large', `A preview may be at most ${MAX_ATTACHMENT_PREVIEW_BYTES} bytes`);
    }
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const earlier = this.db.prepare('SELECT media_type, sha256 FROM attachment_previews WHERE attachment_id = ?').get(id);
    if (earlier) {
      if (earlier.sha256 !== sha256 || earlier.media_type !== mediaType) throw conflict('This attachment already has a different interpretation preview');
      return { created: false };
    }
    const signature = mediaType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
    if (!signature.every((byte, index) => input.data[index] === byte)) throw badRequest('Preview bytes do not match its image media type');
    this.db.prepare('INSERT INTO attachment_previews (attachment_id, media_type, data, sha256) VALUES (?, ?, ?, ?)')
      .run(id, mediaType, input.data, sha256);
    return { created: true };
  }

  getPreview(id: string): AttachmentPreview | null {
    const row = this.db.prepare('SELECT media_type, data FROM attachment_previews WHERE attachment_id = ?').get(id);
    return row ? { mediaType: row.media_type as string, data: row.data as Uint8Array } : null;
  }

  /** Validated before a run or steer is accepted, and again when constructing its message. */
  resolve(ids: readonly string[] = []): Attachment[] {
    if (ids.length > MAX_MESSAGE_ATTACHMENTS) throw badRequest(`A message may include at most ${MAX_MESSAGE_ATTACHMENTS} attachments`);
    if (new Set(ids).size !== ids.length) throw badRequest('Attachment IDs must be unique within a message');
    const attachments = ids.map((id) => {
      const attachment = this.get(id);
      if (!attachment) throw notFound('Attachment');
      return attachment;
    });
    if (attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new HttpError(413, 'payload_too_large', `A message may include at most ${MAX_MESSAGE_ATTACHMENT_BYTES} attachment bytes`);
    }
    return attachments;
  }
}
