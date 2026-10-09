import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketPath, stateDir, type Request, type Response } from './protocol.ts';

/**
 * One browser command per invocation: reads a JSON request on stdin, hands it to the browser
 * daemon (starting it if it is not running) and prints the JSON response. The daemon, not this
 * process, owns the browser — that is what keeps a page open between the agent's tool calls.
 */

const DAEMON_START_MS = 15_000;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** Resolves with the daemon's answer, or `undefined` when nothing is listening. */
function send(request: Request): Promise<Response | undefined> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath());
    let data = '';
    let connected = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', (err) => (connected ? reject(err) : resolve(undefined)));
    socket.on('end', () => {
      try {
        resolve(JSON.parse(data) as Response);
      } catch {
        reject(new Error('The browser daemon closed the connection without answering.'));
      }
    });
  });
}

function startDaemon(request: Request): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const log = openSync(join(stateDir(), 'daemon.log'), 'a', 0o600);
  const daemon = fileURLToPath(new URL('./daemon.ts', import.meta.url));
  // Detached with no inherited pipes: it must outlive this command and the shell that ran it.
  // Playwright decides where its browsers are when it is loaded, so the path has to be in the
  // daemon's environment from the start.
  const { browsersPath } = request.launch;
  const env = browsersPath ? { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath } : process.env;
  spawn(process.execPath, [daemon, JSON.stringify(request.launch)], {
    detached: true,
    stdio: ['ignore', log, log],
    env,
  }).unref();
}

async function main(): Promise<Response> {
  const request = JSON.parse(await readStdin()) as Request;
  const deadline = Date.now() + DAEMON_START_MS;
  let lastStart = 0;
  for (;;) {
    // A connection dropped without an answer means the daemon was on its way out: try again.
    const response = await send(request).catch(() => null);
    if (response) return response;
    if (response === undefined) {
      // None of these is a reason to start a browser: with none running there is nothing to stop, close or describe.
      if (['shutdown', 'end', 'describe'].includes(request.command.cmd)) return { ok: true, info: 'not running' };
      if (Date.now() - lastStart > 2_000) {
        startDaemon(request);
        lastStart = Date.now();
      }
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, error: `The browser daemon did not start. See ${join(stateDir(), 'daemon.log')}.` };
}

main()
  .catch((err: unknown): Response => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  .then((response) => process.stdout.write(JSON.stringify(response)));
