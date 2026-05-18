import * as http from 'http';
import { StringDecoder } from 'string_decoder';
import { log } from '../logger';
import { convertAnthropicToGemini, buildGeminiUrl, GeminiToAnthropicStream, convertGeminiResponse } from './gemini-transform';
import type { ExploreProvider } from './types';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;
const ALLOWED_PATH = '/v1/messages';

export interface ExploreProxyConfig {
  provider: ExploreProvider;
  targetBaseUrl: string;
  apiKey: string;
  model: string;
  bearer: string;
}

export class ExploreProxy {
  private server: http.Server | null = null;
  private port = 0;
  private readonly config: ExploreProxyConfig;

  constructor(config: ExploreProxyConfig) {
    this.config = config;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        log('[ExploreProxy] Unhandled error: %O', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ type: 'error', error: { type: 'server_error', message: String(err) } }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once('error', onError);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.removeListener('error', onError);
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        log('[ExploreProxy] Started on port %d → %s (%s)', this.port, this.config.targetBaseUrl, this.config.provider);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.closeAllConnections();
      this.server.close();
      this.server = null;
      this.port = 0;
      log('[ExploreProxy] Stopped');
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers['authorization'];
    const expected = `Bearer ${this.config.bearer}`;
    if (typeof header !== 'string' || header.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) {
      mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return mismatch === 0;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request', message: 'Method not allowed' } }));
      return;
    }

    if (!this.isAuthorized(req)) {
      log('[ExploreProxy] Rejected unauthorized request from %s', req.socket.remoteAddress);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy token' } }));
      return;
    }

    const urlPath = (req.url ?? '').split('?')[0];
    if (urlPath !== ALLOWED_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Path ${urlPath} not allowed` } }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request', message: 'Invalid JSON body' } }));
      return;
    }

    const sdkModel = typeof body['model'] === 'string' ? (body['model'] as string) : '';

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on('close', onClose);

    log('[ExploreProxy] %s model=%s stream=%s provider=%s', req.url, this.config.model, body['stream'], this.config.provider);

    try {
      if (this.config.provider === 'gemini') {
        await this.forwardGemini(body, sdkModel, abort, res);
      } else {
        await this.forwardAnthropicCompatible(body, sdkModel, abort, res);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      log('[ExploreProxy] Upstream error: %O', err);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
    } finally {
      req.removeListener('close', onClose);
    }
  }

  private buildProviderHeaders(): Record<string, string> {
    const base: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    };
    if (this.config.provider === 'openrouter') {
      base['HTTP-Referer'] = 'https://github.com/nickstefan/damocles';
      base['X-Title'] = 'Damocles Explore';
    }
    return base;
  }

  private get providerLabel(): string {
    switch (this.config.provider) {
      case 'openrouter': return 'OpenRouter';
      case 'stepfun': return 'StepFun';
      case 'gemini': return 'Gemini';
    }
  }

  private writeRateLimitResponse(res: http.ServerResponse, lastRateLimitBody: string): void {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `${this.providerLabel} rate limit exceeded for ${this.config.model} after ${MAX_RETRIES + 1} attempts. ${lastRateLimitBody.slice(0, 200)}`,
      },
    }));
  }

  private async forwardAnthropicCompatible(
    body: Record<string, unknown>,
    sdkModel: string,
    abort: AbortController,
    res: http.ServerResponse,
  ): Promise<void> {
    body['model'] = this.config.model;
    const targetUrl = `${this.config.targetBaseUrl}${ALLOWED_PATH}`;
    const requestBody = JSON.stringify(body);
    const headers = this.buildProviderHeaders();

    let upstream: Response | null = null;
    let lastRateLimitBody = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abort.signal.aborted) return;
      upstream = await fetch(targetUrl, { method: 'POST', headers, body: requestBody, signal: abort.signal });
      if (upstream.status !== 429) break;

      lastRateLimitBody = await upstream.text();
      log('[ExploreProxy] %s rate limited (429) attempt %d/%d: %s', this.providerLabel, attempt + 1, MAX_RETRIES + 1, lastRateLimitBody.slice(0, 300));
      if (attempt < MAX_RETRIES) await this.backoff(attempt, abort);
    }

    if (!upstream || upstream.status === 429) {
      this.writeRateLimitResponse(res, lastRateLimitBody);
      return;
    }

    const contentType = upstream.headers.get('Content-Type') || 'application/json';
    log('[ExploreProxy] ← %d %s', upstream.status, contentType);
    res.writeHead(upstream.status, { 'Content-Type': contentType });

    if (!upstream.body) {
      if (!res.destroyed) res.end();
      return;
    }

    const needsRewrite = Boolean(sdkModel) && this.config.model !== sdkModel;
    if (!needsRewrite) {
      await pipeRaw(upstream.body, res);
    } else if (contentType.includes('text/event-stream')) {
      await pipeSSEWithModelRewrite(upstream.body, res, this.config.model, sdkModel);
    } else {
      await pipeJSONWithModelRewrite(upstream.body, res, this.config.model, sdkModel);
    }

    if (!res.destroyed) res.end();
  }

  private async forwardGemini(
    body: Record<string, unknown>,
    sdkModel: string,
    abort: AbortController,
    res: http.ServerResponse,
  ): Promise<void> {
    const isStream = body['stream'] === true;
    const geminiBody = convertAnthropicToGemini(body);
    const geminiUrl = buildGeminiUrl(this.config.targetBaseUrl, this.config.model, isStream);
    const requestBody = JSON.stringify(geminiBody);
    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.config.apiKey,
    };

    log('[ExploreProxy] Gemini → %s', geminiUrl);

    let upstream: Response | null = null;
    let lastRateLimitBody = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abort.signal.aborted) return;
      upstream = await fetch(geminiUrl, { method: 'POST', headers, body: requestBody, signal: abort.signal });
      if (upstream.status !== 429) break;

      lastRateLimitBody = await upstream.text();
      log('[ExploreProxy] Gemini rate limited (429) attempt %d/%d: %s', attempt + 1, MAX_RETRIES + 1, lastRateLimitBody.slice(0, 300));
      if (attempt < MAX_RETRIES) await this.backoff(attempt, abort);
    }

    if (!upstream || upstream.status === 429) {
      this.writeRateLimitResponse(res, lastRateLimitBody);
      return;
    }

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      log('[ExploreProxy] Gemini error %d: %s', upstream.status, errorBody.slice(0, 500));
      res.writeHead(upstream.status >= 500 ? 502 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: upstream.status >= 500 ? 'api_error' : 'invalid_request_error',
          message: `Gemini API error ${upstream.status}: ${errorBody.slice(0, 300)}`,
        },
      }));
      return;
    }

    log('[ExploreProxy] Gemini ← %d', upstream.status);

    if (isStream && upstream.body) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const transformer = new GeminiToAnthropicStream(sdkModel);
      const reader = upstream.body.getReader();
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      let chunkCount = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.destroyed) break;

          buffer += decoder.write(Buffer.from(value));
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;
            chunkCount++;
            for (const event of transformer.processLine(data)) {
              res.write(event);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      buffer += decoder.end();
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data) {
          for (const event of transformer.processLine(data)) res.write(event);
        }
      }

      for (const event of transformer.flush()) res.write(event);
      log('[ExploreProxy] Gemini stream done: %d SSE chunks', chunkCount);
      if (!res.destroyed) res.end();
    } else if (upstream.body) {
      const text = await new Response(upstream.body).text();
      const geminiResponse = JSON.parse(text);
      const anthropicResponse = convertGeminiResponse(geminiResponse, sdkModel);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anthropicResponse));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: sdkModel,
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }));
    }
  }

  private backoff(attempt: number, abort: AbortController): Promise<void> {
    const delay = BASE_DELAY_MS * Math.pow(2, attempt);
    log('[ExploreProxy] Retrying in %dms', delay);
    return new Promise<void>(r => {
      const timer = setTimeout(r, delay);
      abort.signal.addEventListener('abort', () => { clearTimeout(timer); r(); }, { once: true });
    });
  }
}

async function pipeRaw(body: ReadableStream<Uint8Array>, res: http.ServerResponse): Promise<void> {
  const reader = body.getReader();
  let chunkCount = 0;
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      chunkCount++;
      totalBytes += value.byteLength;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  log('[ExploreProxy] stream done: %d chunks, %d bytes', chunkCount, totalBytes);
}

function rewriteModelField(value: unknown, fromModel: string, toModel: string): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteModelField(item, fromModel, toModel);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (key === 'model' && typeof child === 'string' && child === fromModel) {
      obj[key] = toModel;
    } else if (typeof child === 'object' && child !== null) {
      rewriteModelField(child, fromModel, toModel);
    }
  }
}

async function pipeSSEWithModelRewrite(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  fromModel: string,
  toModel: string,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let chunkCount = 0;

  const flushCompleteEvents = (): void => {
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx + 2);
      buffer = buffer.slice(idx + 2);
      res.write(rewriteSSEEvent(event, fromModel, toModel));
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      chunkCount++;
      buffer += decoder.write(Buffer.from(value));
      flushCompleteEvents();
    }
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.end();
  flushCompleteEvents();
  if (buffer.length > 0) {
    res.write(rewriteSSEEvent(buffer, fromModel, toModel));
  }
  log('[ExploreProxy] SSE rewrite stream done: %d chunks', chunkCount);
}

function rewriteSSEEvent(event: string, fromModel: string, toModel: string): string {
  return event.replace(/^data: (.+)$/gm, (_line, jsonPart: string) => {
    try {
      const parsed = JSON.parse(jsonPart);
      rewriteModelField(parsed, fromModel, toModel);
      return `data: ${JSON.stringify(parsed)}`;
    } catch {
      return `data: ${jsonPart}`;
    }
  });
}

async function pipeJSONWithModelRewrite(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  fromModel: string,
  toModel: string,
): Promise<void> {
  const text = await new Response(body).text();
  try {
    const parsed = JSON.parse(text);
    rewriteModelField(parsed, fromModel, toModel);
    res.write(JSON.stringify(parsed));
  } catch {
    res.write(text);
  }
}
