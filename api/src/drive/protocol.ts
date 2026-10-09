export const MAX_DRIVE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DRIVE_TEXT_BYTES = 256 * 1024;

export interface DriveEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'unsupported';
  sizeBytes: number;
  modifiedAt: string;
  revision: string;
  mediaType: string;
}

export interface DrivePage {
  path: string;
  entries: DriveEntry[];
  nextOffset: number | null;
}

export interface DriveText {
  entry: DriveEntry;
  text: string;
}

export type DriveRequest =
  | { action: 'list'; path: string; offset: number }
  | { action: 'stat' | 'read' | 'text' | 'mkdir'; path: string }
  | { action: 'upload'; path: string; data: string }
  | { action: 'import'; path: string; data: string }
  | { action: 'write'; path: string; text: string; revision: string }
  | { action: 'move'; path: string; destination: string; revision: string }
  | { action: 'delete'; path: string; revision: string };

/** Each original gets its own folder, so equal filenames never overwrite another upload. */
export function attachmentDrivePath(attachment: { id: string; filename: string }): string {
  let name = '';
  for (const character of attachment.filename) {
    if (Buffer.byteLength(name + character) > 240) break;
    name += character;
  }
  return `Uploads/${attachment.id}/${name}`;
}
