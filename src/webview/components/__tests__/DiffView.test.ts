// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { i18n } from '@/i18n';
import DiffView from '../DiffView.vue';
import { highlightDiffLines } from '@/utils/highlightDiff';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import type { FileDiff } from '@/utils/parseUnifiedDiff';
import { CHAT_VIEW_PROVIDE } from '@/__tests__/code-highlighter';

vi.mock('@/utils/highlightDiff', () => ({
  highlightDiffLines: vi.fn(async (lines: FileDiff['lines']) => lines.map((line) => ({ ...line, highlightedContent: line.content }))),
}));

const diff: FileDiff = { lines: [{ oldLineNum: null, newLineNum: 1, type: 'addition', content: 'const a = 1;' }], numbered: true, stats: { added: 1, removed: 0 } };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(highlightDiffLines).mockClear();
});

describe('DiffView', () => {
  it('highlights again only when the diff, file or theme changes, not for a push of the same capabilities', async () => {
    const wrapper = mount(DiffView, { props: { diff, fileName: 'a.ts' }, global: { provide: CHAT_VIEW_PROVIDE, plugins: [i18n] } });
    await flushPromises();
    expect(highlightDiffLines).toHaveBeenCalledTimes(1);

    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES });
    await flushPromises();
    expect(highlightDiffLines).toHaveBeenCalledTimes(1);

    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    await flushPromises();
    expect(highlightDiffLines).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('shows the diff it was last given when an earlier highlight resolves after a later one, or fails after it', async () => {
    type Result = Awaited<ReturnType<typeof highlightDiffLines>>;
    const pending: { resolve: (lines: Result) => void; reject: (reason: Error) => void }[] = [];
    vi.mocked(highlightDiffLines).mockImplementation(() => new Promise<Result>((resolve, reject) => { pending.push({ resolve, reject }); }));
    const of = (content: string): FileDiff => ({ ...diff, lines: [{ ...diff.lines[0]!, content }] });
    const done = (source: FileDiff): Result => source.lines.map((line) => ({ ...line, highlightedContent: line.content }));

    const wrapper = mount(DiffView, { props: { diff: of('first'), fileName: 'a.ts' }, global: { provide: CHAT_VIEW_PROVIDE, plugins: [i18n] } });
    await wrapper.setProps({ diff: of('second'), fileName: 'b.py' });
    await wrapper.setProps({ diff: of('third') });
    expect(pending).toHaveLength(3);

    pending[2]!.resolve(done(of('third')));
    await flushPromises();
    pending[0]!.resolve(done(of('first')));
    pending[1]!.reject(new Error('no grammar'));
    await flushPromises();
    expect(wrapper.text()).toContain('third');
    expect(wrapper.text()).not.toContain('first');
    expect(wrapper.text()).not.toContain('second');
    wrapper.unmount();
  });
});
