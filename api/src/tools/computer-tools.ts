import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { isAbsolute, join, resolve } from 'node:path';
import { shq, type Computer } from '../computer/computer.ts';

/** Largest file the file tools will load whole. Bigger files go through `bash`. */
const MAX_FILE_BYTES = 256_000;

/** Largest image `view_image` shows; providers refuse much more, and a bigger one is resized first. */
const MAX_IMAGE_BYTES = 3_000_000;

export interface ComputerToolOptions {
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  /** Whether the model can be shown pictures; without it `view_image` says so instead of trying. */
  images?: boolean;
}

/** The image types every vision model takes, told apart by their first bytes. */
function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

/**
 * Whether text read from a file is really bytes: a NUL, or many characters that were not valid
 * UTF-8 (the computer decodes output as text). A PNG read as text is tens of thousands of such
 * characters, teaching the model nothing and costing a third of its context.
 */
function looksBinary(text: string): boolean {
  if (text.includes('\0')) return true;
  const sample = text.slice(0, 4000);
  let bad = 0;
  for (const ch of sample) if (ch === '\uFFFD') bad += 1;
  return bad > sample.length / 20;
}

async function readWhole(computer: Computer, path: string, signal?: AbortSignal): Promise<string> {
  const p = shq(path);
  const res = await computer.exec(
    `[ -f ${p} ] || { echo "No such file: "${p} >&2; exit 66; }; ` +
      `[ "$(wc -c < ${p})" -le ${MAX_FILE_BYTES} ] || { echo "File is larger than ${MAX_FILE_BYTES} bytes; work on it with shell tools instead." >&2; exit 67; }; ` +
      `cat -- ${p}`,
    { maxOutputChars: MAX_FILE_BYTES * 4, signal },
  );
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `Could not read ${path}`);
  return res.stdout;
}

async function writeWhole(
  computer: Computer,
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const p = shq(path);
  const res = await computer.exec(`mkdir -p -- "$(dirname -- ${p})" && cat > ${p}`, {
    stdin: content,
    signal,
  });
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `Could not write ${path}`);
}

/** A path as the file tools read it: relative ones start in ~/Drive, `~/` and absolute ones reach the rest of the computer. */
export function filePathOn(computer: Computer, path: string): string {
  return path === '~' ? computer.workspace
    : path.startsWith('~/') ? resolve(computer.workspace, path.slice(2))
    : isAbsolute(path) ? path : resolve(join(computer.workspace, 'Drive'), path);
}

export function createComputerTools(computer: Computer, opts: ComputerToolOptions): ToolSet {
  const drive = join(computer.workspace, 'Drive');
  const filePath = (path: string) => filePathOn(computer, path);
  return {
    // Named for what it is: the model's provider judges the calls of a tool it knows by this name.
    bash: tool({
      description:
        'Run a bash command on your computer and get its combined stdout/stderr and exit code. ' +
        'Each call is a fresh shell starting in ~/Drive, the files the user can browse in the app. Use Drive by default for user files. Files persist, shell state ' +
        '(cd, variables) does not. For long-running work, background it and poll a log file.',
      inputSchema: z.object({
        command: z.string().describe('The bash command line to run.'),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .max(opts.maxTimeoutSec)
          .optional()
          .describe(`Kill the command after this long. Default ${opts.defaultTimeoutSec}.`),
      }),
      execute: async ({ command, timeout_seconds }, { abortSignal }) => {
        const timeoutSec = timeout_seconds ?? opts.defaultTimeoutSec;
        const res = await computer.exec(`mkdir -p -- ${shq(drive)} || exit\ncd -- ${shq(drive)} || exit\n${command}`, { timeoutMs: timeoutSec * 1000, signal: abortSignal });
        const status = res.timedOut
          ? `timed out after ${timeoutSec}s`
          : res.aborted
            ? 'cancelled'
            : `exit code ${res.exitCode}`;
        return `${res.output.trimEnd() || '(no output)'}\n\n[${status}]`;
      },
    }),

    read_file: tool({
      description:
        'Read a text file from your computer, with line numbers. Relative paths resolve against ' +
        '~/Drive. Absolute paths and ~/ paths can access the rest of your computer. Use offset/limit to page through long files.',
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().int().min(1).optional().describe('First line to read, 1-based.'),
        limit: z.number().int().positive().max(2000).optional().describe('Lines to read. Default 500.'),
      }),
      execute: async ({ path, offset = 1, limit = 500 }, { abortSignal }) => {
        path = filePath(path);
        const p = shq(path);
        const res = await computer.exec(
          `[ -f ${p} ] || { echo "No such file: "${p} >&2; exit 66; }; ` +
            `tail -n +${offset} -- ${p} | head -n ${limit} | head -c ${MAX_FILE_BYTES}`,
          { maxOutputChars: MAX_FILE_BYTES * 4, signal: abortSignal },
        );
        if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `Could not read ${path}`);
        if (!res.stdout) return offset > 1 ? `(no lines at or after line ${offset})` : '(empty file)';
        if (looksBinary(res.stdout)) {
          const kind = /\.(png|jpe?g|gif|webp)$/i.test(path) ? 'an image' : 'a binary file';
          throw new Error(
            `${path} is ${kind}, not text, so read_file cannot show it. ` +
              (kind === 'an image'
                ? 'Use view_image to look at it.'
                : 'For a PDF use `pdftotext -layout file.pdf -` in the shell; for anything else, `file` in the shell says what it is.'),
          );
        }
        const lines = res.stdout.replace(/\n$/, '').split('\n');
        const numbered = lines.map((line, i) => `${String(offset + i).padStart(5)}  ${line}`).join('\n');
        const more = lines.length === limit ? `\n\n[showing ${limit} lines; pass offset=${offset + limit} for more]` : '';
        return numbered + more;
      },
    }),

    view_image: tool({
      description:
        'Look at an image file on your computer (PNG, JPEG, GIF or WebP): you see the picture itself. Use it to ' +
        'check a graphic or chart you made before showing it, to read a screenshot, or to see a photo in Drive. ' +
        'Relative paths resolve against ~/Drive. Not for text (read_file) or PDFs (pdftotext in the shell).',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }, { abortSignal }) => {
        if (opts.images === false) {
          throw new Error('The model in use cannot be shown pictures. Describe the image from its file name and size, or ask the user to look.');
        }
        path = filePath(path);
        const p = shq(path);
        const res = await computer.exec(
          `[ -f ${p} ] || { echo "No such file: "${p} >&2; exit 66; }; ` +
            `[ "$(wc -c < ${p})" -le ${MAX_IMAGE_BYTES} ] || { echo "Image is larger than ${MAX_IMAGE_BYTES} bytes; make a smaller copy first (Python's PIL or ImageMagick's convert -resize) and look at that." >&2; exit 67; }; ` +
            `base64 < ${p} | tr -d '\\n'`,
          { maxOutputChars: MAX_IMAGE_BYTES * 2, signal: abortSignal },
        );
        if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `Could not read ${path}`);
        const data = res.stdout.trim();
        const mediaType = imageType(Buffer.from(data.slice(0, 24), 'base64'));
        if (!mediaType) throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image. Convert it to one of those first (for a PDF page: pdftoppm -png).`);
        return { path, mediaType, kilobytes: Math.round((data.length * 0.75) / 1024), data };
      },
      // The model gets the picture; everyone else (the app, the router) gets the line of text.
      toModelOutput: ({ output }) => ({
        type: 'content',
        value: [
          { type: 'text', text: `${output.path} (${output.mediaType}, ${output.kilobytes} KB)` },
          { type: 'file', mediaType: output.mediaType, data: { type: 'data', data: output.data } },
        ],
      }),
    }),

    write_file: tool({
      description:
        'Create or overwrite a text file. Relative paths use ~/Drive, visible to the user in the app; absolute and ~/ paths are also supported. Parent directories are created as needed.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }, { abortSignal }) => {
        path = filePath(path);
        await writeWhole(computer, path, content, abortSignal);
        return `Wrote ${content.length} characters to ${path}`;
      },
    }),

    edit_file: tool({
      description:
        'Replace an exact string in a text file. old_text must match exactly one place in the file ' +
        'unless replace_all is set. Relative paths use ~/Drive; absolute and ~/ paths are also supported.',
      inputSchema: z.object({
        path: z.string(),
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ path, old_text, new_text, replace_all }, { abortSignal }) => {
        path = filePath(path);
        const current = await readWhole(computer, path, abortSignal);
        const count = current.split(old_text).length - 1;
        if (count === 0) throw new Error(`old_text was not found in ${path}. It must match exactly.`);
        if (count > 1 && !replace_all) {
          throw new Error(
            `old_text matches ${count} places in ${path}. Include more context, or set replace_all.`,
          );
        }
        // split/join rather than String.replace: new_text must not be read as a `$&` pattern.
        await writeWhole(computer, path, current.split(old_text).join(new_text), abortSignal);
        return `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${path}`;
      },
    }),
  };
}
