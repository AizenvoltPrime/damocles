// A remote host's connection as the shell and a remote chat page show it (docs/invariants.md "Desktop host", offline banner).

// A host that stopped answering shows nothing for this long, so a short drop never reaches the user.
export const OFFLINE_GRACE_MS = 2000;
// A host that came back after it showed its banner shows green for this long, then the banner collapses.
export const RECONNECTED_MS = 1500;

// destination: the saved address holds something Damocles now refuses, which only forgetting and adding the host changes
export const PERMANENT_FAILURE_CODES = ['hostKeyChanged', 'hostRemoved', 'prerequisites', 'install', 'authFailed', 'destination'] as const;
export type PermanentFailureCode = (typeof PERMANENT_FAILURE_CODES)[number];

// The reconnect loop's phase for a host that is not connected. since and retryAt are this computer's epoch ms; since is when
// the host stopped being healthy (the missed deadline of a suspect connection, the drop of a lost one).
export type HostReconnect =
  | { readonly phase: 'suspect'; readonly since: number }
  | { readonly phase: 'waiting'; readonly since: number; readonly retryAt: number }
  | { readonly phase: 'running'; readonly since: number }
  | { readonly phase: 'signIn'; readonly since: number }
  | { readonly phase: 'failed'; readonly since: number; readonly code: PermanentFailureCode };

export type HostReconnectPhase = HostReconnect['phase'];

// The latest round trip to a host and the last ten (oldest first); it moves only when a measurement finishes.
export interface HostLatency {
  readonly latencyMs: number;
  readonly slow: boolean;
  readonly history: readonly number[];
  // finished measurements on this host since the app started; an identical reading still counts one more
  readonly measurements: number;
}

// A message main holds for a remote chat whose host is away, as its chip shows it. notSent: core refused it after the
// reconnect because the chat had moved to another conversation; it is never sent again.
export interface HeldMessage {
  readonly id: string;
  readonly text: string;
  readonly imageCount: number;
  readonly status: 'queued' | 'notSent';
}

// A remote chat page's connection to its host and the messages main holds for it (PANEL_CHANNELS.connection). offline: not
// connected with no reconnect loop running (before its first connection, after Disconnect).
export interface ChatConnection {
  readonly state: { readonly phase: 'connected' } | { readonly phase: 'offline' } | HostReconnect;
  readonly queued: readonly HeldMessage[];
}

// A chip's button: Cancel on a queued message, Discard on a not-sent one.
export interface HeldMessageAction {
  readonly action: 'cancel' | 'discard';
  readonly id: string;
}

/** The moment a host that is not connected starts showing it: its amber dot and its banner. */
export function shownFrom(reconnect: HostReconnect): number {
  return reconnect.since + OFFLINE_GRACE_MS;
}

/** Whole seconds left until the retry, never negative; the banner's countdown. */
export function secondsUntil(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}
