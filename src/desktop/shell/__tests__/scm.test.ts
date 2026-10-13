// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmChange, ScmCommitInput, ScmRepoSnapshot, ScmView } from '../../preload/scm-channels';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { flattenChanges, visibleText } from '../scm/scm-list';
import { COMMIT_VARIANTS, commitMenu, groupActions, moreActionsMenu, rowMenu, splitButtonMenu, toOverlayMenu, type CommitMenuContext } from '../scm/scm-menus';
import CommitBox from '../scm/CommitBox.vue';
import { fakeScmApi, fakeShellApi, SCM_SETTINGS } from './fakes';

const change = (path: string, status: ScmChange['status'] = 'MODIFIED', letter: ScmChange['letter'] = 'M'): ScmChange =>
  ({ path, status, letter, tone: letter === 'U' ? 'untracked' : 'modified', strike: false });

const snapshot = (groups: Partial<ScmRepoSnapshot['groups']> = {}, extra: Partial<ScmRepoSnapshot> = {}): ScmRepoSnapshot => ({
  repoId: 'r1',
  projectKey: 'p1',
  head: { type: 'branch', name: 'main' },
  commit: { hash: 'h1', subject: 'Initial commit' },
  operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [], ...groups },
  tooManyChanges: false,
  busy: false,
  ...extra,
});

const view: ScmView = { projectKey: 'p1', state: 'ready', repos: [{ repoId: 'r1', label: 'alpha', displayPath: '', kind: 'root' }], selectedRepoId: 'r1', closedCount: 0, unsafePaths: [], parentCount: 0 };
const options = { viewMode: 'list' as const, sortKey: 'path' as const, collapsed: new Set<string>(), statusText: (c: ScmChange) => c.status };

describe('the Source control list', () => {
  it('shows Changes always, with its empty text, and the other groups only while they hold changes', () => {
    expect(flattenChanges(snapshot(), options).map((row) => row.key)).toEqual(['group:workingTree', 'empty:workingTree']);
    expect(flattenChanges(snapshot(), options)[1]).toMatchObject({ text: 'clean' });
    const staged = flattenChanges(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }), options);
    expect(staged.map((row) => row.key)).toEqual(['group:index', 'index:a.ts', 'group:workingTree', 'empty:workingTree']);
    expect(staged[3]).toMatchObject({ text: 'noUnstaged' });
  });

  it('sorts a list by name, path or status text, and a tree into folders first', () => {
    const changes = [change('src/b.ts'), change('a/z.ts', 'UNTRACKED', 'U'), change('c.ts', 'DELETED', 'D')];
    const keys = (sortKey: 'name' | 'path' | 'status') => flattenChanges(snapshot({ workingTree: changes }), { ...options, sortKey }).slice(1).map((row) => row.key);
    expect(keys('path')).toEqual(['workingTree:a/z.ts', 'workingTree:c.ts', 'workingTree:src/b.ts']);
    expect(keys('name')).toEqual(['workingTree:src/b.ts', 'workingTree:c.ts', 'workingTree:a/z.ts']);
    expect(keys('status')).toEqual(['workingTree:c.ts', 'workingTree:src/b.ts', 'workingTree:a/z.ts']);
    const tree = flattenChanges(snapshot({ workingTree: changes }), { ...options, viewMode: 'tree' });
    expect(tree.map((row) => row.key)).toEqual(['group:workingTree', 'folder:workingTree:a', 'workingTree:a/z.ts', 'folder:workingTree:src', 'workingTree:src/b.ts', 'workingTree:c.ts']);
    const collapsed = flattenChanges(snapshot({ workingTree: changes }), { ...options, viewMode: 'tree', collapsed: new Set(['folder:workingTree:a', 'group:index']) });
    expect(collapsed.map((row) => row.key)).not.toContain('workingTree:a/z.ts');
  });

  it('shows control and bidi characters of git text as visible escapes', () => {
    expect(visibleText('evil\u202Etxt.exe')).toBe('evil\\u{202E}txt.exe');
    expect(visibleText('a\nb')).toBe('a\\u{A}b');
    expect(visibleText('plain/name.ts')).toBe('plain/name.ts');
  });

  it('shows the Arabic letter mark, zero-width characters and line separators as escapes too', () => {
    expect(visibleText('a\u061Cb\u200Bc\u200Dd\u2060e\uFEFFf\u2028g\u2029h')).toBe('a\\u{61C}b\\u{200B}c\\u{200D}d\\u{2060}e\\u{FEFF}f\\u{2028}g\\u{2029}h');
  });

  it('numbers each row among its siblings: the groups, a folder level, a list', () => {
    const list = flattenChanges(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')], workingTree: [change('b.ts'), change('c/d.ts')] }), options);
    expect(list.map((row) => [row.key, row.position, row.setSize])).toEqual([
      ['group:index', 1, 2], ['index:a.ts', 1, 1], ['group:workingTree', 2, 2], ['workingTree:b.ts', 1, 2], ['workingTree:c/d.ts', 2, 2],
    ]);
    expect(flattenChanges(snapshot(), options)[1]).toMatchObject({ position: 1, setSize: 1 });
  });
});

const COMMIT_CONTEXT: CommitMenuContext = { operation: null, hasCommit: true, hasTemplate: false, allowNoVerifyCommit: false, amending: false };

describe('the Source control menus', () => {
  const label = (key: string) => key;
  const leafIds = (menu: readonly ReturnType<typeof toOverlayMenu>[number][]): string[] =>
    menu.flatMap((item) => (item.kind === 'item' ? [item.id] : item.kind === 'submenu' ? leafIds(item.items) : []));

  it("puts Commit › in More Actions in VS Code's git.commit groups, and No Verify only while allowed", () => {
    const more = toOverlayMenu(moreActionsMenu({ viewMode: 'list', sortKey: 'path', untrackedChanges: 'mixed', openRepos: 1, closedCount: 0, commit: COMMIT_CONTEXT }), label);
    const commit = more.find((item) => item.kind === 'submenu' && item.id === 'submenu:commit');
    expect(commit?.kind === 'submenu' ? commit.items.map((item) => (item.kind === 'separator' ? '-' : item.id)) : []).toEqual([
      'commit', 'commitStaged', 'commitAll', 'undoLastCommit', 'abortRebase', '-',
      'commitAmend', 'commitStagedAmend', 'commitAllAmend', '-',
      'commitSigned', 'commitStagedSigned', 'commitAllSigned',
    ]);
    expect(leafIds(more).some((id) => id.includes('NoVerify'))).toBe(false);
    expect(leafIds(toOverlayMenu(commitMenu({ ...COMMIT_CONTEXT, allowNoVerifyCommit: true, hasTemplate: true }), label))).toEqual([
      'commit', 'commitStaged', 'commitAll', 'undoLastCommit', 'restoreCommitTemplate', 'abortRebase',
      'commitNoVerify', 'commitStagedNoVerify', 'commitAllNoVerify',
      'commitAmend', 'commitStagedAmend', 'commitAllAmend',
      'commitAmendNoVerify', 'commitStagedAmendNoVerify', 'commitAllAmendNoVerify',
      'commitSigned', 'commitStagedSigned', 'commitAllSigned',
      'commitSignedNoVerify', 'commitStagedSignedNoVerify', 'commitAllSignedNoVerify',
    ]);
  });

  it("sends each Commit › item's variant, and disables what git cannot do now", () => {
    expect(COMMIT_VARIANTS.commitAllAmendNoVerify).toEqual({ scope: 'all', amend: true, signoff: false, noVerify: true, empty: false });
    expect(COMMIT_VARIANTS.commitStagedSigned).toEqual({ scope: 'staged', amend: false, signoff: true, noVerify: false, empty: false });
    expect(COMMIT_VARIANTS.commit).toEqual({ scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false });
    const disabled = (context: CommitMenuContext) => toOverlayMenu(commitMenu(context), label).flatMap((item) => (item.kind === 'item' && item.disabled ? [item.id] : []));
    expect(disabled(COMMIT_CONTEXT)).toEqual(['abortRebase']);
    expect(disabled({ ...COMMIT_CONTEXT, operation: 'rebase' })).toEqual(['commitAmend', 'commitStagedAmend', 'commitAllAmend']);
    expect(disabled({ ...COMMIT_CONTEXT, hasCommit: false })).toEqual(['undoLastCommit', 'abortRebase', 'commitAmend', 'commitStagedAmend', 'commitAllAmend']);
  });

  it('gives the split button Commit, Commit (Amend) to enter amend mode and Commit (Signed Off), each amending in amend mode', () => {
    expect(toOverlayMenu(splitButtonMenu({ operation: null, hasCommit: true, amending: false }), label)).toEqual([
      { kind: 'item', id: 'commit', label: 'action.commit', icon: 'check' },
      { kind: 'item', id: 'toggleAmend', label: 'action.commitAmend', icon: 'pencil-line' },
      { kind: 'separator' },
      { kind: 'item', id: 'commitSigned', label: 'action.commitSigned', icon: 'signature' },
    ]);
    expect(toOverlayMenu(splitButtonMenu({ operation: null, hasCommit: true, amending: true }), label)).toMatchObject([
      { id: 'commit', label: 'action.commitAmend' }, { kind: 'separator' }, { id: 'commitSigned', label: 'action.commitAmendSigned' },
    ]);
    expect(toOverlayMenu(splitButtonMenu({ operation: 'merge', hasCommit: true, amending: false }), label)[1]).toMatchObject({ id: 'toggleAmend', disabled: true });
  });

  it('labels every Commit › item as the amend it runs in amend mode and leaves the amend groups out', () => {
    const items = toOverlayMenu(commitMenu({ ...COMMIT_CONTEXT, allowNoVerifyCommit: true, amending: true }), label)
      .flatMap((item) => (item.kind === 'item' ? [[item.id, item.label]] : []));
    expect(items).toEqual([
      ['commit', 'action.commitAmend'], ['commitStaged', 'action.commitStagedAmend'], ['commitAll', 'action.commitAllAmend'],
      ['undoLastCommit', 'action.undoLastCommit'], ['abortRebase', 'action.abortRebase'],
      ['commitNoVerify', 'action.commitAmendNoVerify'], ['commitStagedNoVerify', 'action.commitStagedAmendNoVerify'], ['commitAllNoVerify', 'action.commitAllAmendNoVerify'],
      ['commitSigned', 'action.commitAmendSigned'], ['commitStagedSigned', 'action.commitStagedAmendSigned'], ['commitAllSigned', 'action.commitAllAmendSigned'],
      ['commitSignedNoVerify', 'action.commitAmendSignedNoVerify'], ['commitStagedSignedNoVerify', 'action.commitStagedAmendSignedNoVerify'], ['commitAllSignedNoVerify', 'action.commitAllAmendSignedNoVerify'],
    ]);
    for (const [, key] of items) expect(shellI18n.global.te(`scm.${key}`, 'en') && shellI18n.global.te(`scm.${key}`, 'el'), key).toBe(true);
  });

  it('lists the tracked and untracked Changes items only when untracked changes are separate', () => {
    const context = { viewMode: 'list' as const, sortKey: 'path' as const, openRepos: 2, closedCount: 1, commit: COMMIT_CONTEXT };
    const mixed = toOverlayMenu(moreActionsMenu({ ...context, untrackedChanges: 'mixed' }), label);
    const changes = (menu: ReturnType<typeof toOverlayMenu>) => menu.find((item) => item.kind === 'submenu' && item.id === 'submenu:changes');
    expect(changes(mixed)).toMatchObject({ items: [{ id: 'stageAll' }, { id: 'unstageAll' }, { id: 'discardAll' }] });
    const separate = toOverlayMenu(moreActionsMenu({ ...context, untrackedChanges: 'separate' }), label);
    expect(JSON.stringify(changes(separate))).toContain('stageAllUntracked');
    expect(separate.find((item) => item.kind === 'submenu' && item.id === 'submenu:repositories')).toMatchObject({
      items: [{ id: 'closeRepository' }, { id: 'closeOtherRepositories' }, { id: 'reopenClosed' }],
    });
    expect(separate.at(-1)).toMatchObject({ id: 'showOutput' });
  });

  it('offers a group the tracked or untracked actions by mode, and an untracked row no HEAD side', () => {
    expect(groupActions('workingTree', 'separate').map((action) => action.label)).toEqual(['openGroupChanges', 'discardAllTracked', 'stageAllTracked']);
    expect(groupActions('untracked', 'separate').map((action) => action.label)).toEqual(['openUntrackedChanges', 'discardAllUntracked', 'stageAllUntracked']);
    const ids = (nodes: ReturnType<typeof rowMenu>) => toOverlayMenu(nodes, label).flatMap((item) => (item.kind === 'item' ? [item.id] : []));
    expect(ids(rowMenu('workingTree', change('a.ts', 'UNTRACKED', 'U')))).not.toContain('openFileHead');
    expect(ids(rowMenu('index', change('a.ts', 'INDEX_MODIFIED')))).toEqual(['openChanges', 'openFile', 'openFileHead', 'unstage', 'copyPath', 'copyRelativePath', 'reveal', 'mention']);
  });
});

describe('the commit box', () => {
  const mounted: VueWrapper[] = [];
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    vi.restoreAllMocks();
  });

  async function mountBox(current: ScmRepoSnapshot, inputValidation: boolean, input: Partial<ScmCommitInput> = {}, draft?: string) {
    const api = fakeScmApi({ views: [view], snapshots: [current], decorations: [], settings: { ...SCM_SETTINGS, inputValidation } });
    vi.mocked(api.commitInput).mockResolvedValue({ template: null, history: [], headMessage: 'Initial commit\n\nThe body.', ...input });
    const shell = fakeShellApi();
    const store = createScmStore(api);
    await store.start();
    if (draft !== undefined) store.setDraft('r1', draft);
    const wrapper = mount(CommitBox, { props: { snapshot: current, platform: 'win32', api: shell }, global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    return { api, shell, store, wrapper };
  }

  const key = async (wrapper: VueWrapper, name: string): Promise<void> => {
    await wrapper.get('textarea').trigger('keydown', { key: name });
    await flushPromises();
  };

  it('warns of a subject over the limit only while input validation is on', async () => {
    const subject = 'x'.repeat(53);
    for (const on of [true, false]) {
      const { wrapper } = await mountBox(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }), on);
      await wrapper.get('textarea').setValue(subject);
      await flushPromises();
      expect(wrapper.find('[data-testid="scm-length-warning"]').exists()).toBe(on);
      if (on) expect(wrapper.get('[data-testid="scm-length-warning"]').text()).toBe('3 characters over 50 in current line');
    }
  });

  it("commits on Ctrl+Enter, takes main's text for the box after it, and shows the reason inline on a refusal", async () => {
    const { api, store, wrapper } = await mountBox(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }), false);
    let settle: () => void = () => {};
    vi.mocked(api.commit).mockImplementationOnce(() => new Promise((resolve) => { settle = () => resolve({ ok: true, message: 'Template' }); }));
    await wrapper.get('textarea').setValue('Fix it');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
    await flushPromises();
    expect(api.commit).toHaveBeenCalledWith({ repoId: 'r1', message: 'Fix it', variant: COMMIT_VARIANTS.commit });
    // Read-only while the commit runs, as VS Code disables its box, so nothing typed meanwhile is replaced when it settles.
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined();
    expect(store.draftOf('r1')).toBe('Fix it');
    settle();
    await flushPromises();
    expect(store.draftOf('r1')).toBe('Template');
    expect(wrapper.get('textarea').attributes('readonly')).toBeUndefined();
    await wrapper.get('textarea').setValue('');

    vi.mocked(api.commit).mockResolvedValueOnce({ ok: false, reason: 'missingUserConfig' });
    await wrapper.get('textarea').setValue('Again');
    await wrapper.get('[data-testid="scm-commit"]').trigger('click');
    await flushPromises();
    expect(store.draftOf('r1')).toBe('Again');
    expect(wrapper.get('[data-testid="scm-commit-feedback"]').text()).toBe('Make sure you configure your "user.name" and "user.email" in git.');
  });

  it('leaves the box as it is when generating fails, and fills it when it succeeds', async () => {
    const { api, store, wrapper } = await mountBox(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }), false);
    await wrapper.get('textarea').setValue('mine');
    await wrapper.get('[data-testid="scm-generate"]').trigger('click');
    await flushPromises();
    expect(store.draftOf('r1')).toBe('mine');
    vi.mocked(api.generateMessage).mockResolvedValueOnce({ ok: true, message: 'Add the thing\n\nBecause.' });
    await wrapper.get('[data-testid="scm-generate"]').trigger('click');
    await flushPromises();
    expect(store.draftOf('r1')).toBe('Add the thing\n\nBecause.');
  });

  it('reads Commit Merge with Abort Merge during a merge, prefilled from MERGE_MSG', async () => {
    const { store, wrapper } = await mountBox(snapshot({}, { operation: 'merge', mergeMessage: "Merge branch 'feat'" }), false);
    expect(store.draftOf('r1')).toBe("Merge branch 'feat'");
    expect(wrapper.get('[data-testid="scm-commit"]').text()).toContain('Commit Merge');
    expect(wrapper.get('[data-testid="scm-abort"]').text()).toBe('Abort Merge');
  });

  it('fills an empty box with the template once, and never a box holding a draft', async () => {
    const { store } = await mountBox(snapshot(), false, { template: 'feat: \n\nWhy:' });
    expect(store.draftOf('r1')).toBe('feat: \n\nWhy:');
    const typed = await mountBox(snapshot(), false, { template: 'feat: ' }, 'mine');
    expect(typed.store.draftOf('r1')).toBe('mine');
  });

  it("enters amend mode from the split button, fills an empty box with HEAD's message, and cancel restores the draft", async () => {
    const { api, shell, store, wrapper } = await mountBox(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }), false);
    shell.answerNext({ kind: 'menu', itemId: 'toggleAmend' });
    await wrapper.get('[data-testid="scm-commit-menu"]').trigger('click');
    await flushPromises();
    expect(shell.requestOverlay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'menu', label: 'More commit actions' }));
    expect(wrapper.get('[data-testid="scm-amend-banner"]').text()).toContain('Amending “Initial commit”');
    expect(wrapper.get('[data-testid="scm-commit"]').text()).toContain('Commit (Amend)');
    expect(store.draftOf('r1')).toBe('Initial commit\n\nThe body.');
    await wrapper.get('[data-testid="scm-amend-cancel"]').trigger('click');
    await flushPromises();
    expect(store.draftOf('r1')).toBe('');
    expect(wrapper.find('[data-testid="scm-amend-banner"]').exists()).toBe(false);

    await wrapper.get('textarea').setValue('Reworded');
    shell.answerNext({ kind: 'menu', itemId: 'toggleAmend' });
    await wrapper.get('[data-testid="scm-commit-menu"]').trigger('click');
    await flushPromises();
    expect(store.draftOf('r1')).toBe('Reworded');
    await wrapper.get('[data-testid="scm-commit"]').trigger('click');
    await flushPromises();
    expect(api.commit).toHaveBeenLastCalledWith({ repoId: 'r1', message: 'Reworded', variant: COMMIT_VARIANTS.commitAmend });
    expect(wrapper.find('[data-testid="scm-amend-banner"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="scm-commit"]').text()).not.toContain('Amend');
  });

  it('commits Signed Off from the split button menu, amending it in amend mode, and leaves amend mode on Escape', async () => {
    const { api, shell, store, wrapper } = await mountBox(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }), false, {}, 'Sign me');
    shell.answerNext({ kind: 'menu', itemId: 'commitSigned' });
    await wrapper.get('[data-testid="scm-commit-menu"]').trigger('click');
    await flushPromises();
    expect(api.commit).toHaveBeenCalledWith({ repoId: 'r1', message: 'Sign me', variant: COMMIT_VARIANTS.commitSigned });

    store.setAmending('r1', '');
    store.setDraft('r1', 'Sign me');
    await flushPromises();
    shell.answerNext({ kind: 'menu', itemId: 'commitSigned' });
    await wrapper.get('[data-testid="scm-commit-menu"]').trigger('click');
    await flushPromises();
    expect(shell.overlayRequests.at(-1)).toMatchObject({ items: [{ id: 'commit', label: 'Commit (Amend)' }, { kind: 'separator' }, { id: 'commitSigned', label: 'Commit (Amend, Signed Off)' }] });
    expect(api.commit).toHaveBeenLastCalledWith({ repoId: 'r1', message: 'Sign me', variant: { ...COMMIT_VARIANTS.commitSigned, amend: true } });
    await key(wrapper, 'Escape');
    expect(wrapper.find('[data-testid="scm-amend-banner"]').exists()).toBe(false);
  });

  it("keeps one repository's commit and generation from blocking or showing on another's box", async () => {
    const two = snapshot({ index: [change('b.ts', 'INDEX_MODIFIED')] }, { repoId: 'r2' });
    const { api, store, wrapper } = await mountBox(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }), false, {}, 'One');
    store.setDraft('r2', 'Two');
    let land: (result: { ok: true; message: string }) => void = () => {};
    vi.mocked(api.commit).mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    vi.mocked(api.generateMessage).mockImplementationOnce(() => new Promise(() => {}));
    await wrapper.get('[data-testid="scm-commit"]').trigger('click');
    await wrapper.get('[data-testid="scm-generate"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-commit"]').attributes('aria-busy')).toBe('true');

    await wrapper.setProps({ snapshot: two });
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-commit"]').attributes('aria-busy')).toBeUndefined();
    expect(wrapper.get('textarea').attributes('readonly')).toBeUndefined();
    await wrapper.get('[data-testid="scm-commit"]').trigger('click');
    await flushPromises();
    expect(api.commit).toHaveBeenLastCalledWith({ repoId: 'r2', message: 'Two', variant: COMMIT_VARIANTS.commit });

    await wrapper.setProps({ snapshot: snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')] }) });
    await wrapper.get('[data-testid="scm-commit"]').trigger('click');
    await flushPromises();
    expect(api.commit).toHaveBeenCalledTimes(2);
    land({ ok: true, message: '' });
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-commit"]').attributes('aria-busy')).toBeUndefined();
  });

  it('restarts a text motion on each recall, across a reflow', async () => {
    const { wrapper } = await mountBox(snapshot(), false, { history: ['second', 'first'] });
    const textarea = wrapper.get('textarea').element;
    const seen: boolean[] = [];
    Object.defineProperty(textarea, 'offsetWidth', { configurable: true, get: () => (seen.push(textarea.classList.contains('d-msg-older')), 0) });
    await key(wrapper, 'ArrowUp');
    expect(textarea.classList.contains('d-msg-older')).toBe(true);
    await key(wrapper, 'ArrowUp');
    expect(seen).toEqual([false, false]);
    expect(textarea.classList.contains('d-msg-older')).toBe(true);
  });

  it('recalls older messages with Up and newer ones with Down, the draft being the newest', async () => {
    const { store, wrapper } = await mountBox(snapshot(), false, { history: ['second', 'first'] });
    await key(wrapper, 'ArrowUp');
    expect(store.draftOf('r1')).toBe('second');
    await key(wrapper, 'ArrowUp');
    expect(store.draftOf('r1')).toBe('first');
    await key(wrapper, 'ArrowUp');
    expect(store.draftOf('r1')).toBe('first');
    await key(wrapper, 'ArrowDown');
    expect(store.draftOf('r1')).toBe('second');
    await key(wrapper, 'ArrowDown');
    expect(store.draftOf('r1')).toBe('');
  });

  it('keeps a typed draft as the newest entry and moves the caret instead of recalling mid-text', async () => {
    const { store, wrapper } = await mountBox(snapshot(), false, { history: ['older'] });
    const textarea = wrapper.get('textarea');
    await textarea.setValue('line one\nline two');
    (textarea.element as HTMLTextAreaElement).setSelectionRange(12, 12);
    await key(wrapper, 'ArrowUp');
    expect(store.draftOf('r1')).toBe('line one\nline two');
    (textarea.element as HTMLTextAreaElement).setSelectionRange(0, 0);
    await key(wrapper, 'ArrowUp');
    expect(store.draftOf('r1')).toBe('older');
    await key(wrapper, 'ArrowDown');
    expect(store.draftOf('r1')).toBe('line one\nline two');
  });

  it('takes the undone message back from main', async () => {
    const { api, store } = await mountBox(snapshot(), false, {}, 'half typed');
    api.setInput({ repoId: 'r1', message: 'Undone\n\nbody', cause: 'undo' });
    await flushPromises();
    expect(store.draftOf('r1')).toBe('Undone\n\nbody');
  });

  it('recalls the message a commit just recorded on the first Up after the box empties, whatever an older read answers later', async () => {
    const { api, store, wrapper } = await mountBox(snapshot(), false, { history: ['older'] });
    let answerOld: () => void = () => {};
    vi.mocked(api.commitInput).mockImplementationOnce(() => new Promise((resolve) => { answerOld = () => resolve({ template: null, history: ['older'], headMessage: 'older' }); }));
    void store.loadCommitInput('r1');
    const reads = vi.mocked(api.commitInput).mock.calls.length;

    vi.mocked(api.commit).mockResolvedValueOnce({ ok: true, message: '', commitInput: { template: null, history: ['Fix it', 'older'], headMessage: 'Fix it' } });
    await wrapper.get('textarea').setValue('Fix it');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
    await flushPromises();
    expect(store.draftOf('r1')).toBe('');
    expect(vi.mocked(api.commitInput).mock.calls.length).toBe(reads);
    await key(wrapper, 'ArrowUp');
    expect(store.draftOf('r1')).toBe('Fix it');
    answerOld();
    await flushPromises();
    expect(store.inputs.value.get('r1')?.history).toEqual(['Fix it', 'older']);
  });
});

describe('the Source control store', () => {
  it("never takes a repository from the first read that a newer pushed view closed, and forgets a removed project's state", async () => {
    const two: ScmView = { ...view, repos: [...view.repos, { repoId: 'r2', label: 'beta', displayPath: 'beta', kind: 'nested' }] };
    const api = fakeScmApi({ views: [two], snapshots: [snapshot(), snapshot({}, { repoId: 'r2' })], decorations: [{ projectKey: 'p1', files: { 'a.ts': { letter: 'M', tone: 'modified', staged: false, strike: false } } }], settings: SCM_SETTINGS });
    let read: () => void = () => {};
    const state = api.getState();
    vi.mocked(api.getState).mockImplementationOnce(() => new Promise((resolve) => { read = () => resolve(state); }));
    const store = createScmStore(api);
    const started = store.start();
    api.pushView(view);
    read();
    await started;
    expect([...store.snapshots.value.keys()]).toEqual(['r1']);
    expect(store.decorationOf('p1', 'a.ts')).toMatchObject({ letter: 'M' });

    store.retainProjects(new Set(['p2']));
    expect(store.views.value.size).toBe(0);
    expect(store.snapshots.value.size).toBe(0);
    expect(store.decorationOf('p1', 'a.ts')).toBeUndefined();
  });
});
