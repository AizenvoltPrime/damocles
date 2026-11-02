// What main forwards of each remote host's ports (docs/invariants.md "Ports and the remote browser"): every listening socket
// the daemon reports and every URL its terminals and agent shells print, under the autoForwardPorts setting, the host's port
// attributes, its output-only fallback and the forwards each of its projects restores. The daemon reports; main decides. A
// port WSL forwards to this computer itself gets no tunnel and is listed via WSL.
import type { Disposable } from '../../../../platform/disposable';
import { listeners } from '../../../../remote/listeners';
import type { PortCandidate } from '../../../daemon/ports/ports-messages';
import type { OnDetect, PortRow, PortsView } from '../../../preload/ports-channels';
import { attributeRange, RESTORE_EXPIRY_MS, type HostPorts, type PortAttributes, type RestoredForward } from '../host-store';
import { ForwardLimitError, PortRefusedError, tunnelKey, type Tunnel, type TunnelManager, type TunnelTarget } from './tunnels';

// a port a terminal printed is forwarded when something listens on it within this long
export const URL_LISTEN_WINDOW_MS = 10_000;
// detected ports' notices, panes and browser tabs per host within a window; a target that opens ports in bulk gets no more
export const DETECTED_ACTIONS_PER_WINDOW = 5;
export const DETECTED_ACTIONS_WINDOW_MS = 60_000;

export interface PortStore {
  ports(hostId: string): HostPorts;
  updatePorts(hostId: string, apply: (ports: HostPorts) => HostPorts): Promise<void>;
  // the host's "local network for the browser" switch
  localNetwork(hostId: string): boolean;
}

export interface PortForwardingDeps {
  readonly tunnels: Pick<TunnelManager, 'forward' | 'stop' | 'stopAll' | 'list' | 'get' | 'changeLocalPort' | 'onDidChange'>;
  readonly store: PortStore;
  readonly autoForward: () => boolean;
  // damocles.desktop.remote.autoForwardPortsFallback; 0 never switches
  readonly fallbackThreshold: () => number;
  // the host's project keys, whose restore entries come back when it connects
  readonly projectsOf: (hostId: string) => readonly string[];
  // the authority key of the host's projects
  readonly authorityOf: (hostId: string) => string;
  // which of a list's new loopback candidates this computer reaches now on their own port through WSL's own forwarding, with
  // no Windows process other than WSL's relay on them; none for a host WSL does not forward. Called once per list
  readonly viaWsl: (hostId: string, candidates: readonly PortCandidate[]) => Promise<(port: number) => boolean>;
  // what a port's onDetect does once its automatic forward is up
  readonly detected: (hostId: string, action: Exclude<OnDetect, 'silent' | 'ignore'>, reached: Reached) => void;
  // the host switched to output-only detection after `count` automatic forwards; undo turns it back for good
  readonly fallbackSwitched: (hostId: string, count: number) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** A clientNetwork mirror value: the authority's forwarded local ports and its switch. */
export interface ClientNetwork {
  readonly authority: string;
  readonly allowedPorts: readonly number[];
  readonly allowLocalNetwork: boolean;
}

type Origin = PortRow['origin'];

// a port as this computer reaches it: through a tunnel, or through WSL on the same port number
export type Reached = Pick<Tunnel, 'remote' | 'localPort'>;

/** Refused: a port WSL forwards itself has no tunnel to stop or move. */
export class ViaWslError extends Error {
  override readonly name = 'ViaWslError';
}

interface Row {
  readonly remote: TunnelTarget;
  origin: Origin;
  // set while its forward should exist; undefined: listed only (detected, ignored)
  tunnelKey: string | undefined;
  error: 'listenFailed' | undefined;
  // the listening socket while the daemon reports one
  candidate: PortCandidate | undefined;
  // WSL forwards it to this computer on the same port, so it has no tunnel
  viaWsl: boolean;
}

interface HostRuntime {
  readonly hostId: string;
  readonly authority: string;
  connected: boolean;
  // bumped by every reset: work that awaited across one keeps nothing it made
  generation: number;
  // the host's row changes, one at a time in order (serial)
  queue: Promise<void>;
  rows: Map<string, Row>;
  // automatic forwards since the connection, which the fallback counts
  autoForwards: number;
  // ports printed in output, until their listen window ends
  readonly printed: Map<number, number>;
  // ports whose first forward this run told the user about
  readonly announced: Set<number>;
  // when each detected action of the current window ran
  actions: number[];
  // a restored local port, waiting for its port to be detected
  readonly preferredLocal: Map<string, number>;
  readonly timers: Set<NodeJS.Timeout>;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1)$/i;
export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host);

/** A row's identity: one loopback port is one row whichever loopback form found it. */
export function rowKey(remote: TunnelTarget): string {
  return isLoopbackHost(remote.host) ? `localhost:${remote.port}` : tunnelKey(remote);
}

/** The attributes of a port: an exact port's over a range's, the narrowest range first (VS Code's tunnelModel). */
export function attributesOf(ports: HostPorts, port: number): PortAttributes {
  const exact = ports.attributes[String(port)];
  if (exact) return exact;
  let best: { readonly width: number; readonly attributes: PortAttributes } | undefined;
  for (const [key, attributes] of Object.entries(ports.attributes)) {
    const range = attributeRange(key);
    if (!range || range.from === range.to || port < range.from || port > range.to) continue;
    const width = range.to - range.from;
    if (!best || width < best.width) best = { width, attributes };
  }
  return best?.attributes ?? {};
}

export function processLabelOf(candidate: PortCandidate | undefined): string | undefined {
  const process = candidate?.process;
  if (!process) return undefined;
  return process.command !== undefined ? `${process.name} (${process.command})` : process.name;
}

const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([other]) => other !== key));

export class PortForwarding {
  private readonly deps: PortForwardingDeps;
  private readonly hosts = new Map<string, HostRuntime>();
  private readonly changed = listeners<[string]>();
  private readonly networkChanged = listeners<[ClientNetwork]>();
  private readonly networks = new Map<string, string>();
  private readonly subscription: Disposable;

  constructor(deps: PortForwardingDeps) {
    this.deps = deps;
    this.subscription = deps.tunnels.onDidChange((authority) => {
      const runtime = [...this.hosts.values()].find((host) => host.authority === authority);
      if (runtime) this.publish(runtime);
    });
  }

  /** A host's Ports view changed (its hostId). */
  onDidChange(listener: (hostId: string) => void): Disposable {
    return this.changed.add(listener);
  }

  /** A host's forwarded local ports or its switch changed; fired before the forward that changed them is used. */
  onClientNetwork(listener: (network: ClientNetwork) => void): Disposable {
    return this.networkChanged.add(listener);
  }

  clientNetworks(): ClientNetwork[] {
    return [...this.hosts.values()].map((runtime) => this.networkOf(runtime));
  }

  /** The host's switch may have changed (the host store changed). */
  settingsChanged(): void {
    for (const runtime of this.hosts.values()) this.publishNetwork(runtime);
  }

  /**
   * A fresh connection of the host: its restore entries come back, and detection starts from nothing. A restore that fails is
   * logged and the rest still come back.
   */
  async connected(hostId: string): Promise<void> {
    const runtime = this.runtime(hostId);
    this.reset(runtime);
    runtime.connected = true;
    return this.serial(runtime, async (current) => {
      const now = this.deps.now();
      const ports = this.deps.store.ports(hostId);
      const restoring: Array<{ readonly projectKey: string; readonly key: string; readonly entry: RestoredForward }> = [];
      for (const projectKey of this.deps.projectsOf(hostId)) {
        for (const [key, entry] of Object.entries(ports.restore[projectKey] ?? {})) restoring.push({ projectKey, key, entry });
      }
      const expired = restoring.filter(({ entry }) => now - entry.lastUsed > RESTORE_EXPIRY_MS);
      const live = restoring.filter(({ entry }) => now - entry.lastUsed <= RESTORE_EXPIRY_MS);
      await this.deps.store.updatePorts(hostId, (stored) => {
        let restore = { ...stored.restore };
        for (const { projectKey, key } of expired) restore = { ...restore, [projectKey]: withoutKey(restore[projectKey] ?? {}, key) };
        for (const { projectKey, key } of live) {
          const entry = restore[projectKey]?.[key];
          if (entry) restore = { ...restore, [projectKey]: { ...restore[projectKey], [key]: { ...entry, lastUsed: now } } };
        }
        return { ...stored, restore: Object.fromEntries(Object.entries(restore).filter(([, entries]) => Object.keys(entries).length > 0)) };
      });
      for (const { entry } of live) {
        if (!current()) return;
        const remote = { host: entry.host, port: entry.port };
        if (!entry.manual) {
          if (entry.localPort !== undefined) runtime.preferredLocal.set(rowKey(remote), entry.localPort);
          continue;
        }
        try {
          await this.open(runtime, remote, 'manual', entry.localPort);
        } catch (err) {
          this.deps.log(`[ports] ${hostId}: restoring the forward of ${tunnelKey(remote)} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (current()) this.publish(runtime);
    });
  }

  /** The host's connection closed: its forwards stop, and its rows go until it connects again. */
  disconnected(hostId: string): void {
    const runtime = this.hosts.get(hostId);
    if (!runtime) return;
    this.reset(runtime);
    this.deps.tunnels.stopAll(runtime.authority);
    this.publish(runtime);
  }

  /** The daemon's whole list of listening sockets. */
  async candidates(hostId: string, candidates: readonly PortCandidate[]): Promise<void> {
    const runtime = this.runtime(hostId);
    if (!runtime.connected) return;
    return this.serial(runtime, async (current) => {
      // one row per loopback port: an IPv4 socket over an IPv6 one, the order the daemon sorts them in
      const byRow = new Map<string, PortCandidate>();
      for (const candidate of candidates) {
        const key = rowKey({ host: candidate.host, port: candidate.port });
        const known = byRow.get(key);
        if (!known || (known.family === 6 && candidate.family === 4)) byRow.set(key, candidate);
      }
      for (const [key, row] of [...runtime.rows]) {
        if (byRow.has(key)) continue;
        row.candidate = undefined;
        // a forward the listener took with it ends; a manual one stays until Stop forwarding, unless WSL carried it
        if (row.origin === 'manual' && !row.viaWsl) continue;
        if (row.tunnelKey !== undefined) this.deps.tunnels.stop(runtime.authority, row.tunnelKey);
        runtime.rows.delete(key);
      }
      // a new row is listed only once it is decided, so a row via WSL is one this computer already reaches
      const newLoopback = [...byRow].filter(([key, candidate]) => !runtime.rows.has(key) && isLoopbackHost(candidate.host)).map(([, candidate]) => candidate);
      const viaWsl = newLoopback.length > 0 ? await this.deps.viaWsl(hostId, newLoopback) : (): boolean => false;
      for (const [key, candidate] of byRow) {
        if (!current()) return;
        const known = runtime.rows.get(key);
        if (known) {
          known.candidate = candidate;
          continue;
        }
        const reachedViaWsl = isLoopbackHost(candidate.host) && viaWsl(candidate.port);
        runtime.rows.set(key, { remote: { host: candidate.host, port: candidate.port }, origin: 'auto', tunnelKey: undefined, error: undefined, candidate, viaWsl: reachedViaWsl });
        await this.detect(runtime, key);
      }
      if (current()) this.publish(runtime);
    });
  }

  /** A URL a terminal or agent shell printed: its port forwards now if something listens on it, or once something does within the window. */
  async urlSeen(hostId: string, port: number): Promise<void> {
    const runtime = this.runtime(hostId);
    if (!runtime.connected) return;
    const until = this.deps.now() + URL_LISTEN_WINDOW_MS;
    runtime.printed.set(port, until);
    const timer = setTimeout(() => {
      runtime.timers.delete(timer);
      if (runtime.printed.get(port) === until) runtime.printed.delete(port);
    }, URL_LISTEN_WINDOW_MS);
    runtime.timers.add(timer);
    return this.serial(runtime, async () => {
      const key = rowKey({ host: 'localhost', port });
      const row = runtime.rows.get(key);
      if (row && row.tunnelKey === undefined && row.candidate) await this.detect(runtime, key);
    });
  }

  view(hostId: string): PortsView {
    const runtime = this.hosts.get(hostId);
    const ports = this.deps.store.ports(hostId);
    const rows = runtime ? [...runtime.rows.entries()].map(([key, row]) => this.rowView(runtime, ports, key, row)) : [];
    rows.sort((a, b) => a.remotePort - b.remotePort || a.remoteHost.localeCompare(b.remoteHost));
    return { hostId, autoForwardMode: ports.fallback === 'switched' ? 'outputOnly' : 'all', autoForward: this.deps.autoForward(), connected: runtime?.connected === true, rows };
  }

  /**
   * Forward a Port: a manual forward, kept until Stop forwarding and restored for the project when the host connects again. A
   * port WSL forwards itself is only marked as the user's: it gets no tunnel, which no Stop could reach.
   */
  async forwardManual(projectKey: string, hostId: string, target: { readonly host?: string; readonly port: number }, label: string | undefined): Promise<Reached> {
    const runtime = this.requireConnected(hostId);
    return this.serial(runtime, async (current) => {
      if (!current()) throw new Error(`${hostId} is not connected`);
      const known = runtime.rows.get(rowKey({ host: target.host ?? 'localhost', port: target.port }));
      const labelled = (ports: HostPorts, port: number): HostPorts['attributes'] => (label === undefined ? ports.attributes : { ...ports.attributes, [String(port)]: { ...ports.attributes[String(port)], label } });
      if (known?.viaWsl) {
        known.origin = 'manual';
        if (label !== undefined) await this.deps.store.updatePorts(hostId, (ports) => ({ ...ports, attributes: labelled(ports, known.remote.port) }));
        this.publish(runtime);
        return { remote: known.remote, localPort: known.remote.port };
      }
      const remote = target.host !== undefined ? { host: target.host, port: target.port } : known?.remote ?? { host: 'localhost', port: target.port };
      const tunnel = await this.open(runtime, remote, 'manual', undefined);
      if (!tunnel) throw new Error(`${hostId} disconnected while forwarding ${tunnelKey(remote)}`);
      await this.deps.store.updatePorts(hostId, (ports) => {
        const entry: RestoredForward = { host: remote.host, port: remote.port, ...(tunnel.localPort !== remote.port ? { localPort: tunnel.localPort } : {}), manual: true, lastUsed: this.deps.now() };
        return { ...ports, attributes: labelled(ports, remote.port), restore: { ...ports.restore, [projectKey]: { ...ports.restore[projectKey], [rowKey(remote)]: entry } } };
      });
      this.publish(runtime);
      return tunnel;
    });
  }

  /** The Forward action of a listed row: forwards it as the user's own choice. */
  async forwardRow(projectKey: string, hostId: string, key: string): Promise<Reached> {
    const runtime = this.requireConnected(hostId);
    const row = runtime.rows.get(key);
    if (!row) throw new Error(`No port ${key} on ${hostId}`);
    return this.forwardManual(projectKey, hostId, row.remote, undefined);
  }

  /** Stop forwarding: the listener and its connections close, and no project restores it. */
  async stop(hostId: string, key: string): Promise<void> {
    const runtime = this.hosts.get(hostId);
    if (!runtime) return;
    return this.serial(runtime, async () => {
      const row = runtime.rows.get(key);
      if (!row) return;
      if (row.viaWsl) throw new ViaWslError(`Port ${key} reaches this computer through WSL and has no forward to stop`);
      if (row.tunnelKey !== undefined) this.deps.tunnels.stop(runtime.authority, row.tunnelKey);
      row.tunnelKey = undefined;
      row.error = undefined;
      if (row.candidate) row.origin = 'auto';
      else runtime.rows.delete(key);
      await this.deps.store.updatePorts(hostId, (ports) => ({
        ...ports,
        restore: Object.fromEntries(Object.entries(ports.restore).map(([projectKey, entries]) => [projectKey, withoutKey(entries, key)] as const).filter(([, entries]) => Object.keys(entries).length > 0)),
      }));
      this.publish(runtime);
    });
  }

  /** Change local port: a refused or taken port throws PortRefusedError and leaves the forward as it was. */
  async changeLocalPort(projectKey: string, hostId: string, key: string, localPort: number): Promise<Tunnel> {
    const runtime = this.requireConnected(hostId);
    return this.serial(runtime, async () => {
      const row = runtime.rows.get(key);
      if (row?.viaWsl) throw new ViaWslError(`Port ${key} reaches this computer through WSL on its own port`);
      if (!row?.tunnelKey) throw new Error(`Port ${key} is not forwarded`);
      const tunnel = await this.deps.tunnels.changeLocalPort(runtime.authority, row.tunnelKey, localPort);
      await this.deps.store.updatePorts(hostId, (ports) => {
        const previous = ports.restore[projectKey]?.[key];
        const entry: RestoredForward = { host: row.remote.host, port: row.remote.port, localPort, manual: previous?.manual === true || row.origin === 'manual', lastUsed: this.deps.now() };
        return { ...ports, restore: { ...ports.restore, [projectKey]: { ...ports.restore[projectKey], [key]: entry } } };
      });
      this.publish(runtime);
      return tunnel;
    });
  }

  async setLabel(hostId: string, port: number, label: string | undefined): Promise<void> {
    await this.deps.store.updatePorts(hostId, (ports) => {
      const { label: _old, ...rest } = ports.attributes[String(port)] ?? {};
      const next = label === undefined ? rest : { ...rest, label };
      return { ...ports, attributes: Object.keys(next).length === 0 ? withoutKey(ports.attributes, String(port)) : { ...ports.attributes, [String(port)]: next } };
    });
    this.publishHost(hostId);
  }

  async setOnDetect(hostId: string, port: number, onDetect: OnDetect): Promise<void> {
    await this.deps.store.updatePorts(hostId, (ports) => ({ ...ports, attributes: { ...ports.attributes, [String(port)]: { ...ports.attributes[String(port)], onDetect } } }));
    this.publishHost(hostId);
  }

  /** Undo of the fallback: every listening port forwards again, and this host never switches again. */
  async undoFallback(hostId: string): Promise<void> {
    await this.deps.store.updatePorts(hostId, (ports) => ({ ...ports, fallback: 'disabled' }));
    const runtime = this.hosts.get(hostId);
    if (runtime?.connected) {
      await this.serial(runtime, async () => {
        for (const key of [...runtime.rows.keys()]) {
          const row = runtime.rows.get(key);
          if (row && row.tunnelKey === undefined && row.candidate) await this.detect(runtime, key);
        }
      });
    }
    this.publishHost(hostId);
  }

  /** The tunnels a loopback URL rewrite uses: an existing forward of that port, else a new one of the detected socket. */
  forwardingFor(hostId: string): Pick<TunnelManager, 'forward' | 'list'> {
    return {
      list: (authority) => this.deps.tunnels.list(authority),
      forward: async (authority, remote, options) => {
        const runtime = this.requireConnected(hostId);
        if (authority !== runtime.authority) throw new Error(`${authority} is not this host's authority`);
        return this.serial(runtime, async (current) => {
          if (!current()) throw new Error(`${hostId} is not connected`);
          const key = rowKey(remote);
          const row = runtime.rows.get(key);
          // the page reaches the target's own port through WSL; no tunnel stands for it
          if (row?.viaWsl) return { authority, key, remote: row.remote, localPort: row.remote.port, localAddresses: ['127.0.0.1'], liveConnections: 0 };
          const forwarded = row?.tunnelKey === undefined ? undefined : this.deps.tunnels.get(authority, row.tunnelKey);
          if (forwarded) return forwarded;
          const target = isLoopbackHost(remote.host) ? row?.remote ?? { host: 'localhost', port: remote.port } : remote;
          const tunnel = await this.open(runtime, target, row?.origin ?? 'auto', options?.localPort, options?.requireLocalPort);
          if (!tunnel) throw new Error(`${hostId} disconnected while forwarding ${tunnelKey(target)}`);
          this.publish(runtime);
          return tunnel;
        });
      },
    };
  }

  // the forwards stop after the subscription ends, so no view is published while the app tears down
  dispose(): void {
    this.subscription.dispose();
    for (const runtime of this.hosts.values()) {
      this.reset(runtime);
      this.deps.tunnels.stopAll(runtime.authority);
    }
  }

  private runtime(hostId: string): HostRuntime {
    let runtime = this.hosts.get(hostId);
    if (!runtime) {
      runtime = { hostId, authority: this.deps.authorityOf(hostId), connected: false, generation: 0, queue: Promise.resolve(), rows: new Map(), autoForwards: 0, printed: new Map(), announced: new Set(), actions: [], preferredLocal: new Map(), timers: new Set() };
      this.hosts.set(hostId, runtime);
    }
    return runtime;
  }

  private requireConnected(hostId: string): HostRuntime {
    const runtime = this.hosts.get(hostId);
    if (!runtime?.connected) throw new Error(`${hostId} is not connected`);
    return runtime;
  }

  // Runs work once the host's earlier work settled; current() turns false at the next reset, after which work keeps nothing
  private serial<T>(runtime: HostRuntime, work: (current: () => boolean) => Promise<T>): Promise<T> {
    const generation = runtime.generation;
    const result = runtime.queue.then(() => work(() => runtime.generation === generation));
    runtime.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private reset(runtime: HostRuntime): void {
    runtime.generation += 1;
    runtime.connected = false;
    runtime.rows = new Map();
    runtime.autoForwards = 0;
    runtime.printed.clear();
    runtime.preferredLocal.clear();
    for (const timer of runtime.timers) clearTimeout(timer);
    runtime.timers.clear();
  }

  // A detected row, newly listed or its URL printed: forwarded, listed, or the host switched to output-only.
  private async detect(runtime: HostRuntime, key: string): Promise<void> {
    const row = runtime.rows.get(key);
    if (!row || row.tunnelKey !== undefined) return;
    const generation = runtime.generation;
    const ports = this.deps.store.ports(runtime.hostId);
    const onDetect = attributesOf(ports, row.remote.port).onDetect ?? 'notify';
    if (onDetect === 'ignore' || !this.deps.autoForward()) return;
    if (row.viaWsl) {
      this.announce(runtime, onDetect, { remote: row.remote, localPort: row.remote.port });
      return;
    }
    const printed = (runtime.printed.get(row.remote.port) ?? 0) >= this.deps.now();
    if (!printed) {
      if (ports.fallback === 'switched') return;
      const threshold = this.deps.fallbackThreshold();
      if (ports.fallback !== 'disabled' && threshold > 0 && runtime.autoForwards >= threshold) {
        await this.deps.store.updatePorts(runtime.hostId, (current) => (current.fallback === undefined ? { ...current, fallback: 'switched' } : current));
        if (runtime.generation !== generation) return;
        this.deps.log(`[ports] ${runtime.hostId}: ${runtime.autoForwards} automatic forwards; only ports seen in output forward from now on`);
        this.deps.fallbackSwitched(runtime.hostId, runtime.autoForwards);
        return;
      }
      runtime.autoForwards += 1;
    }
    row.origin = printed ? 'output' : 'auto';
    runtime.printed.delete(row.remote.port);
    let tunnel: Tunnel | undefined;
    try {
      tunnel = await this.open(runtime, row.remote, row.origin, runtime.preferredLocal.get(key));
    } catch (err) {
      if (err instanceof PortRefusedError || err instanceof ForwardLimitError) return;
      throw err;
    }
    if (tunnel) this.announce(runtime, onDetect, tunnel);
  }

  // A detected port's onDetect: a notice once per port and run, and at most DETECTED_ACTIONS_PER_WINDOW of any per window
  private announce(runtime: HostRuntime, onDetect: Exclude<OnDetect, 'ignore'>, reached: Reached): void {
    if (onDetect === 'silent') return;
    if (onDetect === 'notify') {
      if (runtime.announced.has(reached.remote.port)) return;
      runtime.announced.add(reached.remote.port);
    }
    const now = this.deps.now();
    runtime.actions = runtime.actions.filter((at) => now - at < DETECTED_ACTIONS_WINDOW_MS);
    if (runtime.actions.length >= DETECTED_ACTIONS_PER_WINDOW) {
      this.deps.log(`[ports] ${runtime.hostId}: port ${reached.remote.port} is forwarded without its ${onDetect}: ${DETECTED_ACTIONS_PER_WINDOW} ran in the last ${DETECTED_ACTIONS_WINDOW_MS / 1000} s`);
      return;
    }
    runtime.actions.push(now);
    this.deps.detected(runtime.hostId, onDetect, reached);
  }

  // Opens the row's forward; a listener that cannot start marks the row failed, and a refusal at the forward limit leaves the
  // rows as they were. Undefined: the connection was reset or the row removed while it bound, so the forward was stopped.
  private async open(runtime: HostRuntime, remote: TunnelTarget, origin: Origin, localPort: number | undefined, requireLocalPort?: boolean): Promise<Tunnel | undefined> {
    const key = rowKey(remote);
    const known = runtime.rows.get(key);
    const row: Row = known ?? { remote, origin, tunnelKey: undefined, error: undefined, candidate: undefined, viaWsl: false };
    const previousOrigin = row.origin;
    const generation = runtime.generation;
    runtime.rows.set(key, row);
    row.origin = origin;
    try {
      const tunnel = await this.deps.tunnels.forward(runtime.authority, row.remote, { ...(localPort !== undefined ? { localPort } : {}), ...(requireLocalPort === true ? { requireLocalPort } : {}) });
      if (runtime.generation !== generation || runtime.rows.get(key) !== row) {
        if (![...runtime.rows.values()].some((other) => other.tunnelKey === tunnel.key)) this.deps.tunnels.stop(runtime.authority, tunnel.key);
        return undefined;
      }
      row.tunnelKey = tunnel.key;
      row.error = undefined;
      return tunnel;
    } catch (err) {
      if (err instanceof ForwardLimitError) {
        if (known) row.origin = previousOrigin;
        else if (runtime.rows.get(key) === row) runtime.rows.delete(key);
        throw err;
      }
      if (!(err instanceof PortRefusedError)) row.error = 'listenFailed';
      this.deps.log(`[ports] ${runtime.hostId}: forwarding ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private rowView(runtime: HostRuntime, ports: HostPorts, key: string, row: Row): PortRow {
    const tunnel = row.tunnelKey === undefined ? undefined : this.deps.tunnels.get(runtime.authority, row.tunnelKey);
    const attributes = attributesOf(ports, row.remote.port);
    const onDetect = attributes.onDetect ?? 'notify';
    const processLabel = processLabelOf(row.candidate);
    if (row.viaWsl) {
      return {
        key,
        remoteHost: 'localhost',
        remotePort: row.remote.port,
        localPort: row.remote.port,
        ...(attributes.label !== undefined ? { label: attributes.label } : {}),
        ...(processLabel !== undefined ? { processLabel } : {}),
        state: onDetect === 'ignore' && row.origin !== 'manual' ? 'ignored' : 'forwarded',
        liveConnections: 0,
        origin: row.origin,
        onDetect,
        viaWsl: true,
      };
    }
    return {
      key,
      remoteHost: isLoopbackHost(row.remote.host) ? 'localhost' : row.remote.host,
      remotePort: row.remote.port,
      ...(tunnel ? { localPort: tunnel.localPort } : {}),
      ...(attributes.label !== undefined ? { label: attributes.label } : {}),
      ...(processLabel !== undefined ? { processLabel } : {}),
      state: tunnel ? 'forwarded' : row.error ? 'error' : onDetect === 'ignore' ? 'ignored' : 'detected',
      ...(row.error && !tunnel ? { error: row.error } : {}),
      liveConnections: tunnel?.liveConnections ?? 0,
      origin: row.origin,
      onDetect,
    };
  }

  private networkOf(runtime: HostRuntime): ClientNetwork {
    const direct = [...runtime.rows.values()].filter((row) => row.viaWsl).map((row) => row.remote.port);
    const allowedPorts = [...new Set([...this.deps.tunnels.list(runtime.authority).map((tunnel) => tunnel.localPort), ...direct])].sort((a, b) => a - b);
    return { authority: runtime.authority, allowedPorts, allowLocalNetwork: this.deps.store.localNetwork(runtime.hostId) };
  }

  private publishNetwork(runtime: HostRuntime): void {
    const network = this.networkOf(runtime);
    const json = JSON.stringify(network);
    if (this.networks.get(runtime.authority) === json) return;
    this.networks.set(runtime.authority, json);
    this.networkChanged.fire(network);
  }

  private publishHost(hostId: string): void {
    const runtime = this.hosts.get(hostId);
    if (runtime) this.publish(runtime);
    else this.changed.fire(hostId);
  }

  private publish(runtime: HostRuntime): void {
    this.publishNetwork(runtime);
    this.changed.fire(runtime.hostId);
  }
}
