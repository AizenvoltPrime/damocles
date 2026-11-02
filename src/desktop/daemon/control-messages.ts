// ControlContract: the `control` channel. listRuns, shutdownWhenIdle, shutdownNow and mirror.sync are frozen: their shapes
// never change, and they stay served after `refused { reason: 'protocol' }`.

import type { Call, ClientAuth, ClientPolicy, ClientUser, Contract, MirrorTopics, Tables } from '../core-protocol/messages';
import { MAIN_TO_CORE, parseClientValues, MAX_ITEMS, MAX_LABEL_CHARS, MAX_PATH_CHARS } from '../core-protocol/messages';
import { arr, bool, bytes, either, int, INVALID, nonEmpty, none, num, obj, oneOf, opt, str, streamId, type Parser } from '../core-protocol/schema';
import { isCliPath, PACKAGE_FILE } from './container-commands';
import { CONTAINER_ENGINES, isContainerId, isContainerPath, isContainerUser, type ContainerEngine } from './container-values';

export const CONTROL_MAX_MESSAGE_BYTES: number = 8 * 1024 * 1024;
// the most of one log a logs.read returns
export const MAX_LOG_READ_BYTES: number = 4 * 1024 * 1024;
// the longest terminal idle limit; 0 keeps a terminal no client attaches forever
export const MAX_TERMINAL_IDLE_DAYS = 3650;
// listRuns is frozen: the daemon clamps a longer title, or one run would fail the whole answer
export const MAX_RUN_TITLE_CHARS = 1024;
// the handshake's bound on a hello's deviceName
export const MAX_DEVICE_NAME_CHARS = 256;
// a user name as `loginctl enable-linger` takes it, SSSD's and Active Directory's `@` and `\` included (systemd's relaxed
// name rule: one file name, not numeric); never option-like or holding a control, format or line separator character
export const LINGER_USER: RegExp = /^(?![-\s])(?!\d+$)(?!\.{1,2}$)[^\p{Cc}\p{Cf}\u2028\u2029:/]{1,255}(?<!\s)$/u;
// the public key Damocles generates: one ssh-ed25519 line with its damocles@<client> comment
export const DAMOCLES_PUBLIC_KEY: RegExp = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} damocles@[A-Za-z0-9._-]{1,128}$/;
// a run folder's key: 16 hex digits of the machine id's HMAC
export const RUN_KEY: RegExp = /^[0-9a-f]{16}$/;
// another machine's hostname as its pid file in this home names it: a DNS name, or a Windows computer name
export const OTHER_HOSTNAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
export const MAX_SHARED_HOME_HOSTS = 16;
// log names are single path segments under the daemon's log folder
export const LOG_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface Run {
  readonly kind: 'chat' | 'terminal';
  readonly id: string;
  // the native folder key on the target; empty for a terminal no project started
  readonly projectKey: string;
  readonly title: string;
  readonly state: 'running' | 'waiting' | 'background';
  // the providers the run's broker cache used; empty for a terminal
  readonly providers: readonly string[];
}

export interface MirrorFile {
  // relative to the project's session folder, '/'-separated
  readonly file: string;
  readonly size: number;
  // sha256 hex of the first 4 KiB, and of the 4 KiB before size
  readonly headHash: string;
  readonly tailHash: string;
}

// append: bytes from offset; full: the whole file; deleted: drop it (offset, length and stream 0). stream: the daemon-opened
// stream channel that carries the change's length bytes, then ends.
export interface MirrorChange {
  readonly file: string;
  readonly kind: 'append' | 'full' | 'deleted';
  readonly offset: number;
  readonly length: number;
  readonly stream: number;
}

// what the client holds of the target's sub-call ledger, whose place is fixed on both sides, so no name crosses
export interface MirrorHeld {
  readonly size: number;
  // sha256 hex of the first 4 KiB, and of the 4 KiB before size
  readonly headHash: string;
  readonly tailHash: string;
}

// a change to the sub-call ledger, as MirrorChange for a session file
export interface MirrorLedgerChange {
  readonly kind: 'append' | 'full' | 'deleted';
  readonly offset: number;
  readonly length: number;
  readonly stream: number;
}

export interface LogEntry {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** The daemon's Damocles Core. epoch: 32 hex characters drawn at each start, null before the first; ppid: the daemon's pid. */
export interface CoreState {
  readonly epoch: string | null;
  readonly phase: 'starting' | 'running' | 'restarting' | 'halted';
  // restarts in the current restart window (restart-policy.ts)
  readonly restarts: number;
  readonly pid: number | null;
  readonly ppid: number | null;
}

/**
 * A client's attach to the core channel: generation `attach` (larger than every earlier one of the connection) frames each
 * channel message from then on. hostId is this client's id for the host, whose secrets namespace is remote/<hostId>/.
 */
export interface CoreAttach {
  readonly attach: number;
  readonly hostId: string;
  readonly appInfo: { readonly version: string; readonly host: 'desktop' };
  readonly secretsPersistent: boolean;
  readonly chatBrowserPane: boolean;
  // version-0 values of the mirrors the daemon takes from clients
  readonly mirrors: {
    readonly trust: { readonly keys: readonly string[] };
    readonly folders: MirrorTopics['folders'];
    readonly editor: MirrorTopics['editor'];
    readonly terminal: MirrorTopics['terminal'];
    readonly language: MirrorTopics['language'];
    readonly clientAuth: ClientAuth;
    readonly clientUser: ClientUser;
    readonly clientPolicy: ClientPolicy;
  };
}

// the host namespace of a client's secrets (remote/<hostId>/), so it is one safe path segment
export const HOST_ID: RegExp = /^[A-Za-z0-9_-]{1,64}$/;

export interface ControlRequests {
  // the client's values the daemon takes; the latest attach's terminalIdleDays applies. watchClients: the client takes
  // `clients` events from then on (welcome.features lists clients)
  attach: Call<{ readonly terminalIdleDays: number; readonly watchClients?: boolean }, void>;
  listRuns: Call<object, { readonly runs: readonly Run[] }>;
  shutdownWhenIdle: Call<object, void>;
  // answers, then ends every terminal and exits
  shutdownNow: Call<object, void>;
  'mirror.sync': Call<{ readonly projectKey: string; readonly budgetBytes: number; readonly files: readonly MirrorFile[] }, { readonly changes: readonly MirrorChange[] }>;
  'logs.list': Call<object, { readonly logs: readonly LogEntry[] }>;
  // bytes from offset, at most length; size is the log's size as read
  'logs.read': Call<{ readonly name: string; readonly offset: number; readonly length: number }, { readonly bytes: Uint8Array; readonly size: number }>;
  // serves the core channel for attach generation `attach`; the first attach of the daemon's life forks core
  attachCore: Call<CoreAttach, CoreState>;
  coreState: Call<object, CoreState>;
  // a halted core starts with its restart count cleared, a running one restarts; either way with a new epoch
  restartCore: Call<object, CoreState>;
  // answered at once, for the client's latency measurement; called only when welcome.features lists control.ping
  ping: Call<object, object>;
  // loginctl enable-linger for the daemon's own user, without sudo (linger.ts); called only when welcome.features lists linger
  linger: Call<object, LingerResult>;
  // a graceful Disconnect: answers, then ends this connection with no reconnection grace; called only when welcome.features
  // lists control.disconnect
  disconnect: Call<object, void>;
  // appends Damocles' public key to the daemon user's authorized keys unless it is there (authorized-keys.ts); called only
  // when welcome.features lists ssh.installAuthorizedKey
  'ssh.installAuthorizedKey': Call<{ readonly publicKey: string }, InstallKeyResult>;
  // Remove Damocles server: answers this machine's run key, then shuts down as shutdownNow does, ending this connection only
  // once the daemon released its lock; called only when welcome.features lists control.shutdownForRemoval
  shutdownForRemoval: Call<object, { readonly runKey: string }>;
  // the other machines whose daemon used this home lately (token.ts otherHostsInHome); called only when welcome.features lists
  // control.sharedHome
  sharedHome: Call<object, { readonly hosts: readonly string[] }>;
  // listRuns' chat runs whose turn this connection's client started; called only when welcome.features lists
  // control.listOwnRuns
  listOwnRuns: Call<object, { readonly runs: readonly Run[] }>;
  // the target's sub-call ledger (~/.damocles/usage/subcalls.jsonl) by mirror.sync's rules for one file: kept only while it
  // fits budgetBytes, else deleted when held; no change when the client holds it whole. Called only when welcome.features
  // lists mirror.subcalls
  'mirror.syncSubcalls': Call<{ readonly budgetBytes: number; readonly held?: MirrorHeld }, { readonly change?: MirrorLedgerChange }>;
  // a daemon in WSL: its loopback probe listener's port and nonce (port-probe.ts); called only when welcome.features lists
  // control.portProbe, and refused outside WSL
  portProbe: Call<object, { readonly port: number; readonly nonce: string }>;
  // Dev Containers on this host (containers.ts); each called only when welcome.features lists containers. stream: a stream the
  // client opened on this connection, which the daemon claims by its id
  // the devcontainer configuration of a folder, the CLI's own order; null for none
  'containers.config': Call<{ readonly folder: string }, { readonly configPath: string | null }>;
  // `devcontainer up` (removeExisting: Rebuild) or `read-configuration` with the package's Node, its stderr on stream
  'containers.up': Call<ContainerCliTarget & { readonly dataKey: string; readonly removeExisting: boolean; readonly stream: number }, ContainerCliResult>;
  // the data volume's folder given to the container's remote user (container-commands.ts dataOwnerArgs)
  'containers.prepareData': Call<{ readonly engine: ContainerEngine; readonly containerId: string; readonly user: string }, ContainerEngineResult>;
  'containers.readConfiguration': Call<ContainerCliTarget & { readonly trustReadId: string; readonly stream: number }, ContainerCliResult>;
  // `<engine> ps` and `<engine> inspect --type container <ids>`
  'containers.list': Call<{ readonly engine: ContainerEngine }, ContainerEngineResult>;
  'containers.inspect': Call<{ readonly engine: ContainerEngine; readonly ids: readonly string[] }, ContainerEngineResult>;
  // stage 0 under `<engine> exec -i -u <user> <id>`, its stdin and stdout on stream until either ends
  'containers.exec': Call<{ readonly engine: ContainerEngine; readonly containerId: string; readonly user: string; readonly stream: number }, { readonly result: 'started' } | { readonly result: 'engineMissing' }>;
  // the package from this host's package cache (downloaded once from url and checked by sha256 and size) into folder in the
  // container; notCopied: no checked copy could be made, and the stage asks for the upload
  'containers.copyPackage': Call<{ readonly engine: ContainerEngine; readonly containerId: string; readonly folder: string; readonly file: string; readonly sha256: string; readonly size: number; readonly url: string }, { readonly result: 'copied' | 'notCopied' | 'engineMissing' }>;
  // The SSH agent relay (agent-relay.ts); each called only when welcome.features lists agent.relay. agent.relay: this
  // connection's client relays its agent, so each connection on its proxy socket asks it with an agent.request event.
  'agent.relay': Call<object, void>;
  // the client connects request to its agent over stream, a stream it opened on this connection; ok false: the request is gone
  'agent.connect': Call<{ readonly request: number; readonly stream: number }, { readonly ok: boolean }>;
  // the client refuses request; the daemon closes the waiting connection
  'agent.refuse': Call<{ readonly request: number }, void>;
}

export interface ContainerCliTarget {
  readonly engine: ContainerEngine;
  readonly workspaceFolder: string;
  readonly configPath: string;
}

// ran: the CLI's exit code and its stdout, which carries its one result object; engineMissing: no engine on an absolute PATH
export type ContainerCliResult = { readonly result: 'ran'; readonly code: number | null; readonly stdout: string } | { readonly result: 'engineMissing' };
export type ContainerEngineResult = { readonly result: 'ran'; readonly code: number | null; readonly stdout: string; readonly stderr: string } | { readonly result: 'engineMissing' };
// the most of a container command's stdout or stderr an answer carries
export const MAX_CONTAINER_OUTPUT_CHARS: number = 4 * 1024 * 1024;
const MAX_CONTAINER_IDS = 256;

/**
 * installed: the key was appended; present: it was there already; failed: code names why, path the file it concerns (empty
 * for accountFailed). restricted: the first line holding the key carries options that keep it from logging Damocles in.
 */
export type InstallKeyResult =
  | { readonly result: 'installed' | 'present'; readonly path: string }
  | { readonly result: 'failed'; readonly code: InstallKeyFailure; readonly path: string };

export const INSTALL_KEY_FAILURES = ['ownership', 'notFile', 'writeFailed', 'aclFailed', 'accountFailed', 'restricted'] as const;
export type InstallKeyFailure = (typeof INSTALL_KEY_FAILURES)[number];

/**
 * enabled: loginctl turned linger on; alreadyEnabled: logind recorded it before, so nothing ran; refused: polkit refused it,
 * and an admin runs `sudo loginctl enable-linger <user>`; failed: code names why.
 */
export type LingerResult =
  | { readonly result: 'enabled' }
  | { readonly result: 'alreadyEnabled' }
  | { readonly result: 'refused'; readonly user: string }
  | { readonly result: 'failed'; readonly code: string };

/** An attached client as the others see it: its hello's device name, never its client id; self marks the receiving client. */
export interface AttachedClient {
  readonly deviceName: string;
  readonly self: boolean;
}

/** Events the daemon pushes to a client that attached to core. */
export interface ControlEvents {
  // on every change of the core's epoch, phase or pid
  coreState: CoreState;
  // the attached clients, on every attach, detach and replacement; sent only to a client whose attach asked (watchClients)
  clients: { readonly clients: readonly AttachedClient[] };
  // a file under the session folder of a project this connection mirrors changed since its last mirror.sync of that project
  // began; once per such sync (welcome.features lists mirror.changed)
  'mirror.changed': { readonly projectKey: string };
  // the target's sub-call ledger changed since this connection's last mirror.syncSubcalls began; once per such sync
  // (welcome.features lists mirror.subcalls)
  'mirror.subcallsChanged': object;
  // a process connected to this client's agent proxy socket, held until the client's agent.connect or agent.refuse names
  // request; sent only to a connection that called agent.relay
  'agent.request': { readonly request: number };
}

export interface ClientToControl extends Contract {
  readonly requests: ControlRequests;
  readonly events: Record<string, never>;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

export interface ControlToClient extends Contract {
  readonly requests: Record<string, never>;
  readonly events: ControlEvents;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

export type FrozenControl = Pick<ControlRequests, 'listRuns' | 'shutdownWhenIdle' | 'shutdownNow' | 'mirror.sync'>;

export interface FrozenClientToControl extends Contract {
  readonly requests: FrozenControl;
  readonly events: Record<string, never>;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

const method = <P, R>(params: Parser<P>, result: Parser<R>): { readonly params: Parser<P>; readonly result: Parser<R> } => ({ params, result });

const count = int(0, Number.MAX_SAFE_INTEGER);
// port-probe.ts's nonce: PROBE_NONCE_BYTES random bytes in hex
const PROBE_NONCE = /^[0-9a-f]{32}$/;
const hex: Parser<string> = (raw) => (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw) ? raw : INVALID);
const nothing = obj({});
const mirrorFile: Parser<MirrorFile> = obj({ file: nonEmpty(MAX_PATH_CHARS), size: count, headHash: hex, tailHash: hex });
const run: Parser<Run> = obj({
  kind: oneOf(['chat', 'terminal'] as const),
  id: nonEmpty(128),
  projectKey: str(MAX_PATH_CHARS),
  title: str(MAX_RUN_TITLE_CHARS),
  state: oneOf(['running', 'waiting', 'background'] as const),
  providers: arr(nonEmpty(128), 256),
});
const change: Parser<MirrorChange> = obj({ file: nonEmpty(MAX_PATH_CHARS), kind: oneOf(['append', 'full', 'deleted'] as const), offset: count, length: count, stream: count });
const mirrorHeld: Parser<MirrorHeld> = obj({ size: count, headHash: hex, tailHash: hex });
const ledgerChange: Parser<MirrorLedgerChange> = obj({ kind: oneOf(['append', 'full', 'deleted'] as const), offset: count, length: count, stream: count });
const logName: Parser<string> = (raw) => (typeof raw === 'string' && LOG_NAME.test(raw) ? raw : INVALID);
const hostId: Parser<string> = (raw) => (typeof raw === 'string' && HOST_ID.test(raw) ? raw : INVALID);
const nullable = <T>(parser: Parser<T>): Parser<T | null> => (raw) => (raw === null ? null : parser(raw));
const pid = nullable(int(1, 2 ** 32));
export const parseCoreState: Parser<CoreState> = obj({
  epoch: nullable((raw) => (typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw) ? raw : INVALID)),
  phase: oneOf(['starting', 'running', 'restarting', 'halted'] as const),
  restarts: count,
  pid,
  ppid: pid,
});
const coreAttach: Parser<CoreAttach> = obj({
  attach: int(1, Number.MAX_SAFE_INTEGER),
  hostId,
  appInfo: obj({ version: str(MAX_LABEL_CHARS), host: oneOf(['desktop'] as const) }),
  secretsPersistent: bool,
  chatBrowserPane: bool,
  mirrors: obj({
    trust: obj({ keys: arr(nonEmpty(MAX_PATH_CHARS), MAX_ITEMS) }),
    folders: MAIN_TO_CORE.mirrors.folders,
    editor: MAIN_TO_CORE.mirrors.editor,
    terminal: MAIN_TO_CORE.mirrors.terminal,
    language: MAIN_TO_CORE.mirrors.language,
    ...parseClientValues,
  }),
});

// the handshake's rule for a deviceName: no control, format or line separator character
const displayText = (max: number): Parser<string> => (raw) => (typeof raw === 'string' && raw.length <= max && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(raw) ? raw : INVALID);
const lingerResult: Parser<LingerResult> = either(
  obj({ result: oneOf(['enabled', 'alreadyEnabled'] as const) }),
  either(
    obj({ result: oneOf(['refused'] as const), user: (raw) => (typeof raw === 'string' && LINGER_USER.test(raw) ? raw : INVALID) }),
    obj({ result: oneOf(['failed'] as const), code: (raw) => (typeof raw === 'string' && LOG_NAME.test(raw) ? raw : INVALID) }),
  ),
);

const installKeyResult: Parser<InstallKeyResult> = either(
  obj({ result: oneOf(['installed', 'present'] as const), path: nonEmpty(MAX_PATH_CHARS) }),
  obj({ result: oneOf(['failed'] as const), code: oneOf(INSTALL_KEY_FAILURES), path: str(MAX_PATH_CHARS) }),
);
const publicKey: Parser<string> = (raw) => (typeof raw === 'string' && DAMOCLES_PUBLIC_KEY.test(raw) ? raw : INVALID);

const engine = oneOf(CONTAINER_ENGINES);
const checked = <T extends string>(test: (raw: unknown) => raw is T): Parser<T> => (raw) => (test(raw) ? raw : INVALID);
const cliPath = checked(isCliPath);
const agentRequest = int(1, Number.MAX_SAFE_INTEGER);
const cliTarget = { engine, workspaceFolder: cliPath, configPath: cliPath };
const cliResult: Parser<ContainerCliResult> = either(obj({ result: oneOf(['ran'] as const), code: nullable(int(-(2 ** 31), 2 ** 32)), stdout: str(MAX_CONTAINER_OUTPUT_CHARS) }), obj({ result: oneOf(['engineMissing'] as const) }));
const engineResult: Parser<ContainerEngineResult> = either(
  obj({ result: oneOf(['ran'] as const), code: nullable(int(-(2 ** 31), 2 ** 32)), stdout: str(MAX_CONTAINER_OUTPUT_CHARS), stderr: str(MAX_CONTAINER_OUTPUT_CHARS) }),
  obj({ result: oneOf(['engineMissing'] as const) }),
);
const containerId = checked(isContainerId);
const CONTAINER_REQUESTS = {
  'containers.config': method(obj({ folder: cliPath }), obj({ configPath: nullable(cliPath) })),
  'containers.up': method(obj({ ...cliTarget, dataKey: (raw) => (typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw) ? raw : INVALID), removeExisting: bool, stream: streamId }), cliResult),
  'containers.prepareData': method(obj({ engine, containerId, user: checked(isContainerUser) }), engineResult),
  'containers.readConfiguration': method(obj({ ...cliTarget, trustReadId: (raw) => (typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw) ? raw : INVALID), stream: streamId }), cliResult),
  'containers.list': method(obj({ engine }), engineResult),
  'containers.inspect': method(obj({ engine, ids: (raw) => (Array.isArray(raw) && raw.length > 0 && raw.length <= MAX_CONTAINER_IDS && raw.every(isContainerId) ? (raw as string[]) : INVALID) }), engineResult),
  'containers.exec': method(obj({ engine, containerId, user: checked(isContainerUser), stream: streamId }), either(obj({ result: oneOf(['started'] as const) }), obj({ result: oneOf(['engineMissing'] as const) }))),
  'containers.copyPackage': method(
    obj({ engine, containerId, folder: checked(isContainerPath), file: (raw) => (typeof raw === 'string' && PACKAGE_FILE.test(raw) ? raw : INVALID), sha256: hex, size: int(1, Number.MAX_SAFE_INTEGER), url: (raw) => (typeof raw === 'string' && raw.length <= 2048 && /^https?:\/\/[^\s]+$/.test(raw) ? raw : INVALID) }),
    obj({ result: oneOf(['copied', 'notCopied', 'engineMissing'] as const) }),
  ),
} satisfies Partial<Tables<ClientToControl>['requests']>;

const FROZEN_REQUESTS: Tables<FrozenClientToControl>['requests'] = {
  listRuns: method(nothing, obj({ runs: arr(run, MAX_ITEMS) })),
  shutdownWhenIdle: method(nothing, none),
  shutdownNow: method(nothing, none),
  'mirror.sync': method(obj({ projectKey: nonEmpty(MAX_PATH_CHARS), budgetBytes: count, files: arr(mirrorFile, MAX_ITEMS) }), obj({ changes: arr(change, MAX_ITEMS) })),
};

export const CLIENT_TO_CONTROL: Tables<ClientToControl> = {
  requests: {
    ...FROZEN_REQUESTS,
    attach: method(obj({ terminalIdleDays: int(0, MAX_TERMINAL_IDLE_DAYS), watchClients: opt(bool) }), none),
    'logs.list': method(nothing, obj({ logs: arr(obj({ name: logName, size: count, mtimeMs: num }), MAX_ITEMS) })),
    'logs.read': method(obj({ name: logName, offset: count, length: int(0, MAX_LOG_READ_BYTES) }), obj({ bytes: bytes(MAX_LOG_READ_BYTES), size: count })),
    attachCore: method(coreAttach, parseCoreState),
    coreState: method(nothing, parseCoreState),
    restartCore: method(nothing, parseCoreState),
    ping: method(nothing, nothing),
    linger: method(nothing, lingerResult),
    disconnect: method(nothing, none),
    'ssh.installAuthorizedKey': method(obj({ publicKey }), installKeyResult),
    shutdownForRemoval: method(nothing, obj({ runKey: (raw) => (typeof raw === 'string' && RUN_KEY.test(raw) ? raw : INVALID) })),
    sharedHome: method(nothing, obj({ hosts: arr((raw) => (typeof raw === 'string' && OTHER_HOSTNAME.test(raw) ? raw : INVALID), MAX_SHARED_HOME_HOSTS) })),
    listOwnRuns: method(nothing, obj({ runs: arr(run, MAX_ITEMS) })),
    'mirror.syncSubcalls': method(obj({ budgetBytes: count, held: opt(mirrorHeld) }), obj({ change: opt(ledgerChange) })),
    portProbe: method(nothing, obj({ port: int(1, 65535), nonce: (raw) => (typeof raw === 'string' && PROBE_NONCE.test(raw) ? raw : INVALID) })),
    ...CONTAINER_REQUESTS,
    'agent.relay': method(nothing, none),
    'agent.connect': method(obj({ request: agentRequest, stream: streamId }), obj({ ok: bool })),
    'agent.refuse': method(obj({ request: agentRequest }), none),
  },
  events: {},
  mirrors: {},
  panelOps: {},
};

// what a daemon serves after refusing the client's protocol version
export const FROZEN_CLIENT_TO_CONTROL: Tables<FrozenClientToControl> = { requests: FROZEN_REQUESTS, events: {}, mirrors: {}, panelOps: {} };

export const CONTROL_TO_CLIENT: Tables<ControlToClient> = {
  requests: {},
  events: {
    coreState: parseCoreState,
    clients: obj({ clients: arr(obj({ deviceName: displayText(MAX_DEVICE_NAME_CHARS), self: bool }), MAX_ITEMS) }),
    'mirror.changed': obj({ projectKey: nonEmpty(MAX_PATH_CHARS) }),
    'mirror.subcallsChanged': nothing,
    'agent.request': obj({ request: agentRequest }),
  },
  mirrors: {},
  panelOps: {},
};
