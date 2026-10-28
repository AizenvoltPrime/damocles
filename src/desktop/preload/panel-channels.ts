// Shared by the panel preload and main. The names are fixed: main listens on each view's own webContents.ipc, which only
// that view's messages reach, so the renderer never needs to know which panel it is.

import type { FileIconTheme } from '../local-services/desktop-configuration';
import type { ChatConnection } from '../../shared/host-connection';
import type { HostTone } from '../../shared/host-tones';
import type { HostAttention, HostUpdate } from './shell-channels';

export type ThemeKind = 'dark' | 'light';

export interface PanelTheme {
  readonly kind: ThemeKind;
  readonly css: string;
  // damocles.desktop.reduceMotion, mirrored as the data-reduced-motion attribute of every renderer's root element
  readonly reducedMotion: boolean;
  // damocles.desktop.fileIconTheme, mirrored as the data-file-icon-theme attribute of every renderer's root element
  readonly fileIconTheme: FileIconTheme;
}

// A remote chat's host as this computer's host store names it; core never names it.
export interface PanelHostLabel {
  readonly hostId: string;
  readonly name: string;
  readonly color?: HostTone;
  // this computer's name (os.hostname()), which names the user's own sign-in beside the host's environment
  readonly computer: string;
  // the host is offline or waits for the user to sign in (hostAttention), which the page's banner under its header names
  readonly attention?: HostAttention;
  // a daemon of another protocol still runs agents there (ShellHost.update), which the update banner names
  readonly update?: HostUpdate;
}

// The page banner's button: Reconnect (also Reconnect now and Retry), Sign in, Show log or Edit host, and the update banner's
// Switch when they finish and Switch now, for the page's own host.
export type PanelHostAction = 'reconnect' | 'signIn' | 'showLog' | 'editHost' | 'switchWhenIdle' | 'switchNow';
export const PANEL_HOST_ACTIONS: readonly PanelHostAction[] = ['reconnect', 'signIn', 'showLog', 'editHost', 'switchWhenIdle', 'switchNow'];

export type { ChatConnection as PanelConnection, HeldMessage as PanelQueuedMessage, HeldMessageAction as PanelQueueAction } from '../../shared/host-connection';

// Answer to the synchronous init request the preload sends once at load.
export interface PanelInit {
  readonly state: unknown;
  readonly theme: PanelTheme;
  // present only for a chat of a remote core
  readonly host?: PanelHostLabel;
  // a remote chat shown from its session mirror while its host is not connected: read-only
  readonly offline?: { readonly hostId: string; readonly hostName: string };
  // present only for a chat of a remote core: its connection and held messages, which PANEL_CHANNELS.connection updates
  readonly connection?: ChatConnection;
}

export const PANEL_CHANNELS = {
  // renderer → main (sendSync), answered with PanelInit, or null when main refused the sender
  init: 'damocles:panel:init',
  // renderer → main, one webview message
  post: 'damocles:panel:post',
  // renderer → main, the webview state to persist
  setState: 'damocles:panel:set-state',
  // main → renderer, one host message: JSON text, or a structured clone when it holds binary
  message: 'damocles:panel:message',
  // main → renderer, PanelTheme after a theme or reduce motion change
  theme: 'damocles:panel:theme',
  // main → renderer, PanelHostLabel after the chat's host was renamed, recolored, went away or came back
  host: 'damocles:panel:host',
  // renderer → main, a PanelHostAction on the page's own host
  hostAction: 'damocles:panel:host-action',
  // main → renderer, PanelConnection after the host's phase or the held messages changed
  connection: 'damocles:panel:connection',
  // renderer → main, a PanelQueueAction on one of the page's held messages
  queueAction: 'damocles:panel:queue-action',
} as const;
