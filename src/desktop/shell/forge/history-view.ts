import { MAX_AUTHOR_EMAIL_CHARS, MAX_AUTHOR_NAME_CHARS, MAX_HISTORY_AUTHORS, type AuthorAvatars, type ContainingChange, type HistoryAuthor } from '@shared/forge/history';
import type { ForgeLinkRequest } from '@shared/forge/links';
import { referenceLabel, type ForgeReference } from '@shared/forge/references';

// History details as the Graph and blame ask for them and show them.

/** A link inside commit text or a card: a dotted underline at rest, so it never differs from the text by colour alone. */
export const LINK = 'rounded-5 underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:shadow-[0_0_0_1px_var(--d-accent)]';

/** name within max UTF-16 units, never ending inside a surrogate pair, as main measures it. */
function boundedName(name: string, max: number): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The authors of one history page (or one blame) not asked yet: one per trimmed, lower-cased email (AuthorAvatars' key), with
 * the last commit naming it, which comes oldest in history order and so is the likeliest to be on the server, in calls of at
 * most MAX_HISTORY_AUTHORS. Adds each email to asked. An email longer than main takes, or an email or name holding NUL, which
 * main refuses with the whole call, cannot have a picture.
 */
export function avatarBatches(authors: Iterable<HistoryAuthor>, asked: Set<string>): HistoryAuthor[][] {
  const fresh = new Map<string, HistoryAuthor>();
  for (const author of authors) {
    const email = author.email.trim();
    const key = email.toLowerCase();
    if (key === '' || email.length > MAX_AUTHOR_EMAIL_CHARS || asked.has(key) || email.includes('\0') || author.name.includes('\0')) continue;
    fresh.set(key, { sha: author.sha, email, name: boundedName(author.name, MAX_AUTHOR_NAME_CHARS) });
  }
  for (const key of fresh.keys()) asked.add(key);
  const list = [...fresh.values()];
  const batches: HistoryAuthor[][] = [];
  for (let start = 0; start < list.length; start += MAX_HISTORY_AUTHORS) batches.push(list.slice(start, start + MAX_HISTORY_AUTHORS));
  return batches;
}

/**
 * Which authors' pictures a view asked for under one history context. Each email is asked once; one that got no key (a
 * failed or partial answer) or whose picture would not load is asked once more on a later ask, and then not again until the
 * view reads its context again.
 */
export interface AvatarAsks {
  /** The batches of authors to ask for now (avatarBatches). */
  batches(authors: Iterable<HistoryAuthor>): HistoryAuthor[][];
  /** A batch's answer, undefined when the call failed. */
  settle(batch: readonly HistoryAuthor[], answer: AuthorAvatars | undefined): void;
  /** The picture of email's key did not load (its key is gone from main, or the fetch failed); true: ask for it again now. */
  pictureFailed(email: string): boolean;
}

export function createAvatarAsks(): AvatarAsks {
  const asked = new Set<string>();
  const retried = new Set<string>();
  const askAgain = (key: string): boolean => {
    if (retried.has(key)) return false;
    retried.add(key);
    asked.delete(key);
    return true;
  };
  return {
    batches: (authors) => avatarBatches(authors, asked),
    settle(batch, answer) {
      for (const author of batch) {
        const key = author.email.toLowerCase();
        if (answer?.[key] === undefined) askAgain(key);
      }
    },
    pictureFailed: (email) => askAgain(email.trim().toLowerCase()),
  };
}

/** openReference's request, rebuilt so only the reference's sigil, number and path cross to main. */
export function referenceRequest(repoId: string, reference: ForgeReference): ForgeLinkRequest {
  return { action: 'openReference', repoId, reference: { sigil: reference.sigil, number: reference.number, ...(reference.path !== undefined ? { path: reference.path } : {}) } };
}

/** "Merged in !45" (GitHub "Merged in #12"): the containing MR/PR as the reference its link opens. */
export function mergedReference(change: ContainingChange): ForgeReference {
  return { sigil: change.kind === 'pullRequest' ? '#' : '!', number: change.number };
}

export const mergedLabel = (change: ContainingChange): string => referenceLabel(mergedReference(change));
