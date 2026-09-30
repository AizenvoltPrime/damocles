import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import type { PanelTheme } from './panel-channels';
import { SHELL_CHANNELS, type ContentBounds, type DamoclesShellApi, type ShellState, type ShellToast } from './shell-channels';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// The shell HTML carries the theme from its creation; this keeps it current after an OS theme change.
ipcRenderer.on(SHELL_CHANNELS.theme, (_event, theme: PanelTheme) => {
  const style = document.getElementById(HOST_THEME_STYLE_ID);
  if (style) style.textContent = theme.css;
  document.body.classList.remove('vscode-dark', 'vscode-light');
  document.body.classList.add(`vscode-${theme.kind}`);
  document.body.dataset['vscodeThemeKind'] = `vscode-${theme.kind}`;
});

const api: DamoclesShellApi = {
  getState: () => ipcRenderer.invoke(SHELL_CHANNELS.getState) as Promise<ShellState>,
  onState: (listener) => subscribe<ShellState>(SHELL_CHANNELS.state, listener),
  addProject: () => ipcRenderer.invoke(SHELL_CHANNELS.addProject) as Promise<void>,
  removeProject: (key) => ipcRenderer.invoke(SHELL_CHANNELS.removeProject, key) as ReturnType<DamoclesShellApi['removeProject']>,
  selectProject: (key) => ipcRenderer.invoke(SHELL_CHANNELS.selectProject, key) as Promise<void>,
  grantTrust: (key) => ipcRenderer.invoke(SHELL_CHANNELS.grantTrust, key) as Promise<void>,
  newTab: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.newTab, projectKey) as Promise<void>,
  selectTab: (id) => ipcRenderer.invoke(SHELL_CHANNELS.selectTab, id) as Promise<void>,
  closeTab: (id) => ipcRenderer.invoke(SHELL_CHANNELS.closeTab, id) as Promise<void>,
  togglePane: (id) => ipcRenderer.invoke(SHELL_CHANNELS.togglePane, id) as Promise<void>,
  moveTab: (id, toIndex) => ipcRenderer.invoke(SHELL_CHANNELS.moveTab, id, toIndex) as Promise<void>,
  reportContentBounds: (bounds: ContentBounds) => {
    ipcRenderer.send(SHELL_CHANNELS.contentBounds, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  },
  onToast: (listener) => subscribe<ShellToast>(SHELL_CHANNELS.toast, listener),
  onToastDismiss: (listener) => subscribe<string>(SHELL_CHANNELS.toastDismiss, listener),
  resolveToast: (id, action) => {
    ipcRenderer.send(SHELL_CHANNELS.resolveToast, id, action);
  },
  onFocusTabStrip: (listener) => subscribe<void>(SHELL_CHANNELS.focusTabStrip, () => listener()),
};

contextBridge.exposeInMainWorld('damoclesShell', api);
