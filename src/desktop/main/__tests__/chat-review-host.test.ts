import { describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '../../../core/chat-session';
import type { ChatReviewSnapshot, DraftComment, ReviewSubmitOutcome } from '../../../core/pi-session/chat-review';
import type { ChatChangeFile, ChatScope } from '../../../core/pi-session/chat-changes';
import type { ChatReviewComment, ChatReviewTab } from '../../preload/review-channels';
import { ChatReviewHost } from '../chat-review-host';
import type { EditorPane } from '../editor-pane';

/** Main's side of the chat review (D60): review ids, draft keeping and anchors, send outcomes and refresh ordering. */

const file = (path: string, revision = 'ab12'): ChatChangeFile => ({
  path,
  absolute: `/work/${path}`,
  status: 'M',
  added: 1,
  removed: 1,
  binary: false,
  outsideEdits: false,
  diff: { kind: 'texts', before: 'a\n', after: 'b\n' },
  revision,
});

const snapshot = (paths: readonly string[], generation: number): ChatReviewSnapshot => ({ files: paths.map((path) => file(path)), shellChangesNotListed: true, generation });

const comment = (line: number, text = `comment ${line}`): ChatReviewComment => ({ path: 'a.ts', line, side: 'added', scope: 'chat', text, revision: 'ab12' });

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const tabs = new Map<string, ChatReviewTab>();
  const warnings: string[] = [];
  const logged: string[] = [];
  // each scope's next snapshot; a read with none queued answers at generation 1
  const queued: Array<{ scope: ChatScope; reply: Deferred<ChatReviewSnapshot> }> = [];
  const session = {
    chatReviewSnapshot: vi.fn((scope: ChatScope) => {
      const index = queued.findIndex((candidate) => candidate.scope === scope);
      return index < 0 ? Promise.resolve(snapshot(['a.ts'], 1)) : queued.splice(index, 1)[0]!.reply.promise;
    }),
    chatReviewFileDiff: vi.fn(async () => ({ kind: 'patch' as const, patch: '' })),
    chatReviewAnchor: vi.fn(async (place: { line: number }) => `anchor ${place.line}`),
    submitReview: vi.fn(async (_drafts: readonly DraftComment[]): Promise<ReviewSubmitOutcome> => 'sent'),
    // core's reading of which drafts are stale; none unless a test says so
    chatReviewStale: vi.fn(async (_drafts: readonly DraftComment[]): Promise<DraftComment[]> => []),
  };
  let sessionId: string | undefined = 'session-1';
  let loaded = true;
  const pane = {
    showReview: vi.fn((tab: ChatReviewTab) => {
      tabs.set(tab.reviewId, tab);
      return tab.reviewId;
    }),
    updateReview: vi.fn((tab: ChatReviewTab) => {
      if (tabs.has(tab.reviewId)) tabs.set(tab.reviewId, tab);
    }),
    reviewTabs: () => [...tabs.values()],
    closeReview: async (reviewId: string) => {
      tabs.delete(reviewId);
      host.reviewClosed(reviewId);
    },
  };
  const host: ChatReviewHost = new ChatReviewHost({
    session: () => (loaded ? (session as unknown as ChatSession) : undefined),
    sessionId: () => sessionId,
    title: () => 'Fix it',
    editorPane: () => pane as unknown as EditorPane,
    warn: (message) => warnings.push(message),
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)])),
    menuChanged: () => undefined,
    log: (line) => logged.push(line),
  });
  return {
    host,
    session,
    pane,
    tabs,
    warnings,
    logged,
    tab: (): ChatReviewTab => [...tabs.values()][0]!,
    queue: (scope: ChatScope): Deferred<ChatReviewSnapshot> => {
      const reply = deferred<ChatReviewSnapshot>();
      queued.push({ scope, reply });
      return reply;
    },
    moveTo: (id: string | undefined) => {
      sessionId = id;
    },
    unload: () => {
      loaded = false;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the review tab', () => {
  it('opens with the chat\'s entries read afresh, their revision and whether a line takes comments', async () => {
    const { host, session, tab } = setup();
    await host.show('panel-1', 'chat');
    expect(session.chatReviewSnapshot).toHaveBeenCalledWith('chat', { fresh: true });
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 2);
    await flush();
    expect(session.chatReviewSnapshot).toHaveBeenLastCalledWith('chat', { fresh: false });
    expect(tab()).toMatchObject({ title: 'Changes: Fix it', scope: 'chat', draftsKey: 'session-1', comments: [], staleComments: [] });
    expect(tab().entries).toEqual([{ path: 'a.ts', status: 'M', added: 1, removed: 1, binary: false, outsideEdits: false, revision: 'ab12', commentable: true }]);
  });

  it('lists only the scope the user chose last, whichever read finishes last', async () => {
    const { host, session, tab, queue } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    const slowChat = queue('chat');
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 2 }, 2);
    const turn = queue('turn');
    const scoped = host.setScope({ reviewId, scope: 'turn' });
    turn.resolve(snapshot(['turn-only.ts'], 2));
    await scoped;
    slowChat.resolve(snapshot(['a.ts', 'b.ts'], 2));
    await flush();
    expect(tab().scope).toBe('turn');
    expect(tab().entries.map((entry) => entry.path)).toEqual(['turn-only.ts']);
    expect(session.chatReviewSnapshot).toHaveBeenCalledTimes(3);
  });

  it('drops a read that finishes after a newer one landed', async () => {
    const { host, tab, queue } = setup();
    await host.show('panel-1', 'chat');
    const older = queue('chat');
    const newer = queue('chat');
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 2);
    host.chatChanged('panel-1', { added: 2, removed: 1, files: 1 }, 3);
    newer.resolve(snapshot(['new.ts'], 3));
    await flush();
    older.resolve(snapshot(['old.ts'], 2));
    await flush();
    expect(tab().entries.map((entry) => entry.path)).toEqual(['new.ts']);
  });

  it('reads nothing again for a publish of the generation the tab already shows', async () => {
    const { host, session } = setup();
    await host.show('panel-1', 'chat');
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 1);
    await flush();
    expect(session.chatReviewSnapshot).toHaveBeenCalledTimes(1);
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 2);
    await flush();
    expect(session.chatReviewSnapshot).toHaveBeenCalledTimes(2);
  });

  it('reads nothing for a review whose tab the user closed, or whose open failed', async () => {
    const { host, session, pane, tab, queue } = setup();
    await host.show('panel-1', 'chat');
    await pane.closeReview(tab().reviewId);
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 2);
    await flush();
    expect(session.chatReviewSnapshot).toHaveBeenCalledTimes(1);

    const failing = queue('chat');
    const shown = host.show('panel-1', 'chat');
    failing.reject(new Error('the read failed'));
    await expect(shown).rejects.toThrow('the read failed');
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 3);
    await flush();
    expect(session.chatReviewSnapshot).toHaveBeenCalledTimes(2);
  });

  it('closes with its chat and keeps the chat\'s drafts for the run', async () => {
    const { host, tabs, tab } = setup();
    await host.show('panel-1', 'chat');
    host.setDrafts({ reviewId: tab().reviewId, comments: [comment(1)] });
    await host.panelClosed('panel-1');
    expect(tabs.size).toBe(0);
    await host.show('panel-1', 'chat');
    expect(tab().comments).toEqual([comment(1)]);
  });
});

describe('drafts', () => {
  it('keeps each session\'s drafts apart, and the tab names whose drafts it shows', async () => {
    const { host, tab, moveTo } = setup();
    await host.show('panel-1', 'chat');
    host.setDrafts({ reviewId: tab().reviewId, comments: [comment(1)] });
    moveTo('session-2');
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 2);
    await flush();
    expect(tab()).toMatchObject({ draftsKey: 'session-2', comments: [] });
    moveTo('session-1');
    host.chatChanged('panel-1', { added: 1, removed: 1, files: 1 }, 3);
    await flush();
    expect(tab()).toMatchObject({ draftsKey: 'session-1', comments: [comment(1)] });
  });

  it('records each comment\'s anchor from core when it first arrives and sends it with the comment', async () => {
    const { host, session, tab } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    host.setDrafts({ reviewId, comments: [comment(1)] });
    host.setDrafts({ reviewId, comments: [comment(1), comment(2)] });
    expect(session.chatReviewAnchor).toHaveBeenCalledTimes(2);
    expect(session.chatReviewAnchor.mock.calls.map(([place]) => place.line)).toEqual([1, 2]);
    expect(await host.send({ reviewId })).toEqual({ ok: true });
    expect(session.submitReview).toHaveBeenCalledWith([{ ...comment(1), anchor: 'anchor 1' }, { ...comment(2), anchor: 'anchor 2' }]);
    expect(tab().comments).toEqual([]);
  });

  it('keeps a comment added while the send ran', async () => {
    const { host, session, tab } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    host.setDrafts({ reviewId, comments: [comment(1)] });
    const taken = deferred<'sent'>();
    session.submitReview.mockReturnValueOnce(taken.promise);
    const sending = host.send({ reviewId });
    await flush();
    host.setDrafts({ reviewId, comments: [comment(1), comment(2)] });
    taken.resolve('sent');
    expect(await sending).toEqual({ ok: true });
    expect(tab().comments).toEqual([comment(2)]);
  });

  it('fails the send of a comment whose anchor read failed, and reads that anchor again at the next send', async () => {
    const { host, session, tab } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    session.chatReviewAnchor.mockRejectedValueOnce(new Error('locked'));
    host.setDrafts({ reviewId, comments: [comment(1)] });
    await expect(host.send({ reviewId })).rejects.toThrow('locked');
    expect(await host.send({ reviewId })).toEqual({ ok: true });
    expect(session.chatReviewAnchor).toHaveBeenCalledTimes(2);
    expect(session.submitReview).toHaveBeenCalledWith([{ ...comment(1), anchor: 'anchor 1' }]);
  });
});

describe('stale comments', () => {
  it('marks on the tab the comments core reads as stale, and only those, and the bar and the notice say the same, naming each line', async () => {
    const { host, session, tab, warnings } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    session.chatReviewStale.mockImplementation(async (drafts) => drafts.filter((draft) => draft.line !== 1));
    await host.setDrafts({ reviewId, comments: [comment(1), comment(2), comment(3, 'another')] });
    expect(tab().staleComments).toEqual([comment(2), comment(3, 'another')]);
    expect(session.chatReviewStale).toHaveBeenLastCalledWith([{ ...comment(1), anchor: 'anchor 1' }, { ...comment(2), anchor: 'anchor 2' }, { ...comment(3, 'another'), anchor: 'anchor 3' }]);
    session.submitReview.mockImplementationOnce(async (drafts) => ({ stale: drafts.filter((draft) => draft.line !== 1) }));
    const result = await host.send({ reviewId });
    expect(result).toEqual({ ok: false, reason: 'stale', message: 'The commented lines a.ts:2, 3 changed, so nothing was sent. Delete those comments, then comment on the lines again if they still apply.' });
    expect(warnings).toEqual([result.ok ? '' : 'message' in result ? result.message : '']);
    // the user deletes the stale comments; the tab's marks follow core again
    session.chatReviewStale.mockImplementation(async () => []);
    await host.setDrafts({ reviewId, comments: [comment(1)] });
    expect(tab().staleComments).toEqual([]);
  });

  it('marks a kept comment stale when its tab opens again after the chat changed the line while it was closed', async () => {
    const { host, session, tab, pane } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    await host.setDrafts({ reviewId, comments: [comment(2)] });
    await pane.closeReview(reviewId);
    session.chatReviewStale.mockImplementation(async (drafts) => [...drafts]);
    await host.show('panel-1', 'chat');
    expect(tab().comments).toEqual([comment(2)]);
    expect(tab().staleComments).toEqual([comment(2)]);
  });

  it('keeps the marks and the outcome of the request when reading the stale comments fails, and logs it', async () => {
    const { host, session, tab, warnings, logged } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    session.chatReviewStale.mockRejectedValue(new Error('the worktree folder is gone'));
    await expect(host.setDrafts({ reviewId, comments: [comment(1)] })).resolves.toBeUndefined();
    expect(tab().comments).toEqual([comment(1)]);
    session.submitReview.mockImplementationOnce(async (drafts) => ({ stale: [...drafts] }));
    const result = await host.send({ reviewId });
    expect(result).toEqual({ ok: false, reason: 'stale', message: warnings[0] });
    expect(logged).toEqual(['[ChatReview] reading which comments are stale failed: the worktree folder is gone', '[ChatReview] reading which comments are stale failed: the worktree folder is gone']);
  });

  it('names a removed line as removed, groups lines under their file and names at most three', async () => {
    const { host, session, tab } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    const comments = [comment(2), { ...comment(2), side: 'removed' as const }, { ...comment(7), path: 'b.ts' }, comment(9), comment(11)];
    await host.setDrafts({ reviewId, comments });
    session.submitReview.mockImplementationOnce(async (drafts) => ({ stale: [...drafts] }));
    expect(await host.send({ reviewId })).toEqual({ ok: false, reason: 'stale', message: 'The commented lines a.ts:2, 2 (removed); b.ts:7 and 2 more changed, so nothing was sent. Delete those comments, then comment on the lines again if they still apply.' });
  });

  it('marks a comment stale once the chat changes its line, when the tab reads the new changes', async () => {
    const { host, session, tab } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    await host.setDrafts({ reviewId, comments: [comment(2)] });
    expect(tab().staleComments).toEqual([]);
    session.chatReviewStale.mockImplementation(async (drafts) => [...drafts]);
    host.chatChanged('panel-1', { added: 2, removed: 1, files: 1 }, 2);
    await flush();
    await flush();
    expect(tab().staleComments).toEqual([comment(2)]);
  });
});

describe('send outcomes', () => {
  it('keeps the drafts of a stale or unsent send and says why, each with its own reason', async () => {
    const { host, session, tab, warnings } = setup();
    await host.show('panel-1', 'chat');
    const reviewId = tab().reviewId;
    await host.setDrafts({ reviewId, comments: [comment(1)] });
    session.submitReview.mockImplementationOnce(async (drafts) => ({ stale: [...drafts] }));
    expect(await host.send({ reviewId })).toEqual({ ok: false, reason: 'stale', message: 'The commented line a.ts:1 changed, so nothing was sent. Delete that comment, then comment on the line again if it still applies.' });
    session.submitReview.mockResolvedValueOnce('unsent');
    expect(await host.send({ reviewId })).toEqual({ ok: false, reason: 'unsent' });
    expect(warnings).toHaveLength(2);
    expect(tab().comments).toEqual([comment(1)]);
    session.submitReview.mockResolvedValueOnce('empty');
    expect(await host.send({ reviewId })).toEqual({ ok: false, reason: 'empty' });
  });

  it('answers missing once the chat is gone', async () => {
    const { host, tab, unload } = setup();
    await host.show('panel-1', 'chat');
    unload();
    expect(await host.send({ reviewId: tab().reviewId })).toEqual({ ok: false, reason: 'missing' });
    expect(await host.send({ reviewId: 'unknown' })).toEqual({ ok: false, reason: 'missing' });
  });
});
