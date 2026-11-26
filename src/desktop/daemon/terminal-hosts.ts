// The daemon's links to the terminal hosts of its run folder: docs/invariants.md "Remote terminals outlive their clients and their daemon".
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { channelTransport } from '../../remote/channel-transport';
import { AUTH_TIMEOUT_MS, sayHello, TokenProofError } from '../../remote/handshake';
import { CHANNEL, createMux, MAX_FRAME_BYTES, type StreamChannel } from '../../remote/mux';
import { streamClaims } from '../../remote/tunnel-pipe';
import { createEndpoint, type Endpoint } from '../core-protocol/endpoint';
import type { HostMessage } from '../pty-host/protocol';
import {
  DAEMON_TO_TERMINAL_HOST,
  TERMINAL_HOST_FEATURES,
  TERMINAL_HOST_MAX_MESSAGE_BYTES,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TERMINAL_HOST_TO_DAEMON,
  type DaemonToTerminalHost,
  type HostedTerminal,
  type TerminalHostToDaemon,
} from '../terminal-host/host-messages';
import { readHostTerminals, type HostTerminals } from '../terminal-host/terminals-file';
import { connectAuthenticated } from './attach';
import { compareIdentity, startIdentity, type StartIdentity } from './process-identity';
import { processKills, type ProcessKills, type Reproof } from './process-kill';
import { HOST_REATTACH_WAIT_MS, HOST_RETRY_MS } from './terminal-host-timing';
import { goneFromThisHost, hostRecordFile, hostTerminalsFile, hostTokenPath, isHostEndpoint, readHostRecords, removeHostFiles, SHARED_HOME_WINDOW_MS, TERMINAL_HOST_LOG_FILE, type HostRecordEntry, type PidRecord, type RunPaths } from './token';

// how long a started host may take to write its record; a WMI start on Windows takes seconds
export const HOST_START_TIMEOUT_MS = 30_000;
const HOST_START_POLL_MS = 100;
// how long a host may take to end its terminals and close the link after shutdown; it bounds itself by 2 s, and the daemon's
// whole shutdown fits lock-timing.ts SHUTDOWN_MAX_MS
export const HOST_SHUTDOWN_TIMEOUT_MS = 3000;
// a link that closes again this soon after it attached is tried at the retry pace, so a close that repeats is no tight loop
export const HOST_QUICK_CLOSE_MS = 5000;
// how long every try must have failed before a host whose record is old counts as ended
export const HOST_GIVE_UP_MS: number = 10 * 60 * 1000;
const KEPT_ENDED_HOST_LOGS = 5;
// a host's terminals file, its temporary one (token.ts hostTerminalsFile, hostTerminalsTemp) and its record's temporary one,
// which writePidFile names by the writer's pid, the host's own
const HOST_LEFT_NAME = /^([1-9][0-9]{0,14})(?:\.terminals(?:\.tmp)?|\.json\.\1\.tmp)$/;
const HOST_EVENTS = ['ready', 'data', 'screen', 'process', 'exit', 'error'] as const;

/** A connection on one of a host's endpoints, its bytes on the stream the host opened for it. */
export type ForwardedConnection =
  | { readonly kind: 'cli'; readonly terminalId: string; readonly stream: StreamChannel }
  | { readonly kind: 'agent'; readonly key: string; readonly stream: StreamChannel }
  | { readonly kind: 'relay'; readonly stream: StreamChannel };

export type KillOutcome = 'killed' | 'ended' | 'unproved';

/** An attached terminal host. A host whose link was lost and attached again is a new link under the same pid. */
export interface HostLink {
  readonly pid: number;
  // the host's server version, as its welcome said it over the proven link
  readonly version: string;
  // what the host held when this daemon attached
  readonly terminals: readonly HostedTerminal[];
  // the credential nonce its terminals send (ENDPOINTS_FEATURE); undefined for a host without the feature
  readonly relayNonce: string | undefined;
  readonly endpoint: Pick<Endpoint<DaemonToTerminalHost, TerminalHostToDaemon>, 'request' | 'emit'>;
  // the host's events in order, those that arrived before the listener was set included; one listener
  onMessage(listener: (message: HostMessage) => void): void;
  // the connections the host forwarded, in order, those that arrived before the listener was set included; one listener
  onConnection(listener: (connection: ForwardedConnection) => void): void;
  // the link is gone, whoever closed it; a listener set after that runs at once
  onClose(listener: (reason: string) => void): void;
  // closes the link only: the host and its terminals run on
  close(reason: string): void;
}

export interface TerminalHostsDeps {
  readonly paths: RunPaths;
  // the daemon's server version, which names the host new terminals start in
  readonly version: string;
  // starts a terminal host of this version, detached, and answers its pid
  readonly start: () => Promise<number>;
  readonly retryMs?: number;
  readonly startTimeoutMs?: number;
  // the bound on one host's connect, proof, hello and attach together; default AUTH_TIMEOUT_MS
  readonly attachTimeoutMs?: number;
  readonly reattachWaitMs?: number;
  readonly giveUpMs?: number;
  // default processKills(); only a user's Kill, End terminal host or removal uses it
  readonly kills?: ProcessKills;
  // default startIdentity, which the hosts record theirs and their shells' with
  readonly identity?: StartIdentity;
  readonly log: (line: string) => void;
}

export interface TerminalHosts {
  // Only under the daemon lock: removes what ended hosts left and attaches to every live one, all at once; one that cannot be
  // reached is tried again every HOST_RETRY_MS while its pid lives.
  adoptAll(): Promise<void>;
  // the attached host of this daemon's version, started when none is; one whose link was lost is waited for first, at most
  // HOST_REATTACH_WAIT_MS
  currentHost(): Promise<HostLink>;
  links(): readonly HostLink[];
  // each link once it attached, before any of its events is read; again under the same pid after a lost link
  onLink(listener: (link: HostLink) => void): void;
  // a host whose terminals this daemon held has ended, or answers as another process: its terminals are gone for good
  onEnded(listener: (pid: number) => void): void;
  // a recorded host of this machine whose first attach failed while its pid lives, with the terminals its terminals file
  // names, once; from then on it waits as a lost host does
  onUnattached(listener: (pid: number, terminals: HostTerminals['terminals']) => void): void;
  // a lost or unattached host whose pid lives stayed out of reach for HOST_REATTACH_WAIT_MS (false), or attached after that
  // (true), before onLink hears of the new link
  onResponding(listener: (pid: number, responding: boolean) => void): void;
  // the process group of terminal id's shell, as its host's terminals file names it, whose host is not responding
  // (ProcessKills.group), only while its start identity is the one recorded: killed (sent), ended (no such shell runs now) or
  // unproved (nothing sent, as when the host attached or the daemon let go of its hosts while the shell was proved)
  killGroup(hostPid: number, id: string): Promise<KillOutcome>;
  // ends a host that is not responding (ProcessKills.process) once its start identity is the one recorded, then its terminals
  // through onEnded; a host whose pid names another process now has ended. False for any other pid, and for one unproved
  endHost(pid: number): Promise<boolean>;
  // the link holds no terminal: closed unless it is the host new terminals start in, and an empty host with no daemon exits
  emptied(link: HostLink): void;
  // the idle limit every host enforces from now on (control.attach's terminalIdleDays)
  setIdleDays(days: number): void;
  // the frozen shutdown to every attached host, settled once each closed its link
  endAll(): Promise<void>;
  // endAll, and meanwhile ends every other host of this machine's records, then each attached one that did not close its link
  // in time, each forced (ProcessKills.force) only once its start identity is the one recorded, and removes their files; another
  // machine's are left
  endForRemoval(): Promise<void>;
  // closes every link and stops adopting; no host is ended
  release(reason: string): void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Nothing listens at the endpoint. A live host always holds its socket or a pipe instance, and on POSIX only this user can
// bind in the checked folder, so the host that wrote the record has ended, whatever process has its pid now.
const nothingListens = (err: unknown): boolean => {
  const { code, syscall } = err as NodeJS.ErrnoException;
  return syscall === 'connect' && (code === 'ECONNREFUSED' || code === 'ENOENT');
};

// The endpoint is held by something that is not the host of this record; it is never asked again.
class NotThisHostError extends Error {
  override readonly name: string = 'NotThisHostError';
}

export function createTerminalHosts(deps: TerminalHostsDeps): TerminalHosts {
  const { paths, log } = deps;
  const retryMs = deps.retryMs ?? HOST_RETRY_MS;
  const attachTimeoutMs = deps.attachTimeoutMs ?? AUTH_TIMEOUT_MS;
  const giveUpMs = deps.giveUpMs ?? HOST_GIVE_UP_MS;
  const reattachWaitMs = deps.reattachWaitMs ?? HOST_REATTACH_WAIT_MS;
  const kills = deps.kills ?? processKills();
  const identity = deps.identity ?? startIdentity;
  const links = new Map<number, HostLink>();
  // each attach in flight, so a retry and a start never attach one host twice
  const connecting = new Map<number, Promise<HostLink>>();
  // hosts whose link closed, or of this machine whose first attach failed, while their pid lives, until they attach or are found
  // ended; back settles with the new link, and waiting runs out at reattachWaitMs, when such a host is not responding
  const lost = new Map<number, { readonly version: string; readonly back: Promise<HostLink | undefined>; readonly settle: (link: HostLink | undefined) => void; readonly waiting: NodeJS.Timeout }>();
  // lost hosts still out of reach past reattachWaitMs whose pid lives, until they attach again or are found ended
  const notResponding = new Set<number>();
  const respondingListeners = new Set<(pid: number, responding: boolean) => void>();
  const unattachedListeners = new Set<(pid: number, terminals: HostTerminals['terminals']) => void>();
  // pids this daemon no longer asks: an endpoint that is not the record's host, and an empty host it let go of
  const skipped = new Set<number>();
  // when each host that does not attach first failed, and its last failure, until it attaches or its record goes
  const failing = new Map<number, { readonly since: number; readonly why: string }>();
  // per hung host, its terminals file and a proof of the same process, kept while the file's size and mtime stay, so a retry
  // costs no identity read
  const judged = new Map<number, { readonly size: number; readonly mtimeMs: number; readonly file: HostTerminals | undefined; readonly proof: Proof }>();
  // links this daemon closed itself, whose close starts no new attach
  const letGo = new WeakSet<HostLink>();
  const linkListeners = new Set<(link: HostLink) => void>();
  const endedListeners = new Set<(pid: number) => void>();
  // pids whose end was told, until a host of the pid attaches or is lost again, so each end is told once
  const toldEnded = new Set<number>();
  // the open link of this version new terminals start in; only adopt's link and its close listener set it
  let current: HostLink | undefined;
  let starting: Promise<HostLink> | undefined;
  let retry: NodeJS.Timeout | undefined;
  // undefined until a client said: a host keeps its own limit meanwhile
  let idleDays: number | undefined;
  let released = false;
  let pruned = false;

  const connect = (record: PidRecord): Promise<HostLink> => {
    // one bound over the connect, the proof, the hello and the attach; past it the connection is closed wherever it stands
    const bound = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        bound.abort();
        reject(new Error(`no attach within ${attachTimeoutMs} ms`));
      }, attachTimeoutMs);
    });
    const attached = (async (): Promise<HostLink> => {
      const { protocol } = await connectAuthenticated(record, hostTokenPath(paths, record), isHostEndpoint, undefined, bound.signal);
      try {
        const outcome = await sayHello(protocol, { appVersion: deps.version, protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION, clientId: `daemon-${process.pid}`, deviceName: os.hostname() }, attachTimeoutMs);
        if (outcome.kind === 'refused') throw new Error(`it refused the hello (${outcome.refused.reason}, protocol ${outcome.refused.protocolVersion})`);
        const version = outcome.welcome.serverVersion;
        if (version !== record.version) throw new NotThisHostError(`its record names ${record.version} and it answers as ${version}`);
        protocol.setMaxBodyBytes(MAX_FRAME_BYTES);
        // the host opens a stream for each connection on its endpoints, which the connection event that names it claims
        const mux = createMux({ protocol, side: 'client', acceptStreams: true, onOverflow: () => protocol.close('held frames passed the per-connection bound'), onViolation: (reason) => protocol.close(reason), log });
        const claims = streamClaims(mux, (reason) => protocol.close(reason));
        const endpoint = createEndpoint<DaemonToTerminalHost, TerminalHostToDaemon>({
          transport: channelTransport(mux.messageChannel(CHANNEL.control, TERMINAL_HOST_MAX_MESSAGE_BYTES), TERMINAL_HOST_MAX_MESSAGE_BYTES, (reason) => protocol.close(reason)),
          outgoing: DAEMON_TO_TERMINAL_HOST,
          incoming: TERMINAL_HOST_TO_DAEMON,
          log,
          onViolation: (error) => protocol.close(error.message),
          checkOutgoing: true,
        });
        // held until the hub listens: an event may follow attach's answer in the same read
        let early: HostMessage[] | undefined = [];
        let deliver: ((event: HostMessage) => void) | undefined;
        for (const name of HOST_EVENTS) {
          endpoint.onEvent(name, (payload) => {
            const event = { type: name, ...payload } as HostMessage;
            if (deliver) deliver(event);
            else early?.push(event);
          });
        }
        // the host sends its nonce and the connections that waited for a daemon before attach's answer
        let relayNonce: string | undefined;
        endpoint.onEvent('relayNonce', ({ nonce }) => {
          relayNonce = nonce;
        });
        let earlyConnections: ForwardedConnection[] | undefined = [];
        let take: ((connection: ForwardedConnection) => void) | undefined;
        endpoint.onEvent('connection', (named) => {
          const stream = claims.claim(named.stream);
          if (!stream) {
            log(`[terminal] the terminal host ${record.pid} named stream ${named.stream}, which it did not open`);
            return;
          }
          const connection = { ...named, stream } as ForwardedConnection;
          if (take) take(connection);
          else earlyConnections?.push(connection);
        });
        let closed: string | undefined;
        const closeListeners = new Set<(reason: string) => void>();
        protocol.onClose((reason) => {
          closed = reason;
          claims.dispose();
          mux.dispose();
          endpoint.close(reason);
          for (const listener of [...closeListeners]) listener(reason);
        });
        protocol.startKeepAlive();
        const { terminals } = await endpoint.request('attach', { features: [...TERMINAL_HOST_FEATURES], ...(idleDays !== undefined ? { idleDays } : {}) });
        // the read that carried the answer may have closed the link after it
        if (closed !== undefined) throw new Error(`its link closed as it attached: ${closed}`);
        return {
          pid: record.pid,
          version,
          terminals,
          relayNonce,
          endpoint,
          onMessage: (listener) => {
            deliver = listener;
            const held = early ?? [];
            early = undefined;
            for (const event of held) listener(event);
          },
          onConnection: (listener) => {
            take = listener;
            const held = earlyConnections ?? [];
            earlyConnections = undefined;
            for (const connection of held) listener(connection);
          },
          onClose: (listener) => {
            if (closed !== undefined) listener(closed);
            else closeListeners.add(listener);
          },
          close: (reason) => protocol.close(reason),
        };
      } catch (err) {
        protocol.close(`attaching failed: ${message(err)}`);
        throw err;
      }
    })();
    // a connect that outlives the bound closes what it reached and is heard by nobody
    attached.catch(() => undefined);
    return Promise.race([attached, expired]).finally(() => clearTimeout(timer));
  };

  const ended = (pid: number): void => {
    judged.delete(pid);
    const waited = lost.get(pid);
    clearTimeout(waited?.waiting);
    waited?.settle(undefined);
    lost.delete(pid);
    notResponding.delete(pid);
    if (toldEnded.has(pid)) return;
    toldEnded.add(pid);
    for (const listener of [...endedListeners]) listener(pid);
  };

  const tellResponding = (pid: number, responding: boolean): void => {
    for (const listener of [...respondingListeners]) listener(pid, responding);
  };

  // The host's terminals are kept while it is out of reach; past waitMs with its pid alive it is not responding.
  const markLost = (pid: number, version: string, waitMs: number, since: string): void => {
    toldEnded.delete(pid);
    let settle!: (again: HostLink | undefined) => void;
    const back = new Promise<HostLink | undefined>((resolve) => { settle = resolve; });
    const waiting = setTimeout(() => {
      if (released || !lost.has(pid) || goneFromThisHost(os.hostname(), pid)) return;
      notResponding.add(pid);
      log(`[terminal] the terminal host ${pid} is not responding: it has not attached for ${reattachWaitMs} ms since ${since}, and its terminals' requests wait for it`);
      tellResponding(pid, false);
    }, waitMs);
    lost.set(pid, { version, back, settle, waiting });
  };

  // Whether pid is still the process whose start identity was recorded; the OS's is read only now, so a kill follows at once.
  type Proof = { readonly kind: 'same'; readonly start: string } | { readonly kind: 'ended'; readonly why: string } | { readonly kind: 'unproved'; readonly why: string };
  const prove = async (pid: number, recorded: string | undefined): Promise<Proof> => {
    if (recorded === undefined) return { kind: 'unproved', why: 'no start identity of it was recorded' };
    let now: string | undefined;
    try {
      now = await identity(pid);
    } catch (err) {
      return { kind: 'unproved', why: `its start identity cannot be read: ${message(err)}` };
    }
    if (now === undefined) return { kind: 'ended', why: 'no process has its pid' };
    const match = compareIdentity(recorded, now);
    if (match === 'incomparable') return { kind: 'unproved', why: 'its recorded start identity is of a scheme this daemon does not read' };
    return match === 'same' ? { kind: 'same', start: recorded } : { kind: 'ended', why: 'its pid names another process now' };
  };
  const proveHost = (pid: number, file: HostTerminals | undefined): Promise<Proof> => (file ? prove(pid, file.hostStart) : Promise.resolve({ kind: 'unproved', why: 'it has no terminals file to prove it by' }));
  const reproof = (pid: number, recorded: string | undefined): Reproof => async () => (await prove(pid, recorded)).kind;

  // A hung host's terminals file and its proof, read again only once the file changed; every kill proves anew.
  const judgeHung = async (pid: number): Promise<{ readonly file: HostTerminals | undefined; readonly proof: Proof }> => {
    const stat = await fs.stat(hostTerminalsFile(paths, pid)).catch(() => undefined);
    const kept = judged.get(pid);
    if (stat && kept && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs) return kept;
    const file = await readHostTerminals(paths, pid, log);
    const proof = await proveHost(pid, file);
    if (stat && proof.kind === 'same') judged.set(pid, { size: stat.size, mtimeMs: stat.mtimeMs, file, proof });
    else judged.delete(pid);
    return { file, proof };
  };

  // Removes the files of a host found ended, then ends its terminals.
  const endedHost = async (pid: number, why: string): Promise<void> => {
    const entry = (await readHostRecords(paths, log)).find((recorded) => recorded.pid === pid) ?? { pid, record: undefined };
    await removeLeft(entry, `: ${why}, so it has ended`);
    ended(pid);
  };

  // Every retryMs the link must answer the frozen list within attachTimeoutMs, else it is closed as a lost link.
  const probe = (link: HostLink): void => {
    let open = true;
    let timer: NodeJS.Timeout | undefined;
    let deciding: NodeJS.Immediate | undefined;
    const ask = (): void => {
      timer = setTimeout(() => {
        // a timer late from a stalled loop runs before the poll phase reads what arrived meanwhile, so decide after it
        deciding = setImmediate(() => link.close(`it did not answer a list within ${attachTimeoutMs} ms`));
      }, attachTimeoutMs);
      link.endpoint.request('list', {}).then(() => {
        if (!open) return;
        clearTimeout(timer);
        clearImmediate(deciding);
        timer = setTimeout(ask, retryMs);
      }, (err: unknown) => {
        // the link closing under the request is the probe's or another close's
        if (open) log(`[terminal] the terminal host ${link.pid} failed a list: ${message(err)}`);
      });
    };
    timer = setTimeout(ask, retryMs);
    link.onClose(() => {
      open = false;
      clearTimeout(timer);
      clearImmediate(deciding);
    });
  };

  const scheduleRetry = (): void => {
    if (released || retry !== undefined) return;
    retry = setTimeout(() => void adoptAll().catch((err: unknown) => log(`[terminal] adopting the terminal hosts failed: ${message(err)}`)), retryMs);
  };

  const attach = (record: PidRecord): Promise<HostLink> => {
    const held = links.get(record.pid);
    if (held) return Promise.resolve(held);
    const flying = connecting.get(record.pid) ?? adopt(record).finally(() => connecting.delete(record.pid));
    connecting.set(record.pid, flying);
    return flying;
  };

  const adopt = async (record: PidRecord): Promise<HostLink> => {
    const link = await connect(record);
    if (released) {
      link.close('the daemon let go of its terminal hosts');
      throw new Error('the daemon let go of its terminal hosts');
    }
    links.set(link.pid, link);
    toldEnded.delete(link.pid);
    // a pid this daemon let go of before names another host now
    skipped.delete(link.pid);
    failing.delete(link.pid);
    judged.delete(link.pid);
    const attachedAt = Date.now();
    const again = lost.has(link.pid);
    link.onClose((reason) => {
      if (links.get(link.pid) === link) links.delete(link.pid);
      if (current === link) current = [...links.values()].find((other) => other.version === deps.version);
      log(`[terminal] the link to the terminal host ${link.pid} (${link.version}) closed: ${reason}`);
      if (released || letGo.has(link)) return;
      // the host may live on: its terminals are kept while the daemon attaches again
      markLost(link.pid, link.version, reattachWaitMs, 'its link closed');
      if (again && Date.now() - attachedAt < HOST_QUICK_CLOSE_MS) scheduleRetry();
      else void adoptAll().catch((err: unknown) => log(`[terminal] attaching to the terminal host ${link.pid} again failed: ${message(err)}`));
    });
    if (current === undefined && link.version === deps.version) current = link;
    log(`[terminal] attached to the terminal host ${link.pid} (${link.version}) with ${link.terminals.length} terminals`);
    const waited = lost.get(link.pid);
    clearTimeout(waited?.waiting);
    lost.delete(link.pid);
    if (link.terminals.length === 0 && link !== current) {
      // before the hub hears of the link, so the terminals it held under this pid end
      if (waited) ended(link.pid);
      skipped.add(link.pid);
      letGo.add(link);
      link.close('it holds no terminal');
      return link;
    }
    probe(link);
    if (notResponding.delete(link.pid)) {
      log(`[terminal] the terminal host ${link.pid} answers again`);
      tellResponding(link.pid, true);
    }
    for (const listener of [...linkListeners]) listener(link);
    waited?.settle(link);
    return link;
  };

  // The logs of hosts with no record: the newest KEPT_ENDED_HOST_LOGS hosts' stay.
  const pruneLogs = async (live: ReadonlySet<number>): Promise<void> => {
    const old = new Map<number, { mtimeMs: number; files: string[] }>();
    for (const name of await fs.readdir(paths.logsDir)) {
      const pid = Number(TERMINAL_HOST_LOG_FILE.exec(name)?.[1]);
      if (!Number.isSafeInteger(pid) || live.has(pid)) continue;
      const file = path.join(paths.logsDir, name);
      const { mtimeMs } = await fs.stat(file);
      const entry = old.get(pid) ?? { mtimeMs: 0, files: [] };
      old.set(pid, { mtimeMs: Math.max(entry.mtimeMs, mtimeMs), files: [...entry.files, file] });
    }
    const stale = [...old.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(KEPT_ENDED_HOST_LOGS);
    for (const { files } of stale) for (const file of files) await fs.rm(file, { force: true });
  };

  // A terminals file or a record's temporary file with no record whose pid names no process: its host died before its record or
  // after removing it. A host writes both just before its record, so a live pid's stay.
  const pruneLeftFiles = async (recorded: ReadonlySet<number>): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(paths.terminalHostsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      const pid = Number(HOST_LEFT_NAME.exec(name)?.[1]);
      if (!Number.isSafeInteger(pid) || recorded.has(pid) || !goneFromThisHost(os.hostname(), pid)) continue;
      await fs.rm(path.join(paths.terminalHostsDir, name), { force: true });
      log(`[terminal] removed ${name}, which no record names and whose host has ended`);
    }
  };

  // a folder that is no longer this user's own is left, and the start goes on
  const removeLeft = (entry: HostRecordEntry, why: string): Promise<void> => removeHostFiles(paths, entry).then(
    () => log(`[terminal] removed the record of the terminal host ${entry.pid}${why}`),
    (err: unknown) => log(`[terminal] removing what the ended terminal host ${entry.pid} left failed: ${message(err)}`),
  );

  // A live host touches its record every TOUCH_INTERVAL_MS, so one untouched for longer than the window is no live host's.
  const untouched = async (pid: number): Promise<boolean> => {
    try {
      return Date.now() - (await fs.stat(hostRecordFile(paths, pid))).mtimeMs > SHARED_HOME_WINDOW_MS;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  };

  // Whether the entry's host must be tried again later.
  const adoptEntry = async (entry: HostRecordEntry): Promise<boolean> => {
    if (links.has(entry.pid)) return false;
    const triedAt = Date.now();
    // another hostname's pid and endpoint prove nothing here; only the record goes, by age. A host this daemon held is its own.
    const hostname = entry.record?.hostname;
    const other = hostname !== undefined && hostname !== os.hostname() && !lost.has(entry.pid);
    if (!other && goneFromThisHost(os.hostname(), entry.pid)) {
      await removeLeft(entry, ', which has ended');
      ended(entry.pid);
      return false;
    }
    if (skipped.has(entry.pid)) return false;
    try {
      if (!entry.record) throw new Error('its record does not name a terminal host of this pid');
      await attach(entry.record);
      return false;
    } catch (err) {
      if (released) return false;
      if (!other && nothingListens(err)) {
        failing.delete(entry.pid);
        await removeLeft(entry, ': nothing listens at its endpoint, so it has ended');
        ended(entry.pid);
        return false;
      }
      if (err instanceof TokenProofError || err instanceof NotThisHostError) {
        failing.delete(entry.pid);
        skipped.add(entry.pid);
        log(`[terminal] the terminal host ${entry.pid} is not attached and not tried again: ${message(err)}`);
        ended(entry.pid);
        return false;
      }
      const why = message(err);
      const before = failing.get(entry.pid);
      const first = before === undefined;
      const since = before?.since ?? Date.now();
      failing.set(entry.pid, { since, why });
      // a host this daemon held, or one of this machine's: its pid may be another process's by now
      const ours = !other && entry.record !== undefined && (lost.has(entry.pid) || hostname === os.hostname());
      const { file, proof } = ours ? await judgeHung(entry.pid) : { file: undefined, proof: undefined };
      // another pass attached it meanwhile
      if (released || links.has(entry.pid)) return false;
      if (proof?.kind === 'ended') {
        failing.delete(entry.pid);
        await removeLeft(entry, `: ${proof.why}, so it has ended`);
        ended(entry.pid);
        return false;
      }
      if (proof?.kind === 'unproved' && first) log(`[terminal] the terminal host ${entry.pid} cannot be proved to be the one its record names, so nothing kills it: ${proof.why}`);
      // A live host's daily touch is late after a suspend, so an old record alone proves nothing: its file time is read again
      // once every try has failed for giveUpMs. A host proved running is never given up.
      if (proof?.kind !== 'same' && Date.now() - since >= giveUpMs && await untouched(entry.pid)) {
        failing.delete(entry.pid);
        if (other) {
          await fs.rm(hostRecordFile(paths, entry.pid), { force: true });
          log(`[terminal] removed the record of the terminal host ${entry.pid} of ${hostname}: it did not attach for over ${giveUpMs} ms and no host touched it for over ${SHARED_HOME_WINDOW_MS} ms`);
        } else {
          await removeLeft(entry, `: it did not attach for over ${giveUpMs} ms (${why}) and nothing touched its record for over ${SHARED_HOME_WINDOW_MS} ms, so it has ended`);
        }
        ended(entry.pid);
        return false;
      }
      // never attached: known by its terminals file, and judged as a lost host from the first try on
      if (ours && entry.record && !lost.has(entry.pid)) {
        const terminals = file?.terminals ?? [];
        markLost(entry.pid, entry.record.version, Math.max(triedAt + reattachWaitMs - Date.now(), 0), 'its first attach');
        log(`[terminal] the terminal host ${entry.pid} did not attach; its ${terminals.length} terminals are listed from its terminals file until it does`);
        for (const listener of [...unattachedListeners]) listener(entry.pid, terminals);
      }
      // a host that stays hung is named again only when its failure changes; another machine's never attaches here, so once
      if (!other && (first || before.why !== why)) log(`[terminal] the terminal host ${entry.pid} did not attach, trying again in ${retryMs} ms: ${why}`);
      else if (other && first) log(`[terminal] the terminal host ${entry.pid} of ${hostname} did not attach, trying again every ${retryMs} ms: ${why}`);
      return true;
    }
  };

  async function adoptAll(): Promise<void> {
    clearTimeout(retry);
    retry = undefined;
    if (released) return;
    let entries: HostRecordEntry[];
    try {
      entries = await readHostRecords(paths, log);
    } catch (err) {
      // a host waited for is tried again however the folder reads now
      if (lost.size > 0) scheduleRetry();
      throw err;
    }
    // one host's failure costs no other host its try, and it is tried again
    const again = await Promise.all(entries.map((entry) => adoptEntry(entry).catch((err: unknown) => {
      log(`[terminal] adopting the terminal host ${entry.pid} failed, trying again in ${retryMs} ms: ${message(err)}`);
      return true;
    })));
    // a host that removed its own record on its way out
    const recorded = new Set(entries.map((entry) => entry.pid));
    for (const pid of [...lost.keys()]) if (!recorded.has(pid) && !connecting.has(pid)) ended(pid);
    if (!pruned) {
      pruned = true;
      const live = new Set(entries.map((entry) => entry.pid).filter((pid) => !goneFromThisHost(os.hostname(), pid)));
      await pruneLogs(live).catch((err: unknown) => log(`[terminal] removing ended terminal hosts' logs failed: ${message(err)}`));
      await pruneLeftFiles(recorded).catch((err: unknown) => log(`[terminal] removing what ended terminal hosts left without a record failed: ${message(err)}`));
    }
    if (again.some((retryIt) => retryIt)) scheduleRetry();
  }

  const startOwn = async (): Promise<HostLink> => {
    const pid = await deps.start();
    log(`[terminal] started the terminal host ${pid}`);
    const deadline = Date.now() + (deps.startTimeoutMs ?? HOST_START_TIMEOUT_MS);
    for (;;) {
      const record = (await readHostRecords(paths, log)).find((entry) => entry.pid === pid)?.record;
      if (record) {
        await attach(record);
        // another host of this version that attached meanwhile is kept, and the started one let go of while empty
        if (!current) throw new Error(`the link to the terminal host ${pid} closed as it attached`);
        return current;
      }
      if (goneFromThisHost(os.hostname(), pid)) throw new Error(`the terminal host ${pid} ended before it listened`);
      if (Date.now() >= deadline) throw new Error(`the terminal host ${pid} wrote no record within ${deps.startTimeoutMs ?? HOST_START_TIMEOUT_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, HOST_START_POLL_MS));
    }
  };

  // The lost host of this version, back within the wait; undefined when there is none, it stayed away, or it is already not
  // responding.
  const awaitLost = async (): Promise<HostLink | undefined> => {
    const waited = [...lost].find(([pid, host]) => host.version === deps.version && !notResponding.has(pid))?.[1];
    if (!waited) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), reattachWaitMs); });
    const link = await Promise.race([waited.back, expired]).finally(() => clearTimeout(timer));
    if (!link) log(`[terminal] the terminal host of ${deps.version} whose link was lost is not back; starting another`);
    return link;
  };

  // The frozen shutdown to every attached host; answers the pids whose link closed within HOST_SHUTDOWN_TIMEOUT_MS.
  const endLinks = async (): Promise<ReadonlySet<number>> => {
    released = true;
    clearTimeout(retry);
    retry = undefined;
    for (const waited of lost.values()) clearTimeout(waited.waiting);
    const closed = new Set<number>();
    await Promise.all([...links.values()].map((link) => new Promise<void>((resolve) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        log(`[terminal] the terminal host ${link.pid} did not close its link within ${HOST_SHUTDOWN_TIMEOUT_MS} ms of its shutdown`);
        link.close('the host did not end in time');
      }, HOST_SHUTDOWN_TIMEOUT_MS);
      link.onClose(() => {
        clearTimeout(timer);
        if (!late) closed.add(link.pid);
        resolve();
      });
      link.endpoint.request('shutdown', {}).catch((err: unknown) => {
        // the link closing under the request is the shutdown working
        if (links.has(link.pid)) log(`[terminal] the terminal host ${link.pid} refused its shutdown: ${message(err)}`);
      });
    })));
    return closed;
  };

  // A removal's end of a recorded host: only this machine's, only once its start identity is the one recorded.
  const endRecorded = async (entry: HostRecordEntry): Promise<void> => {
    const hostname = entry.record?.hostname;
    if (hostname !== os.hostname()) {
      log(`[terminal] left the terminal host ${entry.pid} running: its record names ${hostname === undefined ? 'no machine this one can judge' : `the machine ${hostname}`}`);
      return;
    }
    if (goneFromThisHost(hostname, entry.pid)) {
      await removeLeft(entry, ', which has ended');
      return;
    }
    const proof = await proveHost(entry.pid, await readHostTerminals(paths, entry.pid, log));
    if (proof.kind === 'unproved') {
      log(`[terminal] left the terminal host ${entry.pid} running: ${proof.why}`);
      return;
    }
    if (proof.kind === 'ended') {
      await removeLeft(entry, `: ${proof.why}, so it has ended`);
      return;
    }
    // an attached host had the frozen shutdown as its graceful end, and an unreachable or stopped one handles neither that nor SIGTERM
    log(`[terminal] forcing the terminal host ${entry.pid} to end for the removal`);
    if (!(await kills.force(entry.pid, proof.start))) {
      log(`[terminal] the terminal host ${entry.pid} did not end`);
      return;
    }
    await removeLeft(entry, ', which the removal ended');
  };

  return {
    adoptAll,
    currentHost: () => {
      if (released) return Promise.reject(new Error('the daemon let go of its terminal hosts'));
      if (current) return Promise.resolve(current);
      starting ??= (async () => {
        const link = (await awaitLost()) ?? current;
        if (link) return link;
        if (released) throw new Error('the daemon let go of its terminal hosts');
        return startOwn();
      })().finally(() => {
        starting = undefined;
      });
      return starting;
    },
    links: () => [...links.values()],
    onLink: (listener) => {
      linkListeners.add(listener);
    },
    onEnded: (listener) => {
      endedListeners.add(listener);
    },
    onResponding: (listener) => {
      respondingListeners.add(listener);
    },
    onUnattached: (listener) => {
      unattachedListeners.add(listener);
    },
    killGroup: async (hostPid, id) => {
      const shell = (await readHostTerminals(paths, hostPid, log))?.terminals.find((terminal) => terminal.id === id);
      if (!shell || shell.pid <= 0) {
        log(`[terminal] ${id} is not killed directly: the terminals file of its terminal host ${hostPid} names no shell of it`);
        return 'unproved';
      }
      const proof = await prove(shell.pid, shell.start);
      if (proof.kind !== 'same') {
        log(`[terminal] the shell ${shell.pid} of ${id} is not killed: ${proof.why}`);
        return proof.kind;
      }
      // the next lock owner may adopt the host, and a host that attached kills its own terminal on the frozen kill
      if (released || links.has(hostPid)) {
        log(`[terminal] the shell ${shell.pid} of ${id} is not killed directly: ${released ? 'the daemon let go of its terminal hosts' : `its terminal host ${hostPid} answers again`}`);
        return 'unproved';
      }
      // a pty's shell leads its session and process group (node-pty: forkpty on Linux, POSIX_SPAWN_SETSID on macOS); its grace
      // runs on
      kills.group(shell.pid, proof.start, reproof(shell.pid, proof.start)).catch((err: unknown) => log(`[terminal] killing the shell ${shell.pid} of ${id} failed: ${message(err)}`));
      return 'killed';
    },
    endHost: async (pid) => {
      // once released, the next lock owner may adopt it
      if (released || !notResponding.has(pid)) return false;
      log(`[terminal] ending the terminal host ${pid}, which is not responding`);
      const file = await readHostTerminals(paths, pid, log);
      const proof = await proveHost(pid, file);
      if (proof.kind === 'unproved') {
        log(`[terminal] the terminal host ${pid} is not ended: ${proof.why}`);
        return false;
      }
      // it may have attached while it was proved
      if (released || !notResponding.has(pid) || links.has(pid)) {
        log(`[terminal] the terminal host ${pid} is not ended: it answers again`);
        return false;
      }
      if (proof.kind === 'ended') {
        await endedHost(pid, proof.why);
        return true;
      }
      if (!(await kills.process(pid, proof.start, reproof(pid, proof.start)))) {
        log(`[terminal] the terminal host ${pid} did not end`);
        return false;
      }
      // the kill proved it gone; an attach cannot, since a killed host's pid may still be a zombie and its endpoint resets
      await endedHost(pid, 'End terminal host ended its process');
      return true;
    },
    emptied: (link) => {
      if (link === current) return;
      skipped.add(link.pid);
      letGo.add(link);
      link.close('it holds no terminal');
    },
    setIdleDays: (days) => {
      idleDays = days;
      for (const link of links.values()) {
        link.endpoint.request('idleDays', { days }).catch((err: unknown) => log(`[terminal] the terminal host ${link.pid} did not take the idle limit: ${message(err)}`));
      }
    },
    endAll: async () => {
      await endLinks();
    },
    endForRemoval: async () => {
      const attached = new Set(links.keys());
      const shutdown = endLinks();
      const entries = await readHostRecords(paths, log);
      // one host's failure leaves it to the removal stage, which then refuses, and ends no other's
      const end = (entry: HostRecordEntry): Promise<void> => endRecorded(entry).catch((err: unknown) => log(`[terminal] ending the terminal host ${entry.pid} for the removal failed: ${message(err)}`));
      // an attached host that ignored its shutdown is ended beside the unreachable ones (lock-timing.ts REMOVAL_SHUTDOWN_MAX_MS)
      const ignored = shutdown.then((closed) => Promise.all(entries.filter((entry) => attached.has(entry.pid) && !closed.has(entry.pid)).map(end)));
      await Promise.all([Promise.all(entries.filter((entry) => !attached.has(entry.pid)).map(end)), ignored]);
    },
    release: (reason) => {
      released = true;
      clearTimeout(retry);
      retry = undefined;
      for (const waited of lost.values()) clearTimeout(waited.waiting);
      for (const link of [...links.values()]) link.close(reason);
    },
  };
}
