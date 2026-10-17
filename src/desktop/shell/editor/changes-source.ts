import type { ChatReviewComment, ChatReviewFileDiffResult } from '../../preload/review-channels';
import type { ScmFileDiffResult, ScmLetter, ScmTone } from '../../preload/scm-channels';

// What ChangesTab.vue shows: a list of files and one file's unified diff, from whatever source the tab is. Source control's
// changes, View Stash and every Compare (ScmChangesTab.vue) and the chat review (ChatReviewTab.vue) each build one.

export interface ChangesEntry {
  // the source's own path for the file: repo-relative for source control, the review's entry path for a chat
  readonly path: string;
  // the status letter and its colour
  readonly letter: ScmLetter;
  readonly tone: ScmTone;
  // the status in words, for the tooltip and the diff header
  readonly status: string;
  // deleted here: the name is struck through
  readonly strike: boolean;
  // changes whenever the file's diff must be read again; the same value keeps the diff on screen
  readonly version: string;
  // a mark after the name, with its tooltip ("Includes edits made outside this chat")
  readonly note?: string;
  // the diff's lines take comments (the chat review's)
  readonly commentable?: boolean;
}

/** A file's comments in one diff: those on its lines, and adding or removing one. */
export interface ChangesComments {
  // the comments on this file's lines in the diff on screen
  of(path: string): readonly ChatReviewComment[];
  add(comment: Omit<ChatReviewComment, 'scope'>): void;
  // the review holds MAX_REVIEW_COMMENTS, so the open box adds nothing and says so
  readonly full: boolean;
  remove(comment: ChatReviewComment): void;
  // its line changed or left the diff since it was made, so Send refuses it (main's reading of core's rule)
  stale(comment: ChatReviewComment): boolean;
  // a short hint in the diff header ("Click a line number to comment")
  readonly hint: string;
}

export interface ChangesSource {
  readonly entries: readonly ChangesEntry[];
  // the list's text when it holds no file
  readonly emptyText: string;
  // the chat review's patch carries the revision a comment on it names
  fileDiff(path: string): Promise<ScmFileDiffResult | ChatReviewFileDiffResult>;
  // the notice of a file no longer in the source's list; source control's group wording by default
  readonly missingText?: string;
  // the diff header's Open File; absent where the file is not one the editor opens
  readonly openFile?: (path: string) => void;
  // line comments, the chat review's alone
  readonly comments?: ChangesComments;
}
