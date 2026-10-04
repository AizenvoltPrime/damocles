// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import type { ToolCall } from '@shared/types/session';
import ToolCallCard from '../ToolCallCard.vue';
import DiffOverlay from '../DiffOverlay.vue';
import { useDiffStore } from '@/stores/useDiffStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { i18n } from '@/i18n';

const highlightDiffLines = vi.hoisted(() => vi.fn(async (lines: Array<{ content: string }>) => lines.map((line) => ({ ...line, highlightedContent: line.content }))));

vi.mock('@/utils/highlightDiff', () => ({ highlightDiffLines }));

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const BEFORE = lines(200);
/** pi's edit records this shape for a change on line 120 of a 200-line file. */
const PATCH = createTwoFilesPatch('src/a.ts', 'src/a.ts', BEFORE, BEFORE.replace('line 120\n', 'changed 120\n'), undefined, undefined, { context: 4, headerOptions: FILE_HEADERS_ONLY })!;

const Shell = { template: '<div><slot name="header-actions" /><slot /></div>' };

async function card(toolCall: ToolCall): Promise<VueWrapper> {
  const wrapper = mount(ToolCallCard, { props: { toolCall, source: 'session' }, global: { plugins: [i18n] } });
  await flushPromises();
  return wrapper;
}

/** Each rendered row's old number, new number and code, as the reader sees them. */
function rows(wrapper: VueWrapper): string[][] {
  return wrapper.findAll('[data-testid="diff-view"] tr').map((tr) => tr.findAll('td').map((td) => td.text()));
}

const newNumbers = (wrapper: VueWrapper): string[] => wrapper.findAll('[data-part="new-line"]').map((td) => td.text()).filter(Boolean);

function edit(over: Partial<ToolCall> = {}): ToolCall {
  return { id: 't-edit', name: 'Edit', input: { file_path: '/w/src/a.ts', old_string: 'line 120', new_string: 'changed 120' }, status: 'completed', ...over };
}

function write(over: Partial<ToolCall> = {}): ToolCall {
  return { id: 't-write', name: 'Write', input: { file_path: '/w/src/a.ts', content: 'one\ntwo\n' }, status: 'completed', ...over };
}

beforeEach(() => setActivePinia(createPinia()));

describe('an Edit card', () => {
  it('numbers its lines from the recorded patch, as they are in the file', async () => {
    const wrapper = await card(edit({ metadata: { patch: PATCH } }));

    expect(newNumbers(wrapper)).toEqual(['116', '117', '118', '119', '120', '121', '122', '123', '124']);
    expect(rows(wrapper)).toContainEqual(['', '120', '+', 'changed 120']);
    expect(rows(wrapper)).toContainEqual(['120', '', '-', 'line 120']);
    expect(wrapper.get('[data-testid="tool-card-change"]').text()).toBe('+1 −1');
  });

  it('colors the sign of a removed line only, never of a context line', async () => {
    const wrapper = await card(edit({ metadata: { patch: PATCH } }));

    expect(wrapper.findAll('[data-testid="diff-view"] [class*="--d-danger"]').map((td) => td.text())).toEqual(['-']);
  });

  it.each([
    ['denied', edit({ status: 'denied' })],
    ['failed', edit({ status: 'failed', errorMessage: 'not found' })],
    ['running before its result', edit({ status: 'running' })],
  ])('shows the change without line numbers when %s', async (_label, toolCall) => {
    const wrapper = await card(toolCall);

    expect(wrapper.get('[data-testid="diff-view"]').attributes('data-numbered')).toBe('false');
    expect(wrapper.findAll('[data-part="new-line"]')).toHaveLength(0);
    expect(rows(wrapper)).toEqual([['-', 'line 120'], ['+', 'changed 120']]);
  });

  it('numbers its lines from the approval while it awaits one', async () => {
    usePermissionStore().addPermission('t-edit', { toolName: 'Edit', patch: PATCH });

    const wrapper = await card(edit({ status: 'awaiting_approval' }));

    expect(newNumbers(wrapper)).toContain('120');
  });

  it.each([
    ['completed', edit({ metadata: { patch: PATCH } })],
    ['awaiting its own approval', edit({ status: 'awaiting_approval' })],
  ])('is not highlighted again when another call\'s prompt comes or goes (%s)', async (_label, toolCall) => {
    const permissions = usePermissionStore();
    permissions.addPermission('t-edit', { toolName: 'Edit', patch: PATCH });
    await card(toolCall);
    highlightDiffLines.mockClear();

    permissions.addPermission('t-other', { toolName: 'Bash', command: 'ls' });
    await flushPromises();
    permissions.removePermission('t-other');
    await flushPromises();

    expect(highlightDiffLines).not.toHaveBeenCalled();
  });
});

describe('a Write card', () => {
  it('numbers an overwrite from the patch the write recorded', async () => {
    const wrapper = await card(write({ input: { file_path: '/w/src/a.ts', content: 'unused' }, metadata: { patch: PATCH } }));

    expect(rows(wrapper)).toContainEqual(['', '120', '+', 'changed 120']);
  });

  it('numbers a new file from 1, where its lines are', async () => {
    const wrapper = await card(write({ metadata: { created: true } }));

    expect(rows(wrapper)).toEqual([['', '1', '+', 'one'], ['', '2', '+', 'two']]);
    expect(wrapper.get('[data-testid="tool-card-change"]').text()).toBe('+2 −0');
  });

  it('shows a Write that recorded neither a patch nor a creation without line numbers', async () => {
    const wrapper = await card(write());

    expect(wrapper.get('[data-testid="diff-view"]').attributes('data-numbered')).toBe('false');
    expect(rows(wrapper)).toEqual([['+', 'one'], ['+', 'two']]);
  });

  it.each([
    ['an empty new file', write({ input: { file_path: '/w/src/a.ts', content: '' }, metadata: { created: true } }), 'Empty file'],
    ['an overwrite that changed nothing', write({ metadata: { patch: '--- src/a.ts\n+++ src/a.ts\n' } }), 'No changes'],
  ])('says so when there are no lines to show, for %s', async (_label, toolCall, text) => {
    const wrapper = await card(toolCall);

    expect(wrapper.get('[data-testid="diff-empty"]').text()).toBe(text);
  });

  it.each([
    ['tooLarge', 'Diff too large to show'],
    ['binary', 'Binary file'],
  ])('says why an overwrite recorded no patch (%s)', async (reason, text) => {
    const wrapper = await card(write({ metadata: { patchOmitted: reason } }));

    expect(wrapper.get('[data-testid="diff-omitted"]').text()).toBe(text);
    expect(wrapper.find('[data-testid="tool-card-change"]').exists()).toBe(false);
  });
});

describe('the diff a card opens', () => {
  it.each([
    ['an edit with a recorded patch', edit({ metadata: { patch: PATCH } })],
    ['a denied edit', edit({ status: 'denied' })],
    ['a new file', write({ metadata: { created: true } })],
  ])('shows the same lines and numbers as the card, for %s', async (_label, toolCall) => {
    const wrapper = await card(toolCall);
    await wrapper.get('[data-testid="diff-view"]').element.closest('button')!.click();
    const opened = useDiffStore().expandedDiff!;

    const overlay = mount(DiffOverlay, { props: { diff: opened }, global: { plugins: [i18n], stubs: { OverlayShell: Shell } } });
    await flushPromises();

    expect(rows(overlay)).toEqual(rows(wrapper));
  });
});
