// Shared by the shell preload, main and (as types only) the shell app; the shell never sees panel channels.

import type { OverlayAnswer, OverlayRequest } from './overlay-channels';
import type { NotificationBell } from './notifications';
import type { SettingsSectionId } from '../../shared/settings-sections';

export const SHELL_CHANNELS = {
  // renderer → main, invoke
  getState: 'damocles:shell:get-state',
  addProject: 'damocles:shell:add-project',
  removeProject: 'damocles:shell:remove-project',
  selectProject: 'damocles:shell:select-project',
  grantTrust: 'damocles:shell:grant-trust',
  togglePane: 'damocles:shell:toggle-pane',
  chatsList: 'damocles:shell:chats:list',
  chatsSearch: 'damocles:shell:chats:search',
  chatsSelect: 'damocles:shell:chats:select',
  chatsNew: 'damocles:shell:chats:new',
  chatsRename: 'damocles:shell:chats:rename',
  chatsTag: 'damocles:shell:chats:tag',
  chatsDelete: 'damocles:shell:chats:delete',
  overlayRequest: 'damocles:shell:overlay:request',
  appMenu: 'damocles:shell:window:app-menu',
  toggleTheme: 'damocles:shell:window:toggle-theme',
  toggleSidebar: 'damocles:shell:window:toggle-sidebar',
  // section?: a SettingsSectionId; opens the settings modal in the overlay
  openSettings: 'damocles:shell:window:open-settings',
  // renderer → main, send
  contentBounds: 'damocles:shell:content-bounds',
  layout: 'damocles:shell:layout',
  focusedPart: 'damocles:shell:focused-part',
  // main → renderer
  state: 'damocles:shell:state',
  // projectKey whose chat list changed; the shell refetches when it shows that project
  chatsChanged: 'damocles:shell:chats:changed',
  // F6 landed on the sidebar; the shell focuses the sidebar's current row
  focusPart: 'damocles:shell:focus-part',
  // main → renderer, PanelTheme; the preload applies it to the page itself
  theme: 'damocles:shell:theme',
} as const;

// Bounds the shell may send; main clamps nothing, it rejects anything outside these.
export const MAX_ID_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;
export const MAX_CHAT_NAME_LENGTH = 200;
export const MAX_TAG_LENGTH = 50;
// Larger than any real display in CSS px; a coordinate or size outside [0, MAX_SHELL_COORDINATE] is malformed.
export const MAX_SHELL_COORDINATE = 100_000;
// AD7 layout minimums, CSS px.
export const MIN_SIDEBAR_WIDTH = 220;
export const MIN_SECTION_SIZE = 60;

// Prefix of the id of a loaded chat that has no session file yet; a stored chat's id is its sessionId.
export const NEW_CHAT_ID_PREFIX = 'new:';

export type ShellLocale = 'en' | 'el';
export type ShellPlatform = 'win32' | 'darwin' | 'linux';

// waiting = the chat needs the user (requires_action)
export type ChatStatus = 'running' | 'waiting' | 'idle';

export interface ShellProject {
  readonly key: string;
  readonly name: string;
  readonly fsPath: string;
  readonly trusted: boolean;
  // the project's branch from git's HEAD file (D42); undefined outside git
  readonly branch?: string;
  // loaded chats of this project by status
  readonly running: number;
  readonly waiting: number;
}

export interface ShellChat {
  // issued by main; the shell passes it back verbatim
  readonly id: string;
  // '' is a new conversation, which the shell labels itself
  readonly title: string;
  // epoch ms of the last activity, for the Today / Yesterday / Earlier groups
  readonly timestamp: number;
  readonly tag?: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly status: ChatStatus;
  readonly loaded: boolean;
}

export interface ShellChatList {
  readonly projectKey: string;
  // newest first
  readonly chats: readonly ShellChat[];
  // every tag used in the project, sorted
  readonly tags: readonly string[];
}

export type SelectChatResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'leased' | 'missing' };
export type ChatMutationResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'leased' | 'missing' | 'failed' };

export interface ShellSectionLayout {
  readonly collapsed: boolean;
  // CSS px, >= MIN_SECTION_SIZE
  readonly size: number;
}

export interface ShellLayout {
  readonly sidebarVisible: boolean;
  // CSS px, >= MIN_SIDEBAR_WIDTH
  readonly sidebarWidth: number;
  // Chats takes the height Projects leaves, so only Projects has a size.
  readonly sections: { readonly projects: ShellSectionLayout; readonly chats: { readonly collapsed: boolean } };
}

// The selected chat's browser pane, for the title bar's toggle button.
export interface ShellPane {
  readonly open: boolean;
}

export type ShellFocusPart = 'sidebar';

export interface ShellState {
  readonly locale: ShellLocale;
  readonly platform: ShellPlatform;
  readonly projects: readonly ShellProject[];
  // projectKey is absent until main knows a project: before the core starts and nothing is selected yet
  readonly selected: { readonly projectKey?: string; readonly chatId?: string };
  // the breadcrumb's chat
  readonly selectedChat?: { readonly id: string; readonly title: string };
  readonly effectiveTheme: 'dark' | 'light';
  readonly layout: ShellLayout;
  // present only when damocles.browser.enabled is on and a chat is selected
  readonly pane?: ShellPane;
  // display label of the menu accelerator that toggles the pane, e.g. "Ctrl+Shift+B" or "⇧⌘B"
  readonly paneShortcutLabel: string;
  // display labels of menu accelerators, e.g. "Ctrl+N"
  readonly shortcuts: { readonly newChat: string; readonly toggleSidebar: string; readonly settings: string };
  readonly notifications: NotificationBell;
}

// CSS px relative to the window's content area; main scales by the shell's zoom factor.
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type RemoveProjectResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface DamoclesShellApi {
  getState(): Promise<ShellState>;
  // full snapshot on every change; returns the unsubscribe
  onState(listener: (state: ShellState) => void): () => void;
  addProject(): Promise<void>;
  removeProject(key: string): Promise<RemoveProjectResult>;
  // selects the project's last viewed chat, or a new chat in it
  selectProject(key: string): Promise<void>;
  grantTrust(key: string): Promise<void>;
  // opens or collapses the selected chat's browser pane
  togglePane(): Promise<void>;
  listChats(projectKey: string): Promise<ShellChatList>;
  searchChats(projectKey: string, query: string): Promise<ShellChatList>;
  onChatsChanged(listener: (projectKey: string) => void): () => void;
  selectChat(chatId: string): Promise<SelectChatResult>;
  // a new chat in projectKey, or in the selected project when omitted
  newChat(projectKey?: string): Promise<void>;
  renameChat(chatId: string, name: string): Promise<ChatMutationResult>;
  // null removes the tag
  tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult>;
  // the shell has already asked the user to confirm
  deleteChat(chatId: string): Promise<ChatMutationResult>;
  // shows a menu or dialog in the overlay and resolves with the user's answer
  requestOverlay(request: OverlayRequest): Promise<OverlayAnswer>;
  // pops the application menu up at a point in CSS px
  openAppMenu(anchor: { readonly x: number; readonly y: number }): Promise<void>;
  toggleTheme(): Promise<void>;
  toggleSidebar(): Promise<void>;
  // the title-bar gear; resolves once main started opening the modal
  openSettings(section?: SettingsSectionId): Promise<void>;
  reportContentBounds(bounds: ContentBounds): void;
  reportLayout(layout: ShellLayout): void;
  // the shell part holding keyboard focus, null when focus left the sidebar
  reportFocusedPart(part: ShellFocusPart | null): void;
  onFocusPart(listener: (part: ShellFocusPart) => void): () => void;
}
