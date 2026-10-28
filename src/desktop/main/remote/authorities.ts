import type { Duplex } from 'node:stream';
import type { Project } from '../../local-services/confine';
import type { ProjectConnection, ShellPlatform } from '../../preload/shell-channels';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { createRemoteWorkspace } from '../workspace/remote-workspace';
import type { NotConnectedError } from '../workspace/workspaces';
import { connect, type OtherProtocolDaemon, type RemoteConnection } from './connection';

// A project on another authority as main lists it: key `<authorityKey>|<folderKey on the target>`, its native folder path.
export interface RemoteProject extends Project {
  readonly authorityKey: string;
  readonly folderKey: string;
  readonly os: ShellPlatform;
}

// One authority's entry: the connection and the ProjectWorkspace served over it, while it is up or while the daemon holds it
// for a resume (suspect, or its transport lost).
interface AuthorityEntry {
  readonly authorityKey: string;
  state: ProjectConnection;
  connected?: { readonly connection: RemoteConnection; readonly workspace: ProjectWorkspace } | undefined;
  // the attempt in flight, which every caller shares
  attempt?: Promise<void> | undefined;
  // counts Disconnect Host; an attempt that began under an earlier count ends offline and keeps nothing it made
  disconnects: number;
}

export interface AuthoritiesDeps {
  // the authority's byte stream once its bridge runs, before the handshake's time limit starts; the loopback one starts
  // daemon.js attach. An attempt whose resume the daemon refused asks for a second one.
  readonly transport: (authorityKey: string) => Promise<Duplex>;
  readonly appVersion: string;
  readonly clientId: string;
  readonly deviceName: string;
  // the hello's protocol version when the e2e hooks name another
  readonly protocolVersion?: number;
  readonly terminalIdleDays: () => number;
  // a daemon of another protocol answered: the update flow holds its connection for the frozen commands
  readonly otherProtocol: (authorityKey: string, daemon: OtherProtocolDaemon) => void;
  // the native folder key of the authority's project holding cwd, for control.listRuns
  readonly projectOfCwd: (authorityKey: string, cwd: string) => string | undefined;
  // an authority's state changed
  readonly changed: (authorityKey: string) => void;
  // a fresh connection is up, once per connection: never for a resume or a cleared suspect state
  readonly attached: (authorityKey: string, connection: RemoteConnection) => void;
  // what an action on an authority fails with while it is not connected
  readonly notConnected: (authorityKey: string) => NotConnectedError;
  readonly log: (line: string) => void;
}

/** The connection of each authority this app reaches, keyed by authority key; local projects have none. */
export class Authorities {
  private readonly deps: AuthoritiesDeps;
  private readonly entries = new Map<string, AuthorityEntry>();
  private disposed = false;

  constructor(deps: AuthoritiesDeps) {
    this.deps = deps;
  }

  /**
   * offline until a connect starts; connecting during an attempt and while a held connection is suspect; failed after an
   * attempt failed, a connection closed, or while a connection's transport is lost and no attempt runs.
   */
  state(authorityKey: string): ProjectConnection {
    return this.entries.get(authorityKey)?.state ?? 'offline';
  }

  connectedKeys(): string[] {
    return [...this.entries.values()].filter((entry) => usable(entry)).map((entry) => entry.authorityKey);
  }

  /** The connection while it is usable: neither suspect nor lost, so new work never waits on a replay. */
  connection(authorityKey: string): RemoteConnection | undefined {
    const entry = this.entries.get(authorityKey);
    return entry && usable(entry) ? entry.connected?.connection : undefined;
  }

  connectedWorkspace(authorityKey: string): ProjectWorkspace | undefined {
    const entry = this.entries.get(authorityKey);
    return entry && usable(entry) ? entry.connected?.workspace : undefined;
  }

  /** The connection whether usable or held for a resume; what it was sent before a drop completes once it resumes. */
  heldConnection(authorityKey: string): RemoteConnection | undefined {
    return this.entries.get(authorityKey)?.connected?.connection;
  }

  /**
   * Connects once: resumes a held connection, else attaches fresh. A usable authority resolves at once, and an attempt in
   * flight is shared. A suspect connection's transport is given up for a new one.
   */
  connect(authorityKey: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The app is quitting'));
    const entry = this.entries.get(authorityKey) ?? { authorityKey, state: 'offline', disconnects: 0 };
    this.entries.set(authorityKey, entry);
    if (usable(entry)) return Promise.resolve();
    entry.attempt ??= this.attempt(entry).finally(() => { entry.attempt = undefined; });
    return entry.attempt;
  }

  /** Destroys the transport alone (the e2e hooks' drop, or the reconnect of a suspect connection); the protocol is held. */
  cutTransport(authorityKey: string): void {
    this.entries.get(authorityKey)?.connected?.connection.cutTransport();
  }

  /**
   * Ends the authority's connection, held or usable, as the user asked, and supersedes an attempt in flight; it is offline,
   * not failed, until the next connect.
   */
  disconnect(authorityKey: string): void {
    const entry = this.entries.get(authorityKey);
    if (!entry) return;
    entry.disconnects++;
    const connected = entry.connected;
    // cleared first, so the close's own listener leaves the state to this
    entry.connected = undefined;
    connected?.connection.close('the user disconnected');
    this.setState(entry, 'offline');
  }

  /** Detaches from every daemon; none of them, nor their terminals, ends with the app. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.connected?.connection.close('the app is quitting');
  }

  private async attempt(entry: AuthorityEntry): Promise<void> {
    const { log } = this.deps;
    const disconnects = entry.disconnects;
    // Disconnect Host since this attempt began: checked after each await
    const superseded = (): boolean => entry.disconnects !== disconnects;
    const supersededError = (): Error => new Error(`${entry.authorityKey} was disconnected while connecting`);
    // the transport of a superseded attempt is dropped unused
    const transport = async (): Promise<Duplex> => {
      const stream = await this.deps.transport(entry.authorityKey);
      if (!superseded()) return stream;
      stream.destroy();
      throw supersededError();
    };
    this.setState(entry, 'connecting');
    const held = entry.connected?.connection;
    if (held) {
      // a suspect connection gives way to the new transport, which resumes it
      if (!held.lost()) held.cutTransport();
      let outcome: 'resumed' | 'refused';
      try {
        outcome = await held.resume(await transport());
      } catch (err) {
        log(`[remote] resuming ${entry.authorityKey} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.setState(entry, this.disposed || superseded() ? 'offline' : 'failed');
        throw err;
      }
      if (superseded()) {
        this.setState(entry, 'offline');
        throw supersededError();
      }
      if (outcome === 'resumed' && entry.connected?.connection === held) {
        log(`[remote] ${entry.authorityKey}: resumed inside the grace`);
        this.setState(entry, 'connected');
        return;
      }
      // past the grace, after an overflow or a daemon restart nothing is held, and the next connection attaches fresh
      if (entry.connected?.connection === held) entry.connected = undefined;
      held.close('the daemon no longer holds this connection');
      log(`[remote] ${entry.authorityKey}: the daemon refused the reconnection token; attaching fresh`);
    }
    let connection: RemoteConnection;
    try {
      connection = await connect({
        stream: await transport(),
        appVersion: this.deps.appVersion,
        clientId: this.deps.clientId,
        deviceName: this.deps.deviceName,
        ...(this.deps.protocolVersion !== undefined ? { protocolVersion: this.deps.protocolVersion } : {}),
        terminalIdleDays: this.deps.terminalIdleDays(),
        onOtherProtocol: (daemon) => {
          // a daemon answering after the quit began or a Disconnect is let go at once, or it would connect again
          if (this.disposed || superseded()) daemon.close(this.disposed ? 'the app is quitting' : 'the user disconnected');
          else this.deps.otherProtocol(entry.authorityKey, daemon);
        },
        log,
      });
    } catch (err) {
      log(`[remote] connecting to ${entry.authorityKey} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setState(entry, superseded() ? 'offline' : 'failed');
      throw err;
    }
    // a connect that finished after the quit began is not kept, or its bridge would outlive the app
    if (this.disposed) {
      connection.close('the app is quitting');
      this.setState(entry, 'offline');
      throw new Error('The app is quitting');
    }
    if (superseded()) {
      connection.close('the user disconnected');
      this.setState(entry, 'offline');
      throw supersededError();
    }
    const workspace = createRemoteWorkspace({
      endpoint: connection.workspace,
      authorityKey: entry.authorityKey,
      projectOfCwd: (cwd) => this.deps.projectOfCwd(entry.authorityKey, cwd),
      onClose: (listener) => connection.onClose(listener),
      notConnected: () => this.deps.notConnected(entry.authorityKey),
      log,
    });
    entry.connected = { connection, workspace };
    this.setState(entry, 'connected');
    const current = (): boolean => entry.connected?.connection === connection;
    connection.onLost((reason) => {
      if (!current()) return;
      log(`[remote] the transport to ${entry.authorityKey} dropped (${reason}); the daemon holds the connection`);
      this.moved(entry, entry.attempt ? 'connecting' : 'failed');
    });
    connection.onSuspect(() => {
      if (!current() || entry.attempt) return;
      this.moved(entry, usable(entry) ? 'connected' : 'connecting');
    });
    // after the state it ends: a connection that already closed runs this at once
    connection.onClose((reason) => {
      if (!current()) return;
      entry.connected = undefined;
      log(`[remote] the connection to ${entry.authorityKey} ended: ${reason}`);
      this.setState(entry, this.disposed ? 'offline' : 'failed');
    });
    if (current()) this.deps.attached(entry.authorityKey, connection);
  }

  // what connection() answers moved, which listeners hear even when the coarse state stays
  private moved(entry: AuthorityEntry, state: ProjectConnection): void {
    if (entry.state === state) this.deps.changed(entry.authorityKey);
    else this.setState(entry, state);
  }

  private setState(entry: AuthorityEntry, state: ProjectConnection): void {
    if (entry.state === state) return;
    entry.state = state;
    this.deps.changed(entry.authorityKey);
  }
}

function usable(entry: AuthorityEntry): boolean {
  const connection = entry.connected?.connection;
  return connection !== undefined && !connection.lost() && connection.suspectSince() === undefined;
}
