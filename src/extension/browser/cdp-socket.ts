import { request as httpRequest } from 'http';
import { randomBytes } from 'crypto';
import type { Socket } from 'net';
import { log } from '../logger';

type CdpCallback = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Thrown when a CDP command receives no reply within its timeout window. */
export class CdpTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`CDP ${method} timed out after ${timeoutMs}ms`);
    this.name = 'CdpTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

const MAX_FRAME_SIZE = 100 * 1024 * 1024;

export class CdpSocket {
  private socket: Socket | null = null;
  private nextId = 0;
  private callbacks = new Map<number, CdpCallback>();
  private buffer = Buffer.alloc(0);
  private fragmentBuffer: Buffer[] = [];
  private fragmentOpcode = 0;
  private eventHandler: ((method: string, params: unknown, sessionId?: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;

  get connected(): boolean {
    return this.socket !== null;
  }

  onEvent(handler: (method: string, params: unknown, sessionId?: string) => void): void {
    this.eventHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  connect(wsUrl: string): Promise<void> {
    const url = new URL(wsUrl);
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: parseInt(url.port, 10),
          path: url.pathname + url.search,
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': key,
            'Sec-WebSocket-Version': '13',
          },
        },
        () => reject(new Error('Expected WebSocket upgrade, got HTTP response')),
      );

      req.on('upgrade', (_res, socket, head) => {
        this.socket = socket as Socket;
        if (head.length > 0) {
          this.buffer = Buffer.concat([this.buffer, head]);
        }
        socket.on('data', (data: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, data]);
          this.drainFrames();
        });
        socket.on('close', () => this.handleSocketClose());
        socket.on('error', (err) => log(`[CdpSocket] socket error: ${err.message}`));
        resolve();
      });

      req.on('error', reject);
      req.setTimeout(10_000, () => req.destroy(new Error('WebSocket handshake timeout')));
      req.end();
    });
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('CdpSocket not connected'));
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.callbacks.set(id, { resolve, reject, timer });
      const msg: Record<string, unknown> = { id, method };
      if (params) msg['params'] = params;
      if (sessionId) msg['sessionId'] = sessionId;
      this.writeTextFrame(JSON.stringify(msg));
    });
  }

  close(): void {
    if (!this.socket) return;
    try {
      const mask = randomBytes(4);
      const frame = Buffer.alloc(6);
      frame[0] = 0x88;
      frame[1] = 0x80;
      mask.copy(frame, 2);
      this.socket.write(frame);
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
    this.handleSocketClose();
  }

  private writeTextFrame(text: string): void {
    const payload = Buffer.from(text, 'utf8');
    const mask = randomBytes(4);
    const len = payload.length;

    let header: Buffer;
    if (len <= 125) {
      header = Buffer.alloc(6);
      header[0] = 0x81;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len <= 65535) {
      header = Buffer.alloc(8);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
      mask.copy(header, 10);
    }

    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    this.socket!.write(Buffer.concat([header, masked]));
  }

  private sendPong(payload: Buffer): void {
    if (!this.socket) return;
    const mask = randomBytes(4);
    const len = payload.length;

    let header: Buffer;
    if (len <= 125) {
      header = Buffer.alloc(6);
      header[0] = 0x8A;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else {
      header = Buffer.alloc(8);
      header[0] = 0x8A;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    }

    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    this.socket.write(Buffer.concat([header, masked]));
  }

  private drainFrames(): void {
    while (true) {
      if (this.buffer.length < 2) return;

      const byte0 = this.buffer[0]!;
      const byte1 = this.buffer[1]!;
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const isMasked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let headerSize = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        headerSize = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        if (payloadLen > MAX_FRAME_SIZE) {
          this.handleSocketClose();
          return;
        }
        headerSize = 10;
      }

      if (isMasked) headerSize += 4;
      const totalSize = headerSize + payloadLen;
      if (this.buffer.length < totalSize) return;

      let payload = this.buffer.subarray(headerSize, totalSize);
      if (isMasked) {
        const maskKey = this.buffer.subarray(headerSize - 4, headerSize);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
      }

      this.buffer = this.buffer.subarray(totalSize);

      if (opcode === 0x0) {
        this.fragmentBuffer.push(Buffer.from(payload));
        if (fin) {
          const full = Buffer.concat(this.fragmentBuffer);
          this.fragmentBuffer = [];
          if (this.fragmentOpcode === 0x1) this.handleCdpMessage(full.toString('utf8'));
        }
      } else if (opcode === 0x1) {
        if (fin) {
          this.handleCdpMessage(payload.toString('utf8'));
        } else {
          this.fragmentOpcode = opcode;
          this.fragmentBuffer = [Buffer.from(payload)];
        }
      } else if (opcode === 0x8) {
        this.handleSocketClose();
        return;
      } else if (opcode === 0x9) {
        this.sendPong(payload);
      }
    }
  }

  private handleCdpMessage(text: string): void {
    try {
      const msg = JSON.parse(text) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: unknown;
        sessionId?: string;
      };
      if (msg.id !== undefined) {
        const cb = this.callbacks.get(msg.id);
        if (cb) {
          this.callbacks.delete(msg.id);
          clearTimeout(cb.timer);
          if (msg.error) cb.reject(new Error(JSON.stringify(msg.error)));
          else cb.resolve(msg.result);
        }
      } else if (msg.method) {
        this.eventHandler?.(msg.method, msg.params, msg.sessionId);
      }
    } catch {
      log(`[CdpSocket] Failed to parse CDP message (${text.length} chars)`);
    }
  }

  private handleSocketClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.callbacks.values()) {
      clearTimeout(cb.timer);
      cb.reject(new Error('CDP socket closed'));
    }
    this.callbacks.clear();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragmentBuffer = [];
    this.closeHandler?.();
  }
}
