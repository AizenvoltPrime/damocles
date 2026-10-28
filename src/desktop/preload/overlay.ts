import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { applyHostTheme } from './apply-theme';
import type { PanelTheme } from './panel-channels';
import {
  OVERLAY_CHANNELS,
  type CloseRemoteRow,
  type ConnectStartResult,
  type ConnectStepEvent,
  type DamoclesOverlayApi,
  type HostCardInfo,
  type HostParseResult,
  type HostRun,
  type InstallFolderResult,
  type LingerResult,
  type NameCheck,
  type RemoteBrowseResult,
  type RemoteHostEntry,
  type RemovalInfo,
  type RemoveServerResult,
  type PasswordlessResult,
  type PasswordlessStepEvent,
  type InputBrowseResult,
  type OverlayPrefs,
  type OverlayPrefWrite,
  type OverlayRasterRequest,
  type OverlayRequest,
  type OverlaySettingsAttached,
  type OverlaySettingsScope,
  type OverlaySettingsScopes,
  type OverlayState,
  type OverlayToast,
  type PaletteCommand,
  type PopupAnswer,
  type QuickOpenResponse,
} from './overlay-channels';
import type { ChatsContinueWorktree, ChatsWorktreeOptions, DropZonesPointer } from './shell-channels';
import type { ChimeTone, NotificationCenterState } from './notifications';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { SettingsTarget } from '../../shared/settings-sections';
import type { ReleaseIndex, ReleaseNotes, UpdateSnapshot, VersionInfo } from './updates';
import type { TerminalProfileReport } from './terminal-channels';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// The overlay HTML carries the theme from its creation; this keeps it current after a theme change.
ipcRenderer.on(OVERLAY_CHANNELS.theme, (_event, theme: PanelTheme) => applyHostTheme(theme));

const api: DamoclesOverlayApi = {
  getState: () => ipcRenderer.invoke(OVERLAY_CHANNELS.getState) as Promise<OverlayState>,
  onState: (listener) => subscribe<OverlayState>(OVERLAY_CHANNELS.state, listener),
  onRequest: (listener) => {
    const handler = (_event: IpcRendererEvent, message: { requestId: string; request: OverlayRequest }): void => listener(message.requestId, message.request);
    ipcRenderer.on(OVERLAY_CHANNELS.request, handler);
    return () => {
      ipcRenderer.removeListener(OVERLAY_CHANNELS.request, handler);
    };
  },
  onCancel: (listener) => subscribe<string>(OVERLAY_CHANNELS.cancel, listener),
  ack: (requestId) => {
    ipcRenderer.send(OVERLAY_CHANNELS.ack, requestId);
  },
  shown: (requestId) => {
    ipcRenderer.send(OVERLAY_CHANNELS.shown, requestId);
  },
  answer: (requestId, answer) => {
    ipcRenderer.send(OVERLAY_CHANNELS.answer, requestId, answer);
  },
  onToast: (listener) => subscribe<OverlayToast>(OVERLAY_CHANNELS.toast, listener),
  onToastDismiss: (listener) => subscribe<string>(OVERLAY_CHANNELS.toastDismiss, listener),
  resolveToast: (id, action) => {
    ipcRenderer.send(OVERLAY_CHANNELS.resolveToast, id, action);
  },
  reportToastArea: (area) => {
    const parts = area.parts.map((part) => ({ x: part.x, y: part.y, width: part.width, height: part.height }));
    ipcRenderer.send(OVERLAY_CHANNELS.toastArea, { width: area.width, height: area.height, parts });
  },
  reportToastPointer: (over) => {
    ipcRenderer.send(OVERLAY_CHANNELS.toastsPointer, over);
  },
  onToastsFocus: (listener) => subscribe<unknown>(OVERLAY_CHANNELS.toastsFocus, () => listener()),
  leaveToasts: () => {
    ipcRenderer.send(OVERLAY_CHANNELS.toastsLeave);
  },
  holdToast: (id, held) => {
    ipcRenderer.send(OVERLAY_CHANNELS.toastHold, id, held);
  },
  getNotifications: () => ipcRenderer.invoke(OVERLAY_CHANNELS.notificationsGet) as Promise<PopupAnswer<NotificationCenterState>>,
  onNotifications: (listener) => subscribe<NotificationCenterState>(OVERLAY_CHANNELS.notificationsState, listener),
  clearNotifications: () => ipcRenderer.invoke(OVERLAY_CHANNELS.notificationsClear) as Promise<PopupAnswer<void>>,
  setDoNotDisturb: (on) => ipcRenderer.invoke(OVERLAY_CHANNELS.notificationsDnd, on) as Promise<PopupAnswer<void>>,
  onRasterize: (listener) => subscribe<OverlayRasterRequest>(OVERLAY_CHANNELS.rasterize, listener),
  rasterized: (id, png) => {
    ipcRenderer.send(OVERLAY_CHANNELS.rasterized, id, png);
  },
  onChime: (listener) => subscribe<ChimeTone>(OVERLAY_CHANNELS.chime, listener),
  settingsSend: (generation, message) => {
    ipcRenderer.send(OVERLAY_CHANNELS.settingsSend, { generation, message });
  },
  onSettingsMessage: (listener) => subscribe<ExtensionToWebviewMessage>(OVERLAY_CHANNELS.settingsMessage, listener),
  onSettingsAttached: (listener) => subscribe<OverlaySettingsAttached>(OVERLAY_CHANNELS.settingsAttached, listener),
  onSettingsScopeHost: (listener) => subscribe<OverlaySettingsScopes['host']>(OVERLAY_CHANNELS.settingsScopeHost, listener),
  onSettingsTarget: (listener) => subscribe<SettingsTarget>(OVERLAY_CHANNELS.settingsTarget, listener),
  setSettingsScope: (scope) => ipcRenderer.invoke(OVERLAY_CHANNELS.settingsScope, { scope }) as Promise<PopupAnswer<OverlaySettingsScope>>,
  getPrefs: () => ipcRenderer.invoke(OVERLAY_CHANNELS.prefsGet) as Promise<OverlayPrefs>,
  onPrefsChanged: (listener) => subscribe<OverlayPrefs>(OVERLAY_CHANNELS.prefsChanged, listener),
  setPref: (key, value) => ipcRenderer.invoke(OVERLAY_CHANNELS.prefsSet, { key, value }) as Promise<PopupAnswer<OverlayPrefWrite>>,
  relaunch: () => ipcRenderer.invoke(OVERLAY_CHANNELS.relaunch) as Promise<PopupAnswer<void>>,
  resetLayout: () => ipcRenderer.invoke(OVERLAY_CHANNELS.layoutReset) as Promise<PopupAnswer<void>>,
  getUpdate: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateGet) as Promise<PopupAnswer<UpdateSnapshot>>,
  onUpdate: (listener) => subscribe<UpdateSnapshot>(OVERLAY_CHANNELS.updateState, listener),
  checkForUpdates: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateCheck) as Promise<PopupAnswer<void>>,
  restartToUpdate: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateRestart) as Promise<PopupAnswer<void>>,
  showUpdateLog: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateShowLog) as Promise<PopupAnswer<void>>,
  copyVersionInfo: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateCopyInfo) as Promise<PopupAnswer<void>>,
  getVersionInfo: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateVersionInfo) as Promise<PopupAnswer<VersionInfo>>,
  openReleasePage: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateOpenReleasePage) as Promise<PopupAnswer<void>>,
  getReleaseIndex: () => ipcRenderer.invoke(OVERLAY_CHANNELS.releaseNotesIndex) as Promise<PopupAnswer<ReleaseIndex>>,
  getReleaseNotes: (version) => ipcRenderer.invoke(OVERLAY_CHANNELS.releaseNotesGet, version) as Promise<PopupAnswer<ReleaseNotes>>,
  queryQuickOpen: (query) => ipcRenderer.invoke(OVERLAY_CHANNELS.quickOpenQuery, { query: query.query, generation: query.generation }) as Promise<PopupAnswer<QuickOpenResponse>>,
  listCommands: () => ipcRenderer.invoke(OVERLAY_CHANNELS.commandsList, {}) as Promise<PopupAnswer<PaletteCommand[]>>,
  getTerminalProfiles: () => ipcRenderer.invoke(OVERLAY_CHANNELS.terminalProfiles, {}) as Promise<PopupAnswer<TerminalProfileReport>>,
  onTerminalProfiles: (listener) => subscribe<TerminalProfileReport>(OVERLAY_CHANNELS.terminalProfilesChanged, listener),
  onDropZonesPointer: (listener) => subscribe<DropZonesPointer>(OVERLAY_CHANNELS.dropZonesPointer, listener),
  browseInput: (value) => ipcRenderer.invoke(OVERLAY_CHANNELS.inputBrowse, { value }) as Promise<PopupAnswer<InputBrowseResult | null>>,
  worktreeOptions: () => ipcRenderer.invoke(OVERLAY_CHANNELS.worktreeOptions, {}) as Promise<PopupAnswer<ChatsWorktreeOptions>>,
  continueWorktrees: () => ipcRenderer.invoke(OVERLAY_CHANNELS.continueWorktrees, {}) as Promise<PopupAnswer<readonly ChatsContinueWorktree[]>>,
  generateWorktreeMessage: () => ipcRenderer.invoke(OVERLAY_CHANNELS.worktreeGenerateMessage, {}) as Promise<PopupAnswer<{ readonly message: string } | null>>,
  checkHostName: (name, hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsCheckName, hostId === undefined ? { name } : { name, hostId }) as Promise<PopupAnswer<NameCheck>>,
  renameHost: (hostId, name) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsRename, { hostId, name }) as Promise<PopupAnswer<NameCheck>>,
  parseHost: (input) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsParse, { input }) as Promise<PopupAnswer<HostParseResult>>,
  startConnect: (target) => {
    const plain = 'hostId' in target ? { hostId: target.hostId } : 'alias' in target ? { alias: target.alias, name: target.name } : { input: target.input, name: target.name };
    return ipcRenderer.invoke(OVERLAY_CHANNELS.connectStart, { target: plain }) as Promise<PopupAnswer<ConnectStartResult>>;
  },
  answerConnect: (attemptId, promptId, answer, remember) => ipcRenderer.invoke(OVERLAY_CHANNELS.connectAnswer, remember === true ? { attemptId, promptId, answer, remember } : { attemptId, promptId, answer }) as Promise<PopupAnswer<void>>,
  cancelConnect: (attemptId) => ipcRenderer.invoke(OVERLAY_CHANNELS.connectCancel, { attemptId }) as Promise<PopupAnswer<void>>,
  browseHost: (hostId, path) => ipcRenderer.invoke(OVERLAY_CHANNELS.connectBrowse, path === undefined ? { hostId } : { hostId, path }) as Promise<PopupAnswer<RemoteBrowseResult>>,
  pickHostFolder: (hostId, path) => ipcRenderer.invoke(OVERLAY_CHANNELS.connectPickFolder, { hostId, path }) as Promise<PopupAnswer<{ readonly projectKey: string }>>,
  hostRuns: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsRuns, { hostId }) as Promise<PopupAnswer<readonly HostRun[]>>,
  killHostRun: (hostId, runId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsKillRun, { hostId, runId }) as Promise<PopupAnswer<void>>,
  openHostRun: (hostId, runId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsOpenRun, { hostId, runId }) as Promise<PopupAnswer<void>>,
  showHostLog: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsShowLog, { hostId }) as Promise<PopupAnswer<void>>,
  setInstallFolder: (hostId, folder) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsSetInstallFolder, { hostId, folder }) as Promise<PopupAnswer<InstallFolderResult>>,
  copyHostKeyCommand: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsCopyHostKeyCommand, { hostId }) as Promise<PopupAnswer<void>>,
  onConnectStep: (listener) => subscribe<ConnectStepEvent>(OVERLAY_CHANNELS.connectStep, listener),
  onConnectHosts: (listener) => subscribe<readonly HostCardInfo[]>(OVERLAY_CHANNELS.connectHosts, listener),
  allowBackgroundWork: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsAllowBackground, { hostId }) as Promise<PopupAnswer<LingerResult>>,
  onCloseRemoteRows: (listener) => subscribe<readonly CloseRemoteRow[]>(OVERLAY_CHANNELS.closeRemoteRows, listener),
  listRemoteHosts: () => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsList, {}) as Promise<PopupAnswer<readonly RemoteHostEntry[]>>,
  setHostSetting: (hostId, change) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsSetSetting, { hostId, change: { key: change.key, value: change.value } }) as Promise<PopupAnswer<void>>,
  revokeCredentialHost: (hostId, credentialHost) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsRevokeCredential, { hostId, credentialHost }) as Promise<PopupAnswer<void>>,
  setUpPasswordless: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsSetUpPasswordless, { hostId }) as Promise<PopupAnswer<PasswordlessResult>>,
  removalInfo: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsRemovalInfo, { hostId }) as Promise<PopupAnswer<RemovalInfo>>,
  removeServer: (hostId, options) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsRemoveServer, { hostId, options: { removeKey: options.removeKey, disableLinger: options.disableLinger } }) as Promise<PopupAnswer<RemoveServerResult>>,
  retryRemoval: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsRetryRemoval, { hostId }) as Promise<PopupAnswer<RemoveServerResult>>,
  forgetHost: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsForget, { hostId }) as Promise<PopupAnswer<void>>,
  openHostSettings: (hostId) => ipcRenderer.invoke(OVERLAY_CHANNELS.hostsOpenSettings, { hostId }) as Promise<PopupAnswer<void>>,
  onHostEntries: (listener) => subscribe<readonly RemoteHostEntry[]>(OVERLAY_CHANNELS.hostsEntries, listener),
  onPasswordlessStep: (listener) => subscribe<PasswordlessStepEvent>(OVERLAY_CHANNELS.hostsPasswordlessStep, listener),
};

contextBridge.exposeInMainWorld('damoclesOverlay', api);
