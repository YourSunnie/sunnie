import { shq, type Computer } from '../computer/computer.ts';
import { HttpError } from '../util/errors.ts';
import { MAX_DRIVE_FILE_BYTES, type DriveEntry, type DrivePage, type DriveRequest, type DriveText } from './protocol.ts';
import { DRIVE_SCRIPT } from './script.ts';

export class DriveClient {
  private readonly computer: Computer;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(computer: Computer) { this.computer = computer; }

  /** Serialize app operations so two editors cannot both pass the same revision check. */
  request<T>(request: DriveRequest): Promise<T> {
    const pending = this.queue.then(async () => {
      const result = await this.computer.exec(`python3 -c ${shq(DRIVE_SCRIPT)}`, {
        stdin: JSON.stringify({ ...request, workspace: this.computer.workspace }),
        timeoutMs: 30_000,
        maxOutputChars: request.action === 'read' ? MAX_DRIVE_FILE_BYTES * 2 : 2_000_000,
      });
      if (result.exitCode !== 0 || result.timedOut || result.aborted || result.truncated) {
        throw new HttpError(502, 'drive_unavailable', 'Drive did not finish the operation. Refresh before retrying.');
      }
      let response: { ok: boolean; result: T; status: HttpError['status']; error: string };
      try { response = JSON.parse(result.stdout); }
      catch { throw new HttpError(502, 'drive_unavailable', 'Drive returned an unreadable response.'); }
      if (!response.ok) throw new HttpError(response.status, 'drive_error', response.error);
      return response.result;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  list(path: string, offset = 0): Promise<DrivePage> { return this.request({ action: 'list', path, offset }); }
  stat(path: string): Promise<DriveEntry> { return this.request({ action: 'stat', path }); }
  text(path: string): Promise<DriveText> { return this.request({ action: 'text', path }); }
  read(path: string): Promise<{ entry: DriveEntry; data: string }> { return this.request({ action: 'read', path }); }
}
