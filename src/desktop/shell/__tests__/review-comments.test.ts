// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, shallowRef } from 'vue';
import type { ChatReviewComment, ChatReviewTab } from '../../preload/review-channels';
import type { ShellEditorTab } from '../../preload/shell-channels';
import ChangesTab from '../editor/ChangesTab.vue';
import ChatReviewTabView from '../editor/ChatReviewTab.vue';
import type { ChangesEntry, ChangesSource } from '../editor/changes-source';
import { shellI18n } from '../i18n';
import { fakeShellApi, FakeResizeObserver } from './fakes';

const PATCH = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-old one\n+new one\n two\n-old three\n+new three\n';

const mounted: VueWrapper[] = [];
beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // reduced motion: a closing box goes at once, with no animationend to wait for
  document.documentElement.setAttribute('data-reduced-motion', '');
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-reduced-motion');
});

const ENTRY: ChangesEntry = { path: 'a.ts', letter: 'M', tone: 'modified', status: 'Modified', strike: false, version: '1', commentable: true };

async function mountTab(options: { entry?: Partial<ChangesEntry>; patch?: string; full?: boolean; diff?: ChangesSource['fileDiff']; missingText?: string } = {}) {
  const drafts = shallowRef<ChatReviewComment[]>([]);
  const full = shallowRef(options.full === true);
  const source = (): ChangesSource => ({
    entries: [{ ...ENTRY, ...options.entry }],
    emptyText: 'none',
    fileDiff: options.diff ?? (async () => ({ kind: 'patch', patch: options.patch ?? PATCH, revision: 'ab12' })),
    ...(options.missingText ? { missingText: options.missingText } : {}),
    comments: {
      of: (path) => drafts.value.filter((comment) => comment.path === path),
      add: (comment) => {
        drafts.value = [...drafts.value, { ...comment, scope: 'chat' }];
      },
      get full() {
        return full.value;
      },
      remove: (comment) => {
        drafts.value = drafts.value.filter((candidate) => candidate !== comment);
      },
      stale: () => false,
      hint: 'Click a line number to comment',
    },
  });
  const wrapper = mount(ChangesTab, { props: { source: source(), lead: 'This chat' }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, drafts, full };
}

const lineRow = (wrapper: VueWrapper, type: string, nth = 0) => wrapper.findAll(`[data-testid="changes-line"][data-type="${type}"]`)[nth]!;
const input = (wrapper: VueWrapper) => wrapper.find('[data-testid="review-comment-input"]');
const focusedRow = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset['row'];

async function addComment(wrapper: VueWrapper, row: ReturnType<typeof lineRow>, text: string): Promise<void> {
  await row.trigger('keydown', { key: 'Enter' });
  await nextTick();
  await input(wrapper).setValue(text);
  await input(wrapper).trigger('keydown', { key: 'Enter' });
  await flushPromises();
}

describe('review line comments (D60)', () => {
  it('opens a box from a line number or Enter on a focused line; Enter adds, Escape cancels, and the next line opens again', async () => {
    const { wrapper, drafts } = await mountTab();
    await lineRow(wrapper, 'addition').find('[data-testid="review-line-number"]').trigger('click');
    await nextTick();
    expect(input(wrapper).exists()).toBe(true);
    await input(wrapper).setValue('Why new?');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(drafts.value).toEqual([{ path: 'a.ts', line: 1, side: 'added', scope: 'chat', text: 'Why new?', revision: 'ab12' }]);
    expect(input(wrapper).exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="review-comment"]')).toHaveLength(1);

    // a removed line from the keyboard names its old line number
    await addComment(wrapper, lineRow(wrapper, 'deletion', 1), 'Keep three');
    expect(drafts.value[1]).toMatchObject({ line: 3, side: 'removed', text: 'Keep three' });

    // Escape cancels without a comment, and another line still opens
    await lineRow(wrapper, 'addition', 1).trigger('keydown', { key: 'Enter' });
    await nextTick();
    expect(input(wrapper).exists()).toBe(true);
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(input(wrapper).exists()).toBe(false);
    expect(drafts.value).toHaveLength(2);
    await lineRow(wrapper, 'addition', 0).trigger('keydown', { key: 'Enter' });
    await nextTick();
    expect(input(wrapper).exists()).toBe(true);
  });

  it('names the revision of the diff it was served on a comment, not the one its entry had when it asked', async () => {
    const { wrapper, drafts } = await mountTab({ entry: { version: 'asked-at-r0' }, diff: async () => ({ kind: 'patch', patch: PATCH, revision: 'cd34' }) });
    await addComment(wrapper, lineRow(wrapper, 'addition'), 'On the served diff');
    expect(drafts.value[0]).toMatchObject({ revision: 'cd34' });
  });

  it('adds nothing for an empty or blank comment', async () => {
    const { wrapper, drafts } = await mountTab();
    await lineRow(wrapper, 'addition').trigger('keydown', { key: 'Enter' });
    await nextTick();
    await input(wrapper).setValue('   ');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(drafts.value).toEqual([]);
  });

  it('moves the keyboard focus past a comment card to the next line, and Home and End to the first and last lines', async () => {
    const { wrapper } = await mountTab();
    await addComment(wrapper, lineRow(wrapper, 'addition', 0), 'On new one');
    await addComment(wrapper, lineRow(wrapper, 'addition', 1), 'On new three');
    // rows: old one, new one, its card, two, old three, new three, its card
    const added = lineRow(wrapper, 'addition', 0);
    (added.element as HTMLElement).focus();
    await added.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(document.activeElement).toBe(lineRow(wrapper, 'context').element);
    expect(lineRow(wrapper, 'context').attributes('tabindex')).toBe('0');
    await lineRow(wrapper, 'context').trigger('keydown', { key: 'ArrowUp' });
    await flushPromises();
    expect(document.activeElement).toBe(lineRow(wrapper, 'addition', 0).element);
    await lineRow(wrapper, 'addition', 0).trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(document.activeElement).toBe(lineRow(wrapper, 'addition', 1).element);
    await lineRow(wrapper, 'addition', 1).trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(document.activeElement).toBe(lineRow(wrapper, 'addition', 1).element);
    await lineRow(wrapper, 'addition', 1).trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(focusedRow()).toBe('0');
    expect(wrapper.findAll('[data-testid="changes-line"][tabindex="0"]')).toHaveLength(1);
  });

  it('keeps one tab stop on a rendered line when the focused line scrolls out of the virtual window', async () => {
    const many = Array.from({ length: 300 }, (_, index) => `+line ${index + 1}`).join('\n');
    const { wrapper } = await mountTab({ patch: `--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,300 @@\n${many}\n` });
    const diff = wrapper.get('[data-testid="changes-diff"]');
    (lineRow(wrapper, 'addition', 0).element as HTMLElement).focus();
    await flushPromises();
    diff.element.scrollTop = 4000;
    await diff.trigger('scroll');
    await flushPromises();
    expect(wrapper.find('[data-row="0"]').exists()).toBe(false);
    const stops = wrapper.findAll('[data-testid="changes-line"][tabindex="0"]');
    expect(stops).toHaveLength(1);
  });

  it('keeps the box open with its text and says why while the review holds the most comments it can, and adds once it does not', async () => {
    const { wrapper, drafts, full } = await mountTab({ full: true });
    await lineRow(wrapper, 'addition').trigger('keydown', { key: 'Enter' });
    await nextTick();
    // the box says so as it opens, before anything is typed
    expect(wrapper.get('[data-testid="review-comment-refused"]').text()).toBe(shellI18n.global.t('review.full', { count: 200 }));
    await input(wrapper).setValue('One too many');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(input(wrapper).exists()).toBe(true);
    expect((input(wrapper).element as HTMLTextAreaElement).value).toBe('One too many');
    expect(drafts.value).toEqual([]);
    full.value = false;
    await flushPromises();
    expect(wrapper.find('[data-testid="review-comment-refused"]').exists()).toBe(false);
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(drafts.value.map((comment) => comment.text)).toEqual(['One too many']);
  });

  it('keeps the tab stop on the focused line when a card above it goes', async () => {
    const { wrapper, drafts } = await mountTab();
    await addComment(wrapper, lineRow(wrapper, 'addition', 0), 'On new one');
    await addComment(wrapper, lineRow(wrapper, 'addition', 1), 'On new three');
    const last = lineRow(wrapper, 'addition', 1);
    (last.element as HTMLElement).focus();
    await flushPromises();
    drafts.value = drafts.value.slice(1);
    await flushPromises();
    const stops = wrapper.findAll('[data-testid="changes-line"][tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.element).toBe(lineRow(wrapper, 'addition', 1).element);
  });

  it('offers no line comments on a diff whose lines core cannot check, the recorded patches', async () => {
    const { wrapper } = await mountTab({ entry: { commentable: false } });
    expect(wrapper.findAll('[data-testid="review-line-number"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('Click a line number to comment');
    await lineRow(wrapper, 'addition').trigger('keydown', { key: 'Enter' });
    await nextTick();
    expect(input(wrapper).exists()).toBe(false);
  });

  it('names a file listed by its absolute Windows path by its own name, and escapes hidden characters in the diff\'s label', async () => {
    const { wrapper } = await mountTab({ entry: { path: 'C:\\Users\\me\\notes\u202Etxt' } });
    const entry = wrapper.get('[data-testid="changes-entry"]');
    expect(entry.text()).toContain('notes\\u{202E}txt');
    expect(entry.text()).toContain('C:\\Users\\me');
    expect(wrapper.get('[data-testid="changes-diff"]').attributes('aria-label')).toBe('Diff of C:\\Users\\me\\notes\\u{202E}txt');
  });

  it('says a file left the list in the source\'s own words', async () => {
    const { wrapper } = await mountTab({ diff: async () => ({ kind: 'missing' }), missingText: 'This file is no longer in this chat\'s changes.' });
    expect(wrapper.get('[data-testid="changes-notice"]').text()).toBe('This file is no longer in this chat\'s changes.');
  });
});

describe('the review tab\'s bar', () => {
  const reviewOf = (overrides: Partial<ChatReviewTab> = {}): ChatReviewTab => ({
    reviewId: 'r1',
    title: 'Changes: Fix it',
    scope: 'chat',
    entries: [{ path: 'a.ts', status: 'M', added: 2, removed: 2, binary: false, outsideEdits: false, revision: 'ab12', commentable: true }],
    shellChangesNotListed: true,
    draftsKey: 'session-1',
    comments: [],
    staleComments: [],
    ...overrides,
  });
  const tabOf = (review: ChatReviewTab): ShellEditorTab & { review: ChatReviewTab } => ({ id: 't1', kind: 'review', title: review.title, displayPath: review.title, dirty: false, readOnly: true, conflict: false, review });

  async function mountReview(review = reviewOf()) {
    const api = fakeShellApi();
    vi.mocked(api.review.fileDiff).mockResolvedValue({ kind: 'patch', patch: PATCH, revision: 'ab12' });
    const wrapper = mount(ChatReviewTabView, { props: { api, tab: tabOf(review), platform: 'win32' }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    return { api, wrapper };
  }

  async function oneComment(wrapper: VueWrapper): Promise<void> {
    await addComment(wrapper, lineRow(wrapper, 'addition'), 'Why?');
  }

  it('marks a stale comment where it sits, lists one whose line left the diff above it, and shows the words of main for a stale send', async () => {
    const onLine = { path: 'a.ts', line: 1, side: 'added' as const, scope: 'chat' as const, text: 'Why new?', revision: 'ab12' };
    const gone = { ...onLine, line: 40, text: 'Line 40 left' };
    const fresh = { ...onLine, line: 3, text: 'Still fine' };
    const { api, wrapper } = await mountReview(reviewOf({ comments: [onLine, gone, fresh], staleComments: [onLine, gone] }));
    const cards = wrapper.findAll('[data-testid="review-comment"]');
    expect(cards.map((card) => card.text().includes('Line 40 left'))).toEqual([true, false, false]);
    const stale = cards.filter((card) => card.find('[data-testid="review-comment-stale"]').exists());
    expect(stale.map((card) => card.find('p').text())).toEqual(['Line 40 left', 'Why new?']);
    for (const card of stale) expect(card.get('[data-testid="review-comment-stale"]').text()).toBe(shellI18n.global.t('review.staleComment'));
    expect(cards[2]!.find('[data-testid="review-comment-stale"]').exists()).toBe(false);
    const message = 'The commented lines a.ts:1, a.ts:40 changed, so nothing was sent. Delete the comments there or comment on the lines again.';
    vi.mocked(api.review.send).mockResolvedValueOnce({ ok: false, reason: 'stale', message });
    await wrapper.get('[data-testid="review-send"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="review-send-failure"]').text()).toBe(message);
  });

  it('says the chat could not take the comments, in its own words, and keeps them', async () => {
    const { api, wrapper } = await mountReview();
    await oneComment(wrapper);
    vi.mocked(api.review.send).mockResolvedValueOnce({ ok: false, reason: 'unsent' });
    await wrapper.get('[data-testid="review-send"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="review-send-failure"]').text()).toBe(shellI18n.global.t('review.failed.unsent'));
    expect(wrapper.get('[data-testid="review-bar"]').text()).toContain('1');
  });

  it('says a send that failed failed, and keeps the comments', async () => {
    const { api, wrapper } = await mountReview();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await oneComment(wrapper);
    vi.mocked(api.review.send).mockRejectedValueOnce(new Error('main threw'));
    await wrapper.get('[data-testid="review-send"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="review-send-failure"]').text()).toBe(shellI18n.global.t('review.failed.error'));
    expect(logged).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="review-bar"]').exists()).toBe(true);
  });

  it('adds the comment typed in the open box before Ctrl+Enter sends', async () => {
    const { api, wrapper } = await mountReview();
    await oneComment(wrapper);
    await lineRow(wrapper, 'deletion').trigger('keydown', { key: 'Enter' });
    await nextTick();
    await input(wrapper).setValue('And this one');
    await input(wrapper).trigger('keydown', { key: 'Enter', ctrlKey: true });
    await flushPromises();
    const lastDrafts = vi.mocked(api.review.setDrafts).mock.calls.at(-1)![0].comments;
    expect(lastDrafts.map((comment) => comment.text)).toEqual(['Why?', 'And this one']);
    expect(vi.mocked(api.review.send)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.review.setDrafts).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(api.review.send).mock.invocationCallOrder[0]!);
  });

  it('takes main\'s drafts when the chat\'s session under the open tab changes', async () => {
    const kept = { path: 'a.ts', line: 1, side: 'added' as const, scope: 'chat' as const, text: 'kept', revision: 'ab12' };
    const { wrapper } = await mountReview(reviewOf({ comments: [kept] }));
    expect(wrapper.findAll('[data-testid="review-comment"]')).toHaveLength(1);
    await wrapper.setProps({ tab: tabOf(reviewOf({ draftsKey: 'session-2', comments: [] })) });
    await flushPromises();
    expect(wrapper.findAll('[data-testid="review-comment"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="review-bar"]').exists()).toBe(false);
  });
});

describe('deleting review comments', () => {
  it('deletes a comment card from the keyboard and moves focus to the line it was on', async () => {
    const { wrapper, drafts } = await mountTab();
    await addComment(wrapper, lineRow(wrapper, 'addition', 0), 'On new one');
    await addComment(wrapper, lineRow(wrapper, 'addition', 1), 'On new three');
    const line = lineRow(wrapper, 'addition', 1).element as HTMLElement;
    const remove = wrapper.findAll('[data-testid="review-comment-delete"]')[1]!;
    (remove.element as HTMLElement).focus();
    await remove.trigger('click');
    await flushPromises();
    expect(drafts.value.map((comment) => comment.text)).toEqual(['On new one']);
    expect(wrapper.findAll('[data-testid="review-comment"]')).toHaveLength(1);
    expect(document.activeElement).toBe(line);
    expect(line.getAttribute('tabindex')).toBe('0');
  });

  it('shows the drafts of a file that no longer takes comments as cards that say why they cannot be sent, each deletable', async () => {
    const { wrapper, drafts } = await mountTab();
    await addComment(wrapper, lineRow(wrapper, 'addition', 0), 'On new one');
    await addComment(wrapper, lineRow(wrapper, 'deletion', 1), 'Keep three');
    await wrapper.setProps({ source: { ...wrapper.props('source'), entries: [{ ...ENTRY, version: '2', commentable: false }] } });
    await flushPromises();
    const cards = wrapper.findAll('[data-testid="review-comment"]');
    expect(cards).toHaveLength(2);
    for (const card of cards) expect(card.get('[data-testid="review-comment-unsendable"]').text()).toBe(shellI18n.global.t('review.unsendable'));
    // no new comment can be added there
    expect(wrapper.findAll('[data-testid="review-line-number"]')).toHaveLength(0);
    const first = cards[0]!.get('[data-testid="review-comment-delete"]');
    (first.element as HTMLElement).focus();
    await first.trigger('click');
    await flushPromises();
    expect(drafts.value.map((comment) => comment.text)).toEqual(['Keep three']);
    // focus moves on to the next card's Delete
    expect(document.activeElement).toBe(wrapper.get('[data-testid="review-comment-delete"]').element);
    await wrapper.get('[data-testid="review-comment-delete"]').trigger('click');
    await flushPromises();
    expect(drafts.value).toEqual([]);
    expect(document.activeElement).toBe(lineRow(wrapper, 'deletion', 0).element);
  });
});
