import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import type { PanelTheme } from './panel-channels';
import { PANE_CHANNELS, type DamoclesPaneApi, type PaneState } from './pane-channels';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// The pane HTML carries the theme from its creation; this keeps it current after an OS theme change.
ipcRenderer.on(PANE_CHANNELS.theme, (_event, theme: PanelTheme) => {
  const style = document.getElementById(HOST_THEME_STYLE_ID);
  if (style) style.textContent = theme.css;
  document.body.classList.remove('vscode-dark', 'vscode-light');
  document.body.classList.add(`vscode-${theme.kind}`);
  document.body.dataset['vscodeThemeKind'] = `vscode-${theme.kind}`;
});

const api: DamoclesPaneApi = {
  getState: () => ipcRenderer.invoke(PANE_CHANNELS.getState) as Promise<PaneState>,
  onState: (listener) => subscribe<PaneState>(PANE_CHANNELS.state, listener),
  onFocusRequest: (listener) => subscribe<void>(PANE_CHANNELS.focus, () => listener()),
  requestWidth: (width, commit) => {
    ipcRenderer.send(PANE_CHANNELS.requestWidth, width, commit);
  },
  selectPage: (id) => ipcRenderer.invoke(PANE_CHANNELS.selectPage, id) as Promise<void>,
  closePage: (id) => ipcRenderer.invoke(PANE_CHANNELS.closePage, id) as Promise<void>,
  newPage: () => ipcRenderer.invoke(PANE_CHANNELS.newPage) as Promise<void>,
  navigate: (id, url) => ipcRenderer.invoke(PANE_CHANNELS.navigate, id, url) as Promise<boolean>,
  goBack: (id) => ipcRenderer.invoke(PANE_CHANNELS.goBack, id) as Promise<void>,
  goForward: (id) => ipcRenderer.invoke(PANE_CHANNELS.goForward, id) as Promise<void>,
  reload: (id) => ipcRenderer.invoke(PANE_CHANNELS.reload, id) as Promise<void>,
  openExternal: (id) => ipcRenderer.invoke(PANE_CHANNELS.openExternal, id) as Promise<void>,
  pickElement: (id) => ipcRenderer.invoke(PANE_CHANNELS.pickElement, id) as Promise<void>,
  openDevTools: (id) => ipcRenderer.invoke(PANE_CHANNELS.openDevTools, id) as Promise<void>,
  setMaximized: (maximized) => ipcRenderer.invoke(PANE_CHANNELS.setMaximized, maximized) as Promise<void>,
  setCollapsed: (collapsed) => ipcRenderer.invoke(PANE_CHANNELS.setCollapsed, collapsed) as Promise<void>,
};

contextBridge.exposeInMainWorld('damoclesPane', api);
