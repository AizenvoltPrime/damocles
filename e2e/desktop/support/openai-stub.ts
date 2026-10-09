import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  host: string | undefined;
  body: unknown;
}

export interface StubToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface StubReply {
  chunks: string[];
  /** Streamed after the text as `delta.tool_calls` (ids `call_<n>`), ending the reply with finish_reason 'tool_calls'. */
  toolCalls?: StubToolCall[];
  /** When set, the stub sends the first chunk and waits for this promise before sending the rest. */
  holdAfterFirst?: Promise<void>;
}

export interface OpenAIStub {
  /** Base URL including `/v1`, for the models.json provider entry. */
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** Replies consumed in order by the agent's turns; a sub-call, or a turn with none left, gets the echo of its last user text. */
  readonly replies: StubReply[];
  close(): Promise<void>;
}

export const STUB_MODEL_ID = 'gpt-6-luna';

function chunk(id: string, delta: Record<string, unknown>, finishReason: string | null): string {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: STUB_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

let toolCallCount = 0;

async function streamReply(res: http.ServerResponse, reply: StubReply, includeUsage: boolean): Promise<void> {
  const id = `chatcmpl-stub-${Date.now()}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(chunk(id, { role: 'assistant', content: '' }, null));
  const [first, ...rest] = reply.chunks;
  if (first !== undefined) res.write(chunk(id, { content: first }, null));
  if (reply.holdAfterFirst) await reply.holdAfterFirst;
  for (const text of rest) res.write(chunk(id, { content: text }, null));
  const toolCalls = reply.toolCalls ?? [];
  toolCalls.forEach((call, index) => {
    const toolCall = { index, id: `call_${++toolCallCount}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
    res.write(chunk(id, { tool_calls: [toolCall] }, null));
  });
  res.write(chunk(id, {}, toolCalls.length > 0 ? 'tool_calls' : 'stop'));
  if (includeUsage) {
    const usage = { prompt_tokens: 12, completion_tokens: reply.chunks.length, total_tokens: 12 + reply.chunks.length };
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: STUB_MODEL_ID, choices: [], usage })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

interface ChatMessage {
  role: string;
  content: string | { type: string; text?: string }[] | null;
}

function lastUserText(messages: ChatMessage[]): string {
  const user = [...messages].reverse().find((m) => m.role === 'user');
  if (!user?.content) return '';
  if (typeof user.content === 'string') return user.content;
  return user.content.map((part) => part.text ?? '').join('');
}

/** An OpenAI chat-completions endpoint on loopback, over HTTP or, given a certificate, HTTPS. */
export async function startOpenAIStub(options: { tls?: { cert: string; key: string }; hostName?: string } = {}): Promise<OpenAIStub> {
  const requests: RecordedRequest[] = [];
  const replies: StubReply[] = [];

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      let body: unknown = raw;
      let malformed = false;
      if (raw && req.headers['content-type']?.includes('json')) {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          malformed = true;
        }
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host, body });
      // A throw here is outside any test's reach and would crash the worker.
      if (malformed) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub received a malformed JSON body' } }));
        return;
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `stub has no route ${req.method} ${req.url}` } }));
        return;
      }
      const params = body as { stream?: boolean; stream_options?: { include_usage?: boolean }; messages?: ChatMessage[]; tools?: unknown[] };
      if (!params.stream) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub serves streamed completions only' } }));
        return;
      }
      // A sub-call (runStructuredCompletion: the title, memory extraction) offers only its output tool and fires on its own timers.
      const subCall = params.tools?.length === 1;
      const reply = (subCall ? undefined : replies.shift()) ?? { chunks: ['Echo: ', lastUserText(params.messages ?? [])] };
      streamReply(res, reply, params.stream_options?.include_usage === true).catch((err: unknown) => {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      });
    });
  };

  const server = options.tls ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, handler) : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const scheme = options.tls ? 'https' : 'http';
  const host = options.hostName ?? '127.0.0.1';
  return {
    baseUrl: `${scheme}://${host}:${port}/v1`,
    port,
    requests,
    replies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Chat requests only; pi may issue other calls the stub answers with 404. */
export function chatRequests(stub: OpenAIStub): RecordedRequest[] {
  return stub.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/chat/completions'));
}
