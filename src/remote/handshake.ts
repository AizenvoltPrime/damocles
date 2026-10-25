// The handshake (frozen), all Control messages. The bridge and the daemon prove to each other that they hold the daemon
// token without sending it; then the app sends hello and the daemon answers welcome or refused. Each side runs one listener
// attached before its first message, so no step awaits before the next one can be received.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CodecError, decode, encode } from './codec';
import type { Disposable, PersistentProtocol } from './persistent-protocol';

export const NONCE_BYTES = 32;
export const AUTH_TIMEOUT_MS = 10_000;
export const HELLO_TIMEOUT_MS = 30_000;
// The protocol bound before authentication and the parse bounds of every handshake message; a welcome with every field at
// its limit (MAX_FEATURES names, two MAX_TEXT paths at 3 UTF-8 bytes per unit) must fit in both.
export const HANDSHAKE_MAX_BYTES: number = 64 * 1024;
const HANDSHAKE_MAX_ITEMS = 512;
const MAX_TEXT = 4096;
const MAX_FEATURES = 256;
const DAEMON_LABEL = Buffer.from('damocles-daemon');
const BRIDGE_LABEL = Buffer.from('damocles-bridge');

export class HandshakeError extends Error {
  override readonly name = 'HandshakeError';
}

export type OsName = 'linux' | 'darwin' | 'win32';

// What the app needs of the target before any path or shell crosses.
export interface HostFacts {
  readonly os: OsName;
  readonly arch: string;
  // null off Linux
  readonly libc: 'glibc' | 'musl' | null;
  readonly homedir: string;
  // the login shell, or the default shell on Windows
  readonly shell: string;
  readonly gitAvailable: boolean;
  readonly pathFlavor: 'posix' | 'win32';
}

export interface Hello {
  readonly appVersion: string;
  readonly protocolVersion: number;
  readonly clientId: string;
  readonly deviceName: string;
  // Date.now() on the client as it sent hello
  readonly clientTime: number;
  readonly reconnectionToken?: Uint8Array;
}

export interface Welcome {
  readonly serverVersion: string;
  readonly protocolVersion: number;
  readonly features: readonly string[];
  readonly facts: HostFacts;
  readonly reconnectionToken: Uint8Array;
  readonly resumed: boolean;
  // the running Damocles Core's epoch; null while the daemon runs none
  readonly coreEpoch: string | null;
  readonly serverTime: number;
}

export type RefusedReason = 'protocol' | 'unknown-token';

export interface Refused {
  readonly reason: RefusedReason;
  // the daemon's, so the app can say which version runs there
  readonly serverVersion: string;
  readonly protocolVersion: number;
}

export type HelloAnswer = { readonly kind: 'welcome'; readonly welcome: Welcome } | { readonly kind: 'refused'; readonly refused: Refused };

// skewMs: serverTime minus the midpoint of hello's send and welcome's receipt, on the client's clock
export type HelloOutcome = { readonly kind: 'welcome'; readonly welcome: Welcome; readonly skewMs: number } | { readonly kind: 'refused'; readonly refused: Refused };

type Fields = Record<string, unknown>;

function parseFields(body: Uint8Array): Fields | undefined {
  let value: unknown;
  try {
    value = decode(body, { maxBytes: HANDSHAKE_MAX_BYTES, maxItems: HANDSHAKE_MAX_ITEMS, maxDepth: 4 });
  } catch (err) {
    if (err instanceof CodecError) return undefined;
    throw err;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
}

// Every text a peer sends reaches log lines or UI: versions and names keep to a narrow alphabet, a device name drops nothing
// but may hold no control, format or line separator character.
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const isVersionText = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);
const isName = (value: unknown): value is string => typeof value === 'string' && NAME.test(value);
const isDisplayText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !UNSAFE_TEXT.test(value);

const field = (fields: Fields, key: string): unknown => (Object.hasOwn(fields, key) ? fields[key] : undefined);
const isBytes = (value: unknown, length: number): value is Uint8Array => value instanceof Uint8Array && value.length === length;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function proof(token: Uint8Array, label: Buffer, first: Uint8Array, second: Uint8Array): Buffer {
  return createHmac('sha256', token).update(label).update(first).update(second).digest();
}

// timingSafeEqual throws on a length difference, so the length is checked first.
function proves(candidate: unknown, expected: Buffer): boolean {
  return candidate instanceof Uint8Array && candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function parseHello(fields: Fields): Hello | undefined {
  const appVersion = field(fields, 'appVersion');
  const protocolVersion = field(fields, 'protocolVersion');
  const clientId = field(fields, 'clientId');
  const deviceName = field(fields, 'deviceName');
  const clientTime = field(fields, 'clientTime');
  const reconnectionToken = field(fields, 'reconnectionToken');
  if (field(fields, 'type') !== 'hello' || !isVersionText(appVersion) || !isVersion(protocolVersion) || !isName(clientId)) return undefined;
  if (!isDisplayText(deviceName, 256) || !isTime(clientTime) || (reconnectionToken !== undefined && !isBytes(reconnectionToken, NONCE_BYTES))) return undefined;
  return { appVersion, protocolVersion, clientId, deviceName, clientTime, ...(reconnectionToken !== undefined ? { reconnectionToken } : {}) };
}

function parseFacts(raw: unknown): HostFacts | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const fields = raw as Fields;
  const os = field(fields, 'os');
  const arch = field(fields, 'arch');
  const libc = field(fields, 'libc');
  const homedir = field(fields, 'homedir');
  const shell = field(fields, 'shell');
  const gitAvailable = field(fields, 'gitAvailable');
  const pathFlavor = field(fields, 'pathFlavor');
  if (os !== 'linux' && os !== 'darwin' && os !== 'win32') return undefined;
  if (!isName(arch) || (libc !== 'glibc' && libc !== 'musl' && libc !== null) || !isDisplayText(homedir, MAX_TEXT) || homedir === '' || !isDisplayText(shell, MAX_TEXT)) return undefined;
  if (typeof gitAvailable !== 'boolean' || (pathFlavor !== 'posix' && pathFlavor !== 'win32')) return undefined;
  return { os, arch, libc, homedir, shell, gitAvailable, pathFlavor };
}

function parseAnswer(fields: Fields): HelloAnswer | undefined {
  const type = field(fields, 'type');
  const serverVersion = field(fields, 'serverVersion');
  const protocolVersion = field(fields, 'protocolVersion');
  if (!isVersionText(serverVersion) || !isVersion(protocolVersion)) return undefined;
  if (type === 'refused') {
    const reason = field(fields, 'reason');
    return reason === 'protocol' || reason === 'unknown-token' ? { kind: 'refused', refused: { reason, serverVersion, protocolVersion } } : undefined;
  }
  if (type !== 'welcome') return undefined;
  const features = field(fields, 'features');
  const facts = parseFacts(field(fields, 'facts'));
  const reconnectionToken = field(fields, 'reconnectionToken');
  const resumed = field(fields, 'resumed');
  const coreEpoch = field(fields, 'coreEpoch');
  const serverTime = field(fields, 'serverTime');
  if (!Array.isArray(features) || features.length > MAX_FEATURES || !features.every(isName)) return undefined;
  if (!facts || !isBytes(reconnectionToken, NONCE_BYTES) || typeof resumed !== 'boolean' || (coreEpoch !== null && !isName(coreEpoch)) || !isTime(serverTime)) return undefined;
  return { kind: 'welcome', welcome: { serverVersion, protocolVersion, features: [...(features as string[])], facts, reconnectionToken, resumed, coreEpoch, serverTime } };
}

function encodeAnswer(answer: HelloAnswer): Uint8Array {
  return answer.kind === 'welcome'
    ? encode({ type: 'welcome', ...answer.welcome, features: [...answer.welcome.features], facts: { ...answer.welcome.facts } })
    : encode({ type: 'refused', ...answer.refused });
}

/**
 * The bridge's side: proves the endpoint holds the token and then proves its own. Rejects when the endpoint is not this user's
 * daemon, having sent it nothing but the first nonce. agentSock names the forwarded SSH agent's socket.
 */
export function authenticateBridge(protocol: PersistentProtocol, token: Uint8Array, agentSock?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const bridgeNonce = randomBytes(NONCE_BYTES);
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new HandshakeError(`the daemon did not answer within ${AUTH_TIMEOUT_MS} ms`)), AUTH_TIMEOUT_MS);
    const subscriptions: Disposable[] = [];
    subscriptions.push(protocol.onControl((body) => {
      const fields = parseFields(body);
      const daemonNonce = fields && field(fields, 'nonce');
      if (!fields || !isBytes(daemonNonce, NONCE_BYTES) || !proves(field(fields, 'proof'), proof(token, DAEMON_LABEL, bridgeNonce, daemonNonce))) {
        finish(new HandshakeError('the endpoint is not this user\'s daemon'));
        return;
      }
      protocol.sendControl(encode({ proof: proof(token, BRIDGE_LABEL, daemonNonce, bridgeNonce), ...(agentSock !== undefined ? { agentSock } : {}) }));
      finish();
    }));
    subscriptions.push(protocol.onClose((reason) => finish(new HandshakeError(`the daemon closed the connection: ${reason}`))));
    protocol.sendControl(encode({ v: 1, nonce: bridgeNonce }));
  });
}

export interface AcceptOptions {
  readonly protocol: PersistentProtocol;
  readonly token: Uint8Array;
  // the answer to an authenticated client's hello
  readonly answer: (hello: Hello) => HelloAnswer;
  // called synchronously once the answer is sent, so its listeners see a message pipelined behind hello
  readonly accepted: (accepted: Accepted) => void;
  // the connection closed, without an answer to hello
  readonly failed: (reason: string) => void;
  readonly authTimeoutMs?: number;
}

export interface Accepted {
  readonly hello: Hello;
  readonly answer: HelloAnswer;
  // the bridge's forwarded SSH agent socket
  readonly agentSock?: string;
}

/**
 * The daemon's side. Before the bridge's proof checks out it writes only its challenge answer; a connection that has not
 * authenticated within the deadline, or sends anything out of turn, is closed with nothing more written. Attach the
 * connection's other listeners in `accepted`, never after an await.
 */
export function acceptConnection(options: AcceptOptions): void {
  const { protocol, token } = options;
  const daemonNonce = randomBytes(NONCE_BYTES);
  let bridgeNonce: Uint8Array | undefined;
  let agentSock: string | undefined;
  let authenticated = false;
  let settled = false;
  const fail = (reason: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    subscriptions.forEach((subscription) => subscription.dispose());
    protocol.close(reason);
    options.failed(reason);
  };
  let timer = setTimeout(() => fail(`no authentication within ${options.authTimeoutMs ?? AUTH_TIMEOUT_MS} ms`), options.authTimeoutMs ?? AUTH_TIMEOUT_MS);
  const control = (body: Uint8Array): void => {
    if (settled) return;
    const fields = parseFields(body);
    if (!fields) {
      fail('a handshake message that does not decode');
      return;
    }
    if (!bridgeNonce) {
      const nonce = field(fields, 'nonce');
      if (field(fields, 'v') !== 1 || !isBytes(nonce, NONCE_BYTES)) {
        fail('a first message that is not the bridge\'s challenge');
        return;
      }
      bridgeNonce = nonce;
      protocol.sendControl(encode({ nonce: daemonNonce, proof: proof(token, DAEMON_LABEL, bridgeNonce, daemonNonce) }));
      return;
    }
    if (!authenticated) {
      const sock = field(fields, 'agentSock');
      if (!proves(field(fields, 'proof'), proof(token, BRIDGE_LABEL, daemonNonce, bridgeNonce)) || (sock !== undefined && !isDisplayText(sock, MAX_TEXT))) {
        fail('the bridge did not prove the token');
        return;
      }
      authenticated = true;
      agentSock = sock;
      clearTimeout(timer);
      timer = setTimeout(() => fail(`no hello within ${HELLO_TIMEOUT_MS} ms`), HELLO_TIMEOUT_MS);
      return;
    }
    const hello = parseHello(fields);
    if (!hello) {
      fail('a malformed hello');
      return;
    }
    let answer: HelloAnswer;
    try {
      answer = options.answer(hello);
    } catch (err) {
      fail(`answering hello failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    settled = true;
    clearTimeout(timer);
    subscriptions.forEach((subscription) => subscription.dispose());
    protocol.sendControl(encodeAnswer(answer));
    options.accepted({ hello, answer, ...(agentSock !== undefined ? { agentSock } : {}) });
  };
  const subscriptions: Disposable[] = [];
  subscriptions.push(
    protocol.onControl(control),
    protocol.onMessage(() => fail('a regular message before the handshake finished')),
    protocol.onClose((reason) => fail(reason)),
  );
}

/** The app's side, after the bridge authenticated: hello, and the daemon's welcome or refusal with the measured clock skew. */
export function sayHello(protocol: PersistentProtocol, hello: Omit<Hello, 'clientTime'>, timeoutMs: number = HELLO_TIMEOUT_MS): Promise<HelloOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sentAt = Date.now();
    const finish = (outcome: HelloOutcome | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(() => finish(new HandshakeError(`the daemon did not answer hello within ${timeoutMs} ms`)), timeoutMs);
    const subscriptions: Disposable[] = [];
    subscriptions.push(protocol.onControl((body) => {
      const fields = parseFields(body);
      const answer = fields && parseAnswer(fields);
      if (!answer) {
        finish(new HandshakeError('the daemon answered hello outside the contract'));
        protocol.close('a malformed answer to hello');
        return;
      }
      if (answer.kind === 'refused') {
        finish(answer);
        return;
      }
      if (answer.welcome.protocolVersion !== hello.protocolVersion) {
        finish(new HandshakeError(`the daemon welcomed protocol ${answer.welcome.protocolVersion}, not ${hello.protocolVersion}`));
        protocol.close('a welcome for another protocol version');
        return;
      }
      finish({ kind: 'welcome', welcome: answer.welcome, skewMs: answer.welcome.serverTime - (sentAt + Date.now()) / 2 });
    }));
    subscriptions.push(protocol.onClose((reason) => finish(new HandshakeError(`the connection closed before welcome: ${reason}`))));
    protocol.sendControl(encode({ type: 'hello', ...hello, clientTime: sentAt }));
  });
}
