// The chats' review tabs (D60) in the editor pane: main issues each reviewId for a chat panel, keeps each chat's draft
// comments for the run until they are sent or discarded, and answers the damocles:review:* requests from core's diff.
import { randomUUID } from 'node:crypto';
import type { ChatSession } from '../../core/chat-session';
import type { ChatChangeTotals, ChatReviewSnapshot, DraftComment } from '../../core/pi-session/chat-review';
import { isCommentable, type ChatScope } from '../../core/pi-session/chat-changes';
import {
  parseReviewDrafts,
  parseReviewFileDiff,
  parseReviewRef,
  parseReviewScope,
  type ChatReviewComment,
  type ChatReviewFileDiffResult,
  type ChatReviewSendResult,
  type ChatReviewTab,
} from '../preload/review-channels';
import { visibleText } from '../../shared/visible-text';
import type { EditorPane } from './editor-pane';

// A loaded chat's review reads (D60), which core answers.
export type ReviewSession = Pick<ChatSession, 'chatReviewSnapshot' | 'chatReviewFileDiff' | 'chatReviewAnchor' | 'chatReviewStale' | 'submitReview'>;

export interface ChatReviewHostDeps {
  // the loaded chat's review reads, by chat key
  readonly session: (chatKey: string) => ReviewSession | undefined;
  // the chat's stored session id, which its drafts are kept under; undefined before its first message
  readonly sessionId: (chatKey: string) => string | undefined;
  // the chat's title, '' for a new chat
  readonly title: (chatKey: string) => string;
  readonly editorPane: () => EditorPane;
  readonly warn: (message: string) => void;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  // MenuState.selectedChatHasChanges moved
  readonly menuChanged: () => void;
  readonly log: (line: string) => void;
}

// the commented lines a stale send's message names before "and {n} more"
const MAX_NAMED_STALE = 3;

interface Review {
  readonly chatKey: string;
  scope: ChatScope;
  // the latest read asked for this review, and the latest one that reached its tab, with that read's generation
  serial: number;
  landed: number;
  generation: number | undefined;
  // the latest reading of which comments are stale; an older one that ends later never reaches the tab
  marks: number;
}

// A kept draft: the renderer's comment and the anchor core recorded for it when it first arrived.
interface Draft {
  readonly comment: ChatReviewComment;
  readonly anchor: Promise<string | undefined>;
  failed: boolean;
}

function draftOf(session: ReviewSession | undefined, comment: ChatReviewComment): Draft {
  const draft: Draft = { comment, anchor: session ? session.chatReviewAnchor(comment) : Promise.resolve(undefined), failed: false };
  // a failed read rejects the send that awaits it, and the next draft list reads the anchor again
  void draft.anchor.catch(() => {
    draft.failed = true;
  });
  return draft;
}

const sameComment = (a: ChatReviewComment, b: ChatReviewComment): boolean =>
  a.path === b.path && a.line === b.line && a.side === b.side && a.scope === b.scope && a.text === b.text && a.revision === b.revision;

export class ChatReviewHost {
  private readonly deps: ChatReviewHostDeps;
  private readonly reviews = new Map<string, Review>();
  // each chat's drafts for the run, by its stored session id (the chat key until it has one)
  private readonly drafts = new Map<string, readonly Draft[]>();
  private readonly totals = new Map<string, ChatChangeTotals>();

  constructor(deps: ChatReviewHostDeps) {
    this.deps = deps;
  }

  /** Opens or focuses the chat's review tab in a scope (EditorService.showChatReview, Chat: Review Changes, the counter). */
  async show(chatKey: string, scope: ChatScope): Promise<void> {
    const session = this.deps.session(chatKey);
    if (!session) throw new Error('The chat is not loaded');
    const existing = this.reviewIdOf(chatKey);
    const reviewId = existing ?? randomUUID();
    const review = (existing !== undefined ? this.reviews.get(existing) : undefined) ?? { chatKey, scope, serial: 0, landed: 0, generation: undefined, marks: 0 };
    review.scope = scope;
    this.reviews.set(reviewId, review);
    try {
      await this.read(reviewId, review, session, { focus: true, fresh: true });
    } finally {
      // a tab that never opened leaves no review behind
      if (this.reviews.get(reviewId) === review && !this.isOpen(reviewId)) this.reviews.delete(reviewId);
    }
  }

  /** The totals core published for a chat; its open review tab lists the files again unless it shows that generation. */
  chatChanged(chatKey: string, totals: ChatChangeTotals, generation: number): void {
    const before = this.totals.get(chatKey)?.files ?? 0;
    this.totals.set(chatKey, totals);
    if ((before > 0) !== (totals.files > 0)) this.deps.menuChanged();
    const reviewId = this.reviewIdOf(chatKey);
    const review = reviewId !== undefined ? this.reviews.get(reviewId) : undefined;
    if (reviewId !== undefined && review && review.generation !== generation) void this.refresh(reviewId);
  }

  /** Other chats joined or left the chat's worktree: its open review tab reads the count again. */
  sharingChanged(chatKey: string): void {
    const reviewId = this.reviewIdOf(chatKey);
    if (reviewId !== undefined) void this.refresh(reviewId);
  }

  /** The chat changed files (Chat: Review Changes is enabled). */
  hasChanges(chatKey: string | undefined): boolean {
    return chatKey !== undefined && (this.totals.get(chatKey)?.files ?? 0) > 0;
  }

  /** A chat closed: its review tab closes; its drafts stay for the run under its session. */
  async panelClosed(chatKey: string): Promise<void> {
    this.totals.delete(chatKey);
    const reviewId = this.reviewIdOf(chatKey);
    if (reviewId === undefined) return;
    this.reviews.delete(reviewId);
    await this.deps.editorPane().closeReview(reviewId);
  }

  /** The editor pane closed a review tab: nothing reads that review again. */
  reviewClosed(reviewId: string): void {
    this.reviews.delete(reviewId);
  }

  async fileDiff(raw: unknown): Promise<ChatReviewFileDiffResult> {
    const request = parseReviewFileDiff(raw);
    if (!request) throw new Error('Malformed review diff request from the shell');
    const review = this.reviews.get(request.reviewId);
    const session = review ? this.deps.session(review.chatKey) : undefined;
    if (!review || !session) return { kind: 'missing' };
    return session.chatReviewFileDiff(review.scope, request.path);
  }

  async setScope(raw: unknown): Promise<void> {
    const request = parseReviewScope(raw);
    if (!request) throw new Error('Malformed review scope from the shell');
    const review = this.reviews.get(request.reviewId);
    if (!review) return;
    review.scope = request.scope;
    await this.refresh(request.reviewId);
  }

  /** The tab's whole draft list: a comment main already holds keeps its anchor, a new one records its line from core's diff now. */
  async setDrafts(raw: unknown): Promise<void> {
    const request = parseReviewDrafts(raw);
    if (!request) throw new Error('Malformed review drafts from the shell');
    const review = this.reviews.get(request.reviewId);
    if (!review) return;
    const key = this.draftKey(review.chatKey);
    const held = [...(this.drafts.get(key) ?? [])];
    const session = this.deps.session(review.chatKey);
    const next = request.comments.map((comment): Draft => {
      const index = held.findIndex((draft) => !draft.failed && sameComment(draft.comment, comment));
      return index >= 0 ? held.splice(index, 1)[0]! : draftOf(session, comment);
    });
    this.drafts.set(key, next);
    this.updateComments(request.reviewId, review.chatKey);
    await this.markStale(request.reviewId);
  }

  async discard(raw: unknown): Promise<void> {
    const request = parseReviewRef(raw);
    if (!request) throw new Error('Malformed review request from the shell');
    const review = this.reviews.get(request.reviewId);
    if (!review) return;
    this.drafts.delete(this.draftKey(review.chatKey));
    this.updateComments(request.reviewId, review.chatKey);
    await this.markStale(request.reviewId);
  }

  /** Sends the kept drafts as one user message core composes; the drafts go once the chat took it. */
  async send(raw: unknown): Promise<ChatReviewSendResult> {
    const request = parseReviewRef(raw);
    if (!request) throw new Error('Malformed review request from the shell');
    const review = this.reviews.get(request.reviewId);
    const session = review ? this.deps.session(review.chatKey) : undefined;
    if (!review || !session) return { ok: false, reason: 'missing' };
    const key = this.draftKey(review.chatKey);
    // a draft whose anchor read failed reads it again; the revision check keeps that anchor to the diff the comment was made on
    const kept = (this.drafts.get(key) ?? []).map((draft) => (draft.failed ? draftOf(session, draft.comment) : draft));
    this.drafts.set(key, kept);
    const drafts = await Promise.all(kept.map(async (draft) => ({ ...draft.comment, anchor: await draft.anchor })));
    const outcome = await session.submitReview(drafts);
    if (outcome === 'empty') return { ok: false, reason: 'empty' };
    if (typeof outcome === 'object') {
      const stale = kept.filter((_draft, index) => outcome.stale.includes(drafts[index]!)).map((draft) => draft.comment);
      const message = this.staleMessage(stale);
      this.deps.warn(message);
      await this.markStale(request.reviewId);
      return { ok: false, reason: 'stale', message };
    }
    if (outcome === 'unsent') {
      this.deps.warn(this.deps.t('The chat could not take the review comments now, so they are kept. Send them again.'));
      return { ok: false, reason: 'unsent' };
    }
    // only the drafts that were sent go: a comment added while the send ran stays
    if (this.drafts.get(key) === kept) this.drafts.delete(key);
    else this.drafts.set(key, (this.drafts.get(key) ?? []).filter((draft) => !kept.includes(draft)));
    this.updateComments(request.reviewId, review.chatKey);
    return { ok: true };
  }

  // The one wording of a stale send, which the toast and the tab's bar both show, naming each commented line that changed.
  // Lines group under their file ("a.ts:2, 5") and only the first MAX_NAMED_STALE are named, since every card is marked anyway.
  private staleMessage(stale: readonly ChatReviewComment[]): string {
    const t = this.deps.t;
    const places = new Map<string, { readonly path: string; readonly line: string }>();
    for (const comment of stale) {
      const line = comment.side === 'removed' ? t('{0} (removed)', comment.line) : String(comment.line);
      places.set(`${comment.path}\0${line}`, { path: comment.path, line });
    }
    const named = [...places.values()].slice(0, MAX_NAMED_STALE);
    const files = new Map<string, string[]>();
    for (const { path, line } of named) files.set(path, [...(files.get(path) ?? []), line]);
    const listed = [...files].map(([path, lines]) => `${visibleText(path)}:${lines.join(', ')}`).join('; ');
    const more = places.size - named.length;
    const text = more > 0 ? t('{0} and {1} more', listed, more) : listed;
    return places.size === 1
      ? t('The commented line {0} changed, so nothing was sent. Delete that comment, then comment on the line again if it still applies.', text)
      : t('The commented lines {0} changed, so nothing was sent. Delete those comments, then comment on the lines again if they still apply.', text);
  }

  /**
   * Puts core's reading of which kept drafts are stale on the review's tab. A draft whose anchor read failed is left unmarked:
   * Send reads its anchor again and core decides then.
   */
  private async markStale(reviewId: string): Promise<void> {
    const review = this.reviews.get(reviewId);
    const session = review ? this.deps.session(review.chatKey) : undefined;
    if (!review || !session) return;
    const mark = ++review.marks;
    const kept = this.drafts.get(this.draftKey(review.chatKey)) ?? [];
    const anchored = (await Promise.allSettled(kept.map((draft) => draft.anchor))).flatMap((anchor, index) =>
      anchor.status === 'fulfilled' ? [{ draft: kept[index]!, checked: { ...kept[index]!.comment, anchor: anchor.value } }] : []);
    let stale: readonly DraftComment[];
    try {
      stale = await session.chatReviewStale(anchored.map(({ checked }) => checked));
    } catch (err) {
      // The marks only show what Send will refuse, and Send reads it again; a failed reading keeps the marks as they were.
      this.deps.log(`[ChatReview] reading which comments are stale failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.reviews.get(reviewId) !== review || review.marks !== mark) return;
    const staleComments = anchored.filter(({ checked }) => stale.includes(checked)).map(({ draft }) => draft.comment);
    const tab = this.deps.editorPane().reviewTabs().find((candidate) => candidate.reviewId === reviewId);
    if (tab) this.deps.editorPane().updateReview({ ...tab, staleComments });
  }

  private reviewIdOf(chatKey: string): string | undefined {
    for (const [reviewId, review] of this.reviews) if (review.chatKey === chatKey) return reviewId;
    return undefined;
  }

  private isOpen(reviewId: string): boolean {
    return this.deps.editorPane().reviewTabs().some((tab) => tab.reviewId === reviewId);
  }

  private draftKey(chatKey: string): string {
    return this.deps.sessionId(chatKey) ?? chatKey;
  }

  private commentsOf(chatKey: string): ChatReviewComment[] {
    return (this.drafts.get(this.draftKey(chatKey)) ?? []).map((draft) => draft.comment);
  }

  private tabOf(reviewId: string, chatKey: string, scope: ChatScope, snapshot: ChatReviewSnapshot): ChatReviewTab {
    const title = this.deps.title(chatKey);
    return {
      reviewId,
      title: this.deps.t('Changes: {0}', title === '' ? this.deps.t('New chat') : title),
      scope,
      entries: snapshot.files.map((file) => ({
        path: file.path,
        status: file.status,
        added: file.added,
        removed: file.removed,
        binary: file.binary,
        outsideEdits: file.outsideEdits,
        revision: file.revision,
        commentable: isCommentable(file),
      })),
      shellChangesNotListed: snapshot.shellChangesNotListed,
      draftsKey: this.draftKey(chatKey),
      comments: this.commentsOf(chatKey),
      staleComments: this.reviewTabOf(reviewId)?.staleComments ?? [],
      ...(snapshot.sharedWith !== undefined && snapshot.sharedWith > 0 ? { sharedWith: snapshot.sharedWith } : {}),
    };
  }

  private async refresh(reviewId: string): Promise<void> {
    const review = this.reviews.get(reviewId);
    const session = review ? this.deps.session(review.chatKey) : undefined;
    if (!review || !session) return;
    await this.read(reviewId, review, session, { focus: false, fresh: false });
  }

  // Reads the review's scope and puts it in its tab, unless the review closed, its scope moved or a later read landed first.
  private async read(reviewId: string, review: Review, session: ReviewSession, opts: { readonly focus: boolean; readonly fresh: boolean }): Promise<void> {
    const serial = ++review.serial;
    const scope = review.scope;
    const snapshot = await session.chatReviewSnapshot(scope, { fresh: opts.fresh });
    if (this.reviews.get(reviewId) !== review) return;
    const current = review.scope === scope && serial > review.landed;
    if (current) {
      review.landed = serial;
      review.generation = snapshot.generation;
    }
    const pane = this.deps.editorPane();
    const open = this.isOpen(reviewId);
    if (opts.focus || !open) {
      // a later read that already filled the tab is kept, and the open only focuses it
      const tab = current || !open ? this.tabOf(reviewId, review.chatKey, scope, snapshot) : pane.reviewTabs().find((candidate) => candidate.reviewId === reviewId)!;
      pane.showReview(tab, { focus: opts.focus });
    } else if (current) {
      pane.updateReview(this.tabOf(reviewId, review.chatKey, scope, snapshot));
    }
    // A tab opened again shows marks for drafts kept while it was closed, so every read that reaches the tab marks it.
    if (current || opts.focus || !open) await this.markStale(reviewId);
  }

  private reviewTabOf(reviewId: string): ChatReviewTab | undefined {
    return this.deps.editorPane().reviewTabs().find((candidate) => candidate.reviewId === reviewId);
  }

  private updateComments(reviewId: string, chatKey: string): void {
    const tab = this.deps.editorPane().reviewTabs().find((candidate) => candidate.reviewId === reviewId);
    if (tab) this.deps.editorPane().updateReview({ ...tab, draftsKey: this.draftKey(chatKey), comments: this.commentsOf(chatKey) });
  }
}
