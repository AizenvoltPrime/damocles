// Shared by the pane preload, main and (as types only) the pane app; the pane never sees shell or panel channels.

export const PANE_CHANNELS = {
  // renderer → main, invoke
  getState: 'damocles:pane:get-state',
  selectPage: 'damocles:pane:select-page',
  closePage: 'damocles:pane:close-page',
  newPage: 'damocles:pane:new-page',
  navigate: 'damocles:pane:navigate',
  goBack: 'damocles:pane:go-back',
  goForward: 'damocles:pane:go-forward',
  reload: 'damocles:pane:reload',
  openExternal: 'damocles:pane:open-external',
  pickElement: 'damocles:pane:pick-element',
  openDevTools: 'damocles:pane:open-dev-tools',
  setMaximized: 'damocles:pane:set-maximized',
  setCollapsed: 'damocles:pane:set-collapsed',
  // renderer → main, send
  requestWidth: 'damocles:pane:request-width',
  // main → renderer
  state: 'damocles:pane:state',
  // main moved keyboard focus into the pane view (F6 region cycling); the pane focuses its active page tab
  focus: 'damocles:pane:focus',
  // main → renderer, PanelTheme; the preload applies it to the page itself
  theme: 'damocles:pane:theme',
} as const;

// Pane view CSS px; the pane view always renders at zoom factor 1, so these equal window DIPs.
// Height of the chrome above the page view (page tab strip plus nav bar).
export const PANE_CHROME_HEIGHT = 76;
// Width of the divider at the pane's left edge; the page view starts right of it.
export const PANE_DIVIDER_WIDTH = 6;
// One keyboard resize step of the divider.
export const PANE_RESIZE_STEP = 16;

// Bounds the pane may send; main rejects anything outside them.
export const MAX_PANE_ID_LENGTH = 200;
export const MAX_PANE_URL_LENGTH = 8192;
// Larger than any real display in CSS px; a requested width outside [0, MAX_PANE_WIDTH] is malformed.
export const MAX_PANE_WIDTH = 100_000;

export type PaneLocale = 'en' | 'el';
export type PanePlatform = 'win32' | 'darwin' | 'linux';

// collapsed: the pane view is hidden. split: chat | pane side by side. overlay: the window is too narrow for both minimum
// widths, so the pane view covers the whole chat area and the part left of the pane is a scrim. maximized: the pane
// fills the chat area, no divider and no chat.
export type PaneMode = 'collapsed' | 'split' | 'overlay' | 'maximized';

export interface PanePage {
  // main's own page id; the pane passes it back verbatim
  readonly id: string;
  // page title, or the shortened URL until the page reports one
  readonly title: string;
  readonly url: string;
  // data: URL of the page's favicon, size-capped by main
  readonly iconDataUrl?: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  // the element picker is armed on this page
  readonly picking: boolean;
}

export interface PaneState {
  readonly locale: PaneLocale;
  readonly platform: PanePlatform;
  // damocles.browser.enabled; false hides every action that would start the browser
  readonly browserEnabled: boolean;
  // display label of the menu accelerator that toggles the pane, e.g. "Ctrl+Alt+B" or "⌥⌘B"
  readonly toggleShortcutLabel: string;
  // the selected chat tab the pane shows; undefined when no chat tab is selected
  readonly chatTabId?: string;
  readonly mode: PaneMode;
  // Pane width in CSS px measured from the divider's left edge to the area's right edge, divider included; in overlay
  // the scrim is the pane view's width minus this. In maximized it equals the area width.
  readonly width: number;
  // Current bounds of width after main clamped them to the window; for the divider's aria-valuemin/max.
  readonly minWidth: number;
  readonly maxWidth: number;
  // in pane order
  readonly pages: readonly PanePage[];
  readonly activePageId?: string;
}

export interface DamoclesPaneApi {
  getState(): Promise<PaneState>;
  // full snapshot on every change; returns the unsubscribe
  onState(listener: (state: PaneState) => void): () => void;
  onFocusRequest(listener: () => void): () => void;
  // Absolute pane width in CSS px (see PaneState.width). Main clamps it, lays out every view in the same tick and
  // answers with a state; commit persists the width (drag end, key press), a non-commit request only lays out.
  requestWidth(width: number, commit: boolean): void;
  selectPage(id: string): Promise<void>;
  closePage(id: string): Promise<void>;
  // opens about:blank in the selected chat's pane and selects it
  newPage(): Promise<void>;
  // The address text as typed; main adds https:// to a bare host and resolves false when the URL is not http, https
  // or about:blank, and navigates nothing then.
  navigate(id: string, url: string): Promise<boolean>;
  goBack(id: string): Promise<void>;
  goForward(id: string): Promise<void>;
  reload(id: string): Promise<void>;
  // opens the page's current URL in the system browser; http and https only
  openExternal(id: string): Promise<void>;
  pickElement(id: string): Promise<void>;
  openDevTools(id: string): Promise<void>;
  setMaximized(maximized: boolean): Promise<void>;
  setCollapsed(collapsed: boolean): Promise<void>;
}
