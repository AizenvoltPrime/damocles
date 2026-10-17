// Chat review's channels (D60), shared by the shell preload, main and (as types only) the shell app. Main issues every
// reviewId and maps it to the chat panel; the renderer names a file only by an entry path main listed, and sends only the
// comment text, so core composes the message from its own diff.

import type { ChatReviewScope } from '../../shared/types/messages';
import type { ScmFileDiffResult } from './scm-channels';

export type { ChatReviewScope } from '../../shared/types/messages';

export const REVIEW_CHANNELS = {
  // renderer → main, invoke
  // ChatReviewFileDiffRequest → ChatReviewFileDiffResult (the file's diff in the tab's scope, real line numbers)
  fileDiff: 'damocles:review:file-diff',
  // ChatReviewScopeRequest: Whole chat / Last turn; main updates the tab's entries
  setScope: 'damocles:review:set-scope',
  // ChatReviewRef → ChatReviewSendResult: sends main's kept drafts to the chat as one user message
  send: 'damocles:review:send',
  // ChatReviewRef: drops the kept drafts
  discard: 'damocles:review:discard',
  // ChatReviewDraftsRequest: the tab's whole draft list, kept by main per chat for the run until sent or discarded
  setDrafts: 'damocles:review:set-drafts',
} as const;

export const CHAT_REVIEW_SCOPES: readonly ChatReviewScope[] = ['chat', 'turn'];

// Bounds main checks; anything outside is refused, never clamped.
export const MAX_REVIEW_ID_LENGTH = 200;
export const MAX_REVIEW_COMMENTS = 200;
export const MAX_REVIEW_COMMENT_CHARS = 4000;
export const MAX_REVIEW_PATH_LENGTH = 4096;
export const MAX_REVIEW_LINE = 10_000_000;
export const MAX_REVIEW_REVISION_LENGTH = 64;

// A changed file of the chat. path: '/' separated and relative to the chat's working folder, or absolute (native) for a file
// outside it. outsideEdits: the file on disk differs from the chat's last result ("Includes edits made outside this chat").
export interface ChatReviewEntry {
  readonly path: string;
  readonly status: 'A' | 'M' | 'D';
  readonly added: number;
  readonly removed: number;
  // listed with no line diff (a generated image)
  readonly binary: boolean;
  readonly outsideEdits: boolean;
  // changes whenever the file's diff changes, counts unchanged included; a comment names the revision it was made on
  readonly revision: string;
  // the diff's lines take comments: false for a diff of the recorded patches, whose lines core cannot check at send
  readonly commentable: boolean;
}

// line: the new side's number for 'added' and 'context', the old side's for 'removed'; scope: the diff the line belongs to;
// revision: the revision core served with the diff the tab showed, which main checks against its own diff, never trusts.
export interface ChatReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: 'added' | 'removed' | 'context';
  readonly scope: ChatReviewScope;
  readonly text: string;
  readonly revision: string;
}

// The "Changes: {chat title}" tab (EditorTabKind 'review'). shellChangesNotListed: a project-folder chat, whose shell
// commands' changes the list leaves out.
export interface ChatReviewTab {
  readonly reviewId: string;
  readonly title: string;
  readonly scope: ChatReviewScope;
  readonly entries: readonly ChatReviewEntry[];
  readonly shellChangesNotListed: boolean;
  // whose drafts comments are (the chat's stored session); the tab takes main's list when it changes
  readonly draftsKey: string;
  readonly comments: readonly ChatReviewComment[];
  // the comments whose line changed or left the diff since they were made (core's one rule), which Send refuses
  readonly staleComments: readonly ChatReviewComment[];
  // a worktree chat's review lists the whole worktree: how many other chats of the project work in it; absent when none
  readonly sharedWith?: number;
}

export interface ChatReviewRef {
  readonly reviewId: string;
}

export interface ChatReviewFileDiffRequest {
  readonly reviewId: string;
  readonly path: string;
}

export interface ChatReviewScopeRequest {
  readonly reviewId: string;
  readonly scope: ChatReviewScope;
}

export interface ChatReviewDraftsRequest {
  readonly reviewId: string;
  readonly comments: readonly ChatReviewComment[];
}

// empty: no drafts were kept; stale: a comment's line is no longer in the chat's diff, so nothing was sent; unsent: the chat
// could not take the message now and the drafts are kept; missing: the chat is gone
// stale: message names each commented line that changed, in the words main's notice uses too
export type ChatReviewSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'stale'; readonly message: string }
  | { readonly ok: false; readonly reason: 'empty' | 'unsent' | 'missing' };

// patch: with the revision of the diff it prints, which a comment on it names; unreadable: reading the file on disk failed
// (locked, denied), so it lists with no diff
export type ChatReviewFileDiffResult =
  | Exclude<ScmFileDiffResult, { readonly kind: 'patch' }>
  | { readonly kind: 'patch'; readonly patch: string; readonly revision: string }
  | { readonly kind: 'unreadable' };

export interface DamoclesReviewApi {
  fileDiff(request: ChatReviewFileDiffRequest): Promise<ChatReviewFileDiffResult>;
  setScope(request: ChatReviewScopeRequest): Promise<void>;
  send(request: ChatReviewRef): Promise<ChatReviewSendResult>;
  discard(request: ChatReviewRef): Promise<void>;
  setDrafts(request: ChatReviewDraftsRequest): Promise<void>;
}

// Validators main runs on every invoke. Each payload carries exactly its fields.

function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) ? value : undefined;
}

const isReviewId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_REVIEW_ID_LENGTH;
// eslint-disable-next-line no-control-regex
const isEntryPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_REVIEW_PATH_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
const isScope = (value: unknown): value is ChatReviewScope => value === 'chat' || value === 'turn';

export function parseReviewRef(raw: unknown): ChatReviewRef | undefined {
  const value = exact(raw, ['reviewId']);
  return value && isReviewId(value['reviewId']) ? { reviewId: value['reviewId'] } : undefined;
}

export function parseReviewFileDiff(raw: unknown): ChatReviewFileDiffRequest | undefined {
  const value = exact(raw, ['reviewId', 'path']);
  return value && isReviewId(value['reviewId']) && isEntryPath(value['path']) ? { reviewId: value['reviewId'], path: value['path'] } : undefined;
}

export function parseReviewScope(raw: unknown): ChatReviewScopeRequest | undefined {
  const value = exact(raw, ['reviewId', 'scope']);
  return value && isReviewId(value['reviewId']) && isScope(value['scope']) ? { reviewId: value['reviewId'], scope: value['scope'] } : undefined;
}

function parseComment(raw: unknown): ChatReviewComment | undefined {
  const value = exact(raw, ['path', 'line', 'side', 'scope', 'text', 'revision']);
  if (!value || !isEntryPath(value['path']) || !isScope(value['scope'])) return undefined;
  const { line, side, text, revision } = value;
  if (typeof revision !== 'string' || revision.length > MAX_REVIEW_REVISION_LENGTH || !/^[0-9a-f]*$/.test(revision)) return undefined;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > MAX_REVIEW_LINE) return undefined;
  if (side !== 'added' && side !== 'removed' && side !== 'context') return undefined;
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_REVIEW_COMMENT_CHARS || text.includes('\0')) return undefined;
  return { path: value['path'], line, side, scope: value['scope'], text, revision };
}

export function parseReviewDrafts(raw: unknown): ChatReviewDraftsRequest | undefined {
  const value = exact(raw, ['reviewId', 'comments']);
  const listed = value?.['comments'];
  if (!value || !isReviewId(value['reviewId']) || !Array.isArray(listed) || listed.length > MAX_REVIEW_COMMENTS) return undefined;
  const comments: ChatReviewComment[] = [];
  for (const item of listed as unknown[]) {
    const comment = parseComment(item);
    if (!comment) return undefined;
    comments.push(comment);
  }
  return { reviewId: value['reviewId'], comments };
}
