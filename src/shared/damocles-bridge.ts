import type { ChatConnection, HeldMessageAction } from './host-connection';
import type { HostTone } from './host-tones';

export interface BridgeHost {
  readonly hostId: string;
  readonly name: string;
  readonly color?: HostTone;
  readonly computer: string;
  readonly attention?: 'offline' | 'signIn';
  // a daemon of another protocol still runs agents on the host: its app version, how many, and whether a switch waits for them
  readonly update?: { readonly serverVersion: string; readonly runningAgents: number; readonly phase: 'offer' | 'waiting' };
  // the host has a saved record, so allowYolo may ask; absent for a host main never asks about
  readonly canAllowYolo?: true;
}

/** A saved host as this computer's host store names it, for pages of this computer's core that show remote data. */
export interface BridgeHostName {
  readonly name: string;
  readonly color?: HostTone;
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
  // the banner's Reconnect (Reconnect now, Retry), Sign in, Show log or Edit host, and the update banner's two switches, on
  // the page's own host
  hostAction(action: 'reconnect' | 'signIn' | 'showLog' | 'editHost' | 'switchWhenIdle' | 'switchNow'): void;
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
}
