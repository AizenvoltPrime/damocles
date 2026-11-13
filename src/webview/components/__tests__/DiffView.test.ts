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
    const wrapper = mount(DiffView, { props: { diff, fileName: 'a.ts' }, global: { plugins: [i18n] } });
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
});
