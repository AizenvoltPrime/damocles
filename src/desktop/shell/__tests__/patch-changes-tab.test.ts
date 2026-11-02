// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ShellEditorTab, ShellPatchTab } from '../../preload/shell-channels';
import PatchChangesTab from '../editor/PatchChangesTab.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeShellApi } from './fakes';

const PATCH = '===================================================================\n--- /srv/a.txt\n+++ /srv/b.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n';

const SIDES = { left: { name: 'a.txt', folder: '/srv', path: '/srv/a.txt' }, right: { name: 'b.txt', folder: '/srv', path: '/srv/b.txt' } };

const tabOf = (content: ShellPatchTab['content'], sides: Pick<ShellPatchTab, 'left' | 'right'> = SIDES): ShellEditorTab & { patch: ShellPatchTab } => ({
  id: 't1',
  kind: 'changes',
  title: 'a.txt ↔ b.txt',
  displayPath: '/srv/a.txt ↔ /srv/b.txt',
  dirty: false,
  readOnly: true,
  conflict: false,
  patch: { ...sides, content },
});

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

async function mountTab(content: ShellPatchTab['content'], text = PATCH, sides: Pick<ShellPatchTab, 'left' | 'right'> = SIDES) {
  const api = fakeShellApi();
  vi.mocked(api.getDocument).mockImplementation(async (documentId) => ({ kind: 'text', documentId, version: 1, editSeq: 0, text, languageId: 'diff', eol: '\n', encoding: 'utf8', bom: false }));
  const wrapper = mount(PatchChangesTab, { props: { api, tab: tabOf(content, sides) }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { api, wrapper };
}

describe('the two-file patch tab', () => {
  it('is titled with both names, names both paths over the one diff, and lists no files', async () => {
    const { api, wrapper } = await mountTab({ kind: 'patch', documentId: 'doc-1' });
    expect(api.getDocument).toHaveBeenCalledExactlyOnceWith('doc-1');
    expect(wrapper.get('[data-testid="changes-lead"]').text()).toBe('a.txt ↔ b.txt');
    const side = (name: string) => wrapper.get(`[data-testid="changes-pair-${name}"]`);
    expect(side('left').findAll('span').map((part) => part.text())).toEqual(['a.txt', '/srv']);
    expect(side('left').attributes('title')).toBe('/srv/a.txt');
    expect(side('right').findAll('span').map((part) => part.text())).toEqual(['b.txt', '/srv']);
    expect(side('right').attributes('title')).toBe('/srv/b.txt');
    expect(wrapper.find('[data-testid="changes-list"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="changes-summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="changes-diff"]').exists()).toBe(true);
  });

  it('names each side as its host split it, so a POSIX name holding a backslash stays whole', async () => {
    const { wrapper } = await mountTab({ kind: 'patch', documentId: 'doc-1' }, PATCH, {
      left: { name: 'a\\b.txt', folder: '/srv/x', path: '/srv/x/a\\b.txt' },
      right: { name: 'c.txt', folder: 'C:\\work', path: 'C:\\work\\c.txt' },
    });
    expect(wrapper.get('[data-testid="changes-pair-left"]').findAll('span').map((part) => part.text())).toEqual(['a\\b.txt', '/srv/x']);
    expect(wrapper.get('[data-testid="changes-pair-right"]').findAll('span').map((part) => part.text())).toEqual(['c.txt', 'C:\\work']);
  });

  it('is read-only: no comments, no Open File and no actions', async () => {
    const { wrapper } = await mountTab({ kind: 'patch', documentId: 'doc-1' });
    expect(wrapper.find('[data-testid="review-line-number"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="changes-hint"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="changes-open-file"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="changes-actions"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="changes-line"][tabindex]')).toEqual([]);
  });

  it('says two identical files are identical, and a binary pair has no line diff', async () => {
    const identical = await mountTab({ kind: 'patch', documentId: 'doc-1' }, '===================================================================\n--- /srv/a.txt\n+++ /srv/b.txt\n');
    expect(identical.wrapper.get('[data-testid="changes-notice"]').text()).toBe('The two files are identical.');
    const binary = await mountTab({ kind: 'binary' });
    expect(binary.api.getDocument).not.toHaveBeenCalled();
    expect(binary.wrapper.get('[data-testid="changes-notice"]').text()).toBe('One of the files is binary, so they have no line diff.');
  });
});
