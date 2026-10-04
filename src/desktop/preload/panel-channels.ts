// Shared by the panel preload and main. The names are fixed: main listens on each view's own webContents.ipc, which only
// that view's messages reach, so the renderer never needs to know which panel it is.

export type ThemeKind = 'dark' | 'light';

export interface PanelTheme {
  readonly kind: ThemeKind;
  readonly css: string;
  // damocles.desktop.reduceMotion, mirrored as the data-reduced-motion attribute of every renderer's root element
  readonly reducedMotion: boolean;
}

// Answer to the synchronous init request the preload sends once at load.
export interface PanelInit {
  readonly state: unknown;
  readonly theme: PanelTheme;
}

export const PANEL_CHANNELS = {
  // renderer → main (sendSync), answered with PanelInit, or null when main refused the sender
  init: 'damocles:panel:init',
  // renderer → main, one webview message
  post: 'damocles:panel:post',
  // renderer → main, the webview state to persist
  setState: 'damocles:panel:set-state',
  // main → renderer, one host message
  message: 'damocles:panel:message',
  // main → renderer, PanelTheme after a theme or reduce motion change
  theme: 'damocles:panel:theme',
} as const;
