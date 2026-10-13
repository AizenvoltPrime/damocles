// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmChange, ScmChangesTab, ScmFileDiffRequest, ScmFileDiffResult } from '../../preload/scm-channels';
import type { ShellEditorTab } from '../../preload/shell-channels';
import ChangesTab from '../editor/ChangesTab.vue';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { FakeResizeObserver, fakeScmApi } from './fakes';

type Tab = ShellEditorTab & { changes: ScmChangesTab };

const change = (path: string, status: ScmChange['status'] = 'MODIFIED', letter: ScmChange['letter'] = 'M'): ScmChange =>
  ({ path, status, letter, tone: 'modified', strike: false });

const patch = (path: string): ScmFileDiffResult => ({
  kind: 'patch',
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n`,
});

// Main sends a new tab object, with new entry arrays, on every editor state push.
const tabOf = (entries: readonly ScmChange[]): Tab => ({
  id: 't1',
  kind: 'changes',
  title: 'Changes',
  displayPath: 'Changes',
  dirty: false,
  readOnly: true,
  conflict: false,
  changes: { repoId: 'r1', source: { kind: 'workingTree' }, entries: entries.map((entry) => ({ ...entry })) },
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

async function mountTab(entries: readonly ScmChange[], fileDiff: (request: ScmFileDiffRequest) => Promise<ScmFileDiffResult>) {
  const api = fakeScmApi();
  vi.mocked(api.fileDiff).mockImplementation(fileDiff);
  const wrapper = mount(ChangesTab, {
    props: { tab: tabOf(entries) },
    global: { plugins: [shellI18n], provide: { [SCM_STORE]: createScmStore(api) } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { api, wrapper };
}

const shownPath = (wrapper: VueWrapper): string => wrapper.get('[data-testid="changes-path"]').text();
const entry = (wrapper: VueWrapper, path: string) => wrapper.get(`[data-testid="changes-entry"][data-path="${path}"]`);

describe('the Changes tab', () => {
  it('keeps the diff and its scroll when main pushes the same entries again, and reloads in place when the entry changes', async () => {
    const entries = [change('a.ts'), change('b.ts')];
    const { api, wrapper } = await mountTab(entries, async ({ path }) => patch(path));
    expect(api.fileDiff).toHaveBeenCalledTimes(1);
    const diff = wrapper.get('[data-testid="changes-diff"]').element;
    diff.scrollTop = 200;

    await wrapper.setProps({ tab: tabOf(entries) });
    await flushPromises();
    expect(api.fileDiff).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="changes-diff"]').element.scrollTop).toBe(200);

    await wrapper.setProps({ tab: tabOf([change('a.ts', 'INDEX_MODIFIED'), change('b.ts')]) });
    await flushPromises();
    expect(api.fileDiff).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-testid="changes-diff"]').element.scrollTop).toBe(200);

    await entry(wrapper, 'b.ts').trigger('click');
    await flushPromises();
    expect(api.fileDiff).toHaveBeenLastCalledWith({ repoId: 'r1', source: { kind: 'workingTree' }, path: 'b.ts' });
    expect(shownPath(wrapper)).toBe('b.ts');
  });

  it("says a diff that failed could not be read, never showing the previous file's diff under the new name", async () => {
    const { wrapper } = await mountTab([change('a.ts'), change('b.ts')], async ({ path }) => {
      if (path === 'b.ts') throw new Error('git diff failed');
      return patch(path);
    });
    expect(wrapper.find('[data-testid="changes-diff"]').exists()).toBe(true);
    await entry(wrapper, 'b.ts').trigger('click');
    await flushPromises();
    expect(shownPath(wrapper)).toBe('b.ts');
    expect(wrapper.find('[data-testid="changes-diff"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="changes-notice"]').text()).toBe(shellI18n.global.t('changesTab.notice.unreadable'));
  });

  it('drops a diff that answers after a newer one was asked for', async () => {
    let releaseA: (result: ScmFileDiffResult) => void = () => {};
    const { wrapper } = await mountTab([change('a.ts'), change('b.ts')], ({ path }) => (path === 'a.ts'
      ? new Promise<ScmFileDiffResult>((resolve) => { releaseA = resolve; })
      : Promise.resolve({ kind: 'binary' })));
    await entry(wrapper, 'b.ts').trigger('click');
    await flushPromises();
    releaseA(patch('a.ts'));
    await flushPromises();
    expect(wrapper.find('[data-testid="changes-diff"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="changes-notice"]').text()).toBe(shellI18n.global.t('changesTab.notice.binary'));
  });

  it('hands the selection of a file that left the list to the one now in its place', async () => {
    const { wrapper } = await mountTab([change('a.ts'), change('b.ts'), change('c.ts')], async ({ path }) => patch(path));
    await entry(wrapper, 'b.ts').trigger('click');
    await flushPromises();
    await wrapper.setProps({ tab: tabOf([change('a.ts'), change('c.ts')]) });
    await flushPromises();
    expect(shownPath(wrapper)).toBe('c.ts');
    expect(entry(wrapper, 'c.ts').attributes('aria-selected')).toBe('true');
  });

  it('gives each file its position in the whole list and diff row numbers their AA shade', async () => {
    const { wrapper } = await mountTab([change('a.ts'), change('b.ts'), change('c.ts')], async ({ path }) => patch(path));
    expect(entry(wrapper, 'b.ts').attributes()).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '3' });
    const added = wrapper.get('[data-testid="changes-line"][data-type="addition"]');
    expect(added.findAll('span').slice(0, 2).map((span) => span.classes())).toEqual([
      expect.arrayContaining(['text-(--d-faint-text)']),
      expect.arrayContaining(['text-(--d-faint-text)']),
    ]);
  });
});
