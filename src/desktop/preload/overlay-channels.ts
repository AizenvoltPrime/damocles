// Shared by the overlay preload, main and (as types only) the shell and overlay apps. The overlay view and the desktop
// popup window's page both run the overlay preload; main listens on each one's own webContents.ipc, which only that page's
// messages reach, and answers the popup page only on getState and the toast channels.

import type { ChatsContinueWorktree, ChatsWorktreeOptions, DropZonesPointer, GridPane, GridSlot, NewChatWorktree, ProjectConnection, ShellGridLayout, ShellLocale, ShellPlatform } from './shell-channels';
import type { SettingsAccountId, SettingsSectionId, SettingsTarget } from '../../shared/settings-sections';
import type { DesktopLanguageSetting } from '../local-services/desktop-configuration';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/types/messages';
import type { ChimeTone, NotificationBody, NotificationCenterState, ToastAnswer } from './notifications';
import type { ReleaseIndex, ReleaseNotes, UpdateSnapshot, VersionInfo } from './updates';
import type { ScmLetter } from './scm-channels';
import type { HostLatency, HostReconnect } from '../../shared/host-connection';
import type { HostColor } from '../../shared/host-colors';
import type { PermissionMode } from '../../shared/types/settings';
import type { TerminalColor, TerminalGlyph, TerminalPickShells, TerminalProfileReport, TerminalProjectOption } from './terminal-channels';
import { INPUT_VALIDATIONS, MAX_INPUT_VALUE_LENGTH, inputProblem, type InputPlatform, type InputValidation } from '../../shared/input-validation';
import { visibleText } from '../../shared/visible-text';
import { MAX_HELD_MEMORY_QUEUES, type HeldMemoryQueue } from '../../shared/remote-user';
import type { ContainerEngine } from '../daemon/container-values';

export const OVERLAY_CHANNELS = {
  // renderer → main, invoke
  getState: 'damocles:overlay:get-state',
  // renderer → main, send
  ack: 'damocles:overlay:ack',
  shown: 'damocles:overlay:shown',
  answer: 'damocles:overlay:answer',
  resolveToast: 'damocles:overlay:resolve-toast',
  // (id): Copy on a link request's toast; main copies the URL it holds, and the toast stays
  toastCopy: 'damocles:overlay:toast-copy',
  toastArea: 'damocles:overlay:toast-area',
  // Escape in the toast stack: keyboard focus goes back to the part F6 took it from
  toastsLeave: 'damocles:overlay:toasts:leave',
  // (id, held): the pointer or keyboard focus is on a toast, whose life main pauses until released
  toastHold: 'damocles:overlay:toast-hold',
  // boolean: the pointer is over a toast or the "N more" pill, so the popup window takes it
  toastsPointer: 'damocles:overlay:toasts:pointer',
  // { generation, message }: a settings view request for the chat the modal is attached to
  settingsSend: 'damocles:overlay:settings:send',
  // renderer → main, invoke { scope }: a remote chat's settings tab chosen; answers closed unless the settings modal is open
  settingsScope: 'damocles:overlay:settings:scope',
  // renderer → main, invoke { anchor }: the host or Project tab asks to allow YOLO on the attached tab's host; answers whether
  // it is allowed, and closed unless the settings modal is open
  settingsAllowYolo: 'damocles:overlay:settings:allow-yolo',
  // renderer → main, invoke {}: the Sign in of a tab whose host waits for one; main ends the modal and opens the Connect
  // dialog on that host's prompt; answers closed unless the settings modal is open
  settingsSignIn: 'damocles:overlay:settings:sign-in',
  // (id, png: Uint8Array | null): the answer to a rasterize request; main validates the PNG before using it
  rasterized: 'damocles:overlay:rasterized',
  // renderer → main, invoke
  prefsGet: 'damocles:overlay:prefs:get',
  prefsSet: 'damocles:overlay:prefs:set',
  relaunch: 'damocles:overlay:app:relaunch',
  layoutReset: 'damocles:overlay:layout:reset',
  // the notification center; each answers closed unless the center is open
  notificationsGet: 'damocles:overlay:notifications:get',
  notificationsClear: 'damocles:overlay:notifications:clear',
  // boolean: Do not disturb on or off
  notificationsDnd: 'damocles:overlay:notifications:dnd',
  // Settings › About; each answers closed unless the settings modal is open
  updateGet: 'damocles:overlay:update:get',
  // a check from About, which posts no notice: the version card shows its result
  updateCheck: 'damocles:overlay:update:check',
  updateRestart: 'damocles:overlay:update:restart',
  updateShowLog: 'damocles:overlay:update:show-log',
  updateCopyInfo: 'damocles:overlay:update:copy-info',
  updateVersionInfo: 'damocles:overlay:update:version-info',
  // macOS, while an update is available
  updateOpenReleasePage: 'damocles:overlay:update:open-release-page',
  releaseNotesIndex: 'damocles:overlay:release-notes:index',
  // { version }: a version of the index
  releaseNotesGet: 'damocles:overlay:release-notes:get',
  // QuickOpenQuery → QuickOpenResponse; answers closed unless a quickOpen request is open
  quickOpenQuery: 'damocles:overlay:quick-open:query',
  // { generation } → QuickOpenResponse | null, the typed path's row of a response with pathPending, null for none; answers
  // closed unless a quickOpen request is open
  quickOpenPath: 'damocles:overlay:quick-open:path',
  // {} → PaletteCommand[] for the focus context main captured when the quickOpen request opened; answers closed unless one is open
  commandsList: 'damocles:overlay:commands:list',
  // {} → TerminalProfileReport for Settings › Terminal; answers closed unless the settings modal is open
  terminalProfiles: 'damocles:overlay:terminal:profiles',
  // exactly { projectKey } → TerminalPickShells: the project's host's shells once detected, its default first, or notConnected
  // for a host gone since the pick opened; projectKey one the open newTerminal request offers, null for the home folder;
  // answers closed unless a newTerminal request is open
  terminalPickProfiles: 'damocles:overlay:terminal:pick-profiles',
  // { value } → InputBrowseResult | null; answers closed unless an input request is open, null unless it has browse
  inputBrowse: 'damocles:overlay:input:browse',
  // {} → ChatsWorktreeOptions for the open newChatMenu request's project; answers closed unless one is open
  worktreeOptions: 'damocles:overlay:worktree-options',
  // {} → readonly ChatsContinueWorktree[], every live chat worktree of the open newChatMenu request's project that a new chat
  // can continue in, most recently used first; empty when untrusted; answers closed unless one is open
  continueWorktrees: 'damocles:overlay:continue-worktrees',
  // {} → { message } | null from the Background model (D24) for the open mergeMessage dialog's worktree; answers closed unless
  // one is open, and null when no message came (main told the user why)
  worktreeGenerateMessage: 'damocles:overlay:worktree:generate-message',
  // The Connect dialog and its host cards; each answers closed unless a connect request is open, and check-name, rename,
  // connect answer, browse, show-log and set-install-folder also while a settings request is open.
  // { name, hostId? } → NameCheck, the host store's own validator; hostId: the host being renamed, whose own name never clashes
  hostsCheckName: 'damocles:overlay:hosts:check-name',
  // { hostId, name } → NameCheck; saved only when it passes
  hostsRename: 'damocles:overlay:hosts:rename',
  // { input } → HostParseResult: "+ New host"'s user@host[:port] or pasted ssh command against the allowlist
  hostsParse: 'damocles:overlay:hosts:parse',
  // ConnectStartRequest → ConnectStartResult; progress follows on connectStep
  connectStart: 'damocles:overlay:connect:start',
  // { attemptId, promptId, answer: string | null }: a host key 'connect' or 'cancel', a secret, or null to cancel the prompt
  connectAnswer: 'damocles:overlay:connect:answer',
  // { attemptId }: Escape or Cancel during an attempt; ends its ssh
  connectCancel: 'damocles:overlay:connect:cancel',
  // { hostId, path?: string } → RemoteBrowseResult of a connected host; no path: the host's home
  connectBrowse: 'damocles:overlay:connect:browse',
  // { hostId, path } → { projectKey }: adds the folder as a project (asking trust) or selects the project it already is
  connectPickFolder: 'damocles:overlay:connect:pick-folder',
  // { hostId } → readonly HostRun[], the host's running terminals from its daemon
  hostsRuns: 'damocles:overlay:hosts:runs',
  // { hostId, runId }: ends that terminal on the host
  hostsKillRun: 'damocles:overlay:hosts:kill-run',
  // { hostId, runId }: that terminal gets a tab in this window's terminal panel, active and focused, and this computer keeps
  // showing it; its other viewers keep theirs
  hostsOpenRun: 'damocles:overlay:hosts:open-run',
  // { hostId }: opens the host's daemon log and its last bridge stderr as read-only tabs
  hostsShowLog: 'damocles:overlay:hosts:show-log',
  // { hostId, folder: string | null } → InstallFolderResult; null goes back to ~/.damocles/server
  hostsSetInstallFolder: 'damocles:overlay:hosts:set-install-folder',
  // { hostId }: writes the host's hostKeyChanged failure's params.command (ssh-keygen -R with the name quoted for any shell)
  // to the clipboard
  hostsCopyHostKeyCommand: 'damocles:overlay:hosts:copy-host-key-command',
  // { hostId } → LingerResult: loginctl enable-linger for the host's own user; answers closed unless a connect or closeRemote
  // request is open
  hostsAllowBackground: 'damocles:overlay:hosts:allow-background',
  // Settings > Remote hosts and the host card's actions; each answers closed unless a connect or settings request is open
  // {} -> readonly RemoteHostEntry[]
  hostsList: 'damocles:overlay:hosts:list',
  // { hostId, change: HostSettingChange }
  hostsSetSetting: 'damocles:overlay:hosts:set-setting',
  // { hostId, credentialHost }
  hostsRevokeCredential: 'damocles:overlay:hosts:revoke-credential',
  // { hostId, queueId } -> HeldMemoryResult: the held queue goes to this computer's device on the host, which it then drains
  hostsDeliverHeldMemory: 'damocles:overlay:hosts:deliver-held-memory',
  // { hostId, queueId } -> HeldMemoryResult: the held queue is deleted; the overlay confirmed first
  hostsDiscardHeldMemory: 'damocles:overlay:hosts:discard-held-memory',
  // { hostId } -> PasswordlessResult; a call while the host's setup runs joins it; progress follows on hostsOperationsChanged
  hostsSetUpPasswordless: 'damocles:overlay:hosts:set-up-passwordless',
  // { hostId } -> RemovalInfo of a connected host
  hostsRemovalInfo: 'damocles:overlay:hosts:removal-info',
  // { hostId, options: RemoveServerOptions } -> RemoveServerResult; this and hostsRetryRemoval join the host's removal while
  // one runs, and its progress follows on hostsOperationsChanged
  hostsRemoveServer: 'damocles:overlay:hosts:remove-server',
  // { hostId } -> RemoveServerResult: the removal stage that refused with daemonRunning, run again over ssh alone
  hostsRetryRemoval: 'damocles:overlay:hosts:retry-removal',
  // { hostId } -> HostOperations, the host's setup and removal as main holds them now
  hostsOperations: 'damocles:overlay:hosts:operations',
  // { hostId } -> { runs: readonly RemovalRun[] }: the running work Convert to WSL 2 would stop, from a connected distro's daemon
  hostsConversionInfo: 'damocles:overlay:hosts:conversion-info',
  // { hostId } -> void: starts Convert to WSL 2 for a WSL 1 distro's host, or joins the one running; progress follows on
  // hostsOperationsChanged
  hostsConvertToWsl2: 'damocles:overlay:hosts:convert-to-wsl2',
  // { hostId } -> { runs: readonly RemovalRun[] }: the chats and terminals Rebuild Container stops; empty when not connected
  hostsRebuildInfo: 'damocles:overlay:hosts:rebuild-info',
  // { hostId } -> void: starts Rebuild Container for a devcontainer record, or joins the one running; progress follows on
  // hostsOperationsChanged
  hostsRebuildContainer: 'damocles:overlay:hosts:rebuild-container',
  // { via?: hostId } -> ContainerListResult: the running containers on this computer or on the SSH host; connect request only
  containersList: 'damocles:overlay:containers:list',
  // {} -> ContainerFolderPick | null: this computer's folder picker for a folder with a devcontainer configuration; null on
  // cancel; connect request only
  containersPickFolder: 'damocles:overlay:containers:pick-folder',
  // { via: hostId, folder } -> ContainerFolderPick: a folder of the SSH host's folder browser; connect request only
  containersCheckFolder: 'damocles:overlay:containers:check-folder',
  // { hostId }: forgets the host and everything this computer keeps of it
  hostsForget: 'damocles:overlay:hosts:forget',
  // { hostId }: ends the connect request and opens Settings > Remote hosts at the host; answers while a connect request is open
  hostsOpenSettings: 'damocles:overlay:hosts:open-settings',
  // main → renderer
  // OverlayState after the UI language changed
  state: 'damocles:overlay:state',
  request: 'damocles:overlay:request',
  cancel: 'damocles:overlay:cancel',
  toast: 'damocles:overlay:toast',
  toastDismiss: 'damocles:overlay:toast-dismiss',
  // main → renderer: F6 moved keyboard focus to the popup window, whose page focuses the newest toast
  toastsFocus: 'damocles:overlay:toasts:focus',
  // main → renderer, PanelTheme; the preload applies it to the page itself
  theme: 'damocles:overlay:theme',
  // main → renderer, ExtensionToWebviewMessage for the settings modal
  settingsMessage: 'damocles:overlay:settings:message',
  // main → renderer, OverlaySettingsAttached: the modal is attached to another panel now, which may show the same page
  settingsAttached: 'damocles:overlay:settings:attached',
  // main -> renderer, OverlaySettingsScopes['host']: the attached remote chat's host was renamed or recolored while the modal shows
  settingsScopeHost: 'damocles:overlay:settings:scope-host',
  // main -> renderer, OverlaySettingsAwayState | null: the host or Project tab shown waits for its host's core; null once it attached
  settingsAway: 'damocles:overlay:settings:away',
  // main → renderer, SettingsTarget: settings were asked for again while the modal shows
  settingsTarget: 'damocles:overlay:settings:target',
  // main → renderer, OverlayPrefs after a damocles.desktop.* setting changed while the modal shows
  prefsChanged: 'damocles:overlay:prefs:changed',
  // main → renderer, TerminalProfileReport after the profiles were validated again while the modal shows
  terminalProfilesChanged: 'damocles:overlay:terminal:profiles-changed',
  // main → renderer, NotificationCenterState after a change while the center is open
  notificationsState: 'damocles:overlay:notifications:state',
  // main → renderer, OverlayRasterRequest: draw main's art on a canvas and answer with its PNG
  rasterize: 'damocles:overlay:rasterize',
  // main → renderer, ChimeTone: the popup page plays the sound of a popup that just arrived
  chime: 'damocles:overlay:chime',
  // main → renderer, UpdateSnapshot after each update state change while the settings modal is open
  updateState: 'damocles:overlay:update:state',
  // main → renderer, DropZonesPointer from the shell's pane drag while a dropZones request is open
  dropZonesPointer: 'damocles:overlay:drop-zones:pointer',
  // main → renderer, ConnectStepEvent: an attempt's state after each change, while a connect request is open
  connectStep: 'damocles:overlay:connect:step',
  // main -> renderer, readonly RemoteHostEntry[] after any host change while a connect or settings request is open
  hostsEntries: 'damocles:overlay:hosts:entries',
  // main -> renderer, HostOperations after each change of the host's setup or removal, while a connect or settings request is open
  hostsOperationsChanged: 'damocles:overlay:hosts:operations-changed',
  // main → renderer, readonly HostCardInfo[] after a host changed (renamed, connected, dropped) while a connect request is open
  connectHosts: 'damocles:overlay:connect:hosts',
  // main -> renderer, readonly WslDistroInfo[] whenever connectHosts is pushed, while a connect request is open
  connectDistros: 'damocles:overlay:connect:distros',
  // main → renderer, readonly CloseRemoteRow[], every row whole, after a status or token note changed while a closeRemote
  // request is open
  closeRemoteRows: 'damocles:overlay:close-remote:rows',
} as const;

export interface OverlayRequestPush {
  // the kinds of open request the push is addressed to
  readonly kinds: readonly OverlayRequest['kind'][];
  // each push carries the whole state, so of those held only the newest is sent
  readonly latest: boolean;
}

/**
 * Every main → renderer push addressed to an open request. Its popup subscribes only once it renders, so main holds them per
 * request until the page reports it shown; every other main → renderer channel is the page's own.
 */
export const OVERLAY_REQUEST_PUSHES: ReadonlyMap<string, OverlayRequestPush> = new Map([
  [OVERLAY_CHANNELS.settingsMessage, { kinds: ['settings'], latest: false }],
  [OVERLAY_CHANNELS.settingsAttached, { kinds: ['settings'], latest: false }],
  [OVERLAY_CHANNELS.settingsScopeHost, { kinds: ['settings'], latest: true }],
  [OVERLAY_CHANNELS.settingsAway, { kinds: ['settings'], latest: true }],
  [OVERLAY_CHANNELS.settingsTarget, { kinds: ['settings'], latest: true }],
  [OVERLAY_CHANNELS.prefsChanged, { kinds: ['settings'], latest: true }],
  [OVERLAY_CHANNELS.terminalProfilesChanged, { kinds: ['settings'], latest: true }],
  [OVERLAY_CHANNELS.updateState, { kinds: ['settings'], latest: true }],
  [OVERLAY_CHANNELS.notificationsState, { kinds: ['notifications'], latest: true }],
  [OVERLAY_CHANNELS.dropZonesPointer, { kinds: ['dropZones'], latest: true }],
  [OVERLAY_CHANNELS.connectStep, { kinds: ['connect'], latest: false }],
  [OVERLAY_CHANNELS.connectHosts, { kinds: ['connect'], latest: true }],
  [OVERLAY_CHANNELS.connectDistros, { kinds: ['connect'], latest: true }],
  [OVERLAY_CHANNELS.hostsEntries, { kinds: ['connect', 'settings'], latest: true }],
  [OVERLAY_CHANNELS.hostsOperationsChanged, { kinds: ['connect', 'settings'], latest: false }],
  [OVERLAY_CHANNELS.closeRemoteRows, { kinds: ['closeRemote'], latest: true }],
]);

// The steps of a connection attempt, in the order they run; an attempt may skip installing. building runs only for a container
// attempt that runs `devcontainer up`.
export const CONNECT_STEPS = ['building', 'connecting', 'authenticating', 'checking', 'installing', 'starting'] as const;
export type ConnectStep = (typeof CONNECT_STEPS)[number];

// Why an attempt failed; the overlay localizes remote.failure.<code> with its params.
export const SSH_FAILURE_CODES = [
  'hostKeyChanged', 'hostKeyRefused', 'permissionDenied', 'unresolved', 'refused', 'timedOut', 'unreachable', 'cancelled',
  'unsupportedOs', 'glibcTooOld', 'glibcxxMissing', 'kernelTooOld', 'macosTooOld', 'windowsBuildTooOld', 'nixLdMissing',
  'noexec', 'lowSpace', 'installFolderInvalid', 'installFolderUnsafe', 'hashMismatch', 'downloadAndUploadFailed', 'selfTestFailed', 'bridgeFailed',
  // the host's saved address holds something the parser's rules now refuse (params.setting); ssh did not start
  'destinationRefused', 'unknown',
  // a container attempt: folderUntrusted and configRefused ran nothing; composeUnsupported: a dockerComposeFile configuration,
  // whose Compose files the confirmation cannot show; devcontainerFailed {message}: the CLI's own text; containerNeedsBuild: the
  // devcontainer is stopped or gone and nobody watched the attempt, which only a watched one builds; containerPaused {container,
  // engine}: the engine's name of the paused container and the engine that unpauses it
  'folderUntrusted', 'configRefused', 'composeUnsupported', 'noDevcontainerConfig', 'containerEngineMissing', 'devcontainerFailed',
  'containerNotRunning', 'viaNotConnected', 'containerFeatureMissing', 'containerNeedsBuild', 'containerPaused',
  // a WSL attempt: wsl.exe no longer lists the record's distro {distro}
  'distroNotListed',
] as const;
export type SshFailureCode = (typeof SSH_FAILURE_CODES)[number];
// handshakeFailed: the bridge ran but hello, welcome or attach did not complete (params.reason); containerFolderFailed, only as
// a ConnectStepEvent's folderFailure: a devcontainer connected but its workspace folder did not open as a project (no params)
export type ConnectFailureCode = SshFailureCode | 'handshakeFailed' | 'containerFolderFailed';

// Text produced on a target or by main for one: a code plus parameters the overlay localizes (remote.notice.<code>).
export interface HostNotice {
  readonly code: string;
  readonly params: Readonly<Record<string, string | number>>;
}

// a sharedHome notice's hosts param joins the other machines' hostnames, which OTHER_HOSTNAME keeps free of line breaks
export const SHARED_HOME_SEPARATOR = '\n';

export interface ConnectFailure {
  readonly code: ConnectFailureCode;
  readonly params: Readonly<Record<string, string | number>>;
}

// What ssh asks during an attempt: a host key to accept (answered 'connect' or 'cancel') or a secret (answered with its text).
export type SshPrompt =
  | { readonly kind: 'hostKey'; readonly host: string; readonly keyType: string; readonly fingerprint: string }
  // secretKind names the field only, which is masked for every kind; offerRemember: the host's Remember password setting is
  // on and the prompt binds to exactly one hop
  | { readonly kind: 'secret'; readonly secretKind: 'password' | 'passphrase' | 'pin' | 'otp' | 'other'; readonly text: string; readonly offerRemember?: true };

// The user's answer to an SshPrompt; remember is true only when the prompt offered it and the user checked it.
export interface SshPromptAnswer {
  readonly answer: string;
  readonly remember: boolean;
}

// A target's OS as platform detection found it once, with the shell Win32-OpenSSH runs commands in.
export interface CachedPlatform {
  readonly os: ShellPlatform;
  readonly windowsShell?: 'cmd' | 'powershell';
}

// An attempt as the timeline shows it, sent whole after every change.
export interface ConnectStepEvent {
  readonly attemptId: string;
  readonly hostId: string;
  // a wsl or container attempt never enters 'authenticating' and never carries a prompt
  readonly transport: 'ssh' | 'wsl' | 'container';
  readonly step: ConnectStep | 'connected' | 'failed';
  // the steps this attempt has entered, in order
  readonly visited: readonly ConnectStep[];
  // 0..1 while installing downloads or uploads
  readonly progress?: number;
  // the question ssh waits on; answer it through connectAnswer with promptId
  readonly prompt?: { readonly promptId: string } & SshPrompt;
  readonly failure?: ConnectFailure;
  // a devcontainer's connected attempt (step 'connected') whose workspace folder did not open; a start of it again retries
  readonly folderFailure?: { readonly code: 'containerFolderFailed'; readonly params: Readonly<Record<string, never>> };
  // the probe's non-fatal findings
  readonly notices: readonly HostNotice[];
  // a container attempt that ran `devcontainer up`: the text of its log lines, newest last
  readonly buildLog?: BuildLog;
}

// Lines of a build log an attempt or a Rebuild keeps, newest last; total counts every line seen, so total - lines.length
// earlier lines were dropped. Each line is one line of text with no control characters.
export interface BuildLog {
  readonly lines: readonly string[];
  readonly total: number;
}
export const MAX_BUILD_LOG_LINES = 1000;
export const MAX_BUILD_LOG_LINE_CHARS = 2000;

export type { ContainerEngine };
export type ContainerState = 'running' | 'stopped' | 'missing' | 'unknown';

// A container record as its card and Settings show it; via names the SSH host the container runs on.
export interface ContainerHostInfo {
  readonly origin: 'devcontainer' | 'attach';
  readonly image?: string;
  readonly state: ContainerState;
  readonly via?: { readonly hostId: string; readonly name: string };
  readonly engine: ContainerEngine;
  // devcontainer: the workspace folder and config file as the machine running the CLI names them
  readonly workspaceFolder?: string;
  readonly configPath?: string;
  // attach: the container's name and the user Damocles runs as
  readonly containerName?: string;
  readonly user?: 'configured' | 'root';
  // devcontainer: the running container has no damocles-data volume, so ~/.damocles lives in it and a rebuild loses its chats and settings
  readonly withoutDataVolume?: true;
}

// A WSL distro as `wsl.exe --list --verbose` lists it; docker-desktop* distros are never listed.
export interface WslDistroInfo {
  readonly distro: string;
  readonly state: 'running' | 'stopped' | 'other';
  readonly version: 1 | 2;
  readonly isDefault: boolean;
  // present once the distro has a host record
  readonly hostId?: string;
}

// A saved host as the Connect dialog's card shows it; names and labels come from this computer's host store.
export interface HostCardInfo {
  readonly hostId: string;
  readonly kind: 'ssh' | 'wsl' | 'container';
  readonly container?: ContainerHostInfo;
  readonly name: string;
  readonly color?: HostColor;
  // the ssh alias, or user@host:port; a distro's name for a WSL host
  readonly destinationLabel: string;
  // a WSL host's distro as the last list showed it
  readonly wsl?: { readonly distro: string; readonly version: 1 | 2; readonly state: WslDistroInfo['state']; readonly isDefault: boolean };
  readonly os?: ShellPlatform;
  readonly connection: ProjectConnection;
  // an attempt waits on a prompt the user has not seen yet
  readonly signInNeeded: boolean;
  // epoch ms
  readonly lastUsed?: number;
  // native to the host, most recent first
  readonly recentFolders: readonly string[];
  // folders of the host that are projects now, native to the host
  readonly projectFolders: readonly string[];
  readonly notices: readonly HostNotice[];
  // the last attempt's failure while it is the host's state
  readonly failure?: ConnectFailure;
  // the handshake's measured skew, present only past CLOCK_SKEW_WARN_MS
  readonly clockSkewMs?: number;
  // the host's install folder setting; absent: ~/.damocles/server
  readonly installFolder?: string;
  // the reconnect loop's phase while the host is away
  readonly reconnect?: HostReconnect;
  // the latest round trip and the last ten, which the card's sparkline draws
  readonly latency?: HostLatency;
  // the devices attached to the host's daemon, this one included, while connected
  readonly devices?: readonly HostDevice[];
  // the safety profile the card's Safety line shows
  readonly defaultPermissionMode?: PermissionMode;
  readonly allowBypass: boolean;
  // whether the Forward my SSH agent switch is on; absent for a host the agent cannot reach (WSL, a Windows SSH host)
  readonly agentForwarding?: boolean;
  // what Damocles changed on the host (RemoteHostFacts); false for a WSL host
  readonly passwordless: boolean;
  readonly keyInstalledByDamocles: boolean;
  readonly lingerEnabledByDamocles: boolean;
}

// A device attached to a host's daemon, named by the deviceName it sent in hello; self: this computer.
export interface HostDevice {
  readonly deviceName: string;
  readonly self: boolean;
}

// Devices one host card lists, and characters of a device name.
export const MAX_HOST_DEVICES = 32;
export const MAX_DEVICE_NAME_LENGTH = 64;

// What the daemon answered Allow background work: refused carries the host user an admin enables linger for.
export type LingerResult =
  | { readonly result: 'enabled' }
  | { readonly result: 'alreadyEnabled' }
  | { readonly result: 'refused'; readonly user: string }
  | { readonly result: 'failed'; readonly code: string };

// A chat's state in the close dialog: signIn waits with Sign-in needed, idle finished while the dialog was open.
export const CLOSE_REMOTE_STATUSES = ['running', 'waiting', 'signIn', 'idle'] as const;
export type CloseRemoteStatus = (typeof CLOSE_REMOTE_STATUSES)[number];

// A remote chat whose run outlives the app; every label comes from this computer's host store and chat list.
export interface CloseRemoteRow {
  readonly hostId: string;
  // the core panel id of the chat, unique among the rows
  readonly panelId: string;
  // '' is a new conversation, which the dialog labels itself
  readonly title: string;
  readonly projectLabel: string;
  readonly hostLabel: string;
  readonly hostColor?: HostColor;
  readonly status: CloseRemoteStatus;
  // the refresh of this provider's sign-in failed: the whole minutes its current token has left; provider is a pi provider id
  // (PROVIDER_ID_PATTERN)
  readonly tokenNote?: { readonly provider: string; readonly minutesLeft: number };
  // the host ends the user's processes at logout and has no linger, so the run stops when the user logs out there
  readonly lingerWarning?: true;
}

export type CloseRemoteChoice = 'keep' | 'stop' | 'cancel';

// A close row's host part, which follows a rename, a recolor and the host's notices while the dialog shows.
export type CloseRowHost = Pick<CloseRemoteRow, 'hostLabel' | 'hostColor' | 'lingerWarning'>;

// A host's measured clock skew past this many ms shows a warning on its card.
export const CLOCK_SKEW_WARN_MS: number = 2 * 60 * 1000;

// Host names (a host store rule): 1..MAX_HOST_NAME_LENGTH characters after trimming and NFC.
export const MAX_HOST_NAME_LENGTH = 64;
export const NAME_REFUSALS = ['empty', 'tooLong', 'controlChars', 'bidiChars', 'taken'] as const;
export type NameRefusal = (typeof NAME_REFUSALS)[number];
// taken: clashWith is the other host's name or alias it equals
export type NameCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: NameRefusal; readonly clashWith?: string };

// An option of a parsed "+ New host" entry as ssh names it (-J shows as ProxyJump), its value exactly as written.
export interface ParsedSshOption {
  readonly name: string;
  readonly value: string;
}

// option: a flag or -o option outside the allowlist; fixed: an option Damocles sets itself; value: an allowed option with a value
// it refuses; relativePath: an identity file that is not a full path; conflict: a second route gives a setting another value, or
// a second -J; typography: a word processor's dash or quote; quotes: an unclosed quote; missing: a flag or option without its
// value; input: past the length Damocles reads, or more than one line; destination: no host or a malformed one; command: a
// remote command after the host
export const HOST_PARSE_REFUSALS = ['option', 'fixed', 'value', 'relativePath', 'conflict', 'typography', 'quotes', 'missing', 'input', 'destination', 'command'] as const;
export type HostParseRefusal = (typeof HOST_PARSE_REFUSALS)[number];

// refused: the flag or option as the user would type it ('-F', 'ProxyCommand', 'StrictHostKeyChecking=no'), the character for
// typography, 'input', 'command', and for destination the part that failed ('host', 'user', 'port') else 'destination'
export type HostParseResult =
  | { readonly ok: true; readonly destinationLabel: string; readonly options: readonly ParsedSshOption[]; readonly prefillName: string; readonly nameCheck: NameCheck }
  | { readonly ok: false; readonly refused: string; readonly reason: HostParseRefusal };

// A saved host, an ssh config alias to save under name, "+ New host"'s input to parse again and save under name, or a WSL
// distro with no host record yet, saved under name.
export type ConnectTarget =
  | { readonly hostId: string }
  | { readonly alias: string; readonly name: string }
  | { readonly input: string; readonly name: string }
  | { readonly distro: string; readonly name: string }
  // a running container from the attach list (its id as listed), on this computer or on the SSH host via
  | { readonly attach: string; readonly via?: string; readonly user: 'configured' | 'root'; readonly name: string }
  // a folder holding a devcontainer configuration, on this computer or on the SSH host via
  | { readonly devcontainer: string; readonly via?: string; readonly name: string };

// A running container as the attach list shows it; every text is the engine's own, untrusted and bounded. user: the user
// "configured" attaches as (the devcontainer metadata's remoteUser, else the image's user); absent is root. hostId: the attach
// record this container already has.
export interface RunningContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly status: string;
  readonly state: 'running' | 'paused' | 'restarting' | 'other';
  readonly prefillName: string;
  readonly user?: string;
  readonly hostId?: string;
}
export type ContainerListResult =
  | { readonly ok: true; readonly engine: ContainerEngine; readonly containers: readonly RunningContainer[] }
  | { readonly ok: false; readonly code: 'containerEngineMissing' | 'listFailed' | 'notConnected' | 'containerFeatureMissing'; readonly message?: string };
// A folder that holds a devcontainer configuration; hostId: the container record it already has.
export type ContainerFolderPick =
  | { readonly ok: true; readonly folder: string; readonly configPath: string; readonly prefillName: string; readonly hostId?: string }
  | { readonly ok: false; readonly code: 'noDevcontainerConfig' | 'notConnected'; readonly folder: string };

// The fields the devcontainer confirmation lists, in display order (devcontainer-trust.ts reads them from the resolved
// configuration).
export const DEVCONTAINER_TRUST_FIELDS = ['initializeCommand', 'mounts', 'workspaceMount', 'runArgs', 'privileged', 'capAdd', 'securityOpt', 'features', 'otherHostAccess'] as const;
export type DevcontainerTrustField = (typeof DEVCONTAINER_TRUST_FIELDS)[number];
export interface DevcontainerTrustValue {
  // verbatim from the configuration, shown in monospace
  readonly text: string;
  readonly danger?: 'privileged' | 'dockerSocket';
}
export interface DevcontainerTrustEntry {
  readonly field: DevcontainerTrustField;
  readonly values: readonly DevcontainerTrustValue[];
}
// only the fields that have values, in DEVCONTAINER_TRUST_FIELDS order
export type DevcontainerTrustItems = readonly DevcontainerTrustEntry[];
// Values one confirmation lists in all, and characters of one value.
export const MAX_DEVCONTAINER_TRUST_VALUES = 500;
export const MAX_DEVCONTAINER_TRUST_TEXT = 8192;

// What the devcontainer confirmation shows: hostName absent is this computer; changed: a confirmed set exists and differs.
export interface DevcontainerTrustRequest {
  readonly hostName?: string;
  readonly hostColor?: HostColor;
  readonly folder: string;
  readonly configPath: string;
  readonly changed: boolean;
  readonly items: DevcontainerTrustItems;
}

export type ConnectStartResult =
  | { readonly ok: true; readonly attemptId: string; readonly hostId: string }
  | { readonly ok: false; readonly reason: 'name'; readonly check: NameCheck }
  | { readonly ok: false; readonly reason: 'refused'; readonly refused: string; readonly refusal: HostParseRefusal };

// projectKey: the folder is a project already, which a pick selects instead of adding it again
export interface RemoteBrowseFolder {
  readonly name: string;
  readonly projectKey?: string;
}

// eperm-privacy: macOS refused a privacy-protected folder (Desktop, Documents, Downloads, iCloud Drive) named by folder.
// While a picker is open: root is the confinement root the listing lies in (no crumb above it), files the folder's files in
// file mode, and outside a path no root holds.
export type RemoteBrowseResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly parent?: string;
      readonly home: string;
      readonly separator: '/' | '\\';
      readonly folders: readonly RemoteBrowseFolder[];
      readonly root?: string;
      readonly files?: readonly string[];
    }
  | { readonly ok: false; readonly error: 'eperm-privacy'; readonly folder: string }
  | { readonly ok: false; readonly error: 'missing' | 'failed' | 'notConnected' | 'outside' };

// A remote core's file or folder picker in the Connect dialog's folder browser; roots are the folders it is confined to.
export interface RemotePick {
  readonly mode: 'file' | 'folder';
  readonly hostName: string;
  readonly roots: readonly string[];
  readonly title?: string;
  readonly buttonLabel?: string;
}

// A terminal running on a host, from its daemon's run list; projectKey is this computer's key for its project, when listed.
// canOpen: hosts.openRun adds a tab for it here: it has no live tab here, its folder is open here, and its host recorded
// what a view needs.
export interface HostRun {
  readonly id: string;
  readonly title: string;
  readonly state: 'running' | 'waiting' | 'background';
  readonly projectKey?: string;
  readonly canOpen: boolean;
}

// invalid: not an absolute path or ~-prefixed, or it holds a newline or NUL
export type InstallFolderResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'invalid' };

// Settings > Remote hosts: a host's own settings as its row shows them; an absent value is the default (off, none).
export interface RemoteHostSettings {
  readonly color?: HostColor;
  // absent: the target's own damocles.permissionMode decides
  readonly defaultPermissionMode?: PermissionMode;
  readonly allowBypass: boolean;
  readonly forwardAgent: boolean;
  readonly rememberPassword: boolean;
  readonly browserLocalNetwork: boolean;
  readonly openLinksWithoutAsking: boolean;
  readonly osOverride?: ShellPlatform;
  readonly installFolder?: string;
}

// What Damocles changed on the host, which Remove Damocles server may undo.
export interface RemoteHostFacts {
  // Damocles' key is set up and verified, and ssh offers it
  readonly passwordless: boolean;
  // Damocles appended that key to the host's authorized keys
  readonly keyInstalledByDamocles: boolean;
  // Allow background work turned linger on
  readonly lingerEnabledByDamocles: boolean;
  // credential hosts (git over https) this host may use without asking, each with Revoke
  readonly alwaysCredentialHosts: readonly string[];
}

// A saved SSH host, WSL distro or container in Settings > Remote hosts, in saved order; every label from this computer's host store.
export interface RemoteHostEntry {
  readonly hostId: string;
  readonly kind: 'ssh' | 'wsl' | 'container';
  readonly container?: ContainerHostInfo;
  readonly authorityKey: string;
  readonly name: string;
  readonly destinationLabel: string;
  // the override, else what detection found
  readonly os?: ShellPlatform;
  readonly detectedOs?: ShellPlatform;
  readonly connection: ProjectConnection;
  readonly settings: RemoteHostSettings;
  readonly facts: RemoteHostFacts;
  // the host's held memory queues, oldest lastSeen first; empty while it is not connected
  readonly heldMemoryQueues: readonly HeldMemoryQueue[];
}

// Memories a host's daemon holds for a device that has not attached for 30 days, which another device may take or discard;
// count is at least 1, queueId within MAX_HELD_MEMORY_QUEUE_ID_LENGTH.
export type { HeldMemoryQueue };
export { MAX_HELD_MEMORY_QUEUES };
export const MAX_HELD_MEMORY_QUEUE_ID_LENGTH = 128;

// notConnected: the host is not connected, or its daemon holds no queues; gone: the queue is no longer held
export type HeldMemoryFailureCode = 'notConnected' | 'gone';
export type HeldMemoryResult = { readonly ok: true } | { readonly ok: false; readonly code: HeldMemoryFailureCode };

export const HOST_SWITCH_KEYS = ['allowBypass', 'forwardAgent', 'rememberPassword', 'browserLocalNetwork', 'openLinksWithoutAsking'] as const;
export type HostSwitchKey = (typeof HOST_SWITCH_KEYS)[number];

// One setting change; null clears the value (no color, the host's settings decide the mode, detection decides the OS).
export type HostSettingChange =
  | { readonly key: 'color'; readonly value: HostColor | null }
  | { readonly key: 'defaultPermissionMode'; readonly value: PermissionMode | null }
  | { readonly key: HostSwitchKey; readonly value: boolean }
  | { readonly key: 'osOverride'; readonly value: ShellPlatform | null };

export type PasswordlessStep = 'generate' | 'install' | 'verify';
// path names the host file a failure concerns (ownership, notFile, writeFailed, aclFailed, restricted); keyPairIncomplete's
// path is the half of Damocles' key pair left on this computer
// publickeyNotPreferred: the PreferredAuthentications `ssh -G` resolves for the host would try another method before Damocles'
// key; configUnreadable: no ssh, or `ssh -G` named none
// accountFailed: whoami could not name the Windows account the key is installed for
// installFailed: the daemon answered the install with an error; notConnected: the connection closed first
export type PasswordlessFailureCode = 'notConnected' | 'keygenFailed' | 'keyPairIncomplete' | 'unsupported' | 'ownership' | 'notFile' | 'writeFailed' | 'aclFailed' | 'accountFailed' | 'restricted' | 'verifyFailed' | 'publickeyNotPreferred' | 'configUnreadable' | 'installFailed';
export interface PasswordlessFailure {
  readonly code: PasswordlessFailureCode;
  readonly params: Readonly<Record<string, string>>;
}
export type PasswordlessResult = { readonly ok: true } | ({ readonly ok: false; readonly step: PasswordlessStep } & PasswordlessFailure);
export type PasswordlessStepState = 'pending' | 'running' | 'done' | 'failed';
// Set up passwordless login as main runs it: running until it has a result, or failed (main's call threw).
export interface PasswordlessRun {
  readonly steps: Readonly<Record<PasswordlessStep, PasswordlessStepState>>;
  readonly result?: PasswordlessResult;
  readonly failed?: true;
}

// A running chat or terminal Remove Damocles server would end, from the daemon's listRuns.
export interface RemovalRun {
  readonly kind: 'chat' | 'terminal';
  readonly id: string;
  readonly title: string;
  readonly state: 'running' | 'waiting' | 'background';
  readonly projectKey?: string;
}
// The removal dialog: the running work, and each checkbox only when Damocles made that change.
export interface RemovalInfo {
  readonly runs: readonly RemovalRun[];
  readonly offerRemoveKey: boolean;
  readonly offerDisableLinger: boolean;
}
export interface RemoveServerOptions {
  readonly removeKey: boolean;
  readonly disableLinger: boolean;
}
// stageFailed: {code} of STAGE_FAILED_CODES, and {exitCode} with code exit; daemonRunning: this machine's daemon runs or holds its
// lock
export const STAGE_FAILED_CODES = ['keyFile', 'runKey', 'userName', 'protocol', 'killed', 'exit'] as const;
export type RemoveServerFailureCode = 'notConnected' | 'unsupported' | 'daemonRunning' | 'stageFailed';
// versionKept: {version, machine}, another machine's live daemon runs it; serverFolderKept: other machines' entries stay;
// deleteFailed: {entry} could not be deleted; installInProgress: {folder} is kept while a stage installs there
export type RemoveServerNoticeCode = 'versionKept' | 'serverFolderKept' | 'keyNotFound' | 'lingerFailed' | 'deleteFailed' | 'installInProgress';
export type RemoveServerResult =
  | { readonly ok: true; readonly notices: ReadonlyArray<{ readonly code: RemoveServerNoticeCode; readonly params: Readonly<Record<string, string>> }> }
  | { readonly ok: false; readonly code: RemoveServerFailureCode; readonly params: Readonly<Record<string, string>> };
// Remove Damocles server or its Try again as main runs it: running until it has a result, or failed (main's call threw).
// prompt: the secret the removal stage's ssh waits on, answered through connectAnswer with attemptId and promptId.
export interface ServerRemovalRun {
  readonly result?: RemoveServerResult;
  readonly failed?: true;
  readonly prompt?: { readonly attemptId: string; readonly promptId: string } & Extract<SshPrompt, { readonly kind: 'secret' }>;
}
// Convert to WSL 2 as main runs it: stop the daemon, run `wsl.exe --set-version <distro> 2`, connect again.
export const WSL_CONVERSION_STEPS = ['stopping', 'converting', 'reconnecting'] as const;
export type WslConversionStep = (typeof WSL_CONVERSION_STEPS)[number];
// Lines of wsl.exe output a conversion run keeps, newest last.
export const MAX_WSL_CONVERSION_OUTPUT_LINES = 200;
// setVersionFailed and shutdownFailed leave the distro on WSL 1; message is wsl.exe's own text, verbatim
export type WslConversionFailureCode = 'setVersionFailed' | 'shutdownFailed' | 'reconnectFailed';
export interface WslConversionRun {
  readonly steps: Readonly<Record<WslConversionStep, PasswordlessStepState>>;
  readonly output: readonly string[];
  readonly result?: { readonly ok: true } | { readonly ok: false; readonly code: WslConversionFailureCode; readonly message?: string };
  readonly failed?: true;
}
// Rebuild Container as main runs it, after the confirmation: the trust gate, stop the container's daemon, `devcontainer up
// --remove-existing-container` with its log, connect again. configRefused and folderUntrusted stopped nothing.
export const CONTAINER_REBUILD_STEPS = ['stopping', 'building', 'reconnecting'] as const;
export type ContainerRebuildStep = (typeof CONTAINER_REBUILD_STEPS)[number];
// configFailed {message}: the gate failed, so nothing stopped; stopFailed {message}: the daemon's shutdown failed, so nothing
// was removed; buildFailed {message}: up failed after the stop and the old container is gone, the CLI's own text, verbatim;
// buildFailedKept {message}: up failed after the stop and the engine still lists the old container
export type ContainerRebuildFailureCode = 'configRefused' | 'folderUntrusted' | 'composeUnsupported' | 'configFailed' | 'stopFailed' | 'buildFailed' | 'buildFailedKept' | 'reconnectFailed' | 'containerEngineMissing';
export interface ContainerRebuildRun {
  readonly steps: Readonly<Record<ContainerRebuildStep, PasswordlessStepState>>;
  readonly log: BuildLog;
  readonly result?: { readonly ok: true } | { readonly ok: false; readonly code: ContainerRebuildFailureCode; readonly message?: string };
  readonly failed?: true;
}
// A host's setup and removal, always whole. Main keeps a finished run while a Connect dialog or Settings shows, and drops it
// once neither does. revision grows with every snapshot main builds, so a view keeps the highest it heard.
export interface HostOperations {
  readonly hostId: string;
  readonly revision: number;
  readonly passwordless?: PasswordlessRun;
  readonly removal?: ServerRemovalRun;
  readonly conversion?: WslConversionRun;
  readonly rebuild?: ContainerRebuildRun;
}

// Characters of a "+ New host" input, a remote path and an ssh prompt answer the Connect channels accept.
export const MAX_HOST_INPUT_LENGTH = 2000;
export const MAX_REMOTE_PATH_LENGTH = 4096;
export const MAX_PROMPT_ANSWER_LENGTH = 4096;

// Lucide names a request may carry; main rejects a request naming any other icon.
export const OVERLAY_ICONS = [
  'archive',
  'archive-restore',
  'arrow-down-to-line',
  'arrow-down-up',
  'arrow-right-to-line',
  'arrow-up-from-line',
  'arrow-up-right',
  'at-sign',
  'box',
  'check',
  'check-check',
  'cherry',
  'chevrons-up-down',
  'circle-dot',
  'circle-x',
  'clipboard-paste',
  'cloud',
  'cloud-download',
  'cloud-upload',
  'code',
  'columns-2',
  'copy',
  'copy-plus',
  'copy-x',
  'download',
  'eraser',
  'eye',
  'eye-off',
  'file',
  'file-clock',
  'file-plus',
  'file-symlink',
  'file-text',
  'files',
  'filter',
  'filter-x',
  'folder',
  'folder-git-2',
  'folder-input',
  'folder-minus',
  'folder-open',
  'folder-plus',
  'folder-search',
  'folder-tree',
  'git-branch',
  'git-branch-plus',
  'git-commit-horizontal',
  'git-compare',
  'git-fork',
  'git-merge',
  'git-pull-request-arrow',
  'hash',
  'history',
  'list',
  'list-filter',
  'list-tree',
  'maximize-2',
  'message-square',
  'message-square-plus',
  'minus',
  'palette',
  'panel-bottom',
  'panel-right',
  'pencil',
  'pencil-line',
  'plus',
  'refresh-cw',
  'replace',
  'replace-all',
  'rotate-cw',
  'scissors',
  'scroll-text',
  'search',
  'server',
  'shapes',
  'shield-check',
  'shield-off',
  'signature',
  'sparkles',
  'square',
  'square-code',
  'square-terminal',
  'tag',
  'tags',
  'text-select',
  'trash-2',
  'undo-2',
  'ungroup',
  'x',
] as const;
export type OverlayIcon = (typeof OVERLAY_ICONS)[number];

// Payload bounds; main rejects a request or answer outside them.
export const MAX_OVERLAY_ITEMS = 100;
// Items of a menu at both levels together (separators and submenu rows included); each level's list stays within
// MAX_OVERLAY_ITEMS.
export const MAX_MENU_ITEMS = 160;
export const MAX_OVERLAY_LABEL_LENGTH = 200;
// The Connect dialog's ssh config aliases; an alias is at most isSafeAlias's 255 characters.
export const MAX_SSH_CONFIG_ALIASES = 1000;
export const MAX_SSH_ALIAS_LENGTH = 255;
export const MAX_OVERLAY_ID_LENGTH = 200;
// A palette command id; an Open Chat in Project id carries the project's absolute path.
export const MAX_COMMAND_ID_LENGTH = 5000;
export const MAX_OVERLAY_TAGS = 500;
export const MAX_OVERLAY_TEXT_LENGTH = 2000;
// Buttons of a message dialog besides Cancel.
export const MAX_MESSAGE_ACTIONS = 4;
// Lines of a message dialog's preview, each at most MAX_OVERLAY_LABEL_LENGTH characters.
export const MAX_MESSAGE_PREVIEW_LINES = 8;
// CSS px; a coordinate or size outside [0, MAX_OVERLAY_COORDINATE] is malformed.
export const MAX_OVERLAY_COORDINATE = 100_000;
// Boxes in one toast area report: three toasts, the pill and toasts still leaving.
export const MAX_TOAST_PARTS = 32;
// JSON characters of one settings view request; a pasted API key is far smaller.
export const MAX_SETTINGS_MESSAGE_CHARS: number = 64 * 1024;
// The overlay must ack receipt of a request within this many ms or main hides it and rejects the request.
export const OVERLAY_ACK_TIMEOUT_MS = 2000;
// Bytes of one rasterized PNG; main refuses a larger answer.
export const MAX_RASTER_PNG_BYTES: number = 64 * 1024;
// Refs the Graph's ref picker offers, every group together; past it the chosen refs and the first others, and a count of the rest.
export const MAX_REF_PICKER_REFS = 2000;

// Main's art for the taskbar badge (D52): drawn in order on a width×height canvas. Coordinates and sizes are design units,
// multiplied by scale; an SVG layer covers the whole canvas.
export type RasterOp =
  | { readonly kind: 'svg'; readonly svg: string }
  // centred on (x, y) by its ink box, in the renderer's --d-font
  | { readonly kind: 'text'; readonly text: string; readonly x: number; readonly y: number; readonly size: number; readonly weight: number; readonly color: string };

export interface RasterArt {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly ops: readonly RasterOp[];
}

export interface OverlayRasterRequest {
  // issued by main
  readonly id: string;
  readonly art: RasterArt;
}

// CSS px in window content coordinates (the shell page's coordinates).
export interface OverlayPoint {
  readonly x: number;
  readonly y: number;
}

export interface OverlayRect extends OverlayPoint {
  readonly width: number;
  readonly height: number;
}

// What main does itself when the user picks an item: cut, copy or paste on the page that asked, or allow one paste into its
// active terminal. Main sets such an item's label and icon, and keeps it only in a menu a context-menu click or key opened.
export const OVERLAY_CLIPBOARD_ACTIONS = ['cut', 'copy', 'paste', 'terminalPaste'] as const;
export type OverlayClipboardAction = (typeof OVERLAY_CLIPBOARD_ACTIONS)[number];

export type OverlayMenuItem =
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly label: string;
      readonly clipboard?: OverlayClipboardAction;
      readonly icon?: OverlayIcon;
      // a shell's or custom terminal icon, drawn instead of icon (the New Terminal dropdown's profiles)
      readonly glyph?: TerminalGlyph;
      // tints the glyph with --d-ansi-<index of the color in TERMINAL_COLORS>
      readonly color?: TerminalColor;
      readonly shortcut?: string;
      // a second line under the label, within MAX_OVERLAY_LABEL_LENGTH
      readonly hint?: string;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      // why the item is disabled, shown where the shortcut sits; only with disabled, within MAX_OVERLAY_LABEL_LENGTH
      readonly disabledReason?: string;
      readonly checked?: boolean;
      // with checked: one of mutually exclusive choices (menuitemradio) rather than a toggle
      readonly radio?: boolean;
    }
  | { readonly kind: 'separator' }
  // one level deep: its items are items and separators, never another submenu; its own id is never an answer. hint: a second
  // line under the label, within MAX_OVERLAY_LABEL_LENGTH
  | { readonly kind: 'submenu'; readonly id: string; readonly label: string; readonly icon?: OverlayIcon; readonly hint?: string; readonly items: readonly OverlayMenuItem[] };

/**
 * Drops separators at either end and repeated ones, which conditional menu sections and dropped items leave behind, and a
 * submenu left empty.
 */
export function tidyMenu(items: readonly OverlayMenuItem[]): OverlayMenuItem[] {
  const out: OverlayMenuItem[] = [];
  for (const raw of items) {
    const item = raw.kind === 'submenu' ? { ...raw, items: tidyMenu(raw.items) } : raw;
    if (item.kind === 'submenu' && item.items.length === 0) continue;
    if (item.kind === 'separator' && (out.length === 0 || out[out.length - 1]?.kind === 'separator')) continue;
    out.push(item);
  }
  if (out[out.length - 1]?.kind === 'separator') out.pop();
  return out;
}

// A ref the Graph's ref picker offers: its full refname (refs/heads/, refs/remotes/ or refs/tags/) and its short name.
export interface OverlayRefPickerRef {
  readonly id: string;
  readonly name: string;
}

// What the Graph shows: Auto, All, or 1 to MAX_SCM_HISTORY_REFS full refnames.
export type OverlayRefChoice = 'auto' | 'all' | readonly string[];

// Labels are localized by the sender.
export type OverlayRequest =
  | {
      readonly kind: 'menu';
      // the menu's accessible name
      readonly label: string;
      readonly anchor: OverlayRect;
      readonly items: readonly OverlayMenuItem[];
      // present = the menu shows a filter box (the all-tags menu)
      readonly filterPlaceholder?: string;
      // a line above the items, e.g. a file's relative path, in mono
      readonly caption?: string;
    }
  | {
      readonly kind: 'confirm';
      readonly title: string;
      readonly message: string;
      // running: the warning is about work in progress, marked with a spinner
      readonly warning?: { readonly text: string; readonly running: boolean };
      // a labelled box under the message, e.g. "Session:" and the chat title
      readonly detail?: { readonly label: string; readonly text: string };
      readonly confirmLabel: string;
      readonly cancelLabel: string;
      readonly danger: boolean;
    }
  | {
      readonly kind: 'tagPicker';
      readonly anchor: OverlayRect;
      readonly current?: string;
      readonly tags: readonly string[];
      readonly placeholder: string;
    }
  // The Graph's ref picker (A.4): Auto, All, then the repository's branches, remote branches and tags, any of which may be
  // picked together; selected names only refs it offers. failed: a group of refs could not be read; omitted: refs past
  // MAX_REF_PICKER_REFS left out of refs.
  | {
      readonly kind: 'refPicker';
      readonly anchor: OverlayRect;
      readonly refs: readonly OverlayRefPickerRef[];
      readonly selected: OverlayRefChoice;
      readonly failed: boolean;
      readonly omitted: number;
    }
  // Only main opens it; `generation` is the attachment the modal's first settingsSend calls must carry.
  | {
      readonly kind: 'settings';
      readonly section?: SettingsSectionId;
      readonly account?: SettingsAccountId;
      // a release index version, which About's What's new expands and scrolls to
      readonly release?: string;
      // a saved host's id, which the Remote hosts section shows
      readonly host?: string;
      readonly generation: number;
      readonly page: OverlaySettingsPage;
      // present while the selected chat is remote: its User, host and Project tabs
      readonly scopes?: OverlaySettingsScopes;
    }
  // Only main asks one (D41); it stacks above an open request instead of dismissing it.
  | {
      readonly kind: 'message';
      readonly severity: MessageSeverity;
      readonly message: string;
      readonly detail?: string;
      readonly actions: readonly string[];
      // absent: no Cancel button (a save prompt offers Save and Don't Save only); Escape and the scrim still answer null
      readonly cancelLabel?: string;
      // index of the action focused first; absent, Cancel is, so Enter alone never takes a risky action
      readonly defaultAction?: number;
      // lines shown verbatim in the mono font under the detail, e.g. the start of a paste with its control characters as symbols
      readonly preview?: readonly string[];
      // a box above the buttons ("Don't ask again"); the answer carries its state
      readonly checkbox?: MessageCheckbox;
    }
  // the title bar bell's menu, under the bell
  | { readonly kind: 'notifications'; readonly anchor: OverlayRect }
  // Ctrl+P or the title-bar search box (files), or Ctrl+Shift+P (commands); only main opens it. Files mode answers through
  // quickOpenQuery, commands mode through commandsList; a leading '>' switches files to commands, as VS Code does. A scope
  // limits the files to one folder of one project.
  | { readonly kind: 'quickOpen'; readonly mode: QuickOpenMode; readonly scope?: QuickOpenScope }
  // New Terminal (Ctrl+Shift+`, the terminal pane's + or its empty state's button); only main opens it. Step 1 picks a project,
  // in the sidebar's order under its host headings, skipped when projects is one reachable entry or none (the home folder); a
  // Home folder row joins it while no project is reachable. Step 2 picks a shell of that project's host, which the overlay
  // fetches through terminalPickProfiles. Shift+click or Shift+Enter on a project answers with its host's default shell.
  | { readonly kind: 'newTerminal'; readonly projects: readonly TerminalProjectOption[] }
  // A list main offers (a terminal's icon, color or default profile, a ref, stash, tag, remote or worktree picker); only
  // main opens it. Ungrouped, the current item is focused first; filtering matches label and description.
  // With pickMany the rows are checkboxes, at most max checked (1..the selectable items), answered by quickPickMany.
  | { readonly kind: 'quickPick'; readonly placeholder: string; readonly items: readonly OverlayQuickPickItem[]; readonly pickMany?: { readonly max: number } }
  // A text box main asks through askInput; only main opens it.
  | ({ readonly kind: 'input' } & InputRequest)
  // a pane dragged past the shell's threshold; grid is the layout grid's rectangle, pointer where the drag is now
  | {
      readonly kind: 'dropZones';
      readonly pane: GridPane;
      readonly slots: ShellGridLayout['slots'];
      readonly grid: OverlayRect;
      readonly pointer: OverlayPoint;
    }
  // the Chats section's New split button menu (D30, D63); the overlay fetches the options through worktreeOptions
  | {
      readonly kind: 'newChatMenu';
      readonly anchor: OverlayRect;
      readonly projectKey: string;
      readonly projectName: string;
      // New chat's shortcut label, e.g. "Ctrl+N"
      readonly shortcut: string;
    }
  // Only main asks one (D41, slice 12a); it stacks above an open request as a message does.
  | WorktreeDialogRequest
  // Connect to Host (only main opens it): the host list, or with hostId straight to that host's attempt and folder browser;
  // attempt is that host's attempt in flight, its waiting prompt included
  | {
      readonly kind: 'connect';
      readonly hostId?: string;
      // with hostId: the host's card, with its name field open for rename, or its Rebuild Container confirmation, starting no
      // connection
      readonly card?: 'rename' | 'show' | 'rebuild';
      // with card 'show': the chip the host's details were opened from, which the card hangs from as a popover until the
      // dialog moves on to another view
      readonly anchor?: OverlayRect;
      readonly hosts: readonly HostCardInfo[];
      // this computer's WSL distros; empty off Windows or without wsl.exe
      readonly distros: readonly WslDistroInfo[];
      // Host aliases of ~/.ssh/config that are not saved hosts yet
      readonly sshConfigAliases: readonly string[];
      readonly attempt?: ConnectStepEvent;
      // with hostId: the folder browser alone, as a remote core's picker, answering the picked path
      readonly pick?: RemotePick;
      // without hostId: the host search filled in as if typed (an unsaved host the damocles command named), starting nothing
      readonly query?: string;
      // with hostId, from a "Sign in to <host>" banner: the dialog closes once that host connects, showing no folder browser
      readonly purpose?: 'signIn';
    }
  // A close or quit while remote chats run (only main asks it): Keep running, Stop agents or Cancel; it stacks as a message
  // does, and its rows follow on closeRemoteRows
  | { readonly kind: 'closeRemote'; readonly rows: readonly CloseRemoteRow[] }
  // A target asks for this computer's git credential (only main asks it); it stacks as a message does
  | ({ readonly kind: 'gitCredentialConsent' } & GitCredentialConsent)
  // What a devcontainer configuration runs and mounts, before its first up and whenever it changed (only main asks it); it
  // stacks as a message does
  | ({ readonly kind: 'devcontainerTrust' } & DevcontainerTrustRequest)
  // Allow YOLO on a saved host whose switch is off, hung from the control that asked (only main asks it); it stacks as a
  // message does, so it shows above the settings modal
  | { readonly kind: 'allowYolo'; readonly hostName: string; readonly hostColor?: HostColor; readonly anchor: OverlayRect }
  // Choose Client Certificate for This Site...: the certificates the site accepts, which Chrome would offer for it; site is the
  // page's host as its address bar names it
  | { readonly kind: 'clientCertificate'; readonly site: string; readonly certificates: readonly ClientCertificateRow[] };

// What the picker shows of one certificate, and the opaque id main maps back to it; validity in seconds since the epoch.
// distinct false: Chrome's auto-selection could not tell it from another one offered, so it cannot be chosen.
export interface ClientCertificateRow {
  readonly id: string;
  readonly subject: string;
  readonly issuer: string;
  readonly validStart: number;
  readonly validExpiry: number;
  readonly distinct: boolean;
}

// The host's name and tone come from this computer's host store; credentialHost is the https host the target's git asked
// for, as main validated it; targetHelper: the target's git has a credential helper of its own that would save the credential.
export interface GitCredentialConsent {
  readonly hostName: string;
  readonly hostColor?: HostColor;
  readonly credentialHost: string;
  readonly targetHelper: boolean;
}

export const GIT_CREDENTIAL_CONSENT_CHOICES = ['once', 'always', 'deny'] as const;
export type GitCredentialConsentChoice = (typeof GIT_CREDENTIAL_CONSENT_CHOICES)[number];
// The Connect dialog answers dismissed, a picked folder being added through connectPickFolder before it closes; a picker
// answers its picked path.

export type WorktreeDialogRequest = { readonly kind: 'worktreeDialog' } & WorktreeDialog;

// Texts that come from git or the disk (paths, branch names, subjects) reach the overlay as data and render as text only.
export type WorktreeDialog =
  // D32: the setup commands of .damocles/worktree.json, before they first run or after they changed
  | { readonly dialog: 'setupReview'; readonly projectName: string; readonly commands: readonly string[] }
  // D33: Delete worktree. deleteBranchDefault: no unmerged commit, so the branch goes too unless unticked; deleteBranchLocked:
  // the checkbox cannot change (the branch is checked out elsewhere)
  | {
      readonly dialog: 'delete';
      readonly path: string;
      readonly branch: string;
      readonly uncommitted: readonly WorktreeFile[];
      readonly submoduleChanges: readonly WorktreeFile[];
      readonly unmergedCommits: readonly WorktreeCommit[];
      readonly deleteBranchDefault: boolean;
      readonly deleteBranchLocked: boolean;
    }
  // D33: Merge into {target} with uncommitted worktree files, which are committed first with this message
  | { readonly dialog: 'mergeMessage'; readonly branch: string; readonly target: string; readonly files: readonly WorktreeFile[] }
  // D33: the target branch was rewritten after the worktree started
  | { readonly dialog: 'rewritten'; readonly branch: string }
  // Apply or hand-off refused: these files have local changes in the project folder
  | { readonly dialog: 'refusal'; readonly action: 'apply' | 'handOff'; readonly files: readonly WorktreeFile[] }
  // D61: the files that move, those also holding the user's edits marked
  | { readonly dialog: 'handOffConfirm'; readonly direction: 'toWorktree' | 'toProject'; readonly branch?: string; readonly files: readonly HandOffFile[] }
  // R15: the startup scan's findings; nothing is deleted, Prune runs git worktree prune on the item's repository
  | { readonly dialog: 'leftovers'; readonly items: readonly LeftoverItem[] };

export interface WorktreeCommit {
  readonly hash: string;
  readonly subject: string;
}

// A file of a worktree dialog's list, repository-relative, with the status letter source control shows for it.
export interface WorktreeFile {
  readonly path: string;
  readonly letter: ScmLetter;
}

export interface HandOffFile extends WorktreeFile {
  readonly alsoUserEdits: boolean;
}

// unregistered: a folder under ~/.damocles/worktrees no record owns (Reveal); missingFolder: a record whose folder is gone;
// noChat: a live chat worktree past its grace period no chat ever worked in (Delete, or Keep, which stops reporting it);
// gitRecordOnly: git lists a worktree whose folder is gone, which Prune drops
export interface LeftoverItem {
  readonly path: string;
  readonly reason: 'unregistered' | 'missingFolder' | 'gitRecordOnly' | 'noChat';
  // the repository Prune acts on, when one does
  readonly repository?: string;
}

// Bounds of a worktree dialog; main cuts its lists to them and refuses an answer outside them.
export const MAX_WORKTREE_DIALOG_ITEMS = 200;
export const MAX_WORKTREE_COMMIT_MESSAGE_CHARS: number = 64 * 1024;

export type MessageSeverity = 'info' | 'warning' | 'danger';

// checked: its state when the dialog opens
export interface MessageCheckbox {
  readonly label: string;
  readonly checked: boolean;
}

export type { InputValidation };

// VS Code's showInputBox options that Damocles uses. Labels are localized by main.
export interface InputRequest {
  // the box's heading, e.g. "Commit to a New Branch"
  readonly title?: string;
  // the line under the box, VS Code's prompt
  readonly prompt: string;
  readonly placeholder?: string;
  // the prefill
  readonly value?: string;
  // [start, end) UTF-16 offsets into value, VS Code's valueSelection; absent selects the whole value
  readonly valueSelection?: readonly [number, number];
  // checked as the user types; Enter is refused while it fails, and main checks the answer again
  readonly validation?: InputValidation;
  // why main refused the last answer, shown in place of the prompt until the next edit; main asks again with the typed value
  readonly error?: string;
  // a masked box with no autocomplete or spellcheck whose value is never logged; never together with validation or value
  readonly password?: boolean;
  // an inline folder button inside the box (VS Code's inline input button); its click asks main through inputBrowse, which
  // runs the handler main keeps for the request. Never together with password.
  readonly browse?: { readonly tooltip: string };
}

// The box's new value after its browse button, VS Code's value and valueSelection.
export interface InputBrowseResult {
  readonly value: string;
  readonly valueSelection?: readonly [number, number];
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const isOffset = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/** A [start, end) selection within a value of `length`, or undefined when it is not one. */
export function parseValueSelection(raw: unknown, length: number): readonly [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [start, end] = raw as unknown[];
  return isOffset(start, length) && isOffset(end, length) && start <= end ? [start, end] : undefined;
}

/** A clean copy of an input request within the overlay's bounds, or undefined; main asks nothing it cannot show. */
export function parseInputRequest(raw: unknown): Extract<OverlayRequest, { kind: 'input' }> | undefined {
  if (!isRecordValue(raw) || own(raw, 'kind') !== 'input') return undefined;
  const title = own(raw, 'title');
  const prompt = own(raw, 'prompt');
  const placeholder = own(raw, 'placeholder');
  const value = own(raw, 'value');
  const valueSelection = own(raw, 'valueSelection');
  const validation = own(raw, 'validation');
  const password = own(raw, 'password');
  const browse = own(raw, 'browse');
  const error = own(raw, 'error');
  const label = (text: unknown, max: number): boolean => typeof text === 'string' && text.length > 0 && text.length <= max;
  if (!label(prompt, MAX_OVERLAY_TEXT_LENGTH)) return undefined;
  if (title !== undefined && !label(title, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (placeholder !== undefined && !label(placeholder, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
  if (value !== undefined && !(typeof value === 'string' && value.length <= MAX_INPUT_VALUE_LENGTH)) return undefined;
  if (validation !== undefined && !(INPUT_VALIDATIONS as readonly unknown[]).includes(validation)) return undefined;
  if (password !== undefined && (typeof password !== 'boolean' || (password && (validation !== undefined || value !== undefined)))) return undefined;
  if (error !== undefined && (!label(error, MAX_OVERLAY_TEXT_LENGTH) || password === true)) return undefined;
  let tooltip: string | undefined;
  if (browse !== undefined) {
    if (!isRecordValue(browse) || Object.keys(browse).length !== 1 || password === true) return undefined;
    const text = own(browse, 'tooltip');
    if (!label(text, MAX_OVERLAY_LABEL_LENGTH)) return undefined;
    tooltip = text as string;
  }
  let selection: readonly [number, number] | undefined;
  if (valueSelection !== undefined) {
    selection = parseValueSelection(valueSelection, typeof value === 'string' ? value.length : 0);
    if (!selection) return undefined;
  }
  return {
    kind: 'input',
    prompt: prompt as string,
    ...(title !== undefined ? { title: title as string } : {}),
    ...(placeholder !== undefined ? { placeholder: placeholder as string } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(selection ? { valueSelection: selection } : {}),
    ...(validation !== undefined ? { validation: validation as InputValidation } : {}),
    ...(error !== undefined ? { error: error as string } : {}),
    ...(password === true ? { password: true } : {}),
    ...(tooltip !== undefined ? { browse: { tooltip } } : {}),
  };
}

/** The typed value when it answers `request`: a bounded string its validation kind accepts on `platform`. */
export function parseInputAnswer(raw: Record<string, unknown>, request: Extract<OverlayRequest, { kind: 'input' }>, platform: InputPlatform): string | undefined {
  const value = own(raw, 'value');
  if (typeof value !== 'string' || value.length > MAX_INPUT_VALUE_LENGTH) return undefined;
  return request.validation === undefined || inputProblem(request.validation, value, platform) === undefined ? value : undefined;
}

// One quick pick request's items and their serialized size, sized for about 50,000 ref rows (docs/invariants.md, "Source
// control", ref pickers).
export const MAX_QUICK_PICK_ITEMS = 50_000;
export const MAX_QUICK_PICK_BYTES: number = 12 * 1024 * 1024;

const utf8 = new TextEncoder();

// The texts main shows escaped (parseQuickPickRequest), so an item is counted as the overlay receives it.
const SHOWN_TEXTS: ReadonlySet<string> = new Set(['label', 'description', 'hint', 'group']);

/** An item's share of MAX_QUICK_PICK_BYTES: its JSON in UTF-8, its shown texts escaped. */
export function quickPickItemBytes(item: unknown): number {
  return utf8.encode(JSON.stringify(item, (key, value: unknown) => (typeof value === 'string' && SHOWN_TEXTS.has(key) ? visibleText(value) : value))).byteLength;
}

/** Whether a quick pick of these items fits MAX_QUICK_PICK_ITEMS and MAX_QUICK_PICK_BYTES. */
export function fitsQuickPick(items: readonly unknown[]): boolean {
  if (items.length > MAX_QUICK_PICK_ITEMS) return false;
  let bytes = 0;
  for (const item of items) {
    bytes += quickPickItemBytes(item);
    if (bytes > MAX_QUICK_PICK_BYTES) return false;
  }
  return true;
}

// Lucide icons a quick pick item may lead with, by role; the overlay maps each to its glyph.
export const OVERLAY_QUICK_PICK_ICONS = ['add', 'branch', 'remoteBranch', 'tag', 'detached', 'stash', 'worktree', 'remote'] as const;
export type OverlayQuickPickIcon = (typeof OVERLAY_QUICK_PICK_ICONS)[number];

// Within fitsQuickPick, ids unique; id within MAX_OVERLAY_ID_LENGTH, the texts within
// MAX_OVERLAY_LABEL_LENGTH (main cuts a longer label to its tail); main checks them (parseQuickPickRequest in main/overlay.ts).
export interface OverlayQuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly glyph?: TerminalGlyph;
  // tints the glyph with --d-ansi-<index of the color in TERMINAL_COLORS>
  readonly color?: TerminalColor;
  // the current value, marked with a check
  readonly current?: boolean;
  readonly icon?: OverlayQuickPickIcon;
  // a short trailing hint main localizes: "local", "2↓ 1↑"
  readonly hint?: string;
  // a section label; items sharing it are contiguous and the picker heads each run with it, kept above its first visible item
  readonly group?: string;
  // shown whatever the filter, after the matching items (VS Code's QuickPickItem.alwaysShow); never on a grouped item
  readonly alwaysShow?: true;
  // while the filter holds text, the item's description is that text, trimmed and quoted (a create item that will use it);
  // only with alwaysShow
  readonly echoQuery?: true;
  // a row that only informs ("N more refs not shown"): shown dimmed, never accepted
  readonly info?: true;
}

export type OverlayAnswer =
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'menu'; readonly itemId: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  // null removes the tag
  | { readonly kind: 'tagPicker'; readonly tag: string | null }
  // the Graph's ref choice; an empty selection is 'auto'
  | { readonly kind: 'refPicker'; readonly choice: OverlayRefChoice }
  // sent once the modal's exit animation ended
  | { readonly kind: 'settings'; readonly closed: true }
  // the index of the chosen action; null is Cancel. checked: the checkbox's state, present exactly when the request has one
  | { readonly kind: 'message'; readonly action: number | null; readonly checked?: boolean }
  | { readonly kind: 'notifications'; readonly action: 'open'; readonly entryId: string }
  // one of the actions of an entry awaiting its answer; main refuses any other
  | { readonly kind: 'notifications'; readonly action: 'answer'; readonly entryId: string; readonly index: number }
  // null: Escape; mention: the query had the @ prefix
  | { readonly kind: 'quickOpen'; readonly pick: QuickOpenPick | null }
  // a PaletteCommand id; main runs it only when it is listed and enabled for the captured focus context
  | { readonly kind: 'quickOpen'; readonly command: string }
  // Escape answers dismissed. projectKey: a reachable project the request offered, or null (the home folder) while it offered
  // none reachable; profileId: one terminalPickProfiles served for that project, or null for its host's default shell
  | { readonly kind: 'newTerminal'; readonly projectKey: string | null; readonly profileId: string | null }
  // Escape answers dismissed; main refuses an id the request did not offer. query: the filter text as typed, within
  // MAX_INPUT_VALUE_LENGTH
  | { readonly kind: 'quickPick'; readonly itemId: string; readonly query: string }
  // a pickMany quick pick's accept: 1..max distinct ids the request offered, none an info row, in the request's item order;
  // Escape answers dismissed
  | { readonly kind: 'quickPickMany'; readonly itemIds: readonly string[] }
  // Escape answers dismissed; main refuses a value its validation kind rejects
  | { readonly kind: 'input'; readonly value: string }
  // null: dropped outside every zone, or Escape
  | { readonly kind: 'dropZones'; readonly slot: GridSlot | null }
  // Escape answers dismissed; worktree only after the options came and were available, startRef one of their refs, and
  // bringChanges only with the current branch and uncommitted changes
  | { readonly kind: 'newChatMenu'; readonly choice: 'plain' }
  | ({ readonly kind: 'newChatMenu'; readonly choice: 'worktree' } & NewChatWorktree)
  // Continue in a worktree: one of the listed worktrees; the shell then calls newChatInWorktree
  | { readonly kind: 'newChatMenu'; readonly choice: 'continueInWorktree'; readonly worktreeId: string }
  // Escape answers dismissed, which main takes as Skip, Cancel or Close
  | ({ readonly kind: 'worktreeDialog' } & WorktreeDialogAnswer)
  // a picker's path, which main confines again; Escape and Cancel answer dismissed
  | { readonly kind: 'connect'; readonly path: string }
  // dontAskAgain only with keep or stop; Escape and the scrim answer cancel
  | { readonly kind: 'closeRemote'; readonly choice: CloseRemoteChoice; readonly dontAskAgain: boolean }
  | { readonly kind: 'gitCredentialConsent'; readonly choice: GitCredentialConsentChoice }
  // Escape, the scrim and Cancel refuse as accept: false does
  | { readonly kind: 'devcontainerTrust'; readonly accept: boolean }
  // every way the user closes it answers allow false
  | { readonly kind: 'allowYolo'; readonly allow: boolean }
  // a distinct row's id; Cancel and Escape answer dismissed
  | { readonly kind: 'clientCertificate'; readonly id: string };

// Each answers only the dialog of the same name.
export type WorktreeDialogAnswer =
  | { readonly dialog: 'setupReview'; readonly choice: 'run' | 'skip' }
  | { readonly dialog: 'delete'; readonly choice: 'delete' | 'cancel'; readonly deleteBranch: boolean }
  // message: non-blank, within MAX_WORKTREE_COMMIT_MESSAGE_CHARS, when committing
  | { readonly dialog: 'mergeMessage'; readonly choice: 'commit' | 'cancel'; readonly message: string }
  | { readonly dialog: 'rewritten'; readonly choice: 'rebase' | 'apply' | 'cancel' }
  | { readonly dialog: 'refusal'; readonly choice: 'ok' }
  | { readonly dialog: 'handOffConfirm'; readonly choice: 'move' | 'cancel' }
  // reveal (unregistered), prune (gitRecordOnly), delete and keep (noChat) name one of the request's items by path
  | { readonly dialog: 'leftovers'; readonly choice: 'close' }
  | { readonly dialog: 'leftovers'; readonly choice: 'prune' | 'reveal' | 'delete' | 'keep'; readonly path: string };

/**
 * The answer of a channel scoped to one popup. A closed popup (or a disposed overlay) is an expected state its page can
 * still ask in, so main answers it as a value; malformed input and real failures still reject.
 */
export type PopupAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'closed' };

export type QuickOpenMode = 'files' | 'commands';

export interface QuickOpenScope {
  readonly projectKey: string;
  readonly projectName: string;
  // '/' separated, relative to the project, ending in '/'; '' is the project's root
  readonly folder: string;
}

// A command of the desktop registry as the palette shows it, for the focus context main captured.
export interface PaletteCommand {
  readonly id: string;
  // "Category: Title", localized
  readonly label: string;
  // the same in English, which the palette also matches when the UI language is not English
  readonly englishLabel: string;
  readonly category: string;
  // the platform's display form, e.g. 'Ctrl+Shift+F' or '⇧⌘F'
  readonly accelerator: string | null;
  readonly enabled: boolean;
  readonly checked?: boolean;
  // run during this session; recent ones come first, most recent on top
  readonly recent: boolean;
}

// line and column: 1-based, from the query's :line[:column] suffix
export type QuickOpenPick =
  | {
      readonly kind: 'project';
      readonly projectKey: string;
      readonly relativePath: string;
      readonly line?: number;
      readonly column?: number;
      readonly mention: boolean;
    }
  // main opens it only when a query of the same request returned this authority and path
  | {
      readonly kind: 'path';
      readonly authority: string;
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
      readonly mention: false;
    };

// Characters of a Quick Open query; main refuses a longer one.
export const MAX_QUICK_OPEN_QUERY_LENGTH = 512;
// Results of a non-empty query.
export const MAX_QUICK_OPEN_RESULTS = 30;
// Rows of a typed folder's listing answer (docs/invariants.md "Desktop host", Quick Open).
export const MAX_QUICK_OPEN_LISTING_RESULTS = 1000;

// generation: the overlay's counter; a response carries the query's, so a late answer to an older query is ignored
export interface QuickOpenQuery {
  readonly query: string;
  readonly generation: number;
}

// [start, end) UTF-16 offsets into label or description
export type QuickOpenMatch = readonly [number, number];

export interface QuickOpenProjectResult {
  readonly kind: 'project';
  readonly projectKey: string;
  readonly projectName: string;
  readonly relativePath: string;
  // the file name
  readonly label: string;
  // the folder path relative to the project, '' at its root
  readonly description: string;
  readonly labelMatches: readonly QuickOpenMatch[];
  readonly descriptionMatches: readonly QuickOpenMatch[];
  readonly recent: boolean;
  // a typed folder's entry: what Tab puts in the query
  readonly complete?: QuickOpenCompletion;
  // the file the typed path names; the response's line and column belong to this row alone
  readonly exact?: true;
}

// A query main built for a row of a typed folder's listing; the renderer sets it as given and does no path arithmetic.
export interface QuickOpenCompletion {
  readonly input: string;
  // UTF-16 offset into input for the caret, before a closing quote; absent for its end
  readonly caret?: number;
}

// A file a typed absolute path names, or an entry of a typed folder, outside every project; path is its realpath.
export interface QuickOpenPathResult {
  readonly kind: 'path';
  // 'local' or the host authority main resolved it on
  readonly authority: string;
  // absolute, in that authority's path rules
  readonly path: string;
  // the file name
  readonly label: string;
  // the containing folder, absolute
  readonly description: string;
  readonly labelMatches: readonly QuickOpenMatch[];
  readonly descriptionMatches: readonly QuickOpenMatch[];
  // the host's name for its chip; absent on this computer
  readonly host?: string;
  readonly recent: false;
  // a typed folder's entry: what Tab puts in the query
  readonly complete?: QuickOpenCompletion;
  // the file the typed path names; the response's line and column belong to this row alone
  readonly exact?: true;
}

// A folder of a typed folder's listing, `..` included; never a pick: Enter, Tab and a click set the query to input.
export interface QuickOpenFolderResult {
  readonly kind: 'folder';
  // 'local' or the host authority main listed it on
  readonly authority: string;
  // the folder's name, or '..'
  readonly label: string;
  readonly labelMatches: readonly QuickOpenMatch[];
  readonly input: string;
  // UTF-16 offset into input for the caret, before a closing quote; absent for its end
  readonly caret?: number;
  // the host's name for its chip; absent on this computer
  readonly host?: string;
}

export type QuickOpenResult = QuickOpenProjectResult | QuickOpenPathResult | QuickOpenFolderResult;

/** A row's key, which main and the overlay share: a pick is accepted only under a key a row of the open request carried. */
export function quickOpenRowKey(row: QuickOpenResult | QuickOpenPick): string {
  if (row.kind === 'project') return JSON.stringify(['project', row.projectKey, row.relativePath]);
  if (row.kind === 'path') return JSON.stringify(['path', row.authority, row.path]);
  return JSON.stringify(['folder', row.authority, row.input]);
}

export interface QuickOpenResponse {
  readonly generation: number;
  // the selected project, for the current-project label
  readonly currentProjectKey?: string;
  // the query's :line[:column] suffix and @ prefix as main parsed them, so the overlay need not parse
  readonly line?: number;
  readonly column?: number;
  readonly mention: boolean;
  // recent files first, then per-project groups (empty query) or best score first
  readonly results: readonly QuickOpenResult[];
  // the index could not answer (its worker failed or went silent), so the empty results are no search result
  readonly failed?: true;
  // the text search answered while the query's typed path was still being resolved; quickOpenPath brings its row
  readonly pathPending?: true;
  // a typed folder's listing stopped at its bounds, more entries matching than the results hold; listed counts the listing's
  // entries among the results, the way up and a typed file the listing did not hold left out
  readonly truncated?: { readonly listed: number };
  // a typed folder answered with no rows: none of its entries starts with the typed name, it lists nothing and has no
  // parent, or it could not be read
  readonly emptyText?: 'folderNoMatch' | 'folderEmpty' | 'folderDenied';
  // folderNoMatch's typed name, the text after the query's last separator
  readonly emptyName?: string;
}

// A notification-center entry on screen; its id is the entry's.
export interface OverlayToast {
  readonly id: string;
  // epoch ms
  readonly at: number;
  readonly lifeMs: number;
  // life left when main sent it; main pauses it while the toast is held
  readonly remainingMs: number;
  readonly body: NotificationBody;
  // main never times it out: it shows no life bar and stays until it is answered, dismissed or withdrawn
  readonly sticky?: true;
}

// The Connect dialog's filled-in search, at most this many characters.
export const MAX_CONNECT_QUERY_LENGTH = 1024;

export interface OverlayState {
  readonly locale: ShellLocale;
  readonly platform: ShellPlatform;
}

// CSS px of the measured toast stack with its margin, 0×0 when no toast shows; the area's bottom-right corner is the popup
// window's.
export interface OverlayToastArea {
  readonly width: number;
  readonly height: number;
  // the layout boxes of the toasts and the "N more" pill, leaving ones included, from the area's top-left corner
  readonly parts: readonly OverlayRect[];
}

export interface OverlaySettingsAttached {
  readonly generation: number;
  readonly page: OverlaySettingsPage;
  readonly scopes?: OverlaySettingsScopes;
}

// The settings an attachment shows: the core's authority, the chat's settings folder (absent for none) and the chat
// (settingsPageChat in main/overlay-settings.ts).
export interface OverlaySettingsPage {
  readonly authority: string;
  readonly folder?: string;
  readonly chat: string;
}

export type OverlaySettingsScope = 'user' | 'machine' | 'project';

// A remote chat's settings tabs: User, its host (as this computer names it) and Project, with the tab shown.
export interface OverlaySettingsScopes {
  // canAllowYolo: the host has a saved record, so main may ask to allow YOLO on it
  readonly host: { readonly name: string; readonly color?: HostColor; readonly canAllowYolo?: true };
  // the Project tab's settings file, its path native to the host
  readonly projectFile?: string;
  readonly active: OverlaySettingsScope;
}

// Why the tab shown has no core: its host reconnects, waits for the user to sign in, failed for good, is offline with
// nothing reconnecting it (disconnected, removed), or runs a daemon of another version whose update banner waits for the
// user's switch; or the host is connected and its engine restarts, or is halted until the user restarts it.
export type OverlaySettingsAway = 'reconnecting' | 'signIn' | 'failed' | 'offline' | 'switchOffered' | 'restarting' | 'halted';

// What the waiting tab's banner says: switchOffered carries the update banner's facts (HostUpdate).
export type OverlaySettingsAwayState =
  | { readonly state: Exclude<OverlaySettingsAway, 'switchOffered'> }
  | { readonly state: 'switchOffered'; readonly update: { readonly serverVersion: string; readonly runningAgents: number } };

export interface OverlayPrefs {
  // every damocles.desktop.* setting, from user settings
  readonly values: Readonly<Record<string, unknown>>;
  // damocles.desktop.language as this run read it at launch; another value takes a restart
  readonly languageAtLaunch: DesktopLanguageSetting;
}

export type OverlayPrefWrite = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly error: string };

export interface DamoclesOverlayApi {
  getState(): Promise<OverlayState>;
  // the new state after the UI language changed; returns the unsubscribe
  onState(listener: (state: OverlayState) => void): () => void;
  // returns the unsubscribe
  onRequest(listener: (requestId: string, request: OverlayRequest) => void): () => void;
  // main withdrew the request (timeout, crash, window closing); the overlay closes it without answering
  onCancel(listener: (requestId: string) => void): () => void;
  // the page received the request; send as it arrives, before rendering it, within OVERLAY_ACK_TIMEOUT_MS
  ack(requestId: string): void;
  // the request is on screen, however long its render took
  shown(requestId: string): void;
  answer(requestId: string, answer: OverlayAnswer): void;
  // the popup page's toast stack (D52), from here to holdToast
  onToast(listener: (toast: OverlayToast) => void): () => void;
  // main timed the toast out, or it was answered or withdrawn in main
  onToastDismiss(listener: (id: string) => void): () => void;
  // undefined action = dismissed
  resolveToast(id: string, action?: ToastAnswer): void;
  // Copy on a link request's toast
  copyToast(id: string): void;
  reportToastArea(area: OverlayToastArea): void;
  // the pointer moved onto a toast or the "N more" pill (true) or off them (false)
  reportToastPointer(over: boolean): void;
  // F6 moved keyboard focus into the toast stack; returns the unsubscribe
  onToastsFocus(listener: () => void): () => void;
  // Escape in the toast stack; main moves keyboard focus back to the part F6 took it from
  leaveToasts(): void;
  // the pointer or focus is on the toast (true) or left it (false)
  holdToast(id: string, held: boolean): void;
  // getNotifications, clearNotifications and setDoNotDisturb answer closed unless the center is open
  getNotifications(): Promise<PopupAnswer<NotificationCenterState>>;
  onNotifications(listener: (state: NotificationCenterState) => void): () => void;
  clearNotifications(): Promise<PopupAnswer<void>>;
  setDoNotDisturb(on: boolean): Promise<PopupAnswer<void>>;
  // main's art to draw; answer each request once through rasterized
  onRasterize(listener: (request: OverlayRasterRequest) => void): () => void;
  // the PNG of a rasterize request, or null when it could not be drawn
  rasterized(id: string, png: Uint8Array | null): void;
  // the popup page: a popup arrived and its sound is on
  onChime(listener: (tone: ChimeTone) => void): () => void;
  // a settings view request; main drops it unless generation is the current attachment's
  settingsSend(generation: number, message: WebviewToExtensionMessage): void;
  onSettingsMessage(listener: (message: ExtensionToWebviewMessage) => void): () => void;
  onSettingsAttached(listener: (attached: OverlaySettingsAttached) => void): () => void;
  // the host tab's name and color after a rename or recolor; returns the unsubscribe
  onSettingsScopeHost(listener: (host: OverlaySettingsScopes['host']) => void): () => void;
  // the tab shown waits for its host's core, or (null) attached again; returns the unsubscribe
  onSettingsAway(listener: (away: OverlaySettingsAwayState | null) => void): () => void;
  // a remote chat's settings tab; main re-attaches the modal and answers the tab attached, or rejects when it could not
  setSettingsScope(scope: OverlaySettingsScope): Promise<PopupAnswer<OverlaySettingsScope>>;
  // the host or Project tab's Allow YOLO: main asks, hung from anchor, and answers whether the attached tab's host now allows
  // YOLO, or closed while the modal is closed
  allowHostYolo(anchor: OverlayRect): Promise<PopupAnswer<boolean>>;
  // the waiting tab's Sign in: main ends the modal and opens the Connect dialog on its host's prompt
  signInScopeHost(): Promise<PopupAnswer<void>>;
  onSettingsTarget(listener: (target: SettingsTarget) => void): () => void;
  getPrefs(): Promise<OverlayPrefs>;
  onPrefsChanged(listener: (prefs: OverlayPrefs) => void): () => void;
  // setPref, relaunch and resetLayout answer closed unless the settings modal is open
  // writes a damocles.desktop.* setting to user settings
  setPref(key: string, value: unknown): Promise<PopupAnswer<OverlayPrefWrite>>;
  // restarts the app through its normal quit path
  relaunch(): Promise<PopupAnswer<void>>;
  // window-layout.json back to the default layout, applied now
  resetLayout(): Promise<PopupAnswer<void>>;
  // Settings › About, from here on; each answers closed unless the settings modal is open
  getUpdate(): Promise<PopupAnswer<UpdateSnapshot>>;
  // pushed only while the settings modal is open; returns the unsubscribe
  onUpdate(listener: (snapshot: UpdateSnapshot) => void): () => void;
  // a no-op unless the state is idle, upToDate or error
  checkForUpdates(): Promise<PopupAnswer<void>>;
  // rejects unless the state is ready
  restartToUpdate(): Promise<PopupAnswer<void>>;
  showUpdateLog(): Promise<PopupAnswer<void>>;
  // main composes the text and writes it through ClipboardService
  copyVersionInfo(): Promise<PopupAnswer<void>>;
  getVersionInfo(): Promise<PopupAnswer<VersionInfo>>;
  // macOS: rejects unless the state is available
  openReleasePage(): Promise<PopupAnswer<void>>;
  getReleaseIndex(): Promise<PopupAnswer<ReleaseIndex>>;
  // rejects a version not in the index
  getReleaseNotes(version: string): Promise<PopupAnswer<ReleaseNotes>>;
  // answers closed unless a quickOpen request is open
  queryQuickOpen(query: QuickOpenQuery): Promise<PopupAnswer<QuickOpenResponse>>;
  // answers closed unless a quickOpen request is open
  quickOpenPath(generation: number): Promise<PopupAnswer<QuickOpenResponse | null>>;
  // answers closed unless a quickOpen request is open
  listCommands(): Promise<PopupAnswer<PaletteCommand[]>>;
  // answers closed unless the settings modal is open
  getTerminalProfiles(): Promise<PopupAnswer<TerminalProfileReport>>;
  // returns the unsubscribe
  onTerminalProfiles(listener: (report: TerminalProfileReport) => void): () => void;
  // the open newTerminal request's step 2; answers closed unless one is open
  terminalPickProfiles(request: { readonly projectKey: string | null }): Promise<PopupAnswer<TerminalPickShells>>;
  // the open input request's browse button; null leaves the box as it is; answers closed unless an input request is open
  browseInput(value: string): Promise<PopupAnswer<InputBrowseResult | null>>;
  // the shell's pane drag while a dropZones request is open; returns the unsubscribe
  onDropZonesPointer(listener: (pointer: DropZonesPointer) => void): () => void;
  // the open newChatMenu's worktree options; answers closed unless one is open
  worktreeOptions(): Promise<PopupAnswer<ChatsWorktreeOptions>>;
  continueWorktrees(): Promise<PopupAnswer<readonly ChatsContinueWorktree[]>>;
  // Generate in the open mergeMessage dialog; null: no message came, and main told the user why
  generateWorktreeMessage(): Promise<PopupAnswer<{ readonly message: string } | null>>;
  // The Connect dialog, from here on; each answers closed unless a connect request is open
  checkHostName(name: string, hostId?: string): Promise<PopupAnswer<NameCheck>>;
  renameHost(hostId: string, name: string): Promise<PopupAnswer<NameCheck>>;
  parseHost(input: string): Promise<PopupAnswer<HostParseResult>>;
  startConnect(target: ConnectTarget): Promise<PopupAnswer<ConnectStartResult>>;
  // null cancels the prompt, which fails the attempt
  // remember: "Remember on this computer", only for a secret prompt that offered it
  answerConnect(attemptId: string, promptId: string, answer: string | null, remember?: boolean): Promise<PopupAnswer<void>>;
  cancelConnect(attemptId: string): Promise<PopupAnswer<void>>;
  browseHost(hostId: string, path?: string): Promise<PopupAnswer<RemoteBrowseResult>>;
  pickHostFolder(hostId: string, path: string): Promise<PopupAnswer<{ readonly projectKey: string }>>;
  hostRuns(hostId: string): Promise<PopupAnswer<readonly HostRun[]>>;
  killHostRun(hostId: string, runId: string): Promise<PopupAnswer<void>>;
  openHostRun(hostId: string, runId: string): Promise<PopupAnswer<void>>;
  showHostLog(hostId: string): Promise<PopupAnswer<void>>;
  setInstallFolder(hostId: string, folder: string | null): Promise<PopupAnswer<InstallFolderResult>>;
  // rejects unless the host's failure is hostKeyChanged
  copyHostKeyCommand(hostId: string): Promise<PopupAnswer<void>>;
  // returns the unsubscribe
  onConnectStep(listener: (event: ConnectStepEvent) => void): () => void;
  onConnectHosts(listener: (hosts: readonly HostCardInfo[]) => void): () => void;
  onConnectDistros(listener: (distros: readonly WslDistroInfo[]) => void): () => void;
  // answers closed unless a connect or closeRemote request is open
  allowBackgroundWork(hostId: string): Promise<PopupAnswer<LingerResult>>;
  // Settings > Remote hosts and the host card's actions; each answers closed unless a connect or settings request is open
  listRemoteHosts(): Promise<PopupAnswer<readonly RemoteHostEntry[]>>;
  setHostSetting(hostId: string, change: HostSettingChange): Promise<PopupAnswer<void>>;
  revokeCredentialHost(hostId: string, credentialHost: string): Promise<PopupAnswer<void>>;
  deliverHeldMemory(hostId: string, queueId: string): Promise<PopupAnswer<HeldMemoryResult>>;
  discardHeldMemory(hostId: string, queueId: string): Promise<PopupAnswer<HeldMemoryResult>>;
  setUpPasswordless(hostId: string): Promise<PopupAnswer<PasswordlessResult>>;
  removalInfo(hostId: string): Promise<PopupAnswer<RemovalInfo>>;
  removeServer(hostId: string, options: RemoveServerOptions): Promise<PopupAnswer<RemoveServerResult>>;
  retryRemoval(hostId: string): Promise<PopupAnswer<RemoveServerResult>>;
  getHostOperations(hostId: string): Promise<PopupAnswer<HostOperations>>;
  // Convert to WSL 2: the running work to list in the confirmation, then the run itself, which a second call joins
  conversionInfo(hostId: string): Promise<PopupAnswer<{ readonly runs: readonly RemovalRun[] }>>;
  convertToWsl2(hostId: string): Promise<PopupAnswer<void>>;
  // Rebuild Container: the running work to list in the confirmation, then the run itself, which a second call joins
  rebuildInfo(hostId: string): Promise<PopupAnswer<{ readonly runs: readonly RemovalRun[] }>>;
  rebuildContainer(hostId: string): Promise<PopupAnswer<void>>;
  // the attach list and the devcontainer folder pick; each answers closed unless a connect request is open
  listContainers(via?: string): Promise<PopupAnswer<ContainerListResult>>;
  pickContainerFolder(): Promise<PopupAnswer<ContainerFolderPick | null>>;
  checkContainerFolder(via: string, folder: string): Promise<PopupAnswer<ContainerFolderPick>>;
  forgetHost(hostId: string): Promise<PopupAnswer<void>>;
  // answers closed unless a connect request is open
  openHostSettings(hostId: string): Promise<PopupAnswer<void>>;
  // returns the unsubscribe
  onHostEntries(listener: (hosts: readonly RemoteHostEntry[]) => void): () => void;
  onHostOperations(listener: (operations: HostOperations) => void): () => void;
  onCloseRemoteRows(listener: (rows: readonly CloseRemoteRow[]) => void): () => void;
}
