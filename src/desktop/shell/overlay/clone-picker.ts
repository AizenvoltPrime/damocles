import type { QuickOpenMatch } from '../../preload/overlay-channels';
import { cloneAddressOf, isRemoteUrl } from '../../../shared/clone-address';
import type { CloneAccount, CloneRow, CloneSearchAnswer, CloneSearchError } from '../../../shared/forge/clone';

// The clone picker's state: one section per account, each searched on its own; an answer is shown only when it
// carries its section's newest request id, as Quick Open drops an older query's answer.

export type CloneSectionState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly CloneRow[] }
  | { readonly status: 'error'; readonly error: CloneSearchError };

export interface CloneSection {
  readonly account: CloneAccount;
  readonly state: CloneSectionState;
  // the newest search sent for this section; an answer with another id is stale
  readonly requestId: number;
}

/** Sections for the accounts: an account that must sign in again shows that at once and is never searched. */
export function initialSections(accounts: readonly CloneAccount[]): readonly CloneSection[] {
  return accounts.map((account) => ({ account, requestId: -1, state: account.needsSignIn ? { status: 'error', error: 'signInAgain' } : { status: 'loading' } }));
}

/** The section of accountId marked loading under requestId, the others unchanged; a section that must sign in again stays so. */
export function startSearch(sections: readonly CloneSection[], accountId: string, requestId: number): readonly CloneSection[] {
  return sections.map((section) => (section.account.accountId !== accountId || section.account.needsSignIn ? section : { ...section, requestId, state: { status: 'loading' } }));
}

/** The sections with answer applied; unchanged (the same array) when its section asked again since, or is gone. */
export function applyAnswer(sections: readonly CloneSection[], answer: CloneSearchAnswer): readonly CloneSection[] {
  const index = sections.findIndex((section) => section.account.accountId === answer.accountId);
  const section = sections[index];
  if (!section || section.requestId !== answer.requestId) return sections;
  const state: CloneSectionState = 'error' in answer ? { status: 'error', error: answer.error } : { status: 'ready', rows: answer.rows };
  return sections.map((each, at) => (at === index ? { ...each, state } : each));
}

export const isPending = (sections: readonly CloneSection[]): boolean => sections.some((section) => section.state.status === 'loading');

/**
 * Whether a typed query found nothing: every section answered with no row or an error, and at least one listed, which the
 * picker says with Clear the search beside any section's error row.
 */
export function noResults(sections: readonly CloneSection[], query: string): boolean {
  const answered = sections.every((section) => section.state.status === 'error' || (section.state.status === 'ready' && section.state.rows.length === 0));
  return query.trim() !== '' && answered && sections.some((section) => section.state.status === 'ready');
}

// What Git: Clone's box took, which core reads: a scheme URL (https, ssh, git, file), git's scp-like [user@]host:path, and an
// absolute folder (POSIX, a Windows drive, a UNC share).
const PASTES: readonly RegExp[] = [/^[a-z][a-z0-9+.-]*:\/\//i, /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/, /^\//, /^[a-z]:[\\/]/i, /^\\\\/];

/**
 * Whether the query is a repository address to clone rather than words to search for: `git clone` dropped, whitespace only in
 * a local folder's path, as core reads a paste.
 */
export function looksLikeUrl(text: string): boolean {
  const address = cloneAddressOf(text);
  return isRemoteUrl(address) && PASTES.some((paste) => paste.test(address));
}

/** The [start, end) range of the query's first case-insensitive occurrence in text, for highlighting; none for no query. */
export function queryMatches(text: string, query: string): QuickOpenMatch[] {
  const needle = query.trim().toLowerCase();
  const haystack = text.toLowerCase();
  // a character whose lower case is longer (İ) would shift every offset after it
  if (needle === '' || haystack.length !== text.length) return [];
  const at = haystack.indexOf(needle);
  return at < 0 ? [] : [[at, at + needle.length]];
}
