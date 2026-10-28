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
  // a remote chat's connection and the messages main holds for it while its host is away; undefined for a local chat
  getConnection(): ChatConnection | undefined;
  onConnection(listener: (connection: ChatConnection) => void): () => void;
  // Cancel or Discard on one held message
  queueAction(action: HeldMessageAction): void;
  // a remote chat shown read-only from its session mirror while its host is not connected; undefined otherwise
  getOffline(): { readonly hostId: string; readonly hostName: string } | undefined;
}
