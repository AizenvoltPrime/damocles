import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { applyHostTheme } from './apply-theme';
import type { PanelTheme } from './panel-channels';
import {
  OVERLAY_CHANNELS,
  type DamoclesOverlayApi,
  type OverlayPrefs,
  type OverlayPrefWrite,
  type OverlayRasterRequest,
  type OverlayRequest,
  type OverlaySettingsAttached,
  type OverlayState,
  type OverlayToast,
  type PaletteCommand,
  type QuickOpenResponse,
} from './overlay-channels';
import type { DropZonesPointer } from './shell-channels';
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
  getNotifications: () => ipcRenderer.invoke(OVERLAY_CHANNELS.notificationsGet) as Promise<NotificationCenterState>,
  onNotifications: (listener) => subscribe<NotificationCenterState>(OVERLAY_CHANNELS.notificationsState, listener),
  clearNotifications: () => ipcRenderer.invoke(OVERLAY_CHANNELS.notificationsClear) as Promise<void>,
  setDoNotDisturb: (on) => ipcRenderer.invoke(OVERLAY_CHANNELS.notificationsDnd, on) as Promise<void>,
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
  onSettingsTarget: (listener) => subscribe<SettingsTarget>(OVERLAY_CHANNELS.settingsTarget, listener),
  getPrefs: () => ipcRenderer.invoke(OVERLAY_CHANNELS.prefsGet) as Promise<OverlayPrefs>,
  onPrefsChanged: (listener) => subscribe<OverlayPrefs>(OVERLAY_CHANNELS.prefsChanged, listener),
  setPref: (key, value) => ipcRenderer.invoke(OVERLAY_CHANNELS.prefsSet, { key, value }) as Promise<OverlayPrefWrite>,
  relaunch: () => ipcRenderer.invoke(OVERLAY_CHANNELS.relaunch) as Promise<void>,
  resetLayout: () => ipcRenderer.invoke(OVERLAY_CHANNELS.layoutReset) as Promise<void>,
  getUpdate: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateGet) as Promise<UpdateSnapshot>,
  onUpdate: (listener) => subscribe<UpdateSnapshot>(OVERLAY_CHANNELS.updateState, listener),
  checkForUpdates: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateCheck) as Promise<void>,
  restartToUpdate: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateRestart) as Promise<void>,
  showUpdateLog: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateShowLog) as Promise<void>,
  copyVersionInfo: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateCopyInfo) as Promise<void>,
  getVersionInfo: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateVersionInfo) as Promise<VersionInfo>,
  openReleasePage: () => ipcRenderer.invoke(OVERLAY_CHANNELS.updateOpenReleasePage) as Promise<void>,
  getReleaseIndex: () => ipcRenderer.invoke(OVERLAY_CHANNELS.releaseNotesIndex) as Promise<ReleaseIndex>,
  getReleaseNotes: (version) => ipcRenderer.invoke(OVERLAY_CHANNELS.releaseNotesGet, version) as Promise<ReleaseNotes>,
  queryQuickOpen: (query) => ipcRenderer.invoke(OVERLAY_CHANNELS.quickOpenQuery, { query: query.query, generation: query.generation }) as Promise<QuickOpenResponse>,
  listCommands: () => ipcRenderer.invoke(OVERLAY_CHANNELS.commandsList, {}) as Promise<PaletteCommand[]>,
  getTerminalProfiles: () => ipcRenderer.invoke(OVERLAY_CHANNELS.terminalProfiles, {}) as Promise<TerminalProfileReport>,
  onTerminalProfiles: (listener) => subscribe<TerminalProfileReport>(OVERLAY_CHANNELS.terminalProfilesChanged, listener),
  onDropZonesPointer: (listener) => subscribe<DropZonesPointer>(OVERLAY_CHANNELS.dropZonesPointer, listener),
};

contextBridge.exposeInMainWorld('damoclesOverlay', api);
