import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { Socket } from 'net';
import { createHash } from 'crypto';
import { AddressInfo } from 'net';
import { CdpSocket, CdpTimeoutError } from '../cdp-socket';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

// Encode a server to client text frame. Per RFC 6455 server frames are UNMASKED, so the mask bit
// stays clear and no masking key is appended.
function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

describe('CdpSocket send() timeout', () => {
  let server: Server;
  let port: number;
  let upgradedSockets: Socket[] = [];
  let socket: CdpSocket;
  // Reflects whether the server should answer CDP messages. When true, the server echoes a result
  // frame for the incoming id; when false it stays silent so the client side timeout fires.
  let answerRequests = false;
  // When true, the answer is a CDP error frame instead of a result, exercising the reject path.
  let answerWithError = false;

  beforeEach(async () => {
    upgradedSockets = [];
    answerRequests = false;
    answerWithError = false;
    server = createServer();
    server.on('upgrade', (req, rawSocket) => {
      const key = req.headers['sec-websocket-key'] as string;
      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '\r\n',
      ].join('\r\n');
      rawSocket.write(responseHeaders);
      upgradedSockets.push(rawSocket as Socket);

      // The server only decodes enough to learn the client message id, then optionally answers.
      rawSocket.on('data', (data: Buffer) => {
        if (!answerRequests) return;
        const id = extractClientMessageId(data);
        if (id !== null) {
          const reply = answerWithError
            ? { id, error: { code: -32000, message: 'boom' } }
            : { id, result: {} };
          rawSocket.write(encodeServerTextFrame(JSON.stringify(reply)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    socket = new CdpSocket();
    await socket.connect(`ws://127.0.0.1:${port}/`);
  });

  afterEach(async () => {
    socket.close();
    for (const s of upgradedSockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects with a descriptive error when a response never arrives', async () => {
    await expect(socket.send('Foo.bar', undefined, undefined, 50)).rejects.toThrow(
      /Foo\.bar.*timed out/,
    );
  });

  it('drains the callback so a later close does not double reject the timed out id', async () => {
    await expect(socket.send('Foo.bar', undefined, undefined, 50)).rejects.toThrow(/timed out/);
    // Give the event loop a tick past the timeout, then close. If the callback were still present it
    // would reject a second time and Node would report an unhandled rejection, failing the run.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(() => socket.close()).not.toThrow();
  });

  it('resolves normally when a response arrives before the timeout and the timer never fires late', async () => {
    answerRequests = true;
    // The socket increments nextId from 1; this is the first send so the server will answer id 1.
    const result = await socket.send('Foo.bar', undefined, undefined, 1_000);
    expect(result).toEqual({});
    // Wait beyond a hypothetical short timeout window to prove no late rejection surfaces.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  });

  it('rejects with a CdpTimeoutError carrying the method and timeout', async () => {
    const err = await socket.send('Slow.op', undefined, undefined, 40).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpTimeoutError);
    expect((err as CdpTimeoutError).method).toBe('Slow.op');
    expect((err as CdpTimeoutError).timeoutMs).toBe(40);
  });

  it('honours a custom timeoutMs shorter than the default', async () => {
    const started = Date.now();
    await expect(socket.send('Foo.bar', undefined, undefined, 60)).rejects.toBeInstanceOf(CdpTimeoutError);
    // Well under the 15s default: proves the override is used, not the default.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rejects with the CDP error payload when the reply carries an error', async () => {
    answerRequests = true;
    answerWithError = true;
    await expect(socket.send('Foo.bar', undefined, undefined, 1_000)).rejects.toThrow(/boom/);
  });

  it('rejects pending sends when the socket closes mid-flight and fires close handler once', async () => {
    let closeCount = 0;
    socket.onClose(() => { closeCount++; });
    const pending = socket.send('Never.answered', undefined, undefined, 5_000);
    const rejection = expect(pending).rejects.toThrow(/socket closed/);
    socket.close();
    await rejection;
    // A redundant close (e.g. the socket 'close' event after an explicit close) must not re-fire.
    socket.close();
    expect(closeCount).toBe(1);
  });
});

// Minimal client to server frame decoder: reads a single masked text frame and returns its JSON id.
// Client frames are always masked per RFC 6455, so we unmask before parsing. This assumes each 'data'
// event carries exactly one whole frame, which holds for the small single-message sends in these
// tests; it does NOT handle coalesced or split frames and is not a general WebSocket parser.
function extractClientMessageId(buffer: Buffer): number | null {
  if (buffer.length < 2) return null;
  const isMasked = (buffer[1]! & 0x80) !== 0;
  let payloadLen = buffer[1]! & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey: Buffer | null = null;
  if (isMasked) {
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
  }
  try {
    const msg = JSON.parse(payload.toString('utf8')) as { id?: number };
    return msg.id ?? null;
  } catch {
    return null;
  }
}
