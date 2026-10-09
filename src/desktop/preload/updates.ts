// The update service's state and the release notes, shared by main (which owns both) and the shell and overlay apps
// (which render them and never infer an update state of their own).

import type { ShellPlatform } from './shell-channels';

export type UpdateState =
  // the unpackaged app, which never checks
  | { readonly kind: 'disabled' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  // epoch ms
  | { readonly kind: 'upToDate'; readonly checkedAt: number }
  // macOS only: the update is downloaded from its release page; notes are the feed's release notes (HTML or markdown)
  | { readonly kind: 'available'; readonly version: string; readonly notes: string }
  // percent is an integer 0..100
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly kind: 'ready'; readonly version: string; readonly notes: string }
  // the quit that installs the ready update runs; a cancelled quit goes back to ready
  | { readonly kind: 'restarting'; readonly version: string; readonly notes: string }
  // reason is one line, already bounded
  | { readonly kind: 'error'; readonly reason: string };

export interface UpdateSnapshot {
  readonly state: UpdateState;
  // epoch ms of the last check that reached the feed, from any earlier run too; null before the first
  readonly lastCheckedAt: number | null;
  readonly platform: ShellPlatform;
}

export interface VersionInfo {
  readonly version: string;
  readonly packaged: boolean;
  readonly platform: ShellPlatform;
  readonly arch: string;
  readonly electron: string;
  readonly chromium: string;
  readonly node: string;
}

export interface ReleaseIndexEntry {
  readonly version: string;
  // YYYY-MM-DD as CHANGELOG.md writes it
  readonly date: string;
}

export interface ReleaseIndex {
  // the running version
  readonly current: string;
  // newest first
  readonly versions: readonly ReleaseIndexEntry[];
}

export interface ReleaseNotes {
  readonly version: string;
  // the version's CHANGELOG.md section without its heading
  readonly markdown: string;
}

// Main's rule for whether a check may start; a check in any other state is a no-op.
export function canCheck(state: UpdateState): boolean {
  return state.kind === 'idle' || state.kind === 'upToDate' || state.kind === 'error';
}

// What the title-bar pill asks main to do; main refuses an action the current state does not offer.
export const UPDATE_ACTIONS = ['restart', 'releaseNotes', 'showLog', 'releasePage'] as const;
export type UpdateAction = (typeof UPDATE_ACTIONS)[number];

export function isUpdateAction(value: unknown): value is UpdateAction {
  return typeof value === 'string' && (UPDATE_ACTIONS as readonly string[]).includes(value);
}

// Characters of a version a renderer may name; main also requires it to be in the release index.
export const MAX_RELEASE_VERSION_LENGTH = 64;
