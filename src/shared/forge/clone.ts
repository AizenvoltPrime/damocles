// The clone picker as the overlay shows it (docs/invariants.md "GitHub and GitLab accounts", clone picker). Core keeps
// each listed repository's clone URLs behind an opaque key; the overlay passes keys back and never sees a URL.

export const CLONE_VISIBILITIES = ['public', 'private', 'internal'] as const;
export type CloneVisibility = (typeof CLONE_VISIBILITIES)[number];

export const CLONE_PILLS = ['archived', 'fork', 'mirror'] as const;
export type ClonePill = (typeof CLONE_PILLS)[number];

export const MAX_CLONE_QUERY_CHARS = 256;
export const MAX_CLONE_PASTE_CHARS = 2048;

export interface CloneAccount {
  readonly accountId: string;
  readonly login: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly kind: 'github' | 'gitlab';
  /** The picture's key at app://damocles/forge/avatar/<key>, as RepoAccountOption.avatarKey; absent while avatars are off. */
  readonly avatarKey?: string;
  readonly needsSignIn: boolean;
}

export const CLONE_PROTOCOLS = ['https', 'ssh'] as const;
export type CloneProtocol = (typeof CLONE_PROTOCOLS)[number];

/** noAccount: none signed in; notLoaded: core could not read its forge files. protocol: damocles.desktop.forge.cloneProtocol. */
export const CLONE_EMPTY_REASONS = ['noAccount', 'notLoaded'] as const;
export type CloneEmptyReason = (typeof CLONE_EMPTY_REASONS)[number];
export type CloneAccountsView = { readonly accounts: readonly CloneAccount[]; readonly protocol: CloneProtocol } | { readonly empty: CloneEmptyReason };

export interface CloneRow {
  /** Opaque, issued by core. */
  readonly key: string;
  /** "grp/platform", without a trailing slash. */
  readonly namespace: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility: CloneVisibility;
  readonly pill?: ClonePill;
  /** ISO 8601. */
  readonly updatedAt?: string;
}

/**
 * unreachable: no answer, or a rate-limited one; signInAgain: the server refused the account's token, or the account is gone;
 * refused: the server answered but denied the listing (a token without the scope, an organization's SSO or app policy).
 */
export const CLONE_SEARCH_ERRORS = ['unreachable', 'signInAgain', 'refused'] as const;
export type CloneSearchError = (typeof CLONE_SEARCH_ERRORS)[number];

export type CloneSearchAnswer =
  | { readonly requestId: number; readonly accountId: string; readonly rows: readonly CloneRow[] }
  | { readonly requestId: number; readonly accountId: string; readonly error: CloneSearchError };

/**
 * displayPath: host/path without credentials; protocol: an https or ssh address's; serverName: a managed server's; login: the
 * account the clone is preset to, when that server has exactly one and it need not sign in again.
 */
export interface ClonePasteRow {
  readonly displayPath: string;
  readonly protocol?: CloneProtocol;
  readonly serverName?: string;
  readonly login?: string;
}

export interface ClonePasteAnswer {
  readonly row: ClonePasteRow | null;
}

export type CloneSource = { readonly accountId: string; readonly key: string } | { readonly pasteText: string };

/** cancelled: the picker closed while core looked the address up, so nothing was cloned. */
export type CloneStartAnswer = { readonly kind: 'started' } | { readonly kind: 'cancelled' } | { readonly kind: 'refused'; readonly reason: string };
