import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
  tools?: unknown[];
}

export interface FakeProvider {
  baseURL: string;
  requests: ChatRequest[];
  /** The headers of the last request, lower-cased. */
  lastHeaders: Record<string, string | string[] | undefined>;
  close(): Promise<void>;
}

const lastUserText = (req: ChatRequest) => {
  const user = req.messages.findLast((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
};

/**
 * A minimal OpenAI-compatible /chat/completions server with scripted behaviour:
 *  - after a tool result, it reports that result back as text;
 *  - "run: <cmd>" in the user message makes it call the shell tool;
 *  - "slow" makes it stall mid-answer until the client goes away;
 *  - otherwise it echoes.
 * Non-streaming requests (the compactor) get a canned summary.
 */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: ChatRequest[] = [];
  const provider = { lastHeaders: {} as FakeProvider['lastHeaders'] };

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      provider.lastHeaders = req.headers;
      if (req.url?.endsWith('/messages')) {
        const body = JSON.parse(raw) as ChatRequest;
        requests.push(body);
        answerAnthropic(body, res);
        return;
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as ChatRequest;
      requests.push(body);

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-1',
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '<summary>\nA compact summary of earlier talk.\n</summary>\n<memories>\nnone\n</memories>',
                },
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null = null, usage?: object) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'cmpl-1',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      const finish = (reason: string) => {
        chunk({}, reason, { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 });
        res.end('data: [DONE]\n\n');
      };

      const last = body.messages.at(-1)!;
      const text = lastUserText(body);
      const command = /run: (.+?)(?:"|\\|$)/.exec(text)?.[1];

      if (last.role === 'tool') {
        chunk({ role: 'assistant', content: 'Tool said: ' });
        chunk({ content: String(last.content).split('\n')[0] });
        finish('stop');
      } else if (command) {
        chunk({
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } },
          ],
        });
        finish('tool_calls');
      } else if (text.includes('slow')) {
        chunk({ role: 'assistant', content: 'Thinking' });
        // Never finishes on its own; the test cancels the run.
        req.socket.on('close', () => res.end());
      } else {
        chunk({ role: 'assistant', content: 'Echo: ' });
        chunk({ content: 'hello there' });
        finish('stop');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    get lastHeaders() {
      return provider.lastHeaders;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The Anthropic Messages API, just enough of it: an echo of the last user text, streamed as the
 * events the SDK expects, or as one message when not streaming. Usage carries cache figures so
 * tests can see them pass through.
 */
function answerAnthropic(body: ChatRequest, res: import('node:http').ServerResponse): void {
  const text = `Echo: ${lastUserText(body)}`;
  const usage = { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { ...usage, output_tokens: 12 },
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
  event('message_stop', {});
  res.end();
}
