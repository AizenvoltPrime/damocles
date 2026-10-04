import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { applyHostTheme } from './apply-theme';
import type { PanelTheme } from './panel-channels';
import type { OverlayAnswer } from './overlay-channels';
import {
  SHELL_CHANNELS,
  type ChatMutationResult,
  type ContentBounds,
  type DamoclesShellApi,
  type SelectChatResult,
  type ShellChatList,
  type ShellFocusPart,
  type ShellState,
} from './shell-channels';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// The shell HTML carries the theme from its creation; this keeps it current after a theme change.
ipcRenderer.on(SHELL_CHANNELS.theme, (_event, theme: PanelTheme) => applyHostTheme(theme));

const api: DamoclesShellApi = {
  getState: () => ipcRenderer.invoke(SHELL_CHANNELS.getState) as Promise<ShellState>,
  onState: (listener) => subscribe<ShellState>(SHELL_CHANNELS.state, listener),
  addProject: () => ipcRenderer.invoke(SHELL_CHANNELS.addProject) as Promise<void>,
  removeProject: (key) => ipcRenderer.invoke(SHELL_CHANNELS.removeProject, key) as ReturnType<DamoclesShellApi['removeProject']>,
  selectProject: (key) => ipcRenderer.invoke(SHELL_CHANNELS.selectProject, key) as Promise<void>,
  grantTrust: (key) => ipcRenderer.invoke(SHELL_CHANNELS.grantTrust, key) as Promise<void>,
  togglePane: () => ipcRenderer.invoke(SHELL_CHANNELS.togglePane) as Promise<void>,
  listChats: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.chatsList, projectKey) as Promise<ShellChatList>,
  searchChats: (projectKey, query) => ipcRenderer.invoke(SHELL_CHANNELS.chatsSearch, projectKey, query) as Promise<ShellChatList>,
  onChatsChanged: (listener) => subscribe<string>(SHELL_CHANNELS.chatsChanged, listener),
  selectChat: (chatId) => ipcRenderer.invoke(SHELL_CHANNELS.chatsSelect, chatId) as Promise<SelectChatResult>,
  newChat: (projectKey) => ipcRenderer.invoke(SHELL_CHANNELS.chatsNew, projectKey) as Promise<void>,
  renameChat: (chatId, name) => ipcRenderer.invoke(SHELL_CHANNELS.chatsRename, chatId, name) as Promise<ChatMutationResult>,
  tagChat: (chatId, tag) => ipcRenderer.invoke(SHELL_CHANNELS.chatsTag, chatId, tag) as Promise<ChatMutationResult>,
  deleteChat: (chatId) => ipcRenderer.invoke(SHELL_CHANNELS.chatsDelete, chatId) as Promise<ChatMutationResult>,
  requestOverlay: (request) => ipcRenderer.invoke(SHELL_CHANNELS.overlayRequest, request) as Promise<OverlayAnswer>,
  openAppMenu: (anchor) => ipcRenderer.invoke(SHELL_CHANNELS.appMenu, { x: anchor.x, y: anchor.y }) as Promise<void>,
  toggleTheme: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleTheme) as Promise<void>,
  toggleSidebar: () => ipcRenderer.invoke(SHELL_CHANNELS.toggleSidebar) as Promise<void>,
  openSettings: (section) => ipcRenderer.invoke(SHELL_CHANNELS.openSettings, section) as Promise<void>,
  reportContentBounds: (bounds: ContentBounds) => {
    ipcRenderer.send(SHELL_CHANNELS.contentBounds, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  },
  reportLayout: (layout) => {
    ipcRenderer.send(SHELL_CHANNELS.layout, layout);
  },
  reportFocusedPart: (part) => {
    ipcRenderer.send(SHELL_CHANNELS.focusedPart, part);
  },
  onFocusPart: (listener) => subscribe<ShellFocusPart>(SHELL_CHANNELS.focusPart, listener),
};

contextBridge.exposeInMainWorld('damoclesShell', api);
