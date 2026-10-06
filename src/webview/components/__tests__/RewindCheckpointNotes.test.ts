// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import RewindConfirmModal from '../RewindConfirmModal.vue';
import RewindBrowser from '../RewindBrowser.vue';
import { i18n } from '@/i18n';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useUIStore } from '@/stores/useUIStore';
import type { RewindHistoryItem, SkippedFile } from '@shared/types/session';

const mounted: VueWrapper[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const q = (selector: string) => document.body.querySelector(selector);
const qa = (selector: string) => [...document.body.querySelectorAll(selector)];
const rowText = (row: Element) => [...row.children].map((cell) => cell.textContent?.trim()).join(' ');

const MB = 1024 * 1024;
const GB = 1024 * MB;

// One file over the cap, one video and one virtualenv under the category excludes, three LFS weights;
// every category and LFS skip is also counted under the pattern that matched it, as the producer records
// them, and a directory skipped whole is one row with no size.
const manifestFiles: SkippedFile[] = [
  { path: 'renders/raw.rgba', bytes: GB, reason: 'size' },
  { path: 'out/final.mp4', bytes: 5 * MB, reason: 'category' },
  { path: '.venv/', bytes: null, reason: 'category' },
  { path: 'models/a.onnx', bytes: 10 * MB, reason: 'lfs' },
  { path: 'models/b.onnx', bytes: 10 * MB, reason: 'lfs' },
  { path: 'models/c.onnx', bytes: 10 * MB, reason: 'lfs' },
];
const skipped: NonNullable<RewindHistoryItem['skipped']> = {
  totalCount: 6,
  totalBytes: GB + 35 * MB,
  byReason: { size: { count: 1, bytes: GB }, category: { count: 2, bytes: 5 * MB }, lfs: { count: 3, bytes: 30 * MB } },
  patterns: [
    { pattern: '*.mp4', reason: 'category', count: 1, bytes: 5 * MB },
    { pattern: '.venv/', reason: 'category', count: 1, bytes: 0 },
    { pattern: '*.onnx', reason: 'lfs', count: 3, bytes: 30 * MB },
  ],
  manifest: 'c0ffee'.padEnd(40, '0'),
};

async function mountModal(props: Record<string, unknown>): Promise<VueWrapper> {
  const wrapper = mount(RewindConfirmModal, {
    props: { visible: true, canFork: true, filesAffected: 1, files: [{ path: '/w/a.ts', displayName: 'a.ts' }], checkpointId: 'u1', ...props },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper as VueWrapper);
  await flush();
  return wrapper as VueWrapper;
}

async function expandNotRestored(): Promise<void> {
  (q('[data-testid="rewind-not-restored"] button') as HTMLButtonElement).click();
  await flush();
}

beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = 'en';
});
afterEach(() => {
  vi.restoreAllMocks();
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('RewindConfirmModal checkpoint notes', () => {
  it('shows the summary without asking the host, then loads the full list when expanded', async () => {
    const post = vi.spyOn(usePlatformBridge(), 'postMessage');
    await mountModal({ skipped });
    const section = q('[data-testid="rewind-not-restored"]');
    expect(section?.textContent).toContain('Not restored by this checkpoint');
    expect(section?.textContent).toContain('6 files, 1.0 GB');
    expect(post).not.toHaveBeenCalled();

    await expandNotRestored();
    expect(qa('[data-testid="rewind-not-restored-reason"]').map(rowText)).toEqual([
      'over the size limit 1 file, 1.0 GB',
      'media, archive or build output 2 files, 5.0 MB',
      'Git LFS file 3 files, 30.0 MB',
    ]);
    expect(qa('[data-testid="rewind-not-restored-pattern"]').map(rowText)).toEqual([
      '*.mp4: 1 file media, archive or build output',
      '.venv/: 1 file media, archive or build output',
      '*.onnx: 3 files Git LFS file',
    ]);
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'requestSkippedFiles', target: { kind: 'turn', userEntryId: 'u1' } });
    expect(q('[data-testid="rewind-not-restored-loading"]')?.textContent).toContain('Loading the full list');

    useUIStore().setSkippedFiles({ kind: 'turn', userEntryId: 'u1' }, manifestFiles);
    await flush();
    expect(q('[data-testid="rewind-not-restored-loading"]')).toBeNull();
    expect(qa('[data-testid="rewind-not-restored-file"]').map(rowText)).toEqual([
      'renders/raw.rgba 1.0 GB over the size limit',
      'out/final.mp4 5.0 MB media, archive or build output',
      '.venv/ media, archive or build output',
      'models/a.onnx 10.0 MB Git LFS file',
      'models/b.onnx 10.0 MB Git LFS file',
      'models/c.onnx 10.0 MB Git LFS file',
    ]);
    expect(section?.textContent).toContain('A rewind leaves these files exactly as they are.');

    // A loaded list is not asked for again.
    await expandNotRestored();
    await expandNotRestored();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('says so when the full list cannot be read, and asks again on the next expand', async () => {
    const post = vi.spyOn(usePlatformBridge(), 'postMessage');
    await mountModal({ skipped });
    await expandNotRestored();
    useUIStore().setSkippedFiles({ kind: 'turn', userEntryId: 'u1' }, null);
    await flush();
    expect(q('[data-testid="rewind-not-restored-error"]')?.textContent).toContain('The full list could not be loaded.');
    expect(qa('[data-testid="rewind-not-restored-reason"]')).toHaveLength(3);

    await expandNotRestored();
    await expandNotRestored();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('shows nothing extra for a checkpoint that skipped no file', async () => {
    await mountModal({ skipped: { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null } });
    expect(q('[data-testid="rewind-not-restored"]')).toBeNull();
    expect(q('[data-testid="rewind-not-rewindable"]')).toBeNull();
  });

  it('shows a not-rewindable turn with its reason and offers only the fork', async () => {
    const wrapper = await mountModal({
      filesAffected: 0,
      files: undefined,
      notRewindable: { reason: 'baseline-timeout', params: { tool: 'Edit', waitSeconds: 30 } },
    });
    const note = q('[data-testid="rewind-not-rewindable"]');
    expect(note?.textContent).toContain('Files cannot be restored to this point');
    expect(note?.textContent).toContain('A file-changing tool ran before this turn\'s checkpoint was ready.');
    expect(note?.textContent).toContain('Edit waited 30 s for this turn\'s checkpoint and ran without it.');

    const options = qa('[role="alertdialog"] button[disabled]').map((b) => b.textContent ?? '');
    expect(options.some((text) => text.includes('Rewind code to here'))).toBe(true);
    expect(options.some((text) => text.includes('Fork conversation and rewind code'))).toBe(true);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    await flush();
    expect(wrapper.emitted('confirm')).toBeUndefined();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    expect(wrapper.emitted('confirm')).toEqual([['fork-conversation']]);
  });

  it('explains a chat with no project folder and offers only the fork, in English and Greek', async () => {
    const wrapper = await mountModal({ filesAffected: 0, files: undefined, notRewindable: { reason: 'no-project', params: {} } });
    expect(q('[data-testid="rewind-not-rewindable"]')?.textContent).toContain('This chat has no project folder, so its files are not checkpointed.');
    const disabled = qa('[role="alertdialog"] button[disabled]').map((b) => b.textContent ?? '');
    expect(disabled.some((text) => text.includes('Rewind code to here'))).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    expect(wrapper.emitted('confirm')).toEqual([['fork-conversation']]);
    mounted.pop()?.unmount();

    i18n.global.locale.value = 'el';
    await mountModal({ filesAffected: 0, files: undefined, notRewindable: { reason: 'no-project', params: {} } });
    expect(q('[data-testid="rewind-not-rewindable"]')?.textContent).toContain('Αυτή η συνομιλία δεν έχει φάκελο έργου');
  });

  it('renders in Greek, with the raw git error only as a parameter', async () => {
    i18n.global.locale.value = 'el';
    await mountModal({ skipped, notRewindable: { reason: 'baseline-failed', params: { error: 'fatal: Unable to create index.lock' } } });
    expect(q('[data-testid="rewind-not-restored"]')?.textContent).toContain('Δεν επαναφέρονται από αυτό το checkpoint');
    const note = q('[data-testid="rewind-not-rewindable"]')?.textContent ?? '';
    expect(note).toContain('Το checkpoint αυτού του γύρου δεν μπόρεσε να δημιουργηθεί.');
    expect(note).toContain('Το git ανέφερε: fatal: Unable to create index.lock');
    mounted.pop()?.unmount();

    await mountModal({ skipped, notRewindable: { reason: 'baseline-timeout', params: { tool: 'Bash', waitSeconds: 45 } } });
    expect(q('[data-testid="rewind-not-rewindable"]')?.textContent).toContain('Το Bash περίμενε 45 s το checkpoint αυτού του γύρου');
    await expandNotRestored();
    expect(q('[data-testid="rewind-not-restored-loading"]')?.textContent).toContain('Φόρτωση της πλήρους λίστας');
  });
});

describe('RewindBrowser checkpoint notes', () => {
  const items: RewindHistoryItem[] = [
    {
      messageId: 'u2', content: 'render the video', timestamp: Date.now(), filesAffected: 0,
      notRewindable: { reason: 'baseline-timeout', params: { tool: 'Bash', waitSeconds: 30 } },
    },
    { messageId: 'u1', content: 'set up the project', timestamp: Date.now(), filesAffected: 2, skipped },
  ];

  it('badges a not-rewindable row and explains the selected one', async () => {
    const wrapper = mount(RewindBrowser, { props: { prompts: items }, attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(wrapper as VueWrapper);
    await flush();
    expect(qa('[data-testid="rewind-row-not-rewindable"]')).toHaveLength(1);
    expect(q('[data-testid="rewind-not-rewindable"]')?.textContent).toContain('Bash waited 30 s');

    q('[data-testid="rewind-search"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await flush();
    expect(q('[data-testid="rewind-not-rewindable"]')).toBeNull();
    expect(q('[data-testid="rewind-not-restored"]')?.textContent).toContain('6 files');
  });
});
