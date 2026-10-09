import { execFileSync, spawn } from 'node:child_process';
import { chownSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export interface ExecOptions {
  /** Working directory; defaults to the workspace. */
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
  /** Cap on captured stdout and stderr, each. Output beyond it is dropped from the middle. */
  maxOutputChars?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order — what a terminal would have shown. */
  output: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * How long output may keep arriving after the shell itself has exited. Whatever still holds the
 * pipes then is a background job, and waiting for it would be waiting for the job to end.
 */
const DRAIN_MS = 100;

/**
 * The agent's machine. Everything the agent does to its environment — shell commands and file
 * access alike — goes through `exec`, so swapping in another backend (a Docker container, a
 * remote VM over SSH) only means implementing this one interface.
 */
export interface Computer {
  /** The agent's home directory and default working directory. */
  readonly workspace: string;
  /** One-line description for the system prompt. */
  describe(): string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
}

/** Keeps the first and last halves of a stream, dropping the middle once it outgrows `max`. */
class BoundedBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;
  private readonly half: number;

  constructor(max: number) {
    this.half = Math.max(1, Math.floor(max / 2));
  }

  push(chunk: string): void {
    const room = this.half - this.head.length;
    if (room > 0) {
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.half) {
      this.dropped += this.tail.length - this.half;
      this.tail = this.tail.slice(-this.half);
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  toString(): string {
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n\n[... ${this.dropped} characters omitted ...]\n\n${this.tail}`;
  }
}

export interface LocalComputerOptions {
  workspace: string;
  shell?: string;
  /**
   * Linux user to run commands as. The server must itself be root for this; it keeps the
   * server's secrets (API keys, database) out of the agent's reach.
   */
  user?: string;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
}

/** Runs commands on the machine the server itself runs on — a VM, a container, or a dev laptop. */
export class LocalComputer implements Computer {
  readonly workspace: string;
  private readonly shell: string;
  private readonly username: string;
  private readonly ids: { uid: number; gid: number } | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(opts: LocalComputerOptions) {
    this.workspace = opts.workspace;
    this.shell = opts.shell ?? '/bin/bash';
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.maxOutputChars = opts.maxOutputChars ?? 16_000;
    mkdirSync(this.workspace, { recursive: true });

    const current = os.userInfo().username;
    if (opts.user && opts.user !== current) {
      if (process.getuid?.() !== 0) {
        throw new Error(
          `computer.user is "${opts.user}" but the server runs as "${current}". ` +
            'Switching users requires running the server as root.',
        );
      }
      const lookup = (flag: string) =>
        Number(execFileSync('id', [flag, opts.user!], { encoding: 'utf8' }).trim());
      this.ids = { uid: lookup('-u'), gid: lookup('-g') };
      this.username = opts.user;
      chownSync(this.workspace, this.ids.uid, this.ids.gid);
    } else {
      this.username = current;
    }
  }

  describe(): string {
    return `${os.type()} ${os.release()} (${os.arch()}), user "${this.username}", home ${this.workspace}`;
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const max = opts.maxOutputChars ?? this.maxOutputChars;
    const stdout = new BoundedBuffer(max);
    const stderr = new BoundedBuffer(max);
    const output = new BoundedBuffer(max);

    return new Promise((resolve) => {
      // Login profiles can reset PATH. Restore the persistent local bin after they have run.
      const script = `export PATH=${shq(join(this.workspace, '.local', 'bin'))}:"$PATH"\n${command}`;
      const child = spawn(this.shell, ['-lc', script], {
        cwd: opts.cwd ?? this.workspace,
        env: this.environment(),
        uid: this.ids?.uid,
        gid: this.ids?.gid,
        // Own process group, so a timeout takes down the whole tree and not just the shell.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let timedOut = false;
      let aborted = false;
      const killTree = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, opts.timeoutMs ?? this.defaultTimeoutMs);
      const onAbort = () => {
        aborted = true;
        killTree();
      };
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });

      let finished = false;
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (finished) return;
        stdout.push(chunk);
        output.push(chunk);
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        if (finished) return;
        stderr.push(chunk);
        output.push(chunk);
      });
      // A command that never reads stdin would otherwise surface EPIPE as an uncaught error.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin ?? '');

      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (finished) return;
        finished = true;
        // A background job may write for as long as it lives. The pipes stay open and are read
        // to nowhere, so that it is not killed by a closed pipe, but they no longer hold us up.
        for (const pipe of [child.stdout, child.stderr]) (pipe as typeof pipe & { unref?(): void }).unref?.();
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (spawnError) {
          stderr.push(spawnError.message);
          output.push(spawnError.message);
        }
        resolve({
          exitCode,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          output: output.toString(),
          timedOut,
          aborted,
          truncated: output.truncated || stdout.truncated || stderr.truncated,
          durationMs: Date.now() - started,
        });
      };
      child.on('error', (err) => finish(null, err));
      child.on('close', (code) => finish(code));
      // 'close' waits for every holder of the pipes, which a background job, or a process that
      // left the group and survived the kill, can be for ever. The shell's own exit is the end.
      child.on('exit', (code) => setTimeout(() => finish(code), DRAIN_MS));
    });
  }

  /**
   * A deliberately minimal environment: the server's own variables (provider keys, the API
   * token) must never leak into commands the model controls.
   */
  private environment(): NodeJS.ProcessEnv {
    return {
      HOME: this.workspace,
      USER: this.username,
      LOGNAME: this.username,
      SHELL: this.shell,
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      MAMBA_ROOT_PREFIX: join(this.workspace, '.local', 'share', 'mamba'),
      NPM_CONFIG_PREFIX: join(this.workspace, '.local'),
      LANG: process.env.LANG ?? 'C.UTF-8',
      TZ: process.env.TZ,
      TERM: 'dumb',
    };
  }
}

/** Quotes a string as a single POSIX shell word. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
