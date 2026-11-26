import type { ChatConnection, HeldMessageAction, HostRemoved } from './host-connection';
import type { HostColor } from './host-colors';
import type { HostUpdate } from './host-update';

export interface BridgeHost {
  readonly hostId: string;
  readonly name: string;
  readonly color?: HostColor;
  readonly computer: string;
  readonly attention?: 'offline' | 'signIn';
  // Remove Damocles server ran on the host, by another device or as an automatic connect found it
  readonly removed?: HostRemoved;
  // a pending server switch on the host, or this app being too old for it
  readonly update?: HostUpdate;
  // the app's updater runs, so the update banner offers Check for updates; absent in the unpackaged app
  readonly canCheckForUpdates?: true;
  // the host has a saved record, so allowYolo may ask; absent for a host main never asks about
  readonly canAllowYolo?: true;
}

/** A saved host as this computer's host store names it, for pages of this computer's core that show remote data. */
export interface BridgeHostName {
  readonly name: string;
  readonly color?: HostColor;
}

/** `window.damoclesBridge`, exposed by the desktop panel preload through contextBridge; payloads are untyped at that boundary. */
export interface DamoclesBridge {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  getState(): unknown;
  setState(state: unknown): void;
  // a remote chat's host as this computer names it, from main's init; undefined for a local chat, and while main has not
  // answered the init yet, after which onHost hears it; computer is this computer's name; attention: the host is offline or
  // waits for the user to sign in
  getHost(): BridgeHost | undefined;
  onHost(listener: (host: BridgeHost) => void): () => void;
  // the banner's Reconnect (Reconnect now, Retry), Sign in, Show log or Edit host, and the update banner's two switches and
  // Check for updates, on the page's own host
  hostAction(action: 'reconnect' | 'signIn' | 'showLog' | 'editHost' | 'switchWhenIdle' | 'switchNow' | 'checkForUpdates'): void;
  // the composer's locked YOLO: main asks to allow YOLO on the page's own host, hung from anchor (page CSS pixels), and
  // answers whether the host allows YOLO now; rejects when main refused the ask (no click or key it observed in the shown
  // chat, a popup open) or the ask failed
  allowYolo(anchor: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Promise<boolean>;
  // a remote chat's connection and the messages main holds for it while its host is away; undefined for a local chat
  getConnection(): ChatConnection | undefined;
  onConnection(listener: (connection: ChatConnection) => void): () => void;
  // Cancel or Discard on one held message
  queueAction(action: HeldMessageAction): void;
  // a remote chat shown read-only from its session mirror while its host is not connected; undefined otherwise
  getOffline(): { readonly hostId: string; readonly hostName: string } | undefined;
  // a page of this computer's core: every saved host's name and color by host id, from main's init; undefined on a remote
  // chat's page and before the init, after which onHostNames hears it, and again after a host is added, renamed, recolored or forgotten
  getHostNames(): Readonly<Record<string, BridgeHostName>> | undefined;
  onHostNames(listener: (hostNames: Readonly<Record<string, BridgeHostName>>) => void): () => void;
  // a chat page opened its first modal layer or closed its last; the shell's chat gutter, beside the page, shows a scrim meanwhile
  setModalOpen(open: boolean): void;
}
