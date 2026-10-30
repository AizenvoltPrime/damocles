// An authority's Damocles Core as main reaches it: the daemon's child, attached over the connection's `core` channel instead
// of forked (docs/invariants.md "Remote daemon and wire"). Each attach generation is one endpoint lifetime; a new core epoch
// ends it.
import { attachedTransport, createMainEndpoint, type AttachedTransport, type ChatPermissions, type MirrorTopics } from '../../core-protocol';
import type { CoreAttach, CoreState } from '../../daemon/control-messages';
import { CoreClient } from '../core-client';
import { CoreHost, type HostedCore } from '../core-host';
import { createHostServices, type HostServices, type HostServicesDeps, type RelayView } from '../core-services/host-services';
import { KeptPermissions } from '../kept-permissions';
import type { Disposable } from '../../../platform/disposable';
import type { RemoteConnection } from './connection';
import { authorityProjectKeys } from './remote-project-keys';
import type { UserRelays } from './user-relays';

/** One attach generation of an authority's core; it ends when the connection closes, the epoch changes or main disposes it. */
export interface RemoteHostedCore extends HostedCore {
  readonly authority: string;
  readonly client: CoreClient;
  // the epoch attachCore answered for this generation
  epoch(): string | null;
  // creates nothing: relays view, loads its chat page, holds its ready and joins the panel viewKey (else its page's token)
  // names, or the one holding sessionId (another device's); false when none. Its page's later readys join it again.
  rejoin(view: RelayView, viewKey: string | undefined, sessionId?: string): Promise<boolean>;
  terminalToggleChanged(): void;
  // the daemon reported this attach's core gone: its requests fail now and it is handed out no more
  end(why: string): void;
}

export interface RemoteCoreDeps {
  readonly authority: string;
  // this client's id for the host: its secrets namespace is remote/<hostId>/
  readonly hostId: string;
  readonly connection: () => RemoteConnection | undefined;
  // the host services for this authority: its platform with main's refusals, trust from the host store, its views
  readonly services: () => Omit<HostServicesDeps, 'endpoint'>;
  // the epoch the authority's chats were last open under (remote-state.json)
  readonly lastEpoch: string | null;
  // reopens the authority's chats into core: rejoin when the epoch is the one they were open under, else restore them
  readonly openTabs: (core: RemoteHostedCore, rejoin: boolean, kept: ReadonlyMap<string, ChatPermissions>) => Promise<void>;
  // the authority's chat views as the kept permissions name them: by page token, with their view id
  readonly chatViews: () => ReadonlyArray<{ readonly viewId: string; readonly panelToken: string }>;
  readonly retainTabStates: (retain: boolean) => void;
  // main's listeners on an attach's client, made with it and disposed with it
  readonly subscribe: (client: CoreClient) => readonly Disposable[];
  // this computer's client mirrors (clientAuth, clientUser, clientPolicy), which every attach starts from and follows
  readonly relays: UserRelays;
  // the authority runs on this computer, so its core reaches this computer's loopback endpoints
  readonly sharedLoopback: boolean;
  // the engine state or the halt changed
  readonly changed: () => void;
  // how many chats remote-state.json keeps open on the authority, for the log
  readonly keptChats: () => number;
  // a connection's attach is ready and its chats rejoined or restored (or the core is halted, so none can open). restarted:
  // this run had the chats open under another epoch, of a daemon with another pid (server) or the same one (engine).
  readonly reattached: (restarted: 'server' | 'engine' | undefined) => void;
  // the core this run attached to ended while the connection stayed up (a restart, a halt): what it never answered is lost
  readonly coreEnded: () => void;
  readonly drainTimeoutMs: number;
  readonly log: (line: string) => void;
}

class HaltedError extends Error {}

/** The authority's core: a CoreHost whose start attaches, the daemon's core state, and the chats' kept permissions. */
export class RemoteCore {
  readonly host: CoreHost<RemoteHostedCore>;
  private readonly deps: RemoteCoreDeps;
  private readonly kept = new KeptPermissions();
  private generation = 0;
  private state: CoreState | undefined;
  // the epoch the chats are open under: remote-state.json's at launch, then each attach's
  private openEpoch: string | null;
  private restarting = false;
  private disposed = false;
  // the connection the core is attached over, and its coreState events
  private connection: RemoteConnection | undefined;
  private coreStates: Disposable | undefined;
  private connectionClosed: Disposable | undefined;
  // a connection whose chats have not reopened yet, which reattached reports once they have
  private reopening: RemoteConnection | undefined;
  // the daemon's pid while this run's chats were last open; undefined before they first were
  private openPpid: number | null | undefined;

  constructor(deps: RemoteCoreDeps) {
    this.deps = deps;
    this.openEpoch = deps.lastEpoch;
    this.host = new CoreHost<RemoteHostedCore>({
      start: () => this.attach(),
      openTabs: (afterRestart) => this.openTabs(afterRestart),
      retainTabStates: deps.retainTabStates,
      log: deps.log,
      drainTimeoutMs: deps.drainTimeoutMs,
      haltedChanged: deps.changed,
    });
  }

  /** The daemon's last core state; undefined before the first attach answered. */
  coreState(): CoreState | undefined {
    return this.state;
  }

  /** The epoch the authority's chats are open under, which remote-state.json keeps. */
  epoch(): string | null {
    return this.openEpoch;
  }

  /** A Restart the user asked for is in flight until the daemon reports the core running or halted, or the connection drops. */
  isRestarting(): boolean {
    return this.restarting;
  }

  /** The connection came up: its core state events from now on, and a core attached (its first, or one replacing the dropped one). */
  connected(connection: RemoteConnection): void {
    if (this.disposed || this.connection === connection) return;
    this.connection = connection;
    this.reopening = connection;
    this.coreStates?.dispose();
    this.connectionClosed?.dispose();
    const subscription = connection.control.onEvent('coreState', (state) => this.stateChanged(state));
    this.coreStates = subscription;
    this.connectionClosed = connection.onClose(() => {
      subscription.dispose();
      if (this.coreStates === subscription) this.coreStates = undefined;
      this.restartSettled();
    });
    // a halt is cleared only by a reload, which also reopens the chats the halt closed
    if (this.host.halted()) {
      this.host.reload().catch((err: unknown) => this.deps.log(`[remote] attaching to the core on ${this.deps.authority} failed: ${String(err)}`));
      return;
    }
    if (!this.host.started()) {
      const first = this.host.start();
      // a core that ended before it was ready leaves the reopening to the reattach that replaces it
      void first.ready.then(() => (this.host.started() === first ? this.host.openTabs() : undefined)).catch((err: unknown) => this.deps.log(`[remote] reopening the chats of ${this.deps.authority} failed: ${String(err)}`));
      return;
    }
    this.host.reload().catch((err: unknown) => this.deps.log(`[remote] attaching to the core on ${this.deps.authority} failed: ${String(err)}`));
  }

  /** The pill's Restart and Restart Engine: a halted core starts with a new budget, a running one restarts; a new epoch follows. */
  async restart(): Promise<void> {
    const connection = this.deps.connection();
    if (!connection) throw new Error(`${this.deps.authority} is not connected`);
    this.restarting = true;
    this.deps.changed();
    try {
      this.stateChanged(await connection.control.request('restartCore', {}));
    } catch (err) {
      this.restartSettled();
      throw err;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.coreStates?.dispose();
    this.coreStates = undefined;
    this.connectionClosed?.dispose();
    this.connectionClosed = undefined;
    await this.host.dispose();
  }

  private restartSettled(): void {
    if (!this.restarting) return;
    this.restarting = false;
    this.deps.changed();
  }

  // A new epoch ends the running attach: the chats restore into the next one, or wait for Restart while the core is halted.
  private stateChanged(state: CoreState): void {
    if (this.disposed) return;
    this.state = state;
    // a restart that ends halted offers Restart again
    if (state.phase === 'running' || state.phase === 'halted') this.restarting = false;
    const current = this.host.started();
    const serving = current?.epoch();
    // the core this attach serves is gone once the daemon restarts or halts it, or names another epoch
    const gone = current !== undefined && !current.hasEnded() && serving !== undefined && serving !== null
      && (state.epoch !== serving || state.phase === 'restarting' || state.phase === 'halted');
    if (gone) {
      current.end(`the core of epoch ${serving} ended`);
      this.deps.coreEnded();
    }
    const report = (what: string) => (err: unknown): void => this.deps.log(`[remote] ${what} ${this.deps.authority} failed: ${String(err)}`);
    if (state.phase === 'halted') {
      if (!this.host.halted()) this.host.halt().catch(report('halting'));
    } else if (this.host.halted()) {
      this.host.reload().catch(report('attaching to the restarted core on'));
    } else if (gone) {
      this.deps.log(`[remote] the core on ${this.deps.authority} ended (${state.phase}, epoch ${state.epoch ?? 'none'}); reattaching`);
      this.host.restart(current).catch(report('reattaching to'));
    }
    this.deps.changed();
  }

  private async openTabs(afterRestart: boolean): Promise<void> {
    const core = this.host.current();
    if (!core) return;
    const previous = this.openEpoch;
    const rejoin = core.epoch() !== null && core.epoch() === previous;
    const kept = this.kept.reopening(afterRestart && !rejoin);
    this.openEpoch = core.epoch();
    const ppid = this.state?.ppid ?? null;
    const restarted = rejoin || this.openPpid === undefined ? undefined : ppid !== this.openPpid ? 'server' : 'engine';
    const { authority, log } = this.deps;
    if (rejoin) log(`[remote] ${authority}: rejoining ${this.deps.keptChats()} chats through views.join (epoch ${core.epoch() ?? 'none'})`);
    else log(`[remote] ${authority}: restoring ${this.deps.keptChats()} chats (epoch ${core.epoch() ?? 'none'}, was ${previous ?? 'none'}${restarted ? `; the ${restarted} restarted` : ''})`);
    try {
      await this.deps.openTabs(core, rejoin, kept);
      this.openPpid = ppid;
    } finally {
      // a reopening that failed still makes the connection usable: held messages and offline saves go over it
      this.reopened(restarted);
    }
  }

  // once per connection, after its first reopening: a reopening after a core restart on a live connection is no gain
  private reopened(restarted: 'server' | 'engine' | undefined): void {
    if (!this.reopening || this.reopening !== this.connection) return;
    this.reopening = undefined;
    this.deps.reattached(restarted);
  }

  private attach(): RemoteHostedCore {
    const { authority, log } = this.deps;
    const connection = this.deps.connection();
    if (!connection) throw new Error(`${authority} is not connected`);
    const generation = ++this.generation;
    let ended = false;
    let isReady = false;
    // the attach was ready, so the chat views open now are its own
    let servedChats = false;
    let epoch: string | null = null;
    // main's listeners go first, so a read failing with the endpoint finds the core's chats and repositories already gone
    let subscriptions: readonly Disposable[] = [];
    // an attach the daemon ended before its core published (a restart it answered with the old epoch) is never ready
    let endedBeforeReady!: (err: Error) => void;
    const endedEarly = new Promise<never>((_resolve, reject) => (endedBeforeReady = reject));
    const endedAt = endedEarly.catch(() => false as const);
    const end = (why: string): void => {
      if (ended) return;
      ended = true;
      isReady = false;
      endedBeforeReady(new Error(`The core on ${authority} ended before it was ready: ${why}`));
      for (const subscription of subscriptions) subscription.dispose();
      endpoint.close(why);
    };
    const transport: AttachedTransport = attachedTransport(connection.coreChannel, generation, (reason) => connection.close(reason));
    const serviceDeps = this.deps.services();
    const endpoint = createMainEndpoint(transport, log, (error) => {
      log(`[remote] the core on ${authority} broke the protocol (${error.message}); closing the connection`);
      connection.close(error.message);
    }, undefined, serviceDeps.render);
    const services: HostServices = createHostServices({ ...serviceDeps, endpoint });
    const client = new CoreClient(endpoint, (view, attach) => services.adopt(view, attach), authorityProjectKeys(authority, (error) => connection.close(error.message)));
    const closed = connection.onClose((reason) => end(`the connection closed: ${reason}`));
    // a delta published before the attach opens waits in the transport, after the values the attach names
    const relayed = this.deps.relays.attach((topic, value) => endpoint.publish(topic, { value } as MirrorTopics[typeof topic]), this.deps.authority, this.deps.sharedLoopback);
    subscriptions = [relayed.subscription, ...this.deps.subscribe(client)];
    const mirrors = services.init.mirrors;
    const payload: CoreAttach = {
      attach: generation,
      hostId: this.deps.hostId,
      appInfo: services.init.appInfo,
      secretsPersistent: services.init.secretsPersistent,
      chatBrowserPane: services.init.chatBrowserPane,
      mirrors: { trust: mirrors.trust, folders: mirrors.folders, editor: mirrors.editor, terminal: mirrors.terminal, language: mirrors.language, ...relayed.mirrors },
    };
    const ready = (async () => {
      const published = new Promise<void>((resolve) => {
        const subscription = client.onFoldersChanged(() => {
          subscription.dispose();
          resolve();
        });
      });
      const state = await connection.control.request('attachCore', payload);
      this.state = state;
      epoch = state.epoch;
      this.deps.changed();
      if (state.phase === 'halted') {
        // the pill offers Restart; nothing attaches until the daemon reports a core again, and no chat can reopen meanwhile
        void this.host.halt().catch((err: unknown) => log(`[remote] halting ${authority} failed: ${String(err)}`));
        this.reopened(undefined);
        throw new HaltedError(`The core on ${authority} is halted`);
      }
      transport.open();
      await Promise.race([published, endedEarly]);
      isReady = true;
      servedChats = true;
      log(`[remote] attached to the core on ${authority} (attach ${generation}, epoch ${epoch ?? 'none'}, pid ${state.pid ?? 'none'})`);
    })();
    ready.catch(() => undefined);
    return {
      authority,
      client,
      ready,
      isReady: () => isReady && !ended,
      hasEnded: () => ended,
      epoch: () => epoch,
      terminalToggleChanged: () => services.terminalToggleChanged(),
      end,
      rejoin: async (view, viewKey, sessionId) => {
        const held = services.adoptHeld(view);
        view.showPage({ kind: 'chat' });
        // a reload awaits the reopening before it disposes this attach, so an attach that ends first stops waiting for the page
        const ready = await Promise.race([held, endedAt]);
        if (!ready) return false;
        const key = viewKey ?? ready.panelToken;
        if (key === undefined) return false;
        const join = (): Promise<boolean> => client.joinView(view.panelId, key, sessionId).then((joined) => joined !== null);
        if (!(await join())) return false;
        services.rejoinOnReady(view.panelId, () => {
          join().catch((err: unknown) => log(`[remote] rejoining a reloaded chat page on ${authority} failed: ${String(err)}`));
        });
        return true;
      },
      dispose: async () => {
        // an attach that never served keeps what the one before it handed over
        const views = this.deps.chatViews();
        if (servedChats) {
          this.kept.coreEnded(views.map((view) => view.panelToken), (token) => {
            const viewId = views.find((view) => view.panelToken === token)?.viewId;
            return viewId === undefined ? undefined : client.chatOfView(viewId)?.permissions;
          });
        }
        closed.dispose();
        end('Desktop main detached from the core');
        client.dispose();
        services.dispose();
        transport.dispose();
      },
    };
  }
}
