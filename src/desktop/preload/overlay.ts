import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { applyHostTheme } from './apply-theme';
import type { PanelTheme } from './panel-channels';
import {
  OVERLAY_CHANNELS,
  type DamoclesOverlayApi,
  type OverlayPrefs,
  type OverlayPrefWrite,
  type OverlayRequest,
  type OverlaySettingsAttached,
  type OverlayState,
  type OverlayToast,
} from './overlay-channels';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { SettingsTarget } from '../../shared/settings-sections';

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
  reportToastArea: (size) => {
    ipcRenderer.send(OVERLAY_CHANNELS.toastArea, { width: size.width, height: size.height });
  },
  onToastsFocus: (listener) => subscribe<unknown>(OVERLAY_CHANNELS.toastsFocus, () => listener()),
  leaveToasts: () => {
    ipcRenderer.send(OVERLAY_CHANNELS.toastsLeave);
  },
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
};

contextBridge.exposeInMainWorld('damoclesOverlay', api);
