// Main's Ports section: the TunnelManager and PortForwarding wired to each remote host's connection, the shell's invokes (each
// payload checked here), main's own text inputs and notices, and the clientNetwork mirror the local core's proxy reads. A WSL
// distro's connection is probed first for WSL's own loopback forwarding (wsl-port-probe.ts). The loopback daemon has no host
// record: its port state lasts the run.
import type { Disposable } from '../../../../platform/disposable';
import { parseLocalPort, parsePortTarget } from '../../../../shared/input-validation';
import type { StreamChannel } from '../../../../remote/mux';
import { MAX_PORT_LABEL_CHARS, ON_DETECT, type OnDetect, type PortsView } from '../../../preload/ports-channels';
import { MAX_ID_LENGTH } from '../../../preload/shell-channels';
import { authorityKeyOfProject } from '../../../../shared/project-location';
import type { AskInput } from '../../overlay';
import { EMPTY_HOST_PORTS, hostIdOfAuthority, type HostPorts, type HostStore } from '../host-store';
import { windowsPortHolder, type PortHolder, type ProbeVerdict, type WindowsListeners } from '../wsl/wsl-port-probe';
import type { RemoteConnection } from '../connection';
import { PortForwarding, type ClientNetwork, type Reached } from './port-forwarding';
import { reservedClientPorts } from './reserved-ports';
import { ForwardLimitError, MAX_FORWARDS_PER_HOST, PortRefusedError, TunnelManager, type LoopbackAddress, type PortRefusal, type Tunnel } from './tunnels';
import type { PortCandidate } from '../../../daemon/ports/ports-messages';

/** The shell's Ports invokes; each takes the raw payload and checks it before anything acts. */
export interface ShellPortsActions {
  get(raw: unknown): Promise<PortsView | null>;
  forward(raw: unknown): Promise<void>;
  forwardDetected(raw: unknown): Promise<void>;
  stop(raw: unknown): Promise<void>;
  setLabel(raw: unknown): Promise<void>;
  changeLocalPort(raw: unknown): Promise<void>;
  setOnDetect(raw: unknown): Promise<void>;
  openInPane(raw: unknown): Promise<void>;
  openInBrowser(raw: unknown): Promise<void>;
  copyAddress(raw: unknown): Promise<void>;
  undoFallback(raw: unknown): Promise<void>;
}

export interface PortsControllerDeps {
  readonly hostStore: HostStore;
  readonly clientPlatform: NodeJS.Platform;
  // the authority's connection while it is usable
  readonly connection: (authority: string) => RemoteConnection | undefined;
  readonly autoForward: () => boolean;
  readonly fallbackThreshold: () => number;
  readonly projectsOf: (hostId: string) => readonly string[];
  // an SSH host's project key listed in the sidebar
  readonly isProject: (projectKey: string) => boolean;
  readonly hostName: (hostId: string) => string;
  // a notice in the popup window and notification center with the host's chip; the chosen action's index
  readonly notice: (hostId: string, severity: 'info' | 'warning', title: string, message: string, actions: readonly string[]) => Promise<number | undefined>;
  // a browser tab of the project's selected chat (else the host's), at url
  readonly openInPane: (projectKey: string | undefined, hostId: string, url: string) => Promise<void>;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly copy: (text: string) => Promise<void>;
  readonly askInput: AskInput;
  readonly t: (message: string, ...args: string[]) => string;
  readonly now?: () => number;
  // a WSL distro's probe of its daemon's nonce listener, and the reader of this computer's own listeners, loaded at first use
  readonly probe?: (port: number, nonce: string) => Promise<ProbeVerdict>;
  readonly windowsListeners?: () => WindowsListeners;
  // whether this computer's loopback accepts a port within the relay's window (acceptedWithin); without it, a port no Windows
  // process holds is tunneled
  readonly accepted?: (host: LoopbackAddress, port: number) => Promise<boolean>;
  // `wslinfo --networking-mode` in the distro, logged for diagnosis only
  readonly networkingMode?: (distro: string) => Promise<string>;
  readonly log: (line: string) => void;
}

// the daemon answers its loopback probe (control.portProbe)
const PORT_PROBE_FEATURE = 'control.portProbe';
// the loopback daemon's host id and authority key; no drawn host id is this short
export const LOOPBACK_HOST = 'loopback';

const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const text = (raw: unknown, what: string): string => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ID_LENGTH) throw new Error(`${what} is not a bounded string`);
  return raw;
};
const localAddress = (reached: Pick<Tunnel, 'localPort'>): string => `http://localhost:${reached.localPort}`;

export class PortsController {
  readonly tunnels: TunnelManager;
  readonly forwarding: PortForwarding;
  private readonly deps: PortsControllerDeps;
  private readonly subscriptions: Disposable[] = [];
  // each host's connection whose ports this follows
  private readonly followed = new Map<string, { readonly connection: RemoteConnection; readonly subscriptions: Disposable[] }>();
  // the WSL distros whose connection's probe found WSL forwarding loopback ports to this computer
  private readonly wslForwarded = new Set<string>();
  private windowsListeners: { readonly reader: WindowsListeners } | { readonly failed: true } | undefined;
  private loopbackPorts: HostPorts = EMPTY_HOST_PORTS;

  constructor(deps: PortsControllerDeps) {
    this.deps = deps;
    this.tunnels = new TunnelManager({
      opener: (authority) => {
        const connection = deps.connection(authority);
        return connection ? (target): Promise<StreamChannel> => connection.openTunnel(target.host, target.port) : undefined;
      },
      reserved: reservedClientPorts(),
      clientPlatform: deps.clientPlatform,
      log: deps.log,
    });
    this.forwarding = new PortForwarding({
      tunnels: this.tunnels,
      store: {
        ports: (hostId) => (hostId === LOOPBACK_HOST ? this.loopbackPorts : deps.hostStore.ports(hostId)),
        updatePorts: async (hostId, apply) => {
          if (hostId === LOOPBACK_HOST) this.loopbackPorts = apply(this.loopbackPorts);
          else await deps.hostStore.updatePorts(hostId, apply);
        },
        localNetwork: (hostId) => deps.hostStore.host(hostId)?.settings.browserLocalNetwork === true,
      },
      autoForward: deps.autoForward,
      fallbackThreshold: deps.fallbackThreshold,
      projectsOf: deps.projectsOf,
      authorityOf: (hostId) => {
        const authority = this.authorityOf(hostId);
        if (authority === undefined) throw new Error(`No saved host ${hostId}`);
        return authority;
      },
      viaWsl: (hostId, candidates) => this.viaWsl(hostId, candidates),
      detected: (hostId, action, reached) => this.detected(hostId, action, reached),
      fallbackSwitched: (hostId, count) => this.fallbackSwitched(hostId, count),
      now: deps.now ?? Date.now,
      log: deps.log,
    });
    this.subscriptions.push(deps.hostStore.onDidChange(() => this.forwarding.settingsChanged()));
  }

  onView(listener: (view: PortsView) => void): Disposable {
    return this.forwarding.onDidChange((hostId) => listener(this.forwarding.view(hostId)));
  }

  onClientNetwork(listener: (network: ClientNetwork) => void): Disposable {
    return this.forwarding.onClientNetwork(listener);
  }

  clientNetworks(): Record<string, { readonly allowedPorts: readonly number[]; readonly allowLocalNetwork: boolean }> {
    return Object.fromEntries(this.forwarding.clientNetworks().map(({ authority, allowedPorts, allowLocalNetwork }) => [authority, { allowedPorts, allowLocalNetwork }]));
  }

  /**
   * A fresh connection of a host that serves ports: a WSL distro's daemon is probed first, then its restore entries come back
   * and its reports are followed.
   */
  connected(hostId: string, connection: RemoteConnection): void {
    this.stopFollowing(hostId);
    this.wslForwarded.delete(hostId);
    if (!connection.features.includes('ports')) return;
    // the probe runs at the first list, after the daemon's first scan, so WSL has had that long to relay the probe's listener;
    // every list waits for its verdict, in order
    let probed: Promise<void> | undefined;
    const subscriptions = [
      connection.ports.onEvent('list', ({ candidates }) => {
        probed ??= this.probeWsl(hostId, connection);
        probed.then(() => this.forwarding.candidates(hostId, candidates)).catch((err: unknown) => this.deps.log(`[ports] ${hostId}: applying the listening ports failed: ${String(err)}`));
      }),
      connection.ports.onEvent('urlSeen', ({ port }) => {
        this.forwarding.urlSeen(hostId, port).catch((err: unknown) => this.deps.log(`[ports] ${hostId}: forwarding a printed URL's port failed: ${String(err)}`));
      }),
      connection.onClose(() => {
        if (this.followed.get(hostId)?.connection !== connection) return;
        this.stopFollowing(hostId);
        this.forwarding.disconnected(hostId);
      }),
      // a tunnel's socket holds no resumable state, and a browser stalled for the grace is worse off than reset
      connection.onLost(() => {
        const authority = this.authorityOf(hostId);
        if (authority !== undefined) this.tunnels.resetConnections(authority);
      }),
    ];
    this.followed.set(hostId, { connection, subscriptions });
    // detection starts whatever became of the restores
    void this.forwarding.connected(hostId)
      .catch((err: unknown) => this.deps.log(`[ports] ${hostId}: restoring forwards failed: ${String(err)}`))
      .then(() => connection.ports.request('watch', {}))
      .catch((err: unknown) => this.deps.log(`[ports] ${hostId}: watching the ports failed: ${String(err)}`));
  }

  /** Forget host: its forwards stop; its attributes and restore entries go with its host record. */
  forget(hostId: string): void {
    this.stopFollowing(hostId);
    this.wslForwarded.delete(hostId);
    this.forwarding.disconnected(hostId);
  }

  readonly actions: ShellPortsActions = {
    get: async (raw) => {
      const hostId = isRecord(raw) ? hostIdOfAuthority(`ssh+${text(raw['hostId'], 'hostId')}`) : undefined;
      return hostId !== undefined && this.deps.hostStore.host(hostId) ? this.forwarding.view(hostId) : null;
    },
    forward: async (raw) => {
      const { projectKey, hostId } = this.project(raw);
      const target = await this.deps.askInput({ title: this.deps.t('Forward a port'), prompt: this.deps.t('Port on {0}', this.deps.hostName(hostId)), placeholder: this.deps.t('8080 or db:5432'), validation: 'portTarget' });
      const parsed = target === undefined ? undefined : parsePortTarget(target);
      if (!parsed) return;
      const label = await this.deps.askInput({ title: this.deps.t('Forward a port'), prompt: this.deps.t('Label (optional)') });
      if (label === undefined) return;
      await this.atLimitTold(hostId, this.forwarding.forwardManual(projectKey, hostId, parsed, this.label(label)));
    },
    forwardDetected: async (raw) => {
      const { projectKey, hostId } = this.project(raw);
      await this.atLimitTold(hostId, this.forwarding.forwardRow(projectKey, hostId, this.key(raw)));
    },
    stop: async (raw) => {
      const { hostId } = this.project(raw);
      await this.forwarding.stop(hostId, this.key(raw));
    },
    setLabel: async (raw) => {
      const { hostId } = this.project(raw);
      const row = this.row(hostId, this.key(raw));
      const label = await this.deps.askInput({ title: this.deps.t('Set label for {0}', String(row.remotePort)), prompt: this.deps.t('Label'), ...(row.label !== undefined ? { value: row.label } : {}) });
      if (label === undefined) return;
      await this.forwarding.setLabel(hostId, row.remotePort, this.label(label));
    },
    changeLocalPort: async (raw) => {
      const { projectKey, hostId } = this.project(raw);
      const key = this.key(raw);
      const row = this.row(hostId, key);
      if (row.localPort === undefined) throw new Error(`Port ${key} is not forwarded`);
      let value = String(row.localPort);
      let error: string | undefined;
      for (;;) {
        const answer = await this.deps.askInput({ title: this.deps.t('Change local port for {0}', String(row.remotePort)), prompt: this.deps.t('Local port on this computer'), value, validation: 'localPort', ...(error !== undefined ? { error } : {}) });
        const localPort = answer === undefined ? undefined : parseLocalPort(answer);
        if (answer === undefined || localPort === undefined) return;
        try {
          await this.forwarding.changeLocalPort(projectKey, hostId, key, localPort);
          return;
        } catch (err) {
          if (!(err instanceof PortRefusedError)) throw err;
          value = answer;
          error = this.refusalText(err.code, err.port);
        }
      }
    },
    setOnDetect: async (raw) => {
      const { hostId } = this.project(raw);
      const port = isRecord(raw) ? raw['port'] : undefined;
      const onDetect = isRecord(raw) ? raw['onDetect'] : undefined;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || !ON_DETECT.includes(onDetect as OnDetect)) throw new Error('Not a port and onDetect value');
      await this.forwarding.setOnDetect(hostId, port, onDetect as OnDetect);
    },
    openInPane: async (raw) => {
      const { projectKey, hostId } = this.project(raw);
      await this.deps.openInPane(projectKey, hostId, localAddress(this.reached(hostId, this.key(raw))));
    },
    openInBrowser: async (raw) => {
      const { hostId } = this.project(raw);
      await this.deps.openExternal(localAddress(this.reached(hostId, this.key(raw))));
    },
    copyAddress: async (raw) => {
      const { hostId } = this.project(raw);
      await this.deps.copy(localAddress(this.reached(hostId, this.key(raw))));
    },
    undoFallback: async (raw) => {
      const { hostId } = this.project(raw);
      await this.forwarding.undoFallback(hostId);
    },
  };

  /** Stops following every connection and closes every forward's listeners. */
  dispose(): void {
    for (const hostId of [...this.followed.keys()]) this.stopFollowing(hostId);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.forwarding.dispose();
  }

  /** The authority key of a host's projects: a saved host's, or the loopback daemon's. */
  authorityOf(hostId: string): string | undefined {
    return hostId === LOOPBACK_HOST ? LOOPBACK_HOST : this.deps.hostStore.authorityOf(hostId);
  }

  /** Why a local port is refused, as the Change local port box shows it. */
  refusalText(code: PortRefusal, port: number): string {
    switch (code) {
      case 'inUse': return this.deps.t('Port {0} is in use on this computer', String(port));
      case 'reserved': return this.deps.t('Port {0} is reserved for sign-ins on this computer', String(port));
      case 'privileged': return this.deps.t('Ports below 1024 need administrator rights on this computer');
      case 'invalid': return this.deps.t('Enter a port from 1 to 65535');
    }
  }

  // the user's own forward refused at the limit is told in a notice, not failed as an error
  private async atLimitTold(hostId: string, forwarding: Promise<unknown>): Promise<void> {
    try {
      await forwarding;
    } catch (err) {
      if (!(err instanceof ForwardLimitError)) throw err;
      void this.deps.notice(hostId, 'warning', this.deps.t('Port not forwarded'), this.deps.t('{0} already has {1} forwarded ports, the most Damocles keeps for one host. Stop forwarding one to forward another.', this.deps.hostName(hostId), String(MAX_FORWARDS_PER_HOST)), [])
        .catch((noticeErr: unknown) => this.deps.log(`[ports] ${hostId}: the forward limit notice failed: ${String(noticeErr)}`));
    }
  }

  private stopFollowing(hostId: string): void {
    const followed = this.followed.get(hostId);
    this.followed.delete(hostId);
    for (const subscription of followed?.subscriptions ?? []) subscription.dispose();
  }

  private project(raw: unknown): { readonly projectKey: string; readonly hostId: string } {
    const projectKey = isRecord(raw) ? text(raw['projectKey'], 'projectKey') : undefined;
    const authority = projectKey === undefined ? undefined : authorityKeyOfProject(projectKey);
    const hostId = authority === LOOPBACK_HOST ? LOOPBACK_HOST : authority === undefined ? undefined : this.deps.hostStore.hostIdOf(authority);
    if (projectKey === undefined || hostId === undefined || !this.deps.isProject(projectKey)) throw new Error('Not a project on a saved host or the loopback daemon');
    return { projectKey, hostId };
  }

  private key(raw: unknown): string {
    return text(isRecord(raw) ? raw['key'] : undefined, 'key');
  }

  private row(hostId: string, key: string): PortsView['rows'][number] {
    const row = this.forwarding.view(hostId).rows.find((candidate) => candidate.key === key);
    if (!row) throw new Error(`No port ${key} on the host`);
    return row;
  }

  // the port as this computer reaches it: its tunnel, or its own number through WSL
  private reached(hostId: string, key: string): Pick<Tunnel, 'localPort'> {
    const row = this.row(hostId, key);
    if (row.viaWsl) return { localPort: row.remotePort };
    const authority = this.authorityOf(hostId);
    const tunnel = authority === undefined ? undefined : this.tunnels.list(authority).find((candidate) => candidate.localPort === row.localPort);
    if (!tunnel) throw new Error(`Port ${key} is not forwarded`);
    return tunnel;
  }

  // A distro's daemon answers its nonce on a loopback port: read back on this computer's own 127.0.0.1, it shows that WSL
  // forwards loopback ports here. Any other answer leaves every port to the tunnels.
  private async probeWsl(hostId: string, connection: RemoteConnection): Promise<void> {
    const record = this.deps.hostStore.host(hostId);
    if (record?.kind !== 'wsl' || !this.deps.probe || !connection.features.includes(PORT_PROBE_FEATURE)) return;
    const { networkingMode } = this.deps;
    if (networkingMode) {
      networkingMode(record.distro).then(
        (mode) => this.deps.log(`[ports] ${hostId}: wslinfo --networking-mode says ${mode}`),
        (err: unknown) => this.deps.log(`[ports] ${hostId}: wslinfo --networking-mode did not answer: ${String(err)}`),
      );
    }
    try {
      const { port, nonce } = await connection.control.request('portProbe', {});
      const verdict = await this.deps.probe(port, nonce);
      this.deps.log(`[ports] ${hostId}: ${verdict.forwarded ? 'WSL forwards loopback ports to this computer' : `ports are tunneled; the probe got ${verdict.reason}`}`);
      if (verdict.forwarded && this.followed.get(hostId)?.connection === connection) this.wslForwarded.add(hostId);
    } catch (err) {
      this.deps.log(`[ports] ${hostId}: the WSL port probe failed, so ports are tunneled: ${String(err)}`);
    }
  }

  // A port WSL forwards reaches this computer on its own number once WSL's relay holds it, or once a port no Windows process
  // held accepts a connection here within the relay's window; a port another Windows process holds is tunneled. The listeners
  // are read once per call, and once more after such a wait; listeners that cannot be read tunnel every port.
  private async viaWsl(hostId: string, candidates: readonly PortCandidate[]): Promise<(port: number) => boolean> {
    if (!this.wslForwarded.has(hostId)) return () => false;
    const reader = this.windowsListenerReader();
    if (!reader) return () => false;
    const images = new Map<number, string | undefined>();
    const read = (): WindowsListeners | undefined => {
      try {
        const rows = reader.rows();
        return {
          rows: () => rows,
          imagePath: (pid) => {
            if (!images.has(pid)) images.set(pid, reader.imagePath(pid));
            return images.get(pid);
          },
        };
      } catch (err) {
        this.deps.log(`[ports] ${hostId}: reading this computer's listeners failed, so ports are tunneled: ${String(err)}`);
        return undefined;
      }
    };
    const listeners = read();
    if (!listeners) return () => false;
    const holders = new Map<number, PortHolder | 'unanswered'>(candidates.map((candidate) => [candidate.port, windowsPortHolder(candidate.port, listeners)]));
    const waiting = candidates.filter((candidate) => holders.get(candidate.port) === 'none');
    if (waiting.length > 0) {
      const { accepted } = this.deps;
      const answered = await Promise.all(waiting.map(async (candidate) => {
        if (!accepted) return false;
        try {
          return await accepted(candidate.family === 6 ? '::1' : '127.0.0.1', candidate.port);
        } catch (err) {
          this.deps.log(`[ports] ${hostId}: connecting to port ${candidate.port} on this computer failed: ${String(err)}`);
          return false;
        }
      }));
      const again = read();
      if (!again) return () => false;
      waiting.forEach((candidate, index) => holders.set(candidate.port, answered[index] ? windowsPortHolder(candidate.port, again) : 'unanswered'));
    }
    for (const [port, holder] of holders) {
      if (holder === 'other') this.deps.log(`[ports] ${hostId}: port ${port} is held by another program on this computer, so it is tunneled`);
      if (holder === 'unanswered') this.deps.log(`[ports] ${hostId}: port ${port} did not answer on this computer within the relay's window, so it is tunneled`);
    }
    return (port) => holders.get(port) === 'wslRelay' || holders.get(port) === 'none';
  }

  // the reader is loaded once; a load that failed (koffi) is not tried again
  private windowsListenerReader(): WindowsListeners | undefined {
    const load = this.deps.windowsListeners;
    if (!load) return undefined;
    if (this.windowsListeners === undefined) {
      try {
        this.windowsListeners = { reader: load() };
      } catch (err) {
        this.windowsListeners = { failed: true };
        this.deps.log(`[ports] loading this computer's TCP table reader failed, so every WSL port is tunneled: ${String(err)}`);
      }
    }
    return 'reader' in this.windowsListeners ? this.windowsListeners.reader : undefined;
  }

  private label(answer: string): string | undefined {
    const label = answer.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').trim().slice(0, MAX_PORT_LABEL_CHARS);
    return label.length > 0 ? label : undefined;
  }

  private detected(hostId: string, action: 'notify' | 'openPane' | 'openBrowser', tunnel: Reached): void {
    const url = localAddress(tunnel);
    const failed = (what: string) => (err: unknown): void => this.deps.log(`[ports] ${hostId}: ${what} for port ${tunnel.remote.port} failed: ${String(err)}`);
    if (action === 'openPane') {
      this.deps.openInPane(undefined, hostId, url).catch(failed('opening the pane'));
      return;
    }
    if (action === 'openBrowser') {
      this.deps.openExternal(url).catch(failed('opening the browser'));
      return;
    }
    const open = this.deps.t('Open in pane');
    void this.deps.notice(hostId, 'info', this.deps.t('Port {0} is available', String(tunnel.remote.port)), this.deps.t('{0}:{1} is now localhost:{2} on this computer.', this.deps.hostName(hostId), String(tunnel.remote.port), String(tunnel.localPort)), [open]).then((chosen) => {
      if (chosen === 0) return this.deps.openInPane(undefined, hostId, url);
      return undefined;
    }).catch(failed('the notice'));
  }

  private fallbackSwitched(hostId: string, count: number): void {
    const name = this.deps.hostName(hostId);
    void this.deps.notice(
      hostId,
      'warning',
      this.deps.t('{0} now forwards only ports seen in terminal output', name),
      this.deps.t('{0} ports were forwarded automatically. New ports are forwarded once a terminal or agent shell prints their address.', String(count)),
      [this.deps.t('Undo')],
    ).then((chosen) => (chosen === 0 ? this.forwarding.undoFallback(hostId) : undefined))
      .catch((err: unknown) => this.deps.log(`[ports] ${hostId}: the fallback notice failed: ${String(err)}`));
  }
}
