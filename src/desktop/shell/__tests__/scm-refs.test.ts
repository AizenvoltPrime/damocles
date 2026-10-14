// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { MAX_MENU_ITEMS, MAX_OVERLAY_ITEMS, OVERLAY_ICONS, type OverlayMenuItem, type OverlayQuickPickItem } from '../../preload/overlay-channels';
import type { ScmArtifactsResult, ScmChange, ScmChangesTab, ScmRepoSnapshot, ScmStashArtifact, ScmView } from '../../preload/scm-channels';
import type { ShellEditorTab } from '../../preload/shell-channels';
import ChangesTab from '../editor/ChangesTab.vue';
import { shellI18n } from '../i18n';
import { overlayPickModel } from '../overlay/quick-pick';
import { createScmStore, SCM_STORE, type ScmStore } from '../scm/scm-store';
import ScmSection from '../scm/ScmSection.vue';
import { flattenChanges, fromNow, type ScmListOptions } from '../scm/scm-list';
import { actionOf, moreActionsMenu, rowMenu, stashMenu, stashRowMenu, toOverlayMenu, type MoreActionsContext } from '../scm/scm-menus';
import { FakeResizeObserver, fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS, type FakeScmApi, type FakeShellApi } from './fakes';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);
const NOW = Date.UTC(2026, 0, 10, 12);

const stash = (index: number, hash: string, extra: Partial<ScmStashArtifact> = {}): ScmStashArtifact =>
  ({ index, hash, description: `WIP on main: ${index}`, branch: 'main', date: NOW - 2 * 3_600_000, ...extra });
const stashes = (rows: readonly ScmStashArtifact[]): ScmArtifactsResult => ({ ok: true, artifacts: { group: 'stashes', rows } });
const change = (path: string): ScmChange => ({ path, status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false });

const snapshot = (extra: Partial<ScmRepoSnapshot> = {}): ScmRepoSnapshot => ({
  repoId: 'r1',
  projectKey: 'p1',
  head: { type: 'branch', name: 'main' },
  commit: { hash: 'h1', subject: 'Initial commit' },
  operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [] },
  tooManyChanges: false,
  busy: false,
  upstream: { remote: 'origin', branch: 'main', ahead: 0, behind: 0 },
  remotes: ['origin'],
  running: null,
  lastRemote: null,
  ...extra,
});

const view: ScmView = {
  projectKey: 'p1',
  state: 'ready',
  repos: [{ repoId: 'r1', label: 'r1', displayPath: '', kind: 'root' }],
  selectedRepoId: 'r1',
  closedCount: 0,
  unsafePaths: [],
  parentCount: 0,
};

const CONTEXT: MoreActionsContext = {
  viewMode: 'list',
  sortKey: 'path',
  untrackedChanges: 'mixed',
  openRepos: 1,
  closedCount: 0,
  commit: { operation: null, hasCommit: true, hasTemplate: false, allowNoVerifyCommit: false, amending: false },
  remote: { hasRemotes: true, allowForcePush: false, operation: null },
  refs: { head: 'branch', stashStaged: true, stashes: 1 },
};

const english = (key: string): string => shellI18n.global.t(`scm.${key}`, 1, { locale: 'en' });
const submenu = (items: readonly OverlayMenuItem[], id: string): readonly OverlayMenuItem[] => {
  const found = items.find((item) => item.kind === 'submenu' && item.id === `submenu:${id}`);
  return found?.kind === 'submenu' ? found.items : [];
};
const labels = (items: readonly OverlayMenuItem[]): string[] => items.map((item) => (item.kind === 'separator' ? '-' : item.label));
const disabledIds = (items: readonly OverlayMenuItem[]): string[] => items.flatMap((item) => (item.kind === 'item' && item.disabled ? [item.id] : []));

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the branch, stash, tag and worktree menus', () => {
  it("puts Checkout to... at the top level and Branch, Stash, Tags and Worktrees › in VS Code's groups and titles", () => {
    const more = toOverlayMenu(moreActionsMenu(CONTEXT), english);
    expect(more.find((item) => item.kind === 'item' && item.id === 'checkout')).toMatchObject({ label: 'Checkout to...', icon: 'git-branch' });
    expect(labels(submenu(more, 'branch'))).toEqual([
      'Merge...', 'Rebase Branch...', '-', 'Create Branch...', 'Create Branch From...', '-', 'Rename Branch...', 'Delete Branch...', 'Delete Remote Branch...', '-', 'Publish Branch...',
    ]);
    expect(labels(submenu(more, 'stash'))).toEqual([
      'Stash', 'Stash (Include Untracked)', 'Stash Staged', '-', 'Apply Latest Stash', 'Apply Stash...', '-', 'Pop Latest Stash', 'Pop Stash...', '-',
      'Drop Stash...', 'Drop All Stashes...', '-', 'View Stash...',
    ]);
    expect(labels(submenu(more, 'tags'))).toEqual(['Create Tag...', 'Delete Tag...', 'Delete Remote Tag...', '-', 'Push Tags']);
    expect(labels(submenu(more, 'worktrees'))).toEqual(['Create Worktree...', 'Delete Worktree...']);
    expect(more.filter((item) => item.kind === 'submenu').map((item) => item.kind === 'submenu' ? item.label : '')).toEqual(
      ['View & Sort', 'Commit', 'Changes', 'Pull, Push', 'Branch', 'Remote', 'Stash', 'Tags', 'Worktrees', 'Repositories'],
    );
    expect(submenu(more, 'stashes')).toEqual([]);
    expect(submenu(more, 'stash').find((item) => item.kind === 'item' && item.id === 'stashDropAll')).toMatchObject({ danger: true });
  });

  it('hides Stash Staged below git 2.35, and turns the stash pickers off once the Stashes group read none', () => {
    const ids = (context: Parameters<typeof stashMenu>[0]) => toOverlayMenu(stashMenu(context), english).flatMap((item) => (item.kind === 'item' ? [item.id] : []));
    expect(ids({ stashStaged: false, stashes: 1 })).not.toContain('stashStaged');
    expect(disabledIds(toOverlayMenu(stashMenu({ stashStaged: true, stashes: 0 }), english))).toEqual([
      'stashApplyLatest', 'stashApply', 'stashPopLatest', 'stashPop', 'stashDrop', 'stashDropAll', 'stashView',
    ]);
    // not read yet: main answers "There are no stashes" itself, as VS Code does
    expect(disabledIds(toOverlayMenu(stashMenu({ stashStaged: true, stashes: null }), english))).toEqual([]);
  });

  it('turns Rename Branch... and Publish Branch... off on a detached HEAD', () => {
    const more = toOverlayMenu(moreActionsMenu({ ...CONTEXT, refs: { ...CONTEXT.refs, head: 'detached' } }), english);
    expect(disabledIds(submenu(more, 'branch'))).toEqual(['renameBranch', 'publish']);
  });

  it("keeps every id unique across the menu's levels with known icons and bounded size, and answers each through actionOf", () => {
    const flat = (items: readonly OverlayMenuItem[]): OverlayMenuItem[] => items.flatMap((item) => (item.kind === 'submenu' ? [item, ...flat(item.items)] : [item]));
    const all = flat(toOverlayMenu(moreActionsMenu({ ...CONTEXT, untrackedChanges: 'separate', commit: { ...CONTEXT.commit, allowNoVerifyCommit: true }, remote: { ...CONTEXT.remote, allowForcePush: true } }), english));
    expect(all.length).toBeLessThanOrEqual(MAX_MENU_ITEMS);
    const levels = toOverlayMenu(moreActionsMenu(CONTEXT), english);
    for (const level of [levels, ...levels.flatMap((item) => (item.kind === 'submenu' ? [item.items] : []))]) expect(level.length).toBeLessThanOrEqual(MAX_OVERLAY_ITEMS);
    const named = all.flatMap((item) => (item.kind === 'separator' ? [] : [item]));
    const ids = named.map((item) => item.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    for (const item of named) if (item.icon !== undefined) expect(OVERLAY_ICONS, item.id).toContain(item.icon);
    for (const id of ['checkout', 'stashIncludeUntracked', 'deleteRemoteTag', 'createWorktree']) expect(actionOf(id)).toBe(id);
  });

  it("builds D58's stash row menu, Copy Branch Name only for a stash that names its branch", () => {
    const menu = (branch: string | null) => toOverlayMenu(stashRowMenu({ branch }), english);
    expect(labels(menu('main'))).toEqual(['Apply Stash', 'View Stash', 'Pop Stash', 'Drop Stash', '-', 'Copy Branch Name', 'Copy Stash Name']);
    expect(labels(menu(null))).toEqual(['Apply Stash', 'View Stash', 'Pop Stash', 'Drop Stash', '-', 'Copy Stash Name']);
    expect(menu('main').find((item) => item.kind === 'item' && item.id === 'dropStash')).toMatchObject({ danger: true });
  });

  it('offers Stash Changes on a file of every group but Merge Changes', () => {
    const ids = (group: Parameters<typeof rowMenu>[0]) => toOverlayMenu(rowMenu(group, change('a.ts')), english).flatMap((item) => (item.kind === 'item' ? [item.id] : []));
    for (const group of ['index', 'workingTree', 'untracked'] as const) expect(ids(group)).toContain('stashChanges');
    expect(ids('merge')).not.toContain('stashChanges');
    expect(english('action.stashChanges')).toBe('Stash Changes');
  });

  it('has every new label in English and Greek', () => {
    const flat = (items: readonly OverlayMenuItem[]): string[] => items.flatMap((item) => (item.kind === 'submenu' ? [`submenu.${item.id.slice('submenu:'.length)}`, ...flat(item.items)] : item.kind === 'item' ? [`action.${actionOf(item.id)}`] : []));
    const keys = [...flat(toOverlayMenu(moreActionsMenu(CONTEXT), (key) => key)), ...flat(toOverlayMenu(stashRowMenu({ branch: 'main' }), (key) => key)), 'action.stashChanges', 'group.stashes', 'empty.stashes', 'empty.stashesFailed'];
    for (const key of keys) expect(shellI18n.global.te(`scm.${key}`, 'en') && shellI18n.global.te(`scm.${key}`, 'el'), key).toBe(true);
  });
});

describe('the Stashes group rows', () => {
  const options: ScmListOptions = { viewMode: 'list', sortKey: 'path', collapsed: new Set(), statusText: () => '' };

  it('follows the change groups, counted among them, with its rows newest first or its empty text', () => {
    const rows = flattenChanges(snapshot({ groups: { merge: [], index: [], workingTree: [change('a.ts')], untracked: [] } }), options, { state: 'ready', rows: [stash(0, HASH_A), stash(1, HASH_B)] });
    expect(rows.map((row) => [row.key, row.position, row.setSize])).toEqual([
      ['group:workingTree', 1, 2], ['workingTree:a.ts', 1, 1], ['group:stashes', 2, 2], [`stash:${HASH_A}`, 1, 2], [`stash:${HASH_B}`, 2, 2],
    ]);
    expect(flattenChanges(snapshot(), options, { state: 'ready', rows: [] }).slice(-2).map((row) => row.kind === 'stashNote' ? row.text : row.key)).toEqual(['group:stashes', 'none']);
    expect(flattenChanges(snapshot(), options, { state: 'failed' }).at(-1)).toMatchObject({ kind: 'stashNote', text: 'failed' });
  });

  it('shows no count and no rows while the first read is under way, and nothing under a collapsed group', () => {
    expect(flattenChanges(snapshot(), options, { state: 'loading' }).slice(-1)).toEqual([expect.objectContaining({ kind: 'stashGroup', count: null })]);
    const collapsed = flattenChanges(snapshot(), { ...options, collapsed: new Set(['group:stashes']) }, { state: 'ready', rows: [stash(0, HASH_A)] });
    expect(collapsed.at(-1)).toMatchObject({ kind: 'stashGroup', count: 1, expanded: false });
  });

  it('says how long ago in the shell language, as VS Code fromNow does', () => {
    expect(fromNow(NOW - 20_000, NOW, 'en')).toBe('now');
    expect(fromNow(NOW - 5 * 60_000, NOW, 'en')).toBe('5 minutes ago');
    expect(fromNow(NOW - 2 * 86_400_000, NOW, 'en')).toBe('2 days ago');
    expect(fromNow(NOW - 86_400_000, NOW, 'en')).toBe('1 day ago');
    expect(fromNow(NOW - 3 * 86_400_000, NOW, 'el')).toBe('πριν από 3 ημέρες');
  });

  it('builds its formatters once per language, however many ages it formats', () => {
    const Real = Intl.RelativeTimeFormat;
    const built = vi.spyOn(Intl, 'RelativeTimeFormat').mockImplementation(function (...args: ConstructorParameters<typeof Real>) {
      return new Real(...args);
    } as unknown as typeof Real);
    const ages = [20_000, 5 * 60_000, 2 * 86_400_000, 40 * 86_400_000].map((ago) => fromNow(NOW - ago, NOW, 'de'));
    expect(ages).toEqual(['jetzt', 'vor 5 Minuten', 'vor 2 Tagen', 'vor 1 Monat']);
    fromNow(NOW - 60_000, NOW, 'de');
    expect(built).toHaveBeenCalledTimes(2);
  });
});

describe('the branch picker', () => {
  const items: OverlayQuickPickItem[] = [
    { id: 'create', label: 'Create new branch...', icon: 'add', alwaysShow: true },
    { id: 'detached', label: 'Checkout detached...', icon: 'detached', alwaysShow: true },
    { id: 'b1', label: 'main', description: 'abc1234 Initial', icon: 'branch', current: true, group: 'Branches' },
    { id: 'b2', label: 'feat/login', icon: 'branch', hint: 'local', group: 'Branches' },
    { id: 'r1', label: 'origin/main', icon: 'remoteBranch', group: 'Remote branches' },
    { id: 'r2', label: 'origin/feat/login', icon: 'remoteBranch', hint: '2↓ 1↑', group: 'Remote branches' },
    { id: 't1', label: 'v1.0', icon: 'tag', group: 'Tags' },
  ];
  const quote = (query: string): string => `“${query}”`;
  const shape = (query: string) => overlayPickModel(items, query, quote).rows.map((row) => (row.kind === 'separator' ? `# ${row.label}` : row.item.id));

  it('heads each group with its label in main order, starting on the first item, the current branch checked', () => {
    const model = overlayPickModel(items, '', quote);
    expect(shape('')).toEqual(['create', 'detached', '# Branches', 'b1', 'b2', '# Remote branches', 'r1', 'r2', '# Tags', 't1']);
    expect(model.activeId).toBeUndefined();
    const main = model.rows.find((row) => row.kind === 'item' && row.item.id === 'b1');
    expect(main?.kind === 'item' ? main.item : undefined).toMatchObject({ checked: true, mono: true, iconColor: 'var(--d-accent-text)' });
    const remote = model.rows.find((row) => row.kind === 'item' && row.item.id === 'r2');
    expect(remote?.kind === 'item' ? remote.item : undefined).toMatchObject({ hint: '2↓ 1↑', iconColor: 'var(--d-muted)' });
  });

  it('filters in place, keeping a group label above its first match and dropping a group with none, the commands after a rule', () => {
    expect(shape('login')).toEqual(['# Branches', 'b2', '# Remote branches', 'r2', '# ', 'create', 'detached']);
    expect(shape('v1')).toEqual(['# Tags', 't1', '# ', 'create', 'detached']);
    // VS Code (commands.ts setQuickPickItems): the commands keep their place while nothing is typed, and stay when nothing matches
    expect(shape('zzz')).toEqual(['create', 'detached']);
    const create = overlayPickModel(items, 'create', quote).rows.find((row) => row.kind === 'item' && row.item.id === 'create');
    expect(create?.kind === 'item' ? create.item.labelMatches.length : 0).toBeGreaterThan(0);
  });

  // VS Code has no ungrouped item after a group: an item there sits under a separator with no label.
  it('sets an ungrouped item after a group apart under an unlabelled rule, not under that group', () => {
    const mixed: OverlayQuickPickItem[] = [
      { id: 'b1', label: 'main', icon: 'branch', group: 'Branches' },
      { id: 'x', label: 'Fetch all remotes' },
      { id: 't1', label: 'v1.0', icon: 'tag', group: 'Tags' },
    ];
    const rows = (query: string) => overlayPickModel(mixed, query, quote).rows.map((row) => (row.kind === 'separator' ? `# ${row.label}` : row.item.id));
    expect(rows('')).toEqual(['# Branches', 'b1', '# ', 'x', '# Tags', 't1']);
    expect(rows('fetch')).toEqual(['x']);
  });

  it('filters and highlights a label main escaped as it shows, so the visible name finds the ref', () => {
    const escaped: OverlayQuickPickItem[] = [{ id: 'b1', label: 'main\\u{202E}xe.nigol', icon: 'branch', group: 'Branches' }];
    const found = overlayPickModel(escaped, 'main', quote).rows.find((row) => row.kind === 'item');
    expect(found?.kind === 'item' ? found.item.labelMatches : undefined).toEqual([[0, 4]]);
    expect(overlayPickModel(escaped, '202E', quote).rows.some((row) => row.kind === 'item')).toBe(true);
  });

  it('sets a ref name in the mono font by its icon, grouped or not, and nothing else', () => {
    const mono = (entry: OverlayQuickPickItem): boolean | undefined => {
      const found = overlayPickModel([entry], '', quote).rows[0];
      return found?.kind === 'item' ? found.item.mono : undefined;
    };
    expect(mono({ id: 'r', label: 'origin/main', icon: 'remoteBranch', description: '(upstream)' })).toBe(true);
    expect(mono({ id: 't', label: 'v1.0', icon: 'tag' })).toBe(true);
    expect(mono({ id: 's', label: '#0: WIP on main', icon: 'stash', group: 'Stashes' })).toBeUndefined();
    expect(mono({ id: 'd', label: 'Checkout detached...', icon: 'detached' })).toBeUndefined();
  });

  it('shows the row naming refs left out last whatever the filter, dimmed so Enter and a click take nothing', () => {
    const cut = [...items, { id: 'more', label: '12 more refs not shown', alwaysShow: true, info: true } as const];
    const rows = (query: string) => overlayPickModel(cut, query, quote).rows;
    for (const query of ['', 'login']) {
      const last = rows(query).at(-1);
      expect(last?.kind === 'item' ? last.item : undefined, query).toMatchObject({ id: 'more', disabled: true });
    }
  });
});

async function mountSection(scm: FakeScmApi, shell: FakeShellApi = fakeShellApi()): Promise<{ wrapper: VueWrapper; store: ScmStore; shell: FakeShellApi }> {
  const store = createScmStore(scm);
  await store.start();
  const wrapper = mount(ScmSection, {
    props: { api: shell, projectKey: 'p1', projectName: 'alpha', platform: 'win32', viewMode: 'list', sortKey: 'path', collapsed: false },
    global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, store, shell };
}

const scmWith = (current: ScmRepoSnapshot = snapshot()): FakeScmApi => fakeScmApi({ views: [view], snapshots: [current], decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE });

describe('the Stashes group in Source control', () => {
  it('lists the stashes with branch and age, re-reads them on artifactsChanged for its repository only, and says when the read failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const scm = scmWith();
    vi.mocked(scm.artifacts).mockResolvedValue(stashes([stash(0, HASH_A)]));
    const { wrapper } = await mountSection(scm);
    expect(scm.artifacts).toHaveBeenCalledWith({ repoId: 'r1', group: 'stashes' });
    const group = wrapper.get('[data-testid="scm-group"][data-group="stashes"]');
    expect(group.text()).toContain('Stashes');
    expect(group.get('[data-testid="scm-group-count"]').text()).toBe('1');
    expect(wrapper.get('[data-testid="scm-stash-description"]').text()).toBe('WIP on main: 0');
    expect(wrapper.get('[data-testid="scm-stash-detail"]').text()).toBe('main · 2 hours ago');

    scm.artifactsChanged({ repoId: 'r2', groups: ['stashes'] });
    scm.artifactsChanged({ repoId: 'r1', groups: ['branches'] });
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(1);

    vi.mocked(scm.artifacts).mockResolvedValue({ ok: false, reason: 'failed' });
    scm.artifactsChanged({ repoId: 'r1', groups: ['stashes', 'branches'] });
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-stash-note"]').attributes('data-note')).toBe('failed');
    expect(wrapper.find('[data-testid="scm-stash"]').exists()).toBe(false);

    vi.mocked(scm.artifacts).mockResolvedValue(stashes([]));
    scm.artifactsChanged({ repoId: 'r1', groups: ['stashes'] });
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-stash-note"]').text()).toBe('No stashes.');
  });

  it('shows the failure line when the read itself is refused, rather than loading for ever', async () => {
    const scm = scmWith();
    vi.mocked(scm.artifacts).mockRejectedValue(new Error('no handler'));
    const { wrapper } = await mountSection(scm);
    expect(wrapper.get('[data-testid="scm-stash-note"]').attributes('data-note')).toBe('failed');
  });

  it('slides in a stash that arrives live and bumps the count, but not the stashes of the first read', async () => {
    const scm = scmWith();
    vi.mocked(scm.artifacts).mockResolvedValue(stashes([stash(0, HASH_A)]));
    const { wrapper } = await mountSection(scm);
    expect(wrapper.get('[data-testid="scm-stash"]').classes()).not.toContain('d-row-drop');

    vi.mocked(scm.artifacts).mockResolvedValue(stashes([stash(0, HASH_C), stash(1, HASH_A)]));
    scm.artifactsChanged({ repoId: 'r1', groups: ['stashes'] });
    await flushPromises();
    await nextTick();
    const rows = wrapper.findAll('[data-testid="scm-stash"]');
    expect(rows.map((row) => row.attributes('data-index'))).toEqual(['0', '1']);
    expect(rows[0]!.classes()).toContain('d-row-drop');
    expect(rows[1]!.classes()).not.toContain('d-row-drop');
    expect(wrapper.get('[data-group="stashes"]').find('.d-count-bump').exists()).toBe(true);
  });

  it('opens View Stash on a click, applies inline, and runs the row menu on that stash by hash', async () => {
    const scm = scmWith();
    vi.mocked(scm.artifacts).mockResolvedValue(stashes([stash(0, HASH_A), stash(1, HASH_B, { branch: null })]));
    const { wrapper, shell } = await mountSection(scm);
    const [first, second] = wrapper.findAll('[data-testid="scm-stash"]');
    await first!.trigger('click');
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'viewStash', repoId: 'r1', target: { index: 0, hash: HASH_A } });
    await second!.get('[data-testid="scm-stash-apply"]').trigger('click');
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'stashApply', repoId: 'r1', pop: false, target: { index: 1, hash: HASH_B } });

    for (const [itemId, call] of [
      ['popStash', { op: 'stashApply', repoId: 'r1', pop: true, target: { index: 0, hash: HASH_A } }],
      ['dropStash', { op: 'stashDrop', repoId: 'r1', target: { index: 0, hash: HASH_A } }],
    ] as const) {
      shell.answerNext({ kind: 'menu', itemId });
      await first!.trigger('contextmenu');
      await flushPromises();
      expect(scm.run).toHaveBeenLastCalledWith(call);
    }
    shell.answerNext({ kind: 'menu', itemId: 'copyBranchName' });
    await first!.trigger('contextmenu');
    await flushPromises();
    expect(scm.copy).toHaveBeenLastCalledWith({ repoId: 'r1', kind: 'branchName', value: HASH_A });
    shell.answerNext({ kind: 'menu', itemId: 'copyStashName' });
    await second!.trigger('contextmenu');
    await flushPromises();
    expect(scm.copy).toHaveBeenLastCalledWith({ repoId: 'r1', kind: 'stashName', value: HASH_B });
    const menu = shell.overlayRequests.at(-1);
    expect(menu?.kind === 'menu' ? menu.items.flatMap((item) => (item.kind === 'item' ? [item.id] : [])) : []).not.toContain('copyBranchName');
  });

  it("stashes with untracked files from the group's inline action, and a file from its menu", async () => {
    const scm = scmWith(snapshot({ groups: { merge: [], index: [], workingTree: [change('src/a.ts')], untracked: [] } }));
    const { wrapper, shell } = await mountSection(scm);
    await wrapper.get('[data-group="stashes"] [data-testid="scm-group-stashIncludeUntracked"]').trigger('click');
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'stash', repoId: 'r1', scope: 'includeUntracked' });
    shell.answerNext({ kind: 'menu', itemId: 'stashChanges' });
    await wrapper.get('[data-testid="scm-change"]').trigger('contextmenu');
    await flushPromises();
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'stashChanges', repoId: 'r1', paths: ['src/a.ts'] });
  });

  it('runs each More Actions item as its damocles:scm:run request', async () => {
    const scm = scmWith();
    const { wrapper, shell } = await mountSection(scm);
    for (const [itemId, call] of [
      ['checkout', { op: 'checkout', repoId: 'r1', detached: false }],
      ['createBranchFrom', { op: 'createBranch', repoId: 'r1', from: true }],
      ['deleteRemoteBranch', { op: 'deleteRemoteBranch', repoId: 'r1' }],
      ['stashStaged', { op: 'stash', repoId: 'r1', scope: 'staged' }],
      ['stashPopLatest', { op: 'stashApply', repoId: 'r1', pop: true, target: 'latest' }],
      ['stashApply', { op: 'stashApply', repoId: 'r1', pop: false, target: 'pick' }],
      ['stashDropAll', { op: 'stashDropAll', repoId: 'r1' }],
      ['stashView', { op: 'viewStash', repoId: 'r1', target: 'pick' }],
      ['pushTags', { op: 'pushTags', repoId: 'r1' }],
      ['deleteWorktree', { op: 'deleteWorktree', repoId: 'r1' }],
    ] as const) {
      shell.answerNext({ kind: 'menu', itemId });
      await wrapper.get('[data-testid="scm-more-actions"]').trigger('click');
      await flushPromises();
      expect(scm.run, itemId).toHaveBeenLastCalledWith(call);
    }
  });

  it('keeps the title actions shown and More Actions expanded while its menu is open', async () => {
    const scm = scmWith();
    let answer!: (value: { kind: 'dismissed' }) => void;
    const shell = fakeShellApi();
    const { wrapper } = await mountSection(scm, shell);
    vi.mocked(shell.requestOverlay).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const more = wrapper.get('[data-testid="scm-more-actions"]');
    await more.trigger('click');
    expect(more.attributes('aria-expanded')).toBe('true');
    const actions = wrapper.get<HTMLElement>('[data-testid="sidebar-section-actions"]');
    window.dispatchEvent(new Event('blur'));
    await nextTick();
    expect(actions.element.style.display).not.toBe('none');
    answer({ kind: 'dismissed' });
    await flushPromises();
    expect(more.attributes('aria-expanded')).toBe('false');
  });
});

describe('the branch button', () => {
  it('names the branch, marks it local until published, and runs Checkout to... on a click', async () => {
    const scm = scmWith(snapshot({ upstream: null }));
    const { wrapper } = await mountSection(scm);
    const button = wrapper.get('[data-testid="scm-branch"]');
    expect(button.attributes()).toMatchObject({ title: 'Checkout to... (not published yet)', 'aria-label': 'Checkout to... main, not published yet' });
    // main's pick opens in the overlay, and the button cannot say when it closes, so it claims no popup it cannot track
    expect(button.attributes('aria-haspopup')).toBeUndefined();
    expect(button.get('[data-testid="scm-branch-label"]').text()).toBe('main');
    expect(button.find('[data-testid="scm-branch-local"]').exists()).toBe(true);
    await button.trigger('click');
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'checkout', repoId: 'r1', detached: false });
  });

  it("shows a detached HEAD's short hash with no local marker", async () => {
    const { wrapper } = await mountSection(scmWith(snapshot({ head: { type: 'detached', commit: 'abcdef1234567' }, upstream: null })));
    const button = wrapper.get('[data-testid="scm-branch"]');
    expect(button.attributes('data-detached')).toBe('true');
    expect(button.get('[data-testid="scm-branch-label"]').text()).toBe('abcdef12');
    expect(button.find('[data-testid="scm-branch-local"]').exists()).toBe(false);
  });

  it('swaps the label on checkout, the leaving copy without its test id and hidden from AT', async () => {
    const scm = scmWith();
    const store = createScmStore(scm);
    await store.start();
    const wrapper = mount(ScmSection, {
      props: { api: fakeShellApi(), projectKey: 'p1', projectName: 'alpha', platform: 'win32', viewMode: 'list', sortKey: 'path', collapsed: false },
      global: { plugins: [shellI18n], provide: { [SCM_STORE]: store }, stubs: { transition: false } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    scm.pushSnapshot(snapshot({ head: { type: 'branch', name: 'feat/login' } }));
    await nextTick();
    expect(wrapper.findAll('[data-testid="scm-branch-label"]').map((each) => each.text())).toEqual(['feat/login']);
    const leaving = wrapper.findAll('.t-swap-down-leave-active');
    expect(leaving.map((each) => [each.text(), each.attributes('aria-hidden'), each.attributes('data-testid')])).toEqual([['main', 'true', undefined]]);
  });
});

describe("View Stash's title actions", () => {
  const tab = (source: ScmChangesTab['source']): ShellEditorTab & { changes: ScmChangesTab } => ({
    id: 't1', kind: 'changes', title: 'stash@{0}: WIP', displayPath: 'stash@{0}', dirty: false, readOnly: true, conflict: false,
    changes: { repoId: 'r1', source, entries: [change('a.ts')] },
  });
  async function mountTab(source: ScmChangesTab['source']) {
    const api = fakeScmApi();
    const wrapper = mount(ChangesTab, { props: { tab: tab(source) }, global: { plugins: [shellI18n], provide: { [SCM_STORE]: createScmStore(api) } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    return { api, wrapper };
  }

  it('offers Apply Stash, Pop Stash and Drop Stash in that order, and Pop pops the tab\'s pinned stash', async () => {
    const { api, wrapper } = await mountTab({ kind: 'stash', index: 1, hash: HASH_A });
    expect(wrapper.findAll('[data-testid^="changes-stash-"]').map((button) => [button.attributes('data-testid'), button.attributes('aria-label')])).toEqual([
      ['changes-stash-apply', 'Apply Stash'],
      ['changes-stash-pop', 'Pop Stash'],
      ['changes-stash-drop', 'Drop Stash'],
    ]);
    const pop = wrapper.get('[data-testid="changes-stash-pop"]');
    expect(pop.find('.lucide-arrow-up-from-line-icon, .lucide-arrow-up-from-line').exists()).toBe(true);
    await pop.trigger('click');
    await flushPromises();
    expect(api.run).toHaveBeenLastCalledWith({ op: 'stashApply', repoId: 'r1', pop: true, target: { index: 1, hash: HASH_A } });
    // a pop shows no applied check: main closes the tab once the stash is gone
    expect(wrapper.get('[data-testid="changes-stash-apply"]').attributes('data-applied')).toBeUndefined();
  });

  it('turns all three off while any one of them runs', async () => {
    const { api, wrapper } = await mountTab({ kind: 'stash', index: 0, hash: HASH_A });
    let finish!: (result: { ok: true }) => void;
    vi.mocked(api.run).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await wrapper.get('[data-testid="changes-stash-pop"]').trigger('click');
    const disabled = () => wrapper.findAll('[data-testid^="changes-stash-"]').map((button) => button.attributes('disabled') !== undefined);
    expect(disabled()).toEqual([true, true, true]);
    await wrapper.get('[data-testid="changes-stash-drop"]').trigger('click');
    expect(api.run).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await flushPromises();
    expect(disabled()).toEqual([false, false, false]);
  });

  it('offers Apply Stash and Drop Stash on a stash tab only, each on the tab\'s pinned stash', async () => {
    expect((await mountTab({ kind: 'workingTree' })).wrapper.find('[data-testid="changes-stash-apply"]').exists()).toBe(false);
    const { api, wrapper } = await mountTab({ kind: 'stash', index: 2, hash: HASH_A });
    const apply = wrapper.get('[data-testid="changes-stash-apply"]');
    expect(apply.attributes()).toMatchObject({ 'aria-label': 'Apply Stash', title: 'Apply Stash' });
    await apply.trigger('click');
    await flushPromises();
    expect(api.run).toHaveBeenLastCalledWith({ op: 'stashApply', repoId: 'r1', pop: false, target: { index: 2, hash: HASH_A } });
    expect(apply.attributes('data-applied')).toBe('true');
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('Stash applied');
    const drop = wrapper.get('[data-testid="changes-stash-drop"]');
    expect(drop.attributes('aria-label')).toBe('Drop Stash');
    await drop.trigger('click');
    await flushPromises();
    expect(api.run).toHaveBeenLastCalledWith({ op: 'stashDrop', repoId: 'r1', target: { index: 2, hash: HASH_A } });
  });

  it('plays no check when the apply did not happen', async () => {
    const { api, wrapper } = await mountTab({ kind: 'stash', index: 0, hash: HASH_A });
    vi.mocked(api.run).mockResolvedValue({ ok: false, reason: 'cancelled' });
    await wrapper.get('[data-testid="changes-stash-apply"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="changes-stash-apply"]').attributes('data-applied')).toBeUndefined();
  });
});
