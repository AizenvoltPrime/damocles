import { folderKeyOn } from '../../../core/workspace-folders/folder-key';
import { pathFor, projectKeyOf } from '../../../shared/project-location';
import {
  CLOCK_SKEW_WARN_MS,
  MAX_DEVICE_NAME_LENGTH,
  MAX_HELD_MEMORY_QUEUES,
  MAX_HOST_DEVICES,
  MAX_OVERLAY_ITEMS,
  MAX_OVERLAY_LABEL_LENGTH,
  MAX_SSH_CONFIG_ALIASES,
  OVERLAY_CHANNELS,
  type ConnectStartResult,
  type ConnectTarget,
  type HeldMemoryQueue,
  type HeldMemoryResult,
  type HostCardInfo,
  type HostDevice,
  type HostNotice,
  type HostOperations,
  type HostParseResult,
  type HostRun,
  type InstallFolderResult,
  type LingerResult,
  type NameCheck,
  type OverlayAnswer,
  type OverlayRect,
  type OverlayRequest,
  type PasswordlessResult,
  type PasswordlessRun,
  type PasswordlessStep,
  type PasswordlessStepState,
  type RemoteBrowseResult,
  type RemoteHostEntry,
  type RemovalInfo,
  type RemoveServerOptions,
  type RemoveServerResult,
  type ServerRemovalRun,
  type HostSettingChange,
  type RemovalRun,
  type WslConversionRun,
  type WslDistroInfo,
  type ContainerFolderPick,
  type ContainerHostInfo,
  type ContainerListResult,
  type ContainerRebuildRun,
  type ContainerState,
  type RunningContainer,
} from '../../preload/overlay-channels';
import type { InstallKeyResult } from '../../daemon/control-messages';
import { removeServer, runRemovalStage } from './remove-server';
import type { HostUpdate, ProjectConnection, ReopenInContainerResult, ShellHost } from '../../preload/shell-channels';
import type { HostLatency, HostReconnect } from '../../../shared/host-connection';
import type { Project } from '../../local-services/confine';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import type { LiveTerminal } from '../../workspace/terminal/terminal-backend';
import type { RemoteConnection } from './connection';
import type { ConnectActions } from './connect-channels';
import { hostConnection, type RemoteConnections } from './connections';
import { parseConnectDistros, parseConnectHosts, parseConnectRequest, parseConnectStep, parseHostEntries } from '../overlay';
import { canForwardAgent, destinationLabel, devcontainerNameSource, forwardsAgent, hostOs, prefillHostName, type ContainerHostRecord, type HostRecord, type HostStore, type SshHostDestination, type SshHostRecord } from './host-store';
import type { ContainerEngine } from '../../daemon/container-values';
import { attachKey, devcontainerKey } from './containers/container-key';
import type { ContainerSide } from './containers/container-side';
import { shownMessage } from './containers/devcontainer-output';
import { parseInspect, parsePs } from './containers/docker-ps';
import { INITIAL_REBUILD, rebuildContainer, type RebuildResult } from './containers/rebuild-container';
import type { WslListResult } from './wsl/wsl-list';
import type { DistroListing } from './wsl/wsl-transport';
import { convertToWsl2, INITIAL_CONVERSION, type ConversionDeps, type ConversionResult } from './wsl/convert-to-wsl2';
import { shutDownNow } from './app-update-flow';
import { checkSavedAddress, HostNotConnectedError, isSafeAlias, setUpPasswordless, SshConnectError, type KeySetupDeps, type SshDestination, type SshParseResult } from './ssh';

/** A connected host's held memory queues as its core lists them, and Deliver here and Discard of one; false: no longer held. */
export interface HeldMemoryHost {
  queues(): readonly HeldMemoryQueue[];
  deliver(queueId: string): Promise<boolean>;
  discard(queueId: string): Promise<boolean>;
}

export interface RemoteHostsDeps {
  readonly store: HostStore;
  // undefined while the host is not connected or its daemon holds no queues (it lacks user.memory.heldQueues)
  readonly heldMemory: (authorityKey: string) => HeldMemoryHost | undefined;
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
  // shown: the request is on screen; an aborted signal withdraws this request alone
  readonly overlay: () => { request(request: OverlayRequest, shown?: () => void, signal?: AbortSignal): Promise<OverlayAnswer>; send(channel: string, payload: unknown): void; isOpen(kind: 'connect' | 'settings'): boolean } | undefined;
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
  // the host connects no more until asked: its reconnect loop stops, its attempt in flight ends and its connection closes;
  // settles once the attempt it ended settled, never rejecting
  readonly disconnect: (hostId: string) => Promise<void>;
  // Settings at the Remote hosts section, on this host
  readonly openSettings: (hostId: string) => void;
  // generating, installing and verifying the passwordless key
  readonly keySetup: KeySetupDeps;
  readonly sshConfigFile?: string;
  // the removal stage over ssh, with its prompts shown as the host's attempt
  readonly runRemovalStage: (hostId: string, script: string) => Promise<{ readonly code: number | null; readonly lines: readonly string[] }>;
  // ssh -O exit on Damocles' master connection to the host, ending every session on it; nothing when it uses none
  readonly exitControlMaster: (hostId: string) => Promise<void>;
  // this computer's WSL distros, as wsl.exe lists them now
  readonly listDistros: () => Promise<WslListResult>;
  // wsl.exe --set-version <distro> 2, its output line by line
  readonly setWslVersion: ConversionDeps['setVersion'];
  // where a container's engine and the devcontainer CLI run: this computer, or the saved SSH host via
  readonly containerSide: (via: string | undefined) => ContainerSide;
  // a path's folder key where the devcontainer CLI runs: this computer's, or the connected SSH host via's
  readonly cliFolderKey: (via: string | undefined, path: string) => Promise<string>;
  // the engine a new container record uses (damocles.desktop.remote.containerEngine)
  readonly containerEngine: () => ContainerEngine;
  // this computer's folder picker; undefined on cancel
  readonly pickLocalFolder: () => Promise<string | undefined>;
  // a devcontainer record's trust gate, rejecting with the failure naming why nothing ran
  readonly containerGate: (hostId: string) => Promise<void>;
  // devcontainer up for the record, recording the container it gives; removeExisting: Rebuild
  readonly containerUp: (hostId: string, removeExisting: boolean, onLog: (log: ContainerRebuildRun['log']) => void) => Promise<void>;
  // the container's workspace folder as its project, selected
  readonly openContainerFolder: (hostId: string) => Promise<string>;
  readonly log: (line: string) => void;
}

// The daemon runs loginctl enable-linger for its own user (control.linger).
const LINGER_FEATURE = 'linger';
// The daemon appends Damocles' key to its user's authorized keys (control ssh.installAuthorizedKey).
const INSTALL_KEY_FEATURE = 'ssh.installAuthorizedKey';
// a daemon that lists held memory queues (the heldMemory mirror) and takes memory.deliverHeld and memory.discardHeld
export const HELD_MEMORY_FEATURE = 'user.memory.heldQueues';

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

// A host's run of one operation: the state its snapshot shows, and the call a second start joins while it runs.
interface OperationRun<S, T> {
  state: S;
  running: Promise<T> | undefined;
}

// The Connect dialog openConnect shows: the host it shows now (the one it opened on, then the host of each start made in it), the
// attempt whose steps it hears (the one it opened on, then the one each start in it began or joined), the controller that
// withdraws this request alone, and the project a container's folder opened as while it showed that host.
interface OpenDialog {
  host: string | undefined;
  attemptId?: string;
  readonly withdraw: AbortController;
  opened?: string;
}

/** What openConnect opens the Connect dialog on, beside its host. */
export interface ConnectDialogOptions {
  readonly card?: 'rename' | 'show' | 'rebuild';
  readonly query?: string;
  readonly openFolder?: true;
  readonly anchor?: OverlayRect;
  readonly purpose?: 'signIn';
}

/** How a Connect dialog ended: shown false when it closed before it was on screen; opened, the project a container's folder opened as. */
export interface ConnectDialogEnd {
  readonly shown: boolean;
  readonly opened?: string;
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
 * The saved hosts (SSH hosts, WSL distros, containers) as the Connect dialog, the host cards and the shell see them, and the Connect dialog's actions. Names,
 * colors and labels come only from this computer's host store; every id the overlay names is looked up here.
 */
export class RemoteHosts implements ConnectActions {
  private readonly deps: RemoteHostsDeps;
  // the hosts whose attempts the open dialog shows, which watch ends when that dialog closes
  private watching: Set<string> | undefined;
  // the picker the dialog shows, whose browse calls stay inside its roots
  private picking: OpenPick | undefined;
  private dialog: OpenDialog | undefined;
  // per attempt, the opening of its container's folder in flight, which a second start of that attempt joins
  private readonly folderOpenings = new Map<string, Promise<string | undefined>>();
  // per host, the removal stage that refused with daemonRunning, which Try again runs again with its run key
  private readonly pendingRemovals = new Map<string, { readonly script: string; readonly key: boolean; readonly disableLinger: boolean }>();
  // per host, its latest passwordless setup and server removal, kept once ended until no Connect dialog or Settings shows
  private readonly setups = new Map<string, OperationRun<PasswordlessRun, PasswordlessResult>>();
  private readonly removals = new Map<string, OperationRun<Omit<ServerRemovalRun, 'prompt'>, RemoveServerResult>>();
  private readonly conversions = new Map<string, OperationRun<WslConversionRun, ConversionResult>>();
  private readonly rebuilds = new Map<string, OperationRun<ContainerRebuildRun, RebuildResult>>();
  // each container record's state as its engine last reported it
  private readonly containerStates = new Map<string, ContainerState>();
  // the last HostOperations revision built
  private revision = 0;
  // the distros as wsl.exe listed them last; empty before the first list and after a failed one, which is logged
  private distros: readonly WslDistroInfo[] = [];

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
        kind: record.kind,
        ...(record.kind === 'container' ? { container: { origin: record.origin, ...(record.image !== undefined ? { image: record.image } : {}), ...(record.via !== undefined ? { via: record.via } : {}) } } : {}),
        authorityKey: this.authorityOf(record.id),
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

  /** The distros of the last list, each with its host record's id once it has one. */
  distroInfos(): WslDistroInfo[] {
    return this.distros.map((distro) => {
      const hostId = this.deps.store.wslHost(distro.distro)?.id;
      return { distro: distro.distro, state: distro.state, version: distro.version, isDefault: distro.isDefault, ...(hostId !== undefined ? { hostId } : {}) };
    });
  }

  /** Lists the distros again; a failed list is logged and leaves none. Resolves the new list. */
  async refreshDistros(): Promise<readonly WslDistroInfo[]> {
    await this.relist();
    return this.distroInfos();
  }

  /** Lists the distros again and says whether wsl.exe lists distro now, or could not list at all. */
  async distroListing(distro: string): Promise<DistroListing> {
    if (!(await this.relist())) return 'listFailed';
    return this.distros.some((listed) => listed.distro === distro) ? 'listed' : 'notListed';
  }

  // whether wsl.exe answered the list
  private async relist(): Promise<boolean> {
    const listed = await this.deps.listDistros();
    if (!listed.ok && listed.reason !== 'notWindows') this.deps.log(`[remote] listing the WSL distros failed: ${listed.reason}`);
    this.distros = listed.ok ? listed.distros : [];
    return listed.ok;
  }

  /** Whether the authority's target shares this computer's loopback: a distro the last list shows on WSL 1, whose network is Windows' own. */
  sharesClientLoopback(authorityKey: string): boolean {
    const hostId = this.deps.store.hostIdOf(authorityKey);
    const record = hostId === undefined ? undefined : this.deps.store.host(hostId);
    return record?.kind === 'wsl' && this.distros.some((distro) => distro.distro === record.distro && distro.version === 1);
  }

  // the host's authority key; a host the store does not hold has none
  private authorityOf(hostId: string): string {
    const authority = this.deps.store.authorityOf(hostId);
    if (authority === undefined) throw new Error(`No saved host ${hostId}`);
    return authority;
  }

  // the one list the dialog shows and start({alias}) accepts, within the dialog's bound
  private async configAliases(): Promise<readonly string[]> {
    const aliases = await this.deps.sshConfigAliases();
    if (aliases.length > MAX_SSH_CONFIG_ALIASES) this.deps.log(`[remote] the ssh config names ${aliases.length} hosts; the Connect dialog lists the first ${MAX_SSH_CONFIG_ALIASES}`);
    return aliases.slice(0, MAX_SSH_CONFIG_ALIASES);
  }

  connectionOf(hostId: string): ProjectConnection {
    return hostConnection(this.deps.state(this.authorityOf(hostId)), this.deps.connections.failure(hostId));
  }

  /**
   * Opens the Connect dialog on the host list, or with hostId straight to that host: an attempt in flight shows with its
   * waiting prompt, an attempt that met a changed host key shows that failure, and otherwise the dialog starts one itself for
   * a host that is not connected. card opens the host's card instead, starting nothing and showing a running attempt only in
   * its status, never its timeline; 'rename' with its name field open,
   * 'rebuild' at a devcontainer's Rebuild Container confirmation. query fills the host list's search, as if typed, starting nothing.
   * The dialog shows the distros and container states last listed; their fresh lists follow once it is on screen. openFolder
   * (Reopen in Container): a connected devcontainer shows its connected attempt while its folder opens, where its folder browser
   * would show otherwise. anchor (with card 'show'): the chip the card hangs from as a popover. purpose 'signIn' (a "Sign in to <host>" banner): the dialog closes once the
   * host connects, and a host already connected opens nothing. Settles once the dialog closed.
   */
  async openConnect(hostId?: string, options: ConnectDialogOptions = {}): Promise<ConnectDialogEnd> {
    const { card, query, openFolder, anchor, purpose } = options;
    const overlay = this.deps.overlay();
    if (!overlay) throw new Error('No window shows the Connect dialog');
    const record = hostId === undefined ? undefined : this.deps.store.host(hostId);
    if (hostId !== undefined && !record) throw new Error(`No saved host ${hostId}`);
    if (purpose === 'signIn' && hostId !== undefined && this.connectionOf(hostId) === 'connected') return { shown: false };
    // this dialog replaces an open picker, whose confinement goes with it
    this.picking = undefined;
    const known = new Set(this.deps.store.hosts().flatMap((saved) => (saved.kind === 'ssh' && saved.destination.kind === 'alias' ? [saved.destination.alias] : [])));
    const aliases = (await this.configAliases()).filter((alias) => !known.has(alias));
    const joined = openFolder && hostId !== undefined && this.connectionOf(hostId) === 'connected' ? this.deps.connections.connect(hostId, true) : undefined;
    const attempt = hostId === undefined ? undefined : this.deps.connections.attempt(hostId);
    // the timeline's Escape cancels its attempt, which stops a reconnect loop; a card, anchored or not, never shows it, nor its question
    const running = card === undefined && attempt && attempt.step !== 'connected' && attempt.step !== 'failed' ? attempt : undefined;
    // a changed host key stops every attempt: the dialog shows that failure and starts none until the user retries
    const keyChanged = card === undefined && attempt?.step === 'failed' && attempt.failure?.code === 'hostKeyChanged' ? attempt : undefined;
    // the one attempt whose steps the dialog hears until a start in it binds another; with none it hears no step
    const shown = running ?? keyChanged ?? (joined !== undefined && attempt?.attemptId === joined ? attempt : undefined);
    const request = parseConnectRequest({
      kind: 'connect',
      ...(hostId !== undefined ? { hostId } : {}),
      ...(card !== undefined ? { card } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
      ...(query !== undefined ? { query } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      hosts: this.cards(),
      distros: this.distroInfos(),
      sshConfigAliases: aliases,
      ...(shown ? { attempt: shown } : {}),
    });
    if (!request) throw new Error('The Connect dialog exceeds the overlay bounds');
    const watching = new Set<string>();
    this.watching = watching;
    const dialog: OpenDialog = { host: hostId, ...(shown ? { attemptId: shown.attemptId } : {}), withdraw: new AbortController() };
    this.dialog = dialog;
    // the dialog waits on a devcontainer's timeline for its folder to open
    if (running && hostId !== undefined && record?.kind === 'container' && record.origin === 'devcontainer') void this.openWhenConnected(hostId, running.attemptId);
    if (joined !== undefined && hostId !== undefined) {
      watching.add(hostId);
      void this.openWhenConnected(hostId, joined);
    }
    let onScreen = false;
    let screened!: (onScreen: boolean) => void;
    const shownOrClosed = new Promise<boolean>((resolve) => (screened = resolve));
    const answered = overlay.request(request, () => {
      onScreen = true;
      screened(true);
      if (hostId === undefined || !shown) return;
      // the sign-in banner stays until the user can see the prompt it stands for
      if (running) {
        this.deps.connections.watch(hostId, true);
        watching.add(hostId);
      }
      // a dialog that waited behind a question or a page load would show its attempt as it stood when asked
      this.sendStep(overlay, dialog, hostId);
    }, dialog.withdraw.signal);
    this.refreshLists(dialog, shownOrClosed);
    try {
      await answered;
    } finally {
      screened(false);
      // a dialog opened meanwhile replaced this one and keeps watching what it shows
      for (const watched of watching) if (!this.watching?.has(watched) || this.watching === watching) this.deps.connections.watch(watched, false);
      if (this.watching === watching) this.watching = undefined;
      if (this.dialog === dialog) this.dialog = undefined;
      this.dropUnshownRuns();
    }
    return { shown: onScreen, ...(dialog.opened !== undefined ? { opened: dialog.opened } : {}) };
  }

  // The distros and container states listed again behind the dialog, pushed only once it is on screen, since a push made
  // before the overlay page holds the request is dropped.
  private refreshLists(dialog: OpenDialog, shown: Promise<boolean>): void {
    void Promise.all([this.refreshDistros(), this.refreshContainers()]).then(async () => {
      if (!(await shown) || this.dialog !== dialog) return;
      const overlay = this.deps.overlay();
      if (overlay?.isOpen('connect')) this.sendCards(overlay);
    }).catch((err: unknown) => this.deps.log(`[remote] listing the distros and containers for the Connect dialog failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * Reopen in Container: the Connect dialog on the devcontainer record, whose own start connects it and opens its folder.
   * Settles once the dialog closed: the project the folder opened as; cancelled when it closed first, before it was on screen
   * among them; else the failure of the host's attempt.
   */
  async reopenInContainer(hostId: string): Promise<ReopenInContainerResult> {
    this.devcontainerRecord(hostId);
    const ended = await this.openConnect(hostId, { openFolder: true });
    if (ended.opened !== undefined) return { ok: true, projectKey: ended.opened };
    const failure = this.deps.connections.failure(hostId);
    return !ended.shown || failure === undefined || failure.code === 'cancelled' ? { ok: false, code: 'cancelled' } : { ok: false, code: 'connectFailed', message: failure.code };
  }

  /** A host's attempt or state changed: the open dialog hears the step only of the attempt it is bound to, then its host list. */
  hostChanged(hostId: string): void {
    // the removal stage's ssh asks its questions as the host's attempt
    if (this.removals.get(hostId)?.running) this.operationsChanged(hostId);
    const overlay = this.deps.overlay();
    if (!overlay?.isOpen('connect')) return;
    if (this.dialog) this.sendStep(overlay, this.dialog, hostId);
    this.sendCards(overlay);
  }

  // A step reaches only the dialog bound to its attempt, so another attempt's question never opens over a card or the host list.
  private sendStep(overlay: NonNullable<ReturnType<RemoteHostsDeps['overlay']>>, dialog: OpenDialog, hostId: string): void {
    const attempt = this.deps.connections.attempt(hostId);
    if (!attempt || attempt.attemptId !== dialog.attemptId) return;
    const step = parseConnectStep(attempt);
    if (step) overlay.send(OVERLAY_CHANNELS.connectStep, step);
    else this.deps.log(`[remote] ${hostId}: the attempt's step exceeds the overlay bounds; the Connect dialog keeps the last one`);
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
    const distros = parseConnectDistros(this.distroInfos());
    if (distros) overlay.send(OVERLAY_CHANNELS.connectDistros, distros);
    else this.deps.log('[remote] the distro list exceeds the overlay bounds; the Connect dialog keeps the last one');
  }

  /** Every saved host as Settings > Remote hosts lists it, in saved order. */
  entries(): RemoteHostEntry[] {
    return this.deps.store.hosts().map((record) => {
      const os = hostOs(record);
      const { settings } = record;
      const ssh = record.kind === 'ssh' ? record : undefined;
      return {
        hostId: record.id,
        kind: record.kind,
        ...(record.kind === 'container' ? { container: this.containerInfo(record) } : {}),
        authorityKey: this.authorityOf(record.id),
        name: record.name,
        destinationLabel: labelOf(record),
        ...(os !== undefined ? { os } : {}),
        ...(ssh?.platform !== undefined ? { detectedOs: ssh.platform.os } : {}),
        connection: this.connectionOf(record.id),
        settings: {
          ...(record.color !== undefined ? { color: record.color } : {}),
          ...(settings.defaultPermissionMode !== undefined ? { defaultPermissionMode: settings.defaultPermissionMode } : {}),
          allowBypass: settings.allowBypass === true,
          forwardAgent: settings.forwardAgent === true,
          rememberPassword: settings.rememberPassword === true,
          browserLocalNetwork: settings.browserLocalNetwork === true,
          openLinksWithoutAsking: settings.openLinksWithoutAsking === true,
          ...(ssh?.osOverride !== undefined ? { osOverride: ssh.osOverride } : {}),
          ...(settings.installFolder !== undefined ? { installFolder: settings.installFolder } : {}),
        },
        facts: {
          passwordless: ssh?.identityFile !== undefined,
          keyInstalledByDamocles: ssh?.installedKeyFingerprint !== undefined,
          lingerEnabledByDamocles: ssh?.lingerEnabledByDamocles === true,
          alwaysCredentialHosts: record.alwaysCredentialHosts ?? [],
          alwaysForgeAccounts: record.alwaysForgeAccounts ?? [],
        },
        heldMemoryQueues: this.heldQueuesOf(record.id),
      };
    });
  }

  private heldQueuesOf(hostId: string): readonly HeldMemoryQueue[] {
    if (this.connectionOf(hostId) !== 'connected') return [];
    const queues = this.deps.heldMemory(this.authorityOf(hostId))?.queues() ?? [];
    if (queues.length <= MAX_HELD_MEMORY_QUEUES) return queues;
    this.deps.log(`[remote] ${hostId}: ${queues.length - MAX_HELD_MEMORY_QUEUES} held memory queues past the ${MAX_HELD_MEMORY_QUEUES} the overlay shows are left out`);
    return queues.slice(0, MAX_HELD_MEMORY_QUEUES);
  }

  /** Deliver here: the held queue goes to this computer's device on the host, which then drains it. */
  async deliverHeldMemory(hostId: string, queueId: string): Promise<HeldMemoryResult> {
    return this.heldMemoryAction(hostId, queueId, (held) => held.deliver(queueId));
  }

  /** Discard: the held queue is deleted; the overlay confirmed it. */
  async discardHeldMemory(hostId: string, queueId: string): Promise<HeldMemoryResult> {
    return this.heldMemoryAction(hostId, queueId, (held) => held.discard(queueId));
  }

  private async heldMemoryAction(hostId: string, queueId: string, act: (held: HeldMemoryHost) => Promise<boolean>): Promise<HeldMemoryResult> {
    this.record(hostId);
    const held = this.connectionOf(hostId) === 'connected' ? this.deps.heldMemory(this.authorityOf(hostId)) : undefined;
    if (!held) return { ok: false, code: 'notConnected' };
    let done: boolean;
    try {
      done = await act(held);
    } catch (err) {
      this.deps.log(`[remote] ${hostId}: held memory queue ${queueId} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    this.deps.log(`[remote] ${hostId}: held memory queue ${queueId} ${done ? 'taken' : 'was no longer held'}`);
    return done ? { ok: true } : { ok: false, code: 'gone' };
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
    // forwarding is the ssh master's option; a container's relay follows its clientPolicy on the connection it has
    if (before.kind === 'ssh' && forwardsAgent(before) !== forwardsAgent(after) && this.deps.connection(this.authorityOf(hostId))) await this.deps.reconnectFresh(hostId);
  }

  /** Revoke: the pair (this host, credentialHost) asks again on its next credential request. */
  async revokeCredentialHost(hostId: string, credentialHost: string): Promise<void> {
    this.record(hostId);
    await this.deps.store.revokeCredentialHost(hostId, credentialHost);
  }

  /** Revoke: this host's git asks again before it uses the account. */
  async revokeForgeAccount(hostId: string, accountId: string): Promise<void> {
    this.record(hostId);
    await this.deps.store.revokeForgeAccount(hostId, accountId);
  }

  /** Set up passwordless login: generate, install, verify. A call while the host's setup runs joins it. */
  async setUpPasswordless(hostId: string): Promise<PasswordlessResult> {
    const record = this.record(hostId);
    if (record.kind !== 'ssh') return { ok: false, step: 'install', code: 'unsupported', params: {} };
    const pending: PasswordlessStepState = 'pending';
    return this.operate(
      this.setups,
      hostId,
      { steps: { generate: pending, install: pending, verify: pending } },
      (update, run) => this.runPasswordless(hostId, record, (step, state) => update({ ...run.state, steps: { ...run.state.steps, [step]: state } })),
      (state, result) => ({ steps: result.ok ? state.steps : { ...state.steps, [result.step]: 'failed' }, result }),
    );
  }

  private async runPasswordless(hostId: string, record: SshHostRecord, progress: (step: PasswordlessStep, state: PasswordlessStepState) => void): Promise<PasswordlessResult> {
    const connection = this.deps.connection(this.authorityOf(hostId));
    if (!connection) {
      progress('install', 'failed');
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
      progress,
    });
    if (outcome.identityFile !== undefined) await this.deps.store.recordPasswordless(hostId, outcome.identityFile);
    this.deps.log(`[remote] ${hostId}: passwordless login ${outcome.result.ok ? 'set up' : `failed at ${outcome.result.step}: ${outcome.result.code}`}`);
    return outcome.result;
  }

  /** What Remove Damocles server lists and offers: the host's running chats and terminals, and the two undo checkboxes. */
  async removalInfo(hostId: string): Promise<RemovalInfo> {
    const record = this.record(hostId);
    return {
      runs: await this.runningWork(hostId),
      offerRemoveKey: record.kind === 'ssh' && record.installedKeyFingerprint !== undefined,
      offerDisableLinger: record.kind === 'ssh' && record.lingerEnabledByDamocles === true && hostOs(record) !== 'win32',
    };
  }

  /**
   * Remove Damocles server: the daemon shuts down for it and the host goes offline, then the removal stage runs over ssh; the
   * key and linger are undone only when asked and only when Damocles made them. A call while the host's removal runs joins it.
   */
  async removeServer(hostId: string, options: RemoveServerOptions): Promise<RemoveServerResult> {
    const record = this.record(hostId);
    // the removal stage runs over ssh
    if (record.kind !== 'ssh') return { ok: false, code: 'unsupported', params: {} };
    return this.operate(this.removals, hostId, {}, () => this.runRemoval(hostId, record, options), (_state, result) => ({ result }));
  }

  private async runRemoval(hostId: string, record: SshHostRecord, options: RemoveServerOptions): Promise<RemoveServerResult> {
    const authority = this.authorityOf(hostId);
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
              void this.deps.disconnect(hostId);
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

  // the host's running chats and terminals from its daemon's listRuns, as a confirmation lists them
  private async runningWork(hostId: string): Promise<RemovalRun[]> {
    const connection = this.deps.connection(this.authorityOf(hostId));
    if (!connection) throw new Error(`${this.record(hostId).name} is not connected`);
    const { runs } = await connection.control.request('listRuns', {});
    const projects = new Map(this.deps.projects(hostId).map((project) => [project.folderKey, project.key]));
    return runs.slice(0, MAX_OVERLAY_ITEMS).map((run) => {
      const projectKey = run.projectKey === '' ? undefined : projects.get(run.projectKey);
      return { kind: run.kind, id: run.id, title: shownLabel(run.title) ?? '', state: run.state, ...(projectKey !== undefined ? { projectKey } : {}) };
    });
  }

  /** What Convert to WSL 2 lists before the user confirms: the distro's running chats and terminals, which the shutdown ends. */
  async conversionInfo(hostId: string): Promise<{ readonly runs: readonly RemovalRun[] }> {
    this.wslRecord(hostId);
    return { runs: await this.runningWork(hostId) };
  }

  /**
   * Convert to WSL 2, after the user confirmed: the daemon shuts down, wsl.exe converts the distro, and it connects again. A
   * call while the distro's conversion runs joins it; a distro the list shows on WSL 2 is refused.
   */
  async convertToWsl2(hostId: string): Promise<void> {
    const record = this.wslRecord(hostId);
    const joined = this.conversions.get(hostId)?.running;
    if (joined) {
      await joined;
      return;
    }
    const listed = (await this.refreshDistros()).find((distro) => distro.distro === record.distro);
    if (listed?.version !== 1) throw new Error(`${record.distro} is not a WSL 1 distro wsl.exe lists`);
    await this.operate(this.conversions, hostId, INITIAL_CONVERSION, (update) => convertToWsl2({
      shutDown: async () => {
        const connection = this.deps.connection(this.authorityOf(hostId));
        if (connection) await shutDownNow(connection, this.deps.log);
        // nothing reconnects the stopped daemon until the conversion connects it again
        await this.deps.disconnect(hostId);
      },
      setVersion: this.deps.setWslVersion,
      reconnect: async () => {
        const outcome = this.deps.connections.outcome(this.deps.connections.connect(hostId, false));
        if (!outcome) throw new Error(`The attempt to reach ${hostId} was replaced`);
        await outcome;
      },
      log: this.deps.log,
    }, record.distro, update).finally(() => {
      // the card shows the version wsl.exe lists now
      void this.refreshDistros().then(() => this.hostsChanged()).catch((err: unknown) => this.deps.log(`[remote] showing the distros after the conversion failed: ${String(err)}`));
    }), (state, result) => ({ ...state, result }));
  }

  /** What Rebuild Container lists before the user confirms: the container's running chats and terminals; none while not connected. */
  async rebuildInfo(hostId: string): Promise<{ readonly runs: readonly RemovalRun[] }> {
    this.devcontainerRecord(hostId);
    return { runs: this.deps.connection(this.authorityOf(hostId)) ? await this.runningWork(hostId) : [] };
  }

  /**
   * Rebuild Container, after the user confirmed: the trust gate, the daemon's shutdown, `devcontainer up
   * --remove-existing-container`, then a connect under the same key. A call while the container's rebuild runs joins it.
   */
  async rebuildContainer(hostId: string): Promise<void> {
    // the container up replaces, which a failed up may have left in place
    const previous = this.devcontainerRecord(hostId);
    await this.operate(this.rebuilds, hostId, INITIAL_REBUILD, (update) => rebuildContainer({
      passGate: () => this.deps.containerGate(hostId),
      shutDown: async () => {
        const connection = this.deps.connection(this.authorityOf(hostId));
        if (connection) await shutDownNow(connection, this.deps.log);
        // nothing reconnects the stopped daemon until the rebuild connects it again
        await this.deps.disconnect(hostId);
      },
      up: (onLog) => this.deps.containerUp(hostId, true, onLog),
      oldContainerKept: async () => {
        const state = await this.inspectState(previous);
        if (state === 'unknown') throw new Error(`${previous.engine} could not say whether the container ${hostId} had is still there`);
        return state !== 'missing';
      },
      reconnect: async () => {
        const outcome = this.deps.connections.outcome(this.deps.connections.connect(hostId, false));
        if (!outcome) throw new Error(`The attempt to reach ${hostId} was replaced`);
        await outcome;
      },
      log: this.deps.log,
    }, update).finally(() => {
      void this.refreshContainers().then(() => this.hostsChanged()).catch((err: unknown) => this.deps.log(`[remote] showing the containers after the rebuild failed: ${String(err)}`));
    }), (state, result) => ({ ...state, result }));
  }

  /** The running containers of this computer or of the saved SSH host via, as the attach list shows them. */
  async listContainers(via: string | undefined): Promise<ContainerListResult> {
    if (via !== undefined) this.sshRecord(via);
    if (via !== undefined && !this.deps.connection(this.authorityOf(via))) return { ok: false, code: 'notConnected' };
    const engine = this.deps.containerEngine();
    const side = this.deps.containerSide(via);
    let listed;
    try {
      listed = await side.list(engine);
    } catch (err) {
      if (err instanceof SshConnectError && err.code === 'containerFeatureMissing') return { ok: false, code: 'containerFeatureMissing' };
      throw err;
    }
    if (listed.result === 'engineMissing') return { ok: false, code: 'containerEngineMissing' };
    if (listed.code !== 0) return { ok: false, code: 'listFailed', message: shownMessage(listed.stderr) };
    const rows = parsePs(listed.stdout);
    const inspected = rows.length === 0 ? [] : await side.inspect(engine, rows.map((row) => row.id)).then((ran) => (ran.result === 'ran' && ran.code === 0 ? parseInspect(ran.stdout) : []));
    const names = new Set<string>();
    const containers: RunningContainer[] = rows.map((row) => {
      const user = inspected.find((container) => container.id === row.id)?.user;
      const hostId = this.deps.store.containerHost(attachKey(via, row.name))?.id;
      const prefillName = this.uniquePrefill(row.name, names);
      return { ...row, prefillName, ...(user !== undefined ? { user } : {}), ...(hostId !== undefined ? { hostId } : {}) };
    });
    return { ok: true, engine, containers };
  }

  /** This computer's folder picker for a folder holding a devcontainer configuration; null on cancel. */
  async pickContainerFolder(): Promise<ContainerFolderPick | null> {
    const folder = await this.deps.pickLocalFolder();
    return folder === undefined ? null : this.containerFolder(undefined, folder);
  }

  /** A folder of the SSH host via's folder browser, checked for a devcontainer configuration there. */
  async checkContainerFolder(via: string, folder: string): Promise<ContainerFolderPick> {
    this.sshRecord(via);
    if (!this.deps.connection(this.authorityOf(via))) return { ok: false, code: 'notConnected', folder };
    return this.containerFolder(via, folder);
  }

  private async containerFolder(via: string | undefined, folder: string): Promise<ContainerFolderPick> {
    const configPath = await this.deps.containerSide(via).config(folder);
    if (configPath === null) return { ok: false, code: 'noDevcontainerConfig', folder };
    const hostId = this.deps.store.containerHost(await this.devcontainerKeyOf(via, folder, configPath))?.id;
    return { ok: true, folder, configPath, prefillName: this.deps.store.uniqueName(devcontainerNameSource(folder, via)), ...(hostId !== undefined ? { hostId } : {}) };
  }

  // The key of a folder and its configuration by their folder keys where the CLI runs, so one folder however it is spelled
  // (a drive letter's case on Windows) is one record, as the CLI's own container labels make it one container.
  private async devcontainerKeyOf(via: string | undefined, folder: string, configPath: string): Promise<string> {
    const [folderKey, configKey] = await Promise.all([this.deps.cliFolderKey(via, folder), this.deps.cliFolderKey(via, configPath)]);
    return devcontainerKey(via, folderKey, configKey);
  }

  // A container's name made a host name: refused characters removed, and unique among the hosts and the rows listed before.
  private uniquePrefill(name: string, taken: Set<string>): string {
    let candidate = this.deps.store.uniqueName(name);
    for (let n = 2; taken.has(candidate.toLocaleLowerCase('en')); n++) candidate = this.deps.store.uniqueName(`${name} ${n}`);
    taken.add(candidate.toLocaleLowerCase('en'));
    return candidate;
  }

  // An attach from the list: the running container by its id, recorded under its name's key on its first attach.
  private async startAttach(containerId: string, via: string | undefined, user: 'configured' | 'root', name: string): Promise<ConnectStartResult> {
    if (via !== undefined) this.sshRecord(via);
    const listed = await this.listContainers(via);
    const row = listed.ok ? listed.containers.find((container) => container.id === containerId) : undefined;
    if (!listed.ok || !row) throw new Error('The engine lists no such running container');
    const existing = this.deps.store.containerHost(attachKey(via, row.name));
    if (existing) {
      // the container's record keeps its name; the user is this attach's choice, and a connection as another user ends, so the
      // user the card names is the one that runs
      const switched = existing.user !== user;
      await this.deps.store.setContainerUser(existing.id, user);
      // a connect before the ended attempt settled would join it and end cancelled
      if (switched && this.deps.connection(this.authorityOf(existing.id))) await this.deps.disconnect(existing.id);
      return { ok: true, attemptId: this.connectWatched(existing.id), hostId: existing.id };
    }
    const added = await this.deps.store.addContainerHost({ key: attachKey(via, row.name), ...(via !== undefined ? { via } : {}), engine: listed.engine, origin: 'attach', containerName: row.name, user }, name);
    if (!added.ok) return { ok: false, reason: 'name', check: added.check };
    this.hostsChanged();
    return { ok: true, attemptId: this.connectWatched(added.host.id), hostId: added.host.id };
  }

  // A folder with a devcontainer configuration: recorded under its key on the first build; once connected, its workspace folder
  // opens as the project and the dialog closes.
  private async startDevcontainer(folder: string, via: string | undefined, name: string): Promise<ConnectStartResult> {
    const record = await this.devcontainerHost(folder, via, name);
    if (!record.ok) return { ok: false, reason: 'name', check: record.check };
    const attemptId = this.connectWatched(record.host.id);
    void this.openWhenConnected(record.host.id, attemptId);
    return { ok: true, attemptId, hostId: record.host.id };
  }

  /**
   * The devcontainer record of a folder on this computer or the SSH host via, made under name on first use (a unique prefill
   * from the folder when name is absent). Throws for a folder without a configuration.
   */
  async devcontainerHost(folder: string, via: string | undefined, name?: string): Promise<{ readonly ok: true; readonly host: ContainerHostRecord } | { readonly ok: false; readonly check: NameCheck }> {
    if (via !== undefined) this.sshRecord(via);
    const picked = await this.containerFolder(via, folder);
    if (!picked.ok) throw new Error(`${folder} has no devcontainer configuration`);
    const key = await this.devcontainerKeyOf(via, folder, picked.configPath);
    const existing = this.deps.store.containerHost(key);
    if (existing) return { ok: true, host: existing };
    const added = await this.deps.store.addContainerHost({ key, ...(via !== undefined ? { via } : {}), engine: this.deps.containerEngine(), origin: 'devcontainer', workspaceFolder: folder, configPath: picked.configPath }, name ?? picked.prefillName);
    if (!added.ok) return { ok: false, check: added.check };
    this.hostsChanged();
    return { ok: true, host: added.host };
  }

  /**
   * Once the attempt connected, the devcontainer's workspace folder opens as its project and the Connect dialog showing the
   * host closes; resolves the project key. Undefined when the attempt failed (its timeline shows why) or the folder did not
   * open, which the attempt then shows as its folderFailure. A call while the attempt's opening runs joins it.
   */
  openWhenConnected(hostId: string, attemptId: string): Promise<string | undefined> {
    const joined = this.folderOpenings.get(attemptId);
    if (joined) return joined;
    const outcome = this.deps.connections.outcome(attemptId);
    if (!outcome) return Promise.resolve(undefined);
    const opening = this.openFolderOnce(hostId, attemptId, outcome).finally(() => this.folderOpenings.delete(attemptId));
    this.folderOpenings.set(attemptId, opening);
    return opening;
  }

  private async openFolderOnce(hostId: string, attemptId: string, outcome: Promise<void>): Promise<string | undefined> {
    try {
      await outcome;
    } catch {
      // the attempt shows its own failure in the timeline
      return undefined;
    }
    this.deps.connections.setFolderFailed(attemptId, false);
    let projectKey: string;
    try {
      projectKey = await this.deps.openContainerFolder(hostId);
    } catch (err) {
      this.deps.log(`[remote] ${hostId}: opening the container's folder failed: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.connections.setFolderFailed(attemptId, true);
      return undefined;
    }
    const dialog = this.dialog;
    if (dialog?.host === hostId) {
      dialog.opened = projectKey;
      dialog.withdraw.abort();
    }
    return projectKey;
  }

  // Each container record's state from its engine: running, stopped or missing; unknown while its SSH host is away.
  private async refreshContainers(): Promise<void> {
    await Promise.all(this.deps.store.hosts().filter((record): record is ContainerHostRecord => record.kind === 'container').map(async (record) => {
      const state = await this.inspectState(record).catch((err: unknown) => {
        this.deps.log(`[remote] inspecting the container of ${record.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        return 'unknown' as const;
      });
      this.containerStates.set(record.id, state);
    }));
  }

  private async inspectState(record: ContainerHostRecord): Promise<ContainerState> {
    if (record.via !== undefined && !this.deps.connection(this.authorityOf(record.via))) return 'unknown';
    if (record.containerId === undefined) return 'missing';
    const ran = await this.deps.containerSide(record.via).inspect(record.engine, [record.containerId]);
    if (ran.result === 'engineMissing') return 'unknown';
    if (ran.code !== 0) return 'missing';
    const found = parseInspect(ran.stdout).find((container) => container.id === record.containerId);
    return found === undefined ? 'missing' : found.running ? 'running' : 'stopped';
  }

  private containerInfo(record: ContainerHostRecord): ContainerHostInfo {
    const via = record.via === undefined ? undefined : this.deps.store.host(record.via);
    const connected = this.connectionOf(record.id) === 'connected';
    return {
      origin: record.origin,
      ...(record.image !== undefined ? { image: record.image } : {}),
      state: connected ? 'running' : (this.containerStates.get(record.id) ?? 'unknown'),
      ...(via ? { via: { hostId: via.id, name: via.name } } : {}),
      engine: record.engine,
      ...(record.workspaceFolder !== undefined ? { workspaceFolder: record.workspaceFolder } : {}),
      ...(record.configPath !== undefined ? { configPath: record.configPath } : {}),
      ...(record.containerName !== undefined ? { containerName: record.containerName } : {}),
      ...(record.user !== undefined ? { user: record.user } : {}),
      ...(record.withoutDataVolume ? { withoutDataVolume: true } : {}),
    };
  }

  private devcontainerRecord(hostId: string): ContainerHostRecord {
    const record = this.record(hostId);
    if (record.kind !== 'container' || record.origin !== 'devcontainer') throw new Error(`The host ${hostId} is no devcontainer`);
    return record;
  }

  private sshRecord(hostId: string): SshHostRecord {
    const record = this.record(hostId);
    if (record.kind !== 'ssh') throw new Error(`The host ${hostId} is no SSH host`);
    return record;
  }

  private wslRecord(hostId: string): Extract<HostRecord, { readonly kind: 'wsl' }> {
    const record = this.record(hostId);
    if (record.kind !== 'wsl') throw new Error(`The host ${hostId} is no WSL distro`);
    return record;
  }

  /**
   * Try again after daemonRunning: the same removal stage over a fresh ssh, which reaches the target without attaching or
   * starting a daemon; the stage decides by the daemon's lock again. A call while the host's removal runs joins it.
   */
  async retryRemoval(hostId: string): Promise<RemoveServerResult> {
    this.record(hostId);
    const joined = this.removals.get(hostId)?.running;
    if (joined) return joined;
    const pending = this.pendingRemovals.get(hostId);
    if (!pending) throw new Error('No removal of this host waits to be tried again');
    this.pendingRemovals.delete(hostId);
    return this.operate(this.removals, hostId, {}, async () => {
      const result = await runRemovalStage({ runStage: (stage) => this.deps.runRemovalStage(hostId, stage), log: this.deps.log }, pending.script);
      return this.removalEnded(hostId, pending, result);
    }, (_state, result) => ({ result }));
  }

  /** The host's setup and removal as the overlay shows them. */
  operations(hostId: string): HostOperations {
    this.record(hostId);
    return this.snapshotOf(hostId);
  }

  /** A Connect dialog or Settings closed: once neither shows, every run that ended goes, and a running one stays for the next. */
  dropUnshownRuns(): void {
    if (this.showsHosts()) return;
    for (const runs of [this.setups, this.removals, this.conversions, this.rebuilds] as const) for (const [hostId, run] of runs) if (!run.running) runs.delete(hostId);
  }

  // Starts the host's run, or joins the one running. Each change reaches the open overlay as the host's whole snapshot, the
  // run's end before its call answers.
  private operate<S extends { readonly failed?: true }, T>(
    runs: Map<string, OperationRun<S, T>>,
    hostId: string,
    initial: S,
    body: (update: (state: S) => void, run: OperationRun<S, T>) => Promise<T>,
    ended: (state: S, result: T) => S,
  ): Promise<T> {
    const joined = runs.get(hostId)?.running;
    if (joined) return joined;
    const run: OperationRun<S, T> = { state: initial, running: undefined };
    runs.set(hostId, run);
    // a run Forget host dropped shows nowhere
    const update = (state: S): void => {
      run.state = state;
      if (runs.get(hostId) === run) this.operationsChanged(hostId);
    };
    const settle = (state: S): void => {
      run.running = undefined;
      update(state);
      this.dropUnshownRuns();
    };
    this.operationsChanged(hostId);
    const running = body(update, run);
    run.running = running;
    void running.then((result) => settle(ended(run.state, result)), () => settle({ ...run.state, failed: true }));
    return running;
  }

  private showsHosts(): boolean {
    const overlay = this.deps.overlay();
    return overlay?.isOpen('connect') === true || overlay?.isOpen('settings') === true;
  }

  private operationsChanged(hostId: string): void {
    if (this.showsHosts()) this.deps.overlay()?.send(OVERLAY_CHANNELS.hostsOperationsChanged, this.snapshotOf(hostId));
  }

  private snapshotOf(hostId: string): HostOperations {
    const passwordless = this.setups.get(hostId)?.state;
    const removal = this.removals.get(hostId);
    const conversion = this.conversions.get(hostId)?.state;
    const rebuild = this.rebuilds.get(hostId)?.state;
    const prompt = removal?.running ? this.removalPrompt(hostId) : undefined;
    this.revision += 1;
    return {
      hostId,
      revision: this.revision,
      ...(passwordless ? { passwordless } : {}),
      ...(removal ? { removal: { ...removal.state, ...(prompt ? { prompt } : {}) } } : {}),
      ...(conversion ? { conversion } : {}),
      ...(rebuild ? { rebuild } : {}),
    };
  }

  // The secret the running removal stage's ssh waits on, which the host's attempt holds, within the overlay's bounds.
  private removalPrompt(hostId: string): ServerRemovalRun['prompt'] {
    const attempt = this.deps.connections.attempt(hostId);
    const step = attempt && parseConnectStep(attempt);
    return step?.prompt?.kind === 'secret' ? { attemptId: step.attemptId, ...step.prompt } : undefined;
  }

  // Damocles' master connection ends whatever the outcome, so no session stays signed in with a key the removal took away.
  // The host store forgets what the stage undid; a stage that refused with daemonRunning stays ready to be tried again.
  private async removalEnded(hostId: string, removal: { readonly script: string | undefined; readonly key: boolean; readonly disableLinger: boolean }, result: RemoveServerResult): Promise<RemoveServerResult> {
    await this.deps.exitControlMaster(hostId);
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
   * running. An SSH host's containers go first, the same way, since none connects without it. Every step runs after a failed
   * one; a failure keeps the records, so the host still shows and Forget host run again removes what is left.
   */
  async forget(hostId: string): Promise<void> {
    this.record(hostId);
    const failures: unknown[] = [];
    for (const id of [...this.deps.store.containersVia(hostId).map((container) => container.id), hostId]) failures.push(...(await this.forgetLocally(id)));
    if (failures.length > 0) throw failures[0];
    // one write drops the host's record and its containers'
    await this.deps.store.forgetHost(hostId);
    this.deps.log(`[remote] forgot the host ${hostId}`);
  }

  // Everything of the host but its store record: its runs, attempt, connection, remembered answers and local data; the
  // failures of the steps, each run whatever an earlier one did.
  private async forgetLocally(hostId: string): Promise<unknown[]> {
    this.pendingRemovals.delete(hostId);
    this.setups.delete(hostId);
    this.removals.delete(hostId);
    this.conversions.delete(hostId);
    this.rebuilds.delete(hostId);
    this.containerStates.delete(hostId);
    const failures: unknown[] = [];
    for (const step of [() => this.deps.disconnect(hostId), () => this.deps.connections.forget(hostId), () => this.deps.deleteRememberedSecrets(hostId), () => this.deps.forgetLocalData(hostId)]) {
      try {
        await step();
      } catch (err) {
        this.deps.log(`[remote] forgetting the host ${hostId}: ${err instanceof Error ? err.message : String(err)}`);
        failures.push(err);
      }
    }
    return failures;
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
      const record = this.record(target.hostId);
      const attemptId = this.connectWatched(target.hostId);
      if (record.kind === 'container' && record.origin === 'devcontainer') void this.openWhenConnected(target.hostId, attemptId);
      return { ok: true, attemptId, hostId: target.hostId };
    }
    if ('distro' in target) return this.startDistro(target.distro, target.name);
    if ('attach' in target) return this.startAttach(target.attach, target.via, target.user, target.name);
    if ('devcontainer' in target) return this.startDevcontainer(target.devcontainer, target.via, target.name);
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

  // A distro's first connect records it under the name; a distro with a record connects as that host. Only a distro wsl.exe
  // lists now is taken.
  private async startDistro(distro: string, name: string): Promise<ConnectStartResult> {
    if (!(await this.refreshDistros()).some((listed) => listed.distro === distro)) throw new Error('wsl.exe lists no such distro');
    const existing = this.deps.store.wslHost(distro);
    if (existing) return { ok: true, attemptId: this.connectWatched(existing.id), hostId: existing.id };
    const added = await this.deps.store.addWslHost(distro, name);
    if (!added.ok) return { ok: false, reason: 'name', check: added.check };
    this.hostsChanged();
    return { ok: true, attemptId: this.connectWatched(added.host.id), hostId: added.host.id };
  }

  /**
   * A distro's host, recorded under its distro name (made unique) on its first connect: the same record the Connect dialog
   * makes, for Reopen in WSL. Only a distro wsl.exe lists now is taken, found regardless of case as Windows resolves a
   * \\wsl.localhost name, and recorded under the list's spelling.
   */
  async distroHost(name: string): Promise<HostRecord | undefined> {
    const listed = await this.refreshDistros();
    const distro = (listed.find((each) => each.distro === name) ?? listed.find((each) => each.distro.toLowerCase() === name.toLowerCase()))?.distro;
    if (distro === undefined) return undefined;
    const existing = this.deps.store.wslHost(distro);
    if (existing) return existing;
    const added = await this.deps.store.addWslHost(distro, this.deps.store.uniqueName(distro));
    if (!added.ok) throw new Error(`The distro ${distro} could not be named: ${added.check.ok ? '' : added.check.reason}`);
    this.hostsChanged();
    return added.host;
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
    const hostId = this.deps.store.hostIdOf(authority) ?? authority;
    const start = await this.startOf(authority, workspace, roots, options.defaultPath);
    const pick: OpenPick = { hostId, authority, mode, roots, start, extensions: mode === 'file' ? options.extensions : undefined };
    const title = shownLabel(options.title);
    const buttonLabel = shownLabel(options.buttonLabel);
    const request = parseConnectRequest({
      kind: 'connect',
      hostId,
      hosts: [],
      distros: [],
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
    // the picker replaces an open Connect dialog, whose pushes and folder opening go with it
    this.dialog = undefined;
    try {
      const answer = await overlay.request(request);
      return answer.kind === 'connect' ? await this.picked(pick, answer.path) : undefined;
    } finally {
      if (this.picking === pick) this.picking = undefined;
      this.dropUnshownRuns();
    }
  }

  async browse(hostId: string, folder: string | undefined): Promise<RemoteBrowseResult> {
    const pick = this.picking;
    if (pick?.hostId === hostId) return this.browsePick(pick, folder);
    this.record(hostId);
    const authority = this.authorityOf(hostId);
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
    const authorityKey = this.authorityOf(hostId);
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
    await this.deps.terminals.open(this.authorityOf(hostId), runId);
  }

  async killRun(hostId: string, runId: string): Promise<void> {
    const record = this.record(hostId);
    const connection = this.deps.connection(this.authorityOf(hostId));
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
    const connection = this.deps.connection(this.authorityOf(hostId));
    if (!connection) throw new Error(`${this.deps.hostName(this.authorityOf(hostId))} is not connected`);
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
    const dialog = this.dialog;
    if (!dialog) return attemptId;
    dialog.host = hostId;
    dialog.attemptId = attemptId;
    // connect told the attempt before the dialog was bound to it; the dialog reads this step when the start answers
    const overlay = this.deps.overlay();
    if (overlay?.isOpen('connect')) this.sendStep(overlay, dialog, hostId);
    return attemptId;
  }

  private record(hostId: string): HostRecord {
    const record = this.deps.store.host(hostId);
    if (!record) throw new Error(`No saved host ${hostId}`);
    return record;
  }

  // the handshake's skew, only once it passes the warning bound
  private skew(hostId: string): number | undefined {
    const skew = this.deps.connection(this.authorityOf(hostId))?.skewMs;
    return skew !== undefined && Math.abs(skew) > CLOCK_SKEW_WARN_MS ? Math.round(skew) : undefined;
  }

  private card(record: HostRecord): HostCardInfo {
    const os = hostOs(record);
    const skew = this.skew(record.id);
    const connection = this.connectionOf(record.id);
    const failure = connection === 'failed' ? this.deps.connections.failure(record.id) : undefined;
    const connectionNotices = [this.deps.watchLimit(this.authorityOf(record.id)), this.deps.sharedHome(this.authorityOf(record.id))].filter((notice) => notice !== undefined);
    const ssh = record.kind === 'ssh' ? record : undefined;
    const listed = record.kind === 'wsl' ? this.distros.find((distro) => distro.distro === record.distro) : undefined;
    return {
      hostId: record.id,
      kind: record.kind,
      ...(listed ? { wsl: { distro: listed.distro, version: listed.version, state: listed.state, isDefault: listed.isDefault } } : {}),
      ...(record.kind === 'container' ? { container: this.containerInfo(record) } : {}),
      name: record.name,
      ...(record.color !== undefined ? { color: record.color } : {}),
      destinationLabel: labelOf(record),
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
      ...(canForwardAgent(record) ? { agentForwarding: forwardsAgent(record) } : {}),
      passwordless: ssh?.identityFile !== undefined,
      keyInstalledByDamocles: ssh?.installedKeyFingerprint !== undefined,
      lingerEnabledByDamocles: ssh?.lingerEnabledByDamocles === true,
    };
  }

  // the devices attached to the host's daemon while connected, this one first, within the card's bounds
  private devices(hostId: string): { devices?: HostDevice[] } {
    const attached = this.deps.connection(this.authorityOf(hostId))?.devices() ?? [];
    if (attached.length === 0) return {};
    const ordered = [...attached.filter((device) => device.self), ...attached.filter((device) => !device.self)];
    return { devices: ordered.slice(0, MAX_HOST_DEVICES).map((device) => ({ deviceName: [...device.deviceName].slice(0, MAX_DEVICE_NAME_LENGTH).join(''), self: device.self })) };
  }

  private update(hostId: string): { update?: HostUpdate } {
    const update = this.deps.update(this.authorityOf(hostId));
    return update !== undefined ? { update } : {};
  }

  // the reconnect phase and latency a host's dot, banner and card show
  private quality(hostId: string): { reconnect?: HostReconnect; latency?: HostLatency } {
    const authority = this.authorityOf(hostId);
    const reconnect = this.deps.reconnect(authority);
    const latency = this.deps.latency(authority);
    return { ...(reconnect ? { reconnect } : {}), ...(latency ? { latency } : {}) };
  }
}

/** A host card's and Settings' destination: the ssh alias or address, the distro's name, or a container's engine and image. */
function labelOf(record: HostRecord): string {
  if (record.kind === 'container') return record.image !== undefined ? `${record.engine} · ${record.image}` : (record.containerName ?? record.configPath ?? record.engine);
  return record.kind === 'wsl' ? record.distro : destinationLabel(record.destination);
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
