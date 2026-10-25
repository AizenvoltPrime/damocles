import type { Duplex } from 'node:stream';
import type { Project } from '../../local-services/confine';
import type { ProjectConnection, ShellPlatform } from '../../preload/shell-channels';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { createRemoteWorkspace } from '../workspace/remote-workspace';
import type { NotConnectedError } from '../workspace/workspaces';
import { connect, type RemoteConnection } from './connection';

// A project on another authority as main lists it: key `<authorityKey>|<folderKey on the target>`, its native folder path.
export interface RemoteProject extends Project {
  readonly authorityKey: string;
  readonly folderKey: string;
  readonly os: ShellPlatform;
}

// One authority's entry: while connected, the connection and the ProjectWorkspace served over it.
interface AuthorityEntry {
  readonly authorityKey: string;
  state: ProjectConnection;
  connected?: { readonly connection: RemoteConnection; readonly workspace: ProjectWorkspace } | undefined;
  // the attempt in flight, which every caller shares
  attempt?: Promise<void> | undefined;
}

export interface AuthoritiesDeps {
  // the authority's byte stream once its bridge runs, before the handshake's time limit starts; the loopback one starts
  // daemon.js attach
  readonly transport: (authorityKey: string) => Promise<Duplex>;
  readonly appVersion: string;
  readonly clientId: string;
  readonly deviceName: string;
  readonly terminalIdleDays: () => number;
  // the native folder key of the authority's project holding cwd, for control.listRuns
  readonly projectOfCwd: (authorityKey: string, cwd: string) => string | undefined;
  // an authority's state changed
  readonly changed: (authorityKey: string) => void;
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

  /** offline until a connect starts; failed after an attempt failed or a live connection dropped. */
  state(authorityKey: string): ProjectConnection {
    return this.entries.get(authorityKey)?.state ?? 'offline';
  }

  connectedKeys(): string[] {
    return [...this.entries.values()].filter((entry) => entry.connected).map((entry) => entry.authorityKey);
  }

  connection(authorityKey: string): RemoteConnection | undefined {
    return this.entries.get(authorityKey)?.connected?.connection;
  }

  connectedWorkspace(authorityKey: string): ProjectWorkspace | undefined {
    return this.entries.get(authorityKey)?.connected?.workspace;
  }

  /** Connects once; a connected authority resolves at once and an attempt in flight is shared. */
  connect(authorityKey: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The app is quitting'));
    const entry = this.entries.get(authorityKey) ?? { authorityKey, state: 'offline' };
    this.entries.set(authorityKey, entry);
    if (entry.connected) return Promise.resolve();
    entry.attempt ??= this.attempt(entry).finally(() => { entry.attempt = undefined; });
    return entry.attempt;
  }

  /** Detaches from every daemon; none of them, nor their terminals, ends with the app. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.connected?.connection.close('the app is quitting');
  }

  private async attempt(entry: AuthorityEntry): Promise<void> {
    const { log } = this.deps;
    this.setState(entry, 'connecting');
    let connection: RemoteConnection;
    try {
      connection = await connect({
        stream: await this.deps.transport(entry.authorityKey),
        appVersion: this.deps.appVersion,
        clientId: this.deps.clientId,
        deviceName: this.deps.deviceName,
        terminalIdleDays: this.deps.terminalIdleDays(),
        log,
      });
    } catch (err) {
      log(`[remote] connecting to ${entry.authorityKey} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setState(entry, 'failed');
      throw err;
    }
    // a connect that finished after the quit began is not kept, or its bridge would outlive the app
    if (this.disposed) {
      connection.close('the app is quitting');
      this.setState(entry, 'offline');
      throw new Error('The app is quitting');
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
    // after the state it ends: a connection that already closed runs this at once
    connection.onClose((reason) => {
      if (entry.connected?.connection !== connection) return;
      entry.connected = undefined;
      log(`[remote] the connection to ${entry.authorityKey} ended: ${reason}`);
      this.setState(entry, this.disposed ? 'offline' : 'failed');
    });
  }

  private setState(entry: AuthorityEntry, state: ProjectConnection): void {
    if (entry.state === state) return;
    entry.state = state;
    this.deps.changed(entry.authorityKey);
  }
}
