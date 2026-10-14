// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmChange, ScmCommitInput, ScmRepoSnapshot, ScmView } from '../../preload/scm-channels';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { flattenChanges } from '../scm/scm-list';
import { MAX_MENU_ITEMS, MAX_OVERLAY_ID_LENGTH, MAX_OVERLAY_LABEL_LENGTH, OVERLAY_ICONS, type OverlayMenuItem } from '../../preload/overlay-channels';
import { actionOf, COMMIT_VARIANTS, commitMenu, groupActions, moreActionsMenu, rowMenu, splitButtonMenu, toOverlayMenu, type CommitMenuContext, type RefMenuContext, type RemoteMenuContext } from '../scm/scm-menus';
import CommitBox from '../scm/CommitBox.vue';
import { fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS } from './fakes';

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
  upstream: null,
  remotes: [],
  running: null,
  lastRemote: null,
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

  it('numbers each row among its siblings: the groups, a folder level, a list', () => {
    const list = flattenChanges(snapshot({ index: [change('a.ts', 'INDEX_MODIFIED')], workingTree: [change('b.ts'), change('c/d.ts')] }), options);
    expect(list.map((row) => [row.key, row.position, row.setSize])).toEqual([
      ['group:index', 1, 2], ['index:a.ts', 1, 1], ['group:workingTree', 2, 2], ['workingTree:b.ts', 1, 2], ['workingTree:c/d.ts', 2, 2],
    ]);
    expect(flattenChanges(snapshot(), options)[1]).toMatchObject({ position: 1, setSize: 1 });
  });
});

const COMMIT_CONTEXT: CommitMenuContext = { operation: null, hasCommit: true, hasTemplate: false, allowNoVerifyCommit: false, amending: false };
const REMOTE_CONTEXT: RemoteMenuContext = { hasRemotes: true, allowForcePush: false, operation: null };
const REFS_CONTEXT: RefMenuContext = { head: 'branch', stashStaged: true, stashes: 2 };

describe('the Source control menus', () => {
  const label = (key: string) => key;
  const leafIds = (menu: readonly ReturnType<typeof toOverlayMenu>[number][]): string[] =>
    menu.flatMap((item) => (item.kind === 'item' ? [actionOf(item.id)] : item.kind === 'submenu' ? leafIds(item.items) : []));

  it("puts Commit › in More Actions in VS Code's git.commit groups, and No Verify only while allowed", () => {
    const more = toOverlayMenu(moreActionsMenu({ viewMode: 'list', sortKey: 'path', untrackedChanges: 'mixed', openRepos: 1, closedCount: 0, commit: COMMIT_CONTEXT, remote: REMOTE_CONTEXT, refs: REFS_CONTEXT }), label);
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

  it('gives the split button Commit, Commit (Amend), Commit & Push, Commit & Sync and Commit (Signed Off), the last amending in amend mode', () => {
    expect(toOverlayMenu(splitButtonMenu({ operation: null, hasCommit: true, amending: false, head: 'branch', hasRemotes: true }), label)).toEqual([
      { kind: 'item', id: 'commit', label: 'action.commit', icon: 'check' },
      { kind: 'item', id: 'toggleAmend', label: 'action.commitAmend', icon: 'pencil-line' },
      { kind: 'separator' },
      { kind: 'item', id: 'commitPush', label: 'action.commitPush', icon: 'cloud-upload' },
      { kind: 'item', id: 'commitSync', label: 'action.commitSync', icon: 'refresh-cw' },
      { kind: 'separator' },
      { kind: 'item', id: 'commitSigned', label: 'action.commitSigned', icon: 'signature' },
    ]);
    expect(toOverlayMenu(splitButtonMenu({ operation: null, hasCommit: true, amending: true, head: 'branch', hasRemotes: true }), label)).toMatchObject([
      { id: 'commit', label: 'action.commitAmend' }, { kind: 'separator' }, { id: 'commitSigned', label: 'action.commitAmendSigned' },
    ]);
    expect(toOverlayMenu(splitButtonMenu({ operation: 'merge', hasCommit: true, amending: false, head: 'branch', hasRemotes: true }), label)[1]).toMatchObject({ id: 'toggleAmend', disabled: true });
  });

  // main refuses the push after the commit landed: with no remote, and from a detached HEAD; an unborn branch has one once it commits
  it('turns Commit & Push and Commit & Sync off where the push after the commit would be refused', () => {
    const disabled = (head: RefMenuContext['head'], hasRemotes: boolean) =>
      toOverlayMenu(splitButtonMenu({ operation: null, hasCommit: head !== 'unborn', amending: false, head, hasRemotes }), label).flatMap((item) => (item.kind === 'item' && item.disabled ? [item.id] : []));
    expect(disabled('branch', true)).toEqual([]);
    expect(disabled(null, true)).toEqual([]);
    expect(disabled('unborn', true)).toEqual(['toggleAmend']);
    expect(disabled('branch', false)).toEqual(['commitPush', 'commitSync']);
    expect(disabled('detached', true)).toEqual(['commitPush', 'commitSync']);
  });

  it('turns Sync and Sync (Rebase) off unless HEAD is on a branch with a commit, and claims nothing before the status says', () => {
    const context = { viewMode: 'list' as const, sortKey: 'path' as const, untrackedChanges: 'mixed' as const, openRepos: 1, closedCount: 0, commit: COMMIT_CONTEXT, remote: REMOTE_CONTEXT };
    const english = (key: string): string => shellI18n.global.t(`scm.${key}`, 1, { locale: 'en' });
    const reasons = (head: RefMenuContext['head']) => {
      const more = toOverlayMenu(moreActionsMenu({ ...context, refs: { ...REFS_CONTEXT, head } }), english);
      const pullPush = more.find((item) => item.kind === 'submenu' && item.id === 'submenu:pullPush');
      return (pullPush?.kind === 'submenu' ? pullPush.items : []).flatMap((item) => (item.kind === 'item' && item.disabled ? [[actionOf(item.id), item.disabledReason]] : []));
    };
    expect(reasons('branch')).toEqual([]);
    expect(reasons(null)).toEqual([]);
    expect(reasons('detached')).toEqual([['sync', 'Detached HEAD'], ['syncRebase', 'Detached HEAD']]);
    expect(reasons('unborn')).toEqual([['sync', 'No commits yet'], ['syncRebase', 'No commits yet']]);
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
    const context = { viewMode: 'list' as const, sortKey: 'path' as const, openRepos: 2, closedCount: 1, commit: COMMIT_CONTEXT, remote: REMOTE_CONTEXT, refs: REFS_CONTEXT };
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

  it("lays out Pull, Push, Clone, Fetch and the Pull, Push and Remote submenus in VS Code's groups, with VS Code's titles", () => {
    const context = { viewMode: 'list' as const, sortKey: 'path' as const, untrackedChanges: 'mixed' as const, openRepos: 1, closedCount: 0, commit: COMMIT_CONTEXT, refs: REFS_CONTEXT };
    const more = toOverlayMenu(moreActionsMenu({ ...context, remote: REMOTE_CONTEXT }), label);
    const shape = (items: readonly OverlayMenuItem[]): string[] => items.map((item) => (item.kind === 'separator' ? '-' : item.id));
    expect(shape(more)).toEqual([
      'submenu:viewSort', '-', 'pull', 'push', 'clone', 'checkout', 'fetch', '-',
      'submenu:commit', 'submenu:changes', 'submenu:pullPush', 'submenu:branch', 'submenu:remote', 'submenu:stash', 'submenu:tags', 'submenu:worktrees',
      'submenu:repositories', '-', 'showOutput',
    ]);
    const submenu = (items: readonly OverlayMenuItem[], id: string) => {
      const found = items.find((item) => item.kind === 'submenu' && item.id === id);
      return found?.kind === 'submenu' ? found.items : [];
    };
    expect(shape(submenu(more, 'submenu:pullPush')).map((id) => (id === '-' ? id : actionOf(id)))).toEqual(['sync', 'syncRebase', '-', 'pull', 'pullRebase', 'pullFrom', '-', 'push', 'pushTo', '-', 'fetch', 'fetchPrune', 'fetchAll']);
    expect(shape(submenu(more, 'submenu:remote'))).toEqual(['addRemote', 'removeRemote']);
    const english = (key: string): string => shellI18n.global.t(`scm.${key}`, 1, { locale: 'en' });
    const titled = toOverlayMenu(moreActionsMenu({ ...context, remote: { ...REMOTE_CONTEXT, allowForcePush: true } }), english);
    expect(submenu(titled, 'submenu:pullPush').flatMap((item) => (item.kind === 'item' ? [item.label] : []))).toEqual([
      'Sync', 'Sync (Rebase)', 'Pull', 'Pull (Rebase)', 'Pull from...', 'Push', 'Push (Force)', 'Push to...', 'Push to... (Force)',
      'Fetch', 'Fetch (Prune)', 'Fetch From All Remotes',
    ]);
    expect(titled.find((item) => item.kind === 'submenu' && item.id === 'submenu:pullPush')).toMatchObject({ label: 'Pull, Push' });
    expect(submenu(titled, 'submenu:remote').map((item) => (item.kind === 'item' ? item.label : ''))).toEqual(['Add Remote...', 'Remove Remote']);
    for (const id of [...leafIds(titled), 'commitPush', 'commitSync']) {
      expect(shellI18n.global.te(`scm.action.${id}`, 'en') && shellI18n.global.te(`scm.action.${id}`, 'el'), id).toBe(true);
    }
  });

  // main's parseMenuItems refuses a menu whose ids repeat across its levels, or that breaks these bounds
  it("builds menus within the overlay's menu rules: ids unique across levels, known icons, bounded count and text", () => {
    const english = (key: string): string => shellI18n.global.t(`scm.${key}`, 1, { locale: 'en' });
    const fullest = moreActionsMenu({
      viewMode: 'list', sortKey: 'path', untrackedChanges: 'separate', openRepos: 2, closedCount: 1,
      commit: { ...COMMIT_CONTEXT, allowNoVerifyCommit: true, hasTemplate: true },
      remote: { ...REMOTE_CONTEXT, allowForcePush: true },
      refs: REFS_CONTEXT,
    });
    const flat = (items: readonly OverlayMenuItem[]): OverlayMenuItem[] => items.flatMap((item) => (item.kind === 'submenu' ? [item, ...flat(item.items)] : [item]));
    for (const nodes of [fullest, splitButtonMenu({ operation: null, hasCommit: true, amending: false, head: 'branch', hasRemotes: true })]) {
      const all = flat(toOverlayMenu(nodes, english));
      expect(all.length).toBeLessThanOrEqual(MAX_MENU_ITEMS);
      const named = all.flatMap((item) => (item.kind === 'separator' ? [] : [item]));
      const ids = named.map((item) => item.id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
      for (const item of named) {
        expect(item.id.length).toBeLessThanOrEqual(MAX_OVERLAY_ID_LENGTH);
        expect(item.label.length, item.id).toBeGreaterThan(0);
        expect(item.label.length).toBeLessThanOrEqual(MAX_OVERLAY_LABEL_LENGTH);
        if (item.icon !== undefined) expect(OVERLAY_ICONS, item.id).toContain(item.icon);
      }
    }
    const pushTo = toOverlayMenu(fullest, english).find((item) => item.kind === 'submenu' && item.id === 'submenu:pullPush');
    expect(pushTo?.kind === 'submenu' ? pushTo.items.find((item) => item.kind === 'item' && item.label === 'Push to... (Force)') : undefined).toMatchObject({ id: 'pullPush:pushToForce' });
    expect(actionOf('pullPush:pushToForce')).toBe('pushToForce');
    expect(actionOf('commitNoVerify')).toBe('commitNoVerify');
  });

  it('shows the force variants only while allowForcePush is on, and never the palette-only commands', () => {
    const context = { viewMode: 'list' as const, sortKey: 'path' as const, untrackedChanges: 'mixed' as const, openRepos: 1, closedCount: 0, commit: COMMIT_CONTEXT, refs: REFS_CONTEXT };
    const off = leafIds(toOverlayMenu(moreActionsMenu({ ...context, remote: REMOTE_CONTEXT }), label));
    const on = leafIds(toOverlayMenu(moreActionsMenu({ ...context, remote: { ...REMOTE_CONTEXT, allowForcePush: true } }), label));
    expect(off.filter((id) => /force/i.test(id))).toEqual([]);
    expect(on.filter((id) => /force/i.test(id))).toEqual(['pushForce', 'pushToForce']);
    for (const ids of [off, on]) expect(ids.filter((id) => /recursive|followTags|commitEmpty/i.test(id))).toEqual([]);
  });

  it('disables what needs a remote while the repository has none, and Sync (Rebase) during a merge, rebase or cherry pick', () => {
    const context = { viewMode: 'list' as const, sortKey: 'path' as const, untrackedChanges: 'mixed' as const, openRepos: 1, closedCount: 0, commit: COMMIT_CONTEXT, refs: REFS_CONTEXT };
    const disabled = (remote: RemoteMenuContext): string[] => {
      const walk = (items: readonly OverlayMenuItem[]): string[] =>
        items.flatMap((item) => (item.kind === 'item' && item.disabled ? [actionOf(item.id)] : item.kind === 'submenu' ? walk(item.items) : []));
      return walk(toOverlayMenu(moreActionsMenu({ ...context, remote }), label)).filter((id) => id !== 'abortRebase');
    };
    expect(disabled({ ...REMOTE_CONTEXT, hasRemotes: false })).toEqual([
      'pull', 'push', 'fetch',
      'sync', 'syncRebase', 'pull', 'pullRebase', 'pullFrom', 'push', 'pushTo', 'fetch', 'fetchPrune', 'fetchAll',
      'deleteRemoteBranch', 'publish', 'removeRemote', 'deleteRemoteTag', 'pushTags',
    ]);
    expect(disabled({ ...REMOTE_CONTEXT, operation: 'merge' })).toEqual(['syncRebase']);
  });

  it('offers a group the tracked or untracked actions by mode, and an untracked row no HEAD side', () => {
    expect(groupActions('workingTree', 'separate').map((action) => action.label)).toEqual(['openGroupChanges', 'discardAllTracked', 'stageAllTracked']);
    expect(groupActions('untracked', 'separate').map((action) => action.label)).toEqual(['openUntrackedChanges', 'discardAllUntracked', 'stageAllUntracked']);
    const ids = (nodes: ReturnType<typeof rowMenu>) => toOverlayMenu(nodes, label).flatMap((item) => (item.kind === 'item' ? [item.id] : []));
    expect(ids(rowMenu('workingTree', change('a.ts', 'UNTRACKED', 'U')))).not.toContain('openFileHead');
    expect(ids(rowMenu('index', change('a.ts', 'INDEX_MODIFIED')))).toEqual(['openChanges', 'openFile', 'openFileHead', 'unstage', 'stashChanges', 'copyPath', 'copyRelativePath', 'reveal', 'mention']);
  });
});

describe('the commit box', () => {
  const mounted: VueWrapper[] = [];
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    vi.restoreAllMocks();
  });

  async function mountBox(current: ScmRepoSnapshot, inputValidation: boolean, input: Partial<ScmCommitInput> = {}, draft?: string) {
    const api = fakeScmApi({ views: [view], snapshots: [current], decorations: [], settings: { ...SCM_SETTINGS, inputValidation }, clone: NO_CLONE });
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

  // happy-dom lays nothing out, so this pins the structure; slice10.screenshots.ts's 13px and 16px captures show the result.
  it('shows the hint whole beside the button or not at all, never cut, and wraps the operation text rather than truncating it', async () => {
    const { wrapper } = await mountBox(snapshot({ merge: [change('app.ts', 'BOTH_MODIFIED', '!')] }, { operation: 'merge' }), false);
    const footer = wrapper.get('[data-testid="scm-commit-footer"]');
    // One clipped row, right to left: a hint that does not fit wraps onto the hidden second row, and the button stays.
    expect(footer.classes()).toEqual(expect.arrayContaining(['flex-row-reverse', 'flex-wrap', 'overflow-hidden', 'h-9', 'gap-y-2', 'pb-1.5']));
    expect(footer.element.firstElementChild!.querySelector('[data-testid="scm-commit"]')).not.toBeNull();
    const hint = wrapper.get('[data-testid="scm-commit-hint"]').element.closest('[data-testid="scm-commit-footer"] > span')!;
    expect(hint.className).toMatch(/\bwhitespace-nowrap\b/);
    const clipping = footer.findAll('*').map((node) => node.element.getAttribute('class') ?? '').filter((names) => /\btruncate\b|:hidden\b/.test(names));
    expect(clipping).toEqual([]);
    expect(wrapper.get('[data-testid="scm-commit-hint"]').text()).toBe('1 merge conflict to resolve');
    const banner = wrapper.get('[data-testid="scm-operation"]');
    expect(banner.classes()).toContain('flex-wrap');
    expect(banner.classes()).not.toContain('h-7');
    expect(banner.get('[role="status"]').classes()).not.toContain('truncate');
  });

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
    const api = fakeScmApi({ views: [two], snapshots: [snapshot(), snapshot({}, { repoId: 'r2' })], decorations: [{ projectKey: 'p1', files: { 'a.ts': { letter: 'M', tone: 'modified', staged: false, strike: false } } }], settings: SCM_SETTINGS, clone: NO_CLONE });
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
