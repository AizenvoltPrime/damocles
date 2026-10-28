import { folderKeyOn } from '../../../core/workspace-folders/folder-key';
import { pathFor, projectKeyOf } from '../../../shared/project-location';
import {
  CLOCK_SKEW_WARN_MS,
  MAX_DEVICE_NAME_LENGTH,
  MAX_HOST_DEVICES,
  MAX_OVERLAY_ITEMS,
  MAX_OVERLAY_LABEL_LENGTH,
  MAX_SSH_CONFIG_ALIASES,
  OVERLAY_CHANNELS,
  type ConnectStartResult,
  type ConnectTarget,
  type HostCardInfo,
  type HostDevice,
  type HostNotice,
  type HostParseResult,
  type HostRun,
  type InstallFolderResult,
  type LingerResult,
  type NameCheck,
  type OverlayAnswer,
  type OverlayRequest,
  type PasswordlessResult,
  type PasswordlessStepEvent,
  type RemoteBrowseResult,
  type RemoteHostEntry,
  type RemovalInfo,
  type RemoveServerOptions,
  type RemoveServerResult,
  type HostSettingChange,
} from '../../preload/overlay-channels';
import type { InstallKeyResult } from '../../daemon/control-messages';
import { removeServer, runRemovalStage } from './remove-server';
import type { HostUpdate, ProjectConnection, ShellHost } from '../../preload/shell-channels';
import type { HostLatency, HostReconnect } from '../../../shared/host-connection';
import type { Project } from '../../local-services/confine';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import type { LiveTerminal } from '../../workspace/terminal/terminal-backend';
import type { RemoteConnection } from './connection';
import type { ConnectActions } from './connect-channels';
import { hostConnection, type RemoteConnections } from './connections';
import { parseConnectHosts, parseConnectRequest, parseConnectStep, parseHostEntries } from '../overlay';
import { destinationLabel, forwardsAgent, hostIdOfAuthority, hostOs, prefillHostName, sshAuthorityKey, type HostStore, type SshHostDestination, type SshHostRecord } from './host-store';
import { checkSavedAddress, HostNotConnectedError, isSafeAlias, setUpPasswordless, SshConnectError, type KeySetupDeps, type SshDestination, type SshParseResult } from './ssh';

export interface RemoteHostsDeps {
  readonly store: HostStore;
  readonly connections: RemoteConnections;
  readonly state: (authorityKey: string) => ProjectConnection;
  // the reconnect loop's phase while the authority is away, and its latest round trips
  readonly reconnect: (authorityKey: string) => HostReconnect | undefined;
  readonly latency: (authorityKey: string) => HostLatency | undefined;
  // the card's notice once the host's watcher ran out of inotify watches for a project on this connection
  readonly watchLimit: (authorityKey: string) => HostNotice | undefined;
  // the card's notice once this connection's daemon named other machines running Damocles in its home
  readonly sharedHome: (authorityKey: string) => HostNotice | undefined;
  readonly connection: (authorityKey: string) => RemoteConnection | undefined;
  readonly workspace: (authorityKey: string) => ProjectWorkspace | undefined;
  // this window's terminals: whether open can give a host's terminal a tab, and opening it
  readonly terminals: {
    canOpen(authorityKey: string, terminal: LiveTerminal): boolean;
    open(authorityKey: string, id: string): Promise<void>;
  };
  // the projects main lists on the host: key, native folder and folder key
  readonly projects: (hostId: string) => ReadonlyArray<{ readonly key: string; readonly fsPath: string; readonly folderKey: string }>;
  // the folders a remote core's picker is confined to: the authority's projects first, then their live chat worktrees
  readonly pickRoots: (authorityKey: string) => readonly Project[];
  // an authority's name as this computer's host store names it
  readonly hostName: (authorityKey: string) => string;
  // the banner of a busy daemon of another protocol on the authority
  readonly update: (authorityKey: string) => HostUpdate | undefined;
  // the ssh parser's verdict on "+ New host" input
  readonly parse: (input: string) => SshParseResult;
  // Host aliases of the user's ssh config, wildcards skipped
  readonly sshConfigAliases: () => Promise<readonly string[]>;
  // the install folder rule stage 1 applies
  readonly validInstallFolder: (folder: string) => boolean;
  // adds the folder as a project (asking trust as any new project does) or selects the project it already is
  readonly addProject: (hostId: string, folder: string) => Promise<string>;
  readonly showLogs: (hostId: string) => Promise<void>;
  readonly writeClipboard: (text: string) => void;
  // the Connect dialog: undefined while no window holds an overlay
  readonly overlay: () => { request(request: OverlayRequest): Promise<OverlayAnswer>; send(channel: string, payload: unknown): void; isOpen(kind: 'connect' | 'settings'): boolean } | undefined;
  // a host's name or color changed: the shell, chat pages and notifications follow
  readonly renamed: (hostId: string, previousName: string) => void;
  // the host's policy (default mode, YOLO, agent forwarding) changed: every attach of it hears its new clientPolicy
  readonly policyChanged: (hostId: string) => void;
  // a change that only a new ssh session applies (agent forwarding): Damocles' master ends and the host connects again
  readonly reconnectFresh: (hostId: string) => Promise<void>;
  // the host's remembered ssh answers go (Remember password turned off, Forget host)
  readonly deleteRememberedSecrets: (hostId: string) => Promise<void>;
  // everything else this computer keeps of a forgotten host: its update flow, Damocles' master connection, its session mirror
  // once its sync settled, browser profile, remote-state.json entries
  readonly forgetLocalData: (hostId: string) => Promise<void>;
  // the host connects no more until asked: its reconnect loop stops, its attempt in flight ends and its connection closes
  readonly disconnect: (hostId: string) => void;
  // Settings at the Remote hosts section, on this host
  readonly openSettings: (hostId: string) => void;
  // generating, installing and verifying the passwordless key
  readonly keySetup: KeySetupDeps;
  readonly sshConfigFile?: string;
  // the removal stage over ssh, with its prompts shown as the host's attempt
  readonly runRemovalStage: (hostId: string, script: string) => Promise<{ readonly code: number | null; readonly lines: readonly string[] }>;
  readonly log: (line: string) => void;
}

// The daemon runs loginctl enable-linger for its own user (control.linger).
const LINGER_FEATURE = 'linger';
// The daemon appends Damocles' key to its user's authorized keys (control ssh.installAuthorizedKey).
const INSTALL_KEY_FEATURE = 'ssh.installAuthorizedKey';

// macOS privacy-protected folders under the home, whose EPERM names the folder (the sshd needs Full Disk Access).
const MAC_PRIVACY_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents'];

/** The privacy folder a failed listing on a macOS target lies in, or undefined. */
export function macPrivacyFolder(home: string, folder: string): string | undefined {
  const flavor = pathFor({ os: 'darwin' });
  return MAC_PRIVACY_FOLDERS.map((name) => flavor.join(home, name)).find((protectedFolder) => folder === protectedFolder || folder.startsWith(`${protectedFolder}/`));
}

// A remote core's options for its picker; title and buttonLabel are its own text, shown as text. extensions (without the dot,
// '*' for any) narrow a file picker's files.
export interface PickOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly buttonLabel?: string;
  readonly extensions?: readonly string[];
}

/** Whether a file picker with these extensions lists name; none or '*' lists every file. */
export function pickable(name: string, extensions: readonly string[] | undefined): boolean {
  if (extensions === undefined || extensions.includes('*')) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && extensions.some((extension) => extension.toLowerCase() === name.slice(dot + 1).toLowerCase());
}

// A folder of a picker's roots: the root and the '/'-separated path under it ('' for the root itself).
interface Located {
  readonly project: Project;
  readonly relativePath: string;
}

// The picker open in the Connect dialog: the id its browse calls name, its authority, mode, roots and first folder.
interface OpenPick {
  readonly hostId: string;
  readonly authority: string;
  readonly mode: 'file' | 'folder';
  readonly roots: readonly Project[];
  readonly start: Located;
  readonly extensions: readonly string[] | undefined;
}

const shownLabel = (text: string | undefined): string | undefined => {
  if (text === undefined || text.trim() === '') return undefined;
  return text.length <= MAX_OVERLAY_LABEL_LENGTH ? text : `${text.slice(0, MAX_OVERLAY_LABEL_LENGTH - 1)}…`;
};

/** A known_hosts host spec the clipboard command may name: one word that ssh-keygen reads as a host, never an option. */
const isHostSpec = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:[\]%-]{1,300}$/.test(value) && !value.startsWith('-');

/**
 * The saved SSH hosts as the Connect dialog, the host cards and the shell see them, and the Connect dialog's actions. Names,
 * colors and labels come only from this computer's host store; every id the overlay names is looked up here.
 */
export class RemoteHosts implements ConnectActions {
  private readonly deps: RemoteHostsDeps;
  // the hosts whose attempts the open dialog shows, which watch ends when that dialog closes
  private watching: Set<string> | undefined;
  // the picker the dialog shows, whose browse calls stay inside its roots
  private picking: OpenPick | undefined;
  // per host, the removal stage that refused with daemonRunning, which Try again runs again with its run key
  private readonly pendingRemovals = new Map<string, { readonly script: string; readonly key: boolean; readonly disableLinger: boolean }>();

  constructor(deps: RemoteHostsDeps) {
    this.deps = deps;
  }

  /** Every saved host for ShellState. */
  shellHosts(): ShellHost[] {
    return this.deps.store.hosts().map((record) => {
      const os = hostOs(record);
      const skew = this.skew(record.id);
      return {
        hostId: record.id,
        authorityKey: sshAuthorityKey(record.id),
        name: record.name,
        ...(record.color !== undefined ? { color: record.color } : {}),
        ...(os !== undefined ? { os } : {}),
        connection: this.connectionOf(record.id),
        signInNeeded: this.deps.connections.signInNeeded(record.id),
        ...(skew !== undefined ? { clockSkewMs: skew } : {}),
        ...this.quality(record.id),
        ...this.update(record.id),
      };
    });
  }

  /** Every saved host as its card shows it, most recently used first. */
  cards(): HostCardInfo[] {
    return [...this.deps.store.hosts()].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)).map((record) => this.card(record));
  }

  // the one list the dialog shows and start({alias}) accepts, within the dialog's bound
  private async configAliases(): Promise<readonly string[]> {
    const aliases = await this.deps.sshConfigAliases();
    if (aliases.length > MAX_SSH_CONFIG_ALIASES) this.deps.log(`[remote] the ssh config names ${aliases.length} hosts; the Connect dialog lists the first ${MAX_SSH_CONFIG_ALIASES}`);
    return aliases.slice(0, MAX_SSH_CONFIG_ALIASES);
  }

  connectionOf(hostId: string): ProjectConnection {
    return hostConnection(this.deps.state(sshAuthorityKey(hostId)), this.deps.connections.failure(hostId));
  }

  /**
   * Opens the Connect dialog on the host list, or with hostId straight to that host: an attempt in flight shows with its
   * waiting prompt, an attempt that met a changed host key shows that failure, and otherwise the dialog starts one itself for
   * a host that is not connected. card opens the host's card instead, starting nothing; 'rename' with its name field open.
   */
  async openConnect(hostId?: string, card?: 'rename' | 'show'): Promise<void> {
    const overlay = this.deps.overlay();
    if (!overlay) throw new Error('No window shows the Connect dialog');
    if (hostId !== undefined && !this.deps.store.host(hostId)) throw new Error(`No saved host ${hostId}`);
    // this dialog replaces an open picker, whose confinement goes with it
    this.picking = undefined;
    const known = new Set(this.deps.store.hosts().flatMap((record) => (record.destination.kind === 'alias' ? [record.destination.alias] : [])));
    const aliases = (await this.configAliases()).filter((alias) => !known.has(alias));
    const attempt = hostId === undefined ? undefined : this.deps.connections.attempt(hostId);
    const running = attempt && attempt.step !== 'connected' && attempt.step !== 'failed' ? attempt : undefined;
    // a changed host key stops every attempt: the dialog shows that failure and starts none until the user retries
    const keyChanged = card === undefined && attempt?.step === 'failed' && attempt.failure?.code === 'hostKeyChanged' ? attempt : undefined;
    const shown = running ?? keyChanged;
    const watching = new Set<string>();
    this.watching = watching;
    if (running && hostId !== undefined) this.watch(hostId);
    const request = parseConnectRequest({
      kind: 'connect',
      ...(hostId !== undefined ? { hostId } : {}),
      ...(card !== undefined ? { card } : {}),
      hosts: this.cards(),
      sshConfigAliases: aliases,
      ...(shown ? { attempt: shown } : {}),
    });
    if (!request) throw new Error('The Connect dialog exceeds the overlay bounds');
    try {
      await overlay.request(request);
    } finally {
      // a dialog opened meanwhile replaced this one and keeps watching what it shows
      for (const watched of watching) if (!this.watching?.has(watched) || this.watching === watching) this.deps.connections.watch(watched, false);
      if (this.watching === watching) this.watching = undefined;
    }
  }

  /** A host's attempt or state changed: the open dialog hears it, then its host list. */
  hostChanged(hostId: string): void {
    const overlay = this.deps.overlay();
    if (!overlay?.isOpen('connect')) return;
    const attempt = this.deps.connections.attempt(hostId);
    if (attempt) {
      const step = parseConnectStep(attempt);
      if (step) overlay.send(OVERLAY_CHANNELS.connectStep, step);
      else this.deps.log(`[remote] ${hostId}: the attempt's step exceeds the overlay bounds; the Connect dialog keeps the last one`);
    }
    this.sendCards(overlay);
  }

  /** The host list changed (a rename, a setting, a project added or removed): the open dialog and Settings hear it. */
  hostsChanged(): void {
    const overlay = this.deps.overlay();
    if (overlay?.isOpen('connect')) this.sendCards(overlay);
    if (!overlay?.isOpen('connect') && !overlay?.isOpen('settings')) return;
    const entries = parseHostEntries(this.entries());
    if (entries) overlay.send(OVERLAY_CHANNELS.hostsEntries, entries);
    else this.deps.log('[remote] the saved hosts exceed the overlay bounds; the overlay keeps the last list');
  }

  // Rebuilt by the parser the dialog's request passes, so a push never carries what the request could not.
  private sendCards(overlay: NonNullable<ReturnType<RemoteHostsDeps['overlay']>>): void {
    const cards = parseConnectHosts(this.cards());
    if (cards) overlay.send(OVERLAY_CHANNELS.connectHosts, cards);
    else this.deps.log('[remote] the host list exceeds the overlay bounds; the Connect dialog keeps the last one');
  }

  /** Every saved host as Settings > Remote hosts lists it, in saved order. */
  entries(): RemoteHostEntry[] {
    return this.deps.store.hosts().map((record) => {
      const os = hostOs(record);
      const { settings } = record;
      return {
        hostId: record.id,
        authorityKey: sshAuthorityKey(record.id),
        name: record.name,
        destinationLabel: destinationLabel(record.destination),
        ...(os !== undefined ? { os } : {}),
        ...(record.platform !== undefined ? { detectedOs: record.platform.os } : {}),
        connection: this.connectionOf(record.id),
        settings: {
          ...(record.color !== undefined ? { color: record.color } : {}),
          ...(settings.defaultPermissionMode !== undefined ? { defaultPermissionMode: settings.defaultPermissionMode } : {}),
          allowBypass: settings.allowBypass === true,
          forwardAgent: settings.forwardAgent === true,
          rememberPassword: settings.rememberPassword === true,
          browserLocalNetwork: settings.browserLocalNetwork === true,
          openLinksWithoutAsking: settings.openLinksWithoutAsking === true,
          ...(record.osOverride !== undefined ? { osOverride: record.osOverride } : {}),
          ...(settings.installFolder !== undefined ? { installFolder: settings.installFolder } : {}),
        },
        facts: {
          passwordless: record.identityFile !== undefined,
          keyInstalledByDamocles: record.installedKeyFingerprint !== undefined,
          lingerEnabledByDamocles: record.lingerEnabledByDamocles === true,
          alwaysCredentialHosts: record.alwaysCredentialHosts ?? [],
        },
      };
    });
  }

  /**
   * One setting of a host. A color reaches every badge, stripe and chat page at once; the default mode, YOLO and agent
   * forwarding reach the host's attached core as its clientPolicy; forwarding also takes a new ssh session; Remember password
   * turned off deletes the answers it kept.
   */
  async setSetting(hostId: string, change: HostSettingChange): Promise<void> {
    const before = this.record(hostId);
    await this.deps.store.setHostSetting(hostId, change);
    const after = this.record(hostId);
    if (change.key === 'color') this.deps.renamed(hostId, before.name);
    if (change.key === 'defaultPermissionMode' || change.key === 'allowBypass' || change.key === 'forwardAgent' || change.key === 'osOverride') this.deps.policyChanged(hostId);
    if (change.key === 'rememberPassword' && !change.value) await this.deps.deleteRememberedSecrets(hostId);
    if (forwardsAgent(before) !== forwardsAgent(after) && this.deps.connection(sshAuthorityKey(hostId))) await this.deps.reconnectFresh(hostId);
  }

  /** Revoke: the pair (this host, credentialHost) asks again on its next credential request. */
  async revokeCredentialHost(hostId: string, credentialHost: string): Promise<void> {
    this.record(hostId);
    await this.deps.store.revokeCredentialHost(hostId, credentialHost);
  }

  /** Set up passwordless login: generate, install, verify, each step pushed to the open overlay. */
  async setUpPasswordless(hostId: string): Promise<PasswordlessResult> {
    const record = this.record(hostId);
    const progress = (event: PasswordlessStepEvent): void => {
      const overlay = this.deps.overlay();
      if (overlay?.isOpen('connect') || overlay?.isOpen('settings')) overlay.send(OVERLAY_CHANNELS.hostsPasswordlessStep, event);
    };
    const connection = this.deps.connection(sshAuthorityKey(hostId));
    if (!connection) {
      progress({ hostId, step: 'install', state: 'failed', failure: { code: 'notConnected', params: {} } });
      return { ok: false, step: 'install', code: 'notConnected', params: {} };
    }
    const outcome = await setUpPasswordless(this.deps.keySetup, {
      destination: sshDestination(record.destination, this.deps.log),
      ...(this.deps.sshConfigFile !== undefined ? { configFile: this.deps.sshConfigFile } : {}),
      canInstall: connection.features.includes(INSTALL_KEY_FEATURE),
      install: async (publicKey): Promise<InstallKeyResult> => {
        let closed = false;
        const subscription = connection.onClose(() => { closed = true; });
        try {
          return await connection.control.request('ssh.installAuthorizedKey', { publicKey });
        } catch (err) {
          throw closed ? new HostNotConnectedError(err instanceof Error ? err.message : String(err)) : err;
        } finally {
          subscription.dispose();
        }
      },
      recordInstalled: (installed) => this.deps.store.recordInstalledKey(hostId, installed),
      progress: (step, state, failure) => progress({ hostId, step, state, ...(failure ? { failure } : {}) }),
    });
    if (outcome.identityFile !== undefined) await this.deps.store.recordPasswordless(hostId, outcome.identityFile);
    this.deps.log(`[remote] ${hostId}: passwordless login ${outcome.result.ok ? 'set up' : `failed at ${outcome.result.step}: ${outcome.result.code}`}`);
    return outcome.result;
  }

  /** What Remove Damocles server lists and offers: the host's running chats and terminals, and the two undo checkboxes. */
  async removalInfo(hostId: string): Promise<RemovalInfo> {
    const record = this.record(hostId);
    const connection = this.deps.connection(sshAuthorityKey(hostId));
    if (!connection) throw new Error(`${record.name} is not connected`);
    const { runs } = await connection.control.request('listRuns', {});
    const projects = new Map(this.deps.projects(hostId).map((project) => [project.folderKey, project.key]));
    return {
      runs: runs.slice(0, MAX_OVERLAY_ITEMS).map((run) => {
        const projectKey = run.projectKey === '' ? undefined : projects.get(run.projectKey);
        return { kind: run.kind, id: run.id, title: shownLabel(run.title) ?? '', state: run.state, ...(projectKey !== undefined ? { projectKey } : {}) };
      }),
      offerRemoveKey: record.installedKeyFingerprint !== undefined,
      offerDisableLinger: record.lingerEnabledByDamocles === true && hostOs(record) !== 'win32',
    };
  }

  /**
   * Remove Damocles server: the daemon shuts down for it and the host goes offline, then the removal stage runs over ssh; the
   * key and linger are undone only when asked and only when Damocles made them.
   */
  async removeServer(hostId: string, options: RemoveServerOptions): Promise<RemoveServerResult> {
    const record = this.record(hostId);
    const authority = sshAuthorityKey(hostId);
    const connection = this.deps.connection(authority);
    const key = options.removeKey && record.installedKeyEntry !== undefined && record.installedKeyFile !== undefined ? { entry: record.installedKeyEntry, file: record.installedKeyFile } : undefined;
    const disableLinger = options.disableLinger && record.lingerEnabledByDamocles === true;
    this.pendingRemovals.delete(hostId);
    let script: string | undefined;
    const result = await removeServer({
      connected: () => connection && {
        features: connection.features,
        shutdownForRemoval: async () => {
          // the daemon ends this connection once it released its lock; the host stays offline from then on
          let subscriptions: Array<{ dispose(): void }> = [];
          const closed = new Promise<void>((resolve) => {
            const ended = (): void => {
              for (const subscription of subscriptions) subscription.dispose();
              this.deps.disconnect(hostId);
              resolve();
            };
            subscriptions = [connection.onClose(ended), connection.onLost(ended)];
          });
          try {
            const { runKey } = await connection.control.request('shutdownForRemoval', {});
            return { runKey, closed };
          } catch (err) {
            // a refused shutdown leaves the host connected, and a later drop is an ordinary one
            for (const subscription of subscriptions) subscription.dispose();
            throw err;
          }
        },
      },
      os: hostOs(record) === 'win32' ? 'win32' : 'posix',
      ...(record.settings.installFolder !== undefined ? { installFolder: record.settings.installFolder } : {}),
      ...(typeof record.previousInstallFolder === 'string' ? { previousInstallFolder: record.previousInstallFolder } : {}),
      ...(key ? { key } : {}),
      runStage: (stage) => {
        script = stage;
        return this.deps.runRemovalStage(hostId, stage);
      },
      log: this.deps.log,
    }, { disableLinger });
    return this.removalEnded(hostId, { script, key: key !== undefined, disableLinger }, result);
  }

  /**
   * Try again after daemonRunning: the same removal stage over a fresh ssh, which reaches the target without attaching or
   * starting a daemon; the stage decides by the daemon's lock again.
   */
  async retryRemoval(hostId: string): Promise<RemoveServerResult> {
    this.record(hostId);
    const pending = this.pendingRemovals.get(hostId);
    if (!pending) throw new Error('No removal of this host waits to be tried again');
    this.pendingRemovals.delete(hostId);
    const result = await runRemovalStage({ runStage: (stage) => this.deps.runRemovalStage(hostId, stage), log: this.deps.log }, pending.script);
    return this.removalEnded(hostId, pending, result);
  }

  // The host store forgets what the stage undid; a stage that refused with daemonRunning stays ready to be tried again.
  private async removalEnded(hostId: string, removal: { readonly script: string | undefined; readonly key: boolean; readonly disableLinger: boolean }, result: RemoveServerResult): Promise<RemoveServerResult> {
    if (!result.ok && result.code === 'daemonRunning' && removal.script !== undefined) this.pendingRemovals.set(hostId, { ...removal, script: removal.script });
    if (result.ok) {
      if (removal.key) await this.deps.store.clearInstalledKey(hostId);
      if (removal.disableLinger && !result.notices.some((notice) => notice.code === 'lingerFailed')) await this.deps.store.clearLingerEnabled(hostId);
    }
    return result;
  }

  /**
   * Forget host: this computer keeps nothing of it: its record, projects and trust, its remembered answers, session mirror,
   * browser profile and remote-state.json entries. A connected or connecting host is disconnected first; its daemon keeps
   * running.
   */
  async forget(hostId: string): Promise<void> {
    this.record(hostId);
    this.pendingRemovals.delete(hostId);
    this.deps.disconnect(hostId);
    this.deps.connections.forget(hostId);
    await this.deps.deleteRememberedSecrets(hostId);
    await this.deps.forgetLocalData(hostId);
    await this.deps.store.forgetHost(hostId);
    this.deps.log(`[remote] forgot the host ${hostId}`);
  }

  openSettings(hostId: string): void {
    this.record(hostId);
    this.deps.openSettings(hostId);
  }

  checkName(name: string, hostId: string | undefined): NameCheck {
    if (hostId !== undefined) this.record(hostId);
    return this.deps.store.checkName(name, hostId);
  }

  async rename(hostId: string, name: string): Promise<NameCheck> {
    const previous = this.record(hostId).name;
    const check = await this.deps.store.renameHost(hostId, name);
    if (check.ok) this.deps.renamed(hostId, previous);
    return check;
  }

  parse(input: string): HostParseResult {
    const parsed = this.deps.parse(input);
    if (!parsed.ok) return { ok: false, refused: parsed.refused, reason: parsed.reason };
    const { destination } = parsed;
    const prefillName = prefillHostName(destination.host);
    return { ok: true, destinationLabel: destinationLabel(destination), options: destination.options, prefillName, nameCheck: this.deps.store.checkName(prefillName) };
  }

  async start(target: ConnectTarget): Promise<ConnectStartResult> {
    if ('hostId' in target) {
      this.record(target.hostId);
      return { ok: true, attemptId: this.connectWatched(target.hostId), hostId: target.hostId };
    }
    let added;
    if ('alias' in target) {
      // only a Host alias of the user's config, which ssh resolves itself
      if (!(await this.configAliases()).includes(target.alias)) throw new Error('The alias is not a Host of the ssh config');
      added = await this.deps.store.addHost({ destination: { kind: 'alias', alias: target.alias }, name: target.name });
    } else {
      // the renderer's parse is never trusted: the input is parsed again
      const parsed = this.deps.parse(target.input);
      if (!parsed.ok) return { ok: false, reason: 'refused', refused: parsed.refused, refusal: parsed.reason };
      added = await this.deps.store.addHost({ destination: parsed.destination, name: target.name });
    }
    if (!added.ok) return { ok: false, reason: 'name', check: added.check };
    this.hostsChanged();
    return { ok: true, attemptId: this.connectWatched(added.host.id), hostId: added.host.id };
  }

  answer(attemptId: string, promptId: string, answer: string | null, remember: boolean): void {
    this.deps.connections.answer(attemptId, promptId, answer, remember);
  }

  cancel(attemptId: string): void {
    this.deps.connections.cancel(attemptId);
  }

  /**
   * A remote core's file or folder picker: the Connect dialog's folder browser alone, over the authority's workspace and
   * confined to its projects and their live chat worktrees. Resolves the picked target path, confined again on the host, or
   * undefined on cancel or for a path no root holds.
   */
  async pick(authority: string, mode: 'file' | 'folder', options: PickOptions): Promise<string | undefined> {
    const overlay = this.deps.overlay();
    if (!overlay) throw new Error('No window shows the folder browser');
    const roots = this.deps.pickRoots(authority);
    const workspace = this.deps.workspace(authority);
    if (roots.length === 0 || !workspace) {
      this.deps.log(`[remote] no picker for ${authority}: ${workspace ? 'it has no project' : 'it is not connected'}`);
      return undefined;
    }
    const hostId = hostIdOfAuthority(authority) ?? authority;
    const start = await this.startOf(authority, workspace, roots, options.defaultPath);
    const pick: OpenPick = { hostId, authority, mode, roots, start, extensions: mode === 'file' ? options.extensions : undefined };
    const title = shownLabel(options.title);
    const buttonLabel = shownLabel(options.buttonLabel);
    const request = parseConnectRequest({
      kind: 'connect',
      hostId,
      hosts: [],
      sshConfigAliases: [],
      pick: {
        mode,
        hostName: this.deps.hostName(authority),
        roots: roots.slice(0, MAX_OVERLAY_ITEMS).map((root) => root.fsPath),
        ...(title !== undefined ? { title } : {}),
        ...(buttonLabel !== undefined ? { buttonLabel } : {}),
      },
    });
    if (!request) throw new Error('The picker exceeds the overlay bounds');
    this.picking = pick;
    try {
      const answer = await overlay.request(request);
      return answer.kind === 'connect' ? await this.picked(pick, answer.path) : undefined;
    } finally {
      if (this.picking === pick) this.picking = undefined;
    }
  }

  async browse(hostId: string, folder: string | undefined): Promise<RemoteBrowseResult> {
    const pick = this.picking;
    if (pick?.hostId === hostId) return this.browsePick(pick, folder);
    this.record(hostId);
    const authority = sshAuthorityKey(hostId);
    const connection = this.deps.connection(authority);
    const workspace = this.deps.workspace(authority);
    if (!connection || !workspace) return { ok: false, error: 'notConnected' };
    const { os, homedir } = connection.facts;
    const flavor = pathFor({ os });
    const target = folder ?? homedir;
    if (!flavor.isAbsolute(target)) return { ok: false, error: 'missing' };
    const listed = await workspace.files.browse(target);
    if (!listed.ok) {
      const privacy = os === 'darwin' && listed.reason === 'failed' ? macPrivacyFolder(homedir, target) : undefined;
      return privacy !== undefined ? { ok: false, error: 'eperm-privacy', folder: privacy } : { ok: false, error: listed.reason };
    }
    const projects = new Map(this.deps.projects(hostId).map((project) => [project.folderKey, project.key]));
    const parent = flavor.dirname(listed.path);
    return {
      ok: true,
      path: listed.path,
      ...(parent !== listed.path ? { parent } : {}),
      home: homedir,
      separator: flavor.sep === '\\' ? '\\' : '/',
      folders: [...listed.folders].sort((a, b) => a.localeCompare(b)).map((name) => {
        const projectKey = projects.get(folderKeyOn(os, flavor.join(listed.path, name)));
        return { name, ...(projectKey !== undefined ? { projectKey } : {}) };
      }),
    };
  }

  async pickFolder(hostId: string, folder: string): Promise<{ readonly projectKey: string }> {
    if (this.picking) throw new Error('A picker adds no project');
    this.record(hostId);
    const projectKey = await this.deps.addProject(hostId, folder);
    await this.deps.store.touchHost(hostId, folder);
    return { projectKey };
  }

  async runs(hostId: string): Promise<readonly HostRun[]> {
    this.record(hostId);
    const authorityKey = sshAuthorityKey(hostId);
    const connection = this.deps.connection(authorityKey);
    if (!connection) return [];
    const [{ runs }, live] = await Promise.all([connection.control.request('listRuns', {}), connection.workspace.request('terminals.list', {})]);
    const projects = new Map(this.deps.projects(hostId).map((project) => [project.folderKey, project.key]));
    const { terminals } = this.deps;
    return runs.filter((run) => run.kind === 'terminal').map((run) => {
      const projectKey = run.projectKey === '' ? undefined : projects.get(run.projectKey);
      const listed = live.find((terminal) => terminal.id === run.id);
      return {
        id: run.id,
        title: run.title,
        state: run.state,
        ...(projectKey !== undefined ? { projectKey } : {}),
        canOpen: listed !== undefined && terminals.canOpen(authorityKey, listed),
      };
    });
  }

  async openRun(hostId: string, runId: string): Promise<void> {
    this.record(hostId);
    await this.deps.terminals.open(sshAuthorityKey(hostId), runId);
  }

  async killRun(hostId: string, runId: string): Promise<void> {
    const record = this.record(hostId);
    const connection = this.deps.connection(sshAuthorityKey(hostId));
    if (!connection) throw new Error(`${record.name} is not connected`);
    // the daemon's terminal hub ends it and tells every viewer, this window's tab included
    connection.workspace.emit('terminals.post', { request: { type: 'kill', id: runId } });
    this.hostChanged(hostId);
  }

  showLog(hostId: string): Promise<void> {
    this.record(hostId);
    return this.deps.showLogs(hostId);
  }

  /** Allow background work: the daemon enables linger for its own user, and the card's notice goes once it did. */
  async allowBackground(hostId: string): Promise<LingerResult> {
    this.record(hostId);
    const connection = this.deps.connection(sshAuthorityKey(hostId));
    if (!connection) throw new Error(`${this.deps.hostName(sshAuthorityKey(hostId))} is not connected`);
    if (!connection.features.includes(LINGER_FEATURE)) return { result: 'failed', code: 'unsupported' };
    const result = await connection.control.request('linger', {});
    if (result.result === 'enabled' || result.result === 'alreadyEnabled') this.deps.connections.dropNotice(hostId, 'noLinger');
    // only linger this call turned on, so Remove Damocles server never offers to undo an admin's
    if (result.result === 'enabled') await this.deps.store.recordLingerEnabled(hostId);
    this.deps.log(`[remote] ${hostId}: Allow background work ${result.result}`);
    return result;
  }

  async setInstallFolder(hostId: string, folder: string | null): Promise<InstallFolderResult> {
    this.record(hostId);
    if (folder !== null && !this.deps.validInstallFolder(folder)) return { ok: false, reason: 'invalid' };
    await this.deps.store.setInstallFolder(hostId, folder);
    this.hostsChanged();
    return { ok: true };
  }

  async copyHostKeyCommand(hostId: string): Promise<void> {
    this.record(hostId);
    const failure = this.deps.connections.failure(hostId);
    const command = failure?.params['command'];
    if (failure?.code !== 'hostKeyChanged' || !isHostSpec(failure.params['host']) || typeof command !== 'string') throw new Error('The host has no changed host key to remove');
    this.deps.writeClipboard(command);
  }

  // A path inside one of the picker's roots, the deepest holding it; undefined outside them all.
  private async locate(authority: string, roots: readonly Project[], target: string): Promise<Located | undefined> {
    const connection = this.deps.connection(authority);
    const workspace = this.deps.workspace(authority);
    if (!connection || !workspace) return undefined;
    const key = folderKeyOn(connection.facts.os, target);
    const root = roots.find((candidate) => folderKeyOn(connection.facts.os, candidate.fsPath) === key);
    if (root) return { project: root, relativePath: '' };
    const found = await workspace.files.projectOfPath(roots, target);
    return found && { project: found.project, relativePath: found.relativePath };
  }

  // The folder a picker opens at: defaultPath's folder (a file's own folder) when a root holds it, else the first root.
  private async startOf(authority: string, workspace: ProjectWorkspace, roots: readonly Project[], defaultPath: string | undefined): Promise<Located> {
    const first: Located = { project: roots[0]!, relativePath: '' };
    const located = defaultPath === undefined ? undefined : await this.locate(authority, roots, defaultPath);
    if (!located) return first;
    const confined = await workspace.files.confineExisting(located.project, located.relativePath);
    if (!confined.ok) return first;
    if (await workspace.files.isDirectory(confined.path)) return located;
    const slash = located.relativePath.lastIndexOf('/');
    return { project: located.project, relativePath: slash < 0 ? '' : located.relativePath.slice(0, slash) };
  }

  // A picker's listing: only inside its roots, read through the host's own confinement; files only in file mode.
  private async browsePick(pick: OpenPick, folder: string | undefined): Promise<RemoteBrowseResult> {
    const connection = this.deps.connection(pick.authority);
    const workspace = this.deps.workspace(pick.authority);
    if (!connection || !workspace) return { ok: false, error: 'notConnected' };
    const located = folder === undefined ? pick.start : await this.locate(pick.authority, pick.roots, folder);
    if (!located) return { ok: false, error: 'outside' };
    const listed = await workspace.tree.list(located.project, located.relativePath, []);
    if (!listed.ok) return { ok: false, error: listed.reason };
    const flavor = pathFor({ os: connection.facts.os });
    const root = located.project.fsPath;
    const at = located.relativePath === '' ? root : flavor.join(root, ...located.relativePath.split('/'));
    const names = (kind: 'file' | 'dir'): string[] => listed.entries.filter((entry) => entry.kind === kind).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
    return {
      ok: true,
      path: at,
      ...(located.relativePath !== '' ? { parent: flavor.dirname(at) } : {}),
      home: root,
      root,
      separator: flavor.sep === '\\' ? '\\' : '/',
      folders: names('dir').map((name) => ({ name })),
      ...(pick.mode === 'file' ? { files: names('file').filter((name) => pickable(name, pick.extensions)) } : {}),
    };
  }

  // The picked path, confined again on the host and of the picker's kind; anything else is refused.
  private async picked(pick: OpenPick, target: string): Promise<string | undefined> {
    const workspace = this.deps.workspace(pick.authority);
    const located = await this.locate(pick.authority, pick.roots, target);
    const confined = located && workspace ? await workspace.files.confineExisting(located.project, located.relativePath) : undefined;
    // the name the listing filtered by, never the whole path, whose folders may hold a dot
    const fits = pick.mode === 'folder' || pickable(located?.relativePath.split('/').at(-1) ?? '', pick.extensions);
    if (!workspace || !confined?.ok || !fits || (await workspace.files.isDirectory(confined.path)) !== (pick.mode === 'folder')) {
      this.deps.log(`[remote] refused the picked path: not a ${pick.mode} inside the projects of ${pick.authority}`);
      return undefined;
    }
    return confined.path;
  }

  private connectWatched(hostId: string): string {
    const attemptId = this.deps.connections.connect(hostId, this.watching !== undefined);
    this.watching?.add(hostId);
    return attemptId;
  }

  private watch(hostId: string): void {
    this.deps.connections.watch(hostId, true);
    this.watching?.add(hostId);
  }

  private record(hostId: string): SshHostRecord {
    const record = this.deps.store.host(hostId);
    if (!record) throw new Error(`No saved host ${hostId}`);
    return record;
  }

  // the handshake's skew, only once it passes the warning bound
  private skew(hostId: string): number | undefined {
    const skew = this.deps.connection(sshAuthorityKey(hostId))?.skewMs;
    return skew !== undefined && Math.abs(skew) > CLOCK_SKEW_WARN_MS ? Math.round(skew) : undefined;
  }

  private card(record: SshHostRecord): HostCardInfo {
    const os = hostOs(record);
    const skew = this.skew(record.id);
    const connection = this.connectionOf(record.id);
    const failure = connection === 'failed' ? this.deps.connections.failure(record.id) : undefined;
    const connectionNotices = [this.deps.watchLimit(sshAuthorityKey(record.id)), this.deps.sharedHome(sshAuthorityKey(record.id))].filter((notice) => notice !== undefined);
    return {
      hostId: record.id,
      name: record.name,
      ...(record.color !== undefined ? { color: record.color } : {}),
      destinationLabel: destinationLabel(record.destination),
      ...(os !== undefined ? { os } : {}),
      connection,
      signInNeeded: this.deps.connections.signInNeeded(record.id),
      ...(record.lastUsed !== undefined ? { lastUsed: record.lastUsed } : {}),
      recentFolders: record.recentFolders,
      projectFolders: this.deps.projects(record.id).map((project) => project.fsPath),
      notices: [...this.deps.connections.notices(record.id), ...connectionNotices],
      ...(failure ? { failure } : {}),
      ...(skew !== undefined ? { clockSkewMs: skew } : {}),
      ...(record.settings.installFolder !== undefined ? { installFolder: record.settings.installFolder } : {}),
      ...this.quality(record.id),
      ...this.devices(record.id),
      ...(record.settings.defaultPermissionMode !== undefined ? { defaultPermissionMode: record.settings.defaultPermissionMode } : {}),
      allowBypass: record.settings.allowBypass === true,
      passwordless: record.identityFile !== undefined,
      keyInstalledByDamocles: record.installedKeyFingerprint !== undefined,
      lingerEnabledByDamocles: record.lingerEnabledByDamocles === true,
    };
  }

  // the devices attached to the host's daemon while connected, this one first, within the card's bounds
  private devices(hostId: string): { devices?: HostDevice[] } {
    const attached = this.deps.connection(sshAuthorityKey(hostId))?.devices() ?? [];
    if (attached.length === 0) return {};
    const ordered = [...attached.filter((device) => device.self), ...attached.filter((device) => !device.self)];
    return { devices: ordered.slice(0, MAX_HOST_DEVICES).map((device) => ({ deviceName: [...device.deviceName].slice(0, MAX_DEVICE_NAME_LENGTH).join(''), self: device.self })) };
  }

  private update(hostId: string): { update?: HostUpdate } {
    const update = this.deps.update(sshAuthorityKey(hostId));
    return update !== undefined ? { update } : {};
  }

  // the reconnect phase and latency a host's dot, banner and card show
  private quality(hostId: string): { reconnect?: HostReconnect; latency?: HostLatency } {
    const authority = sshAuthorityKey(hostId);
    const reconnect = this.deps.reconnect(authority);
    const latency = this.deps.latency(authority);
    return { ...(reconnect ? { reconnect } : {}), ...(latency ? { latency } : {}) };
  }
}

/**
 * What ssh is given for a saved host: its alias, or its address as the parser's rules take it now. A saved part those rules
 * refuse fails with destinationRefused before ssh starts, since leaving it out would change who or where ssh connects; only
 * an option Damocles sets itself is left out, with a log line.
 */
export function sshDestination(destination: SshHostDestination, log: (line: string) => void): SshDestination {
  if (destination.kind === 'alias') {
    if (!isSafeAlias(destination.alias)) throw new SshConnectError('destinationRefused', { setting: 'alias' }, '');
    return destination;
  }
  const checked = checkSavedAddress(destination);
  if (!checked.ok) throw new SshConnectError('destinationRefused', { setting: checked.setting }, '');
  if (checked.dropped.length > 0) log(`[remote] leaving out saved ssh options Damocles sets itself: ${checked.dropped.join(', ')}`);
  return checked.destination;
}

/** The project key of a folder of a host, computed from the target's folder key. */
export function sshProjectKey(hostId: string, folderKey: string): string {
  return projectKeyOf({ kind: 'ssh', hostId }, folderKey);
}
