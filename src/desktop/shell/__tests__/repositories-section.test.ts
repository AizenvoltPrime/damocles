// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { OverlayAnswer, OverlayMenuItem } from '../../preload/overlay-channels';
import type { ScmArtifacts, ScmArtifactsRequest, ScmArtifactsResult, ScmBranchArtifact, ScmRepoSnapshot, ScmStashArtifact, ScmTagArtifact, ScmView } from '../../preload/scm-channels';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import RepositoriesSection from '../scm/RepositoriesSection.vue';
import ScmSection from '../scm/ScmSection.vue';
import { folderRowId, groupRowId, repoRowId } from '../scm/repositories-tree';
import { actionOf, branchRowMenu, repositoryStashMenu, tagRowMenu, toOverlayMenu, worktreeRowMenu } from '../scm/scm-menus';
import { FakeResizeObserver, fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS, type FakeScmApi, type FakeShellApi } from './fakes';

const NOW = Date.UTC(2026, 0, 10, 12);
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const commit = (hash: string, subject: string) => ({ hash, subject, author: 'Ada', date: NOW - 3_600_000 });
const branch = (name: string, hash: string, current = false): ScmBranchArtifact => ({ ref: `refs/heads/${name}`, name, commit: commit(hash, `${name} work`), current, upstream: null });
const tag = (name: string): ScmTagArtifact => ({ ref: `refs/tags/${name}`, name, commit: commit(HASH_A, 'release'), annotated: false, current: false });
const stash: ScmStashArtifact = { index: 0, hash: HASH_B, description: 'On main: wip', branch: 'main', date: NOW - 3_600_000 };

const ROOT = { repoId: 'r1', label: 'acme', displayPath: '', kind: 'root' as const, root: '/w/acme' };
const NESTED = { repoId: 'r2', label: 'lib', displayPath: 'lib', kind: 'nested' as const, root: '/w/acme/lib' };
const twistie = async (wrapper: VueWrapper, group: string): Promise<void> => {
  await row(wrapper, 'group', group).get('[data-testid="repositories-twistie"]').trigger('click');
  await flushPromises();
};

const view = (repos: ScmView['repos'], selectedRepoId: string, extra: Partial<ScmView> = {}): ScmView =>
  ({ projectKey: 'p1', state: 'ready', repos, selectedRepoId, closedCount: 0, unsafePaths: [], parentCount: 0, ...extra });
const snapshot = (repoId: string, head: string): ScmRepoSnapshot => ({
  repoId,
  projectKey: 'p1',
  head: { type: 'branch', name: head },
  commit: { hash: HASH_A, subject: 'Initial' },
  operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [] },
  tooManyChanges: false,
  busy: false,
  upstream: null,
  remotes: [],
  running: null,
  lastRemote: null,
  revision: 0,
});

const LISTS: Partial<Record<ScmArtifactsRequest['group'], ScmArtifacts>> = {
  branches: { group: 'branches', rows: [branch('feat/b', HASH_B), branch('feat/a', HASH_A), branch('main', HASH_A, true)] },
  tags: { group: 'tags', rows: [tag('v1.0')] },
  stashes: { group: 'stashes', rows: [stash] },
  worktrees: { group: 'worktrees', rows: [{ path: 'C:\\w\\acme', name: 'acme', branch: 'main', commit: commit(HASH_A, 'Initial'), main: true, current: true, locked: false, prunable: false, opens: 'project' }] },
};

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scmFor(views: ScmView, snapshots: readonly ScmRepoSnapshot[] = views.repos.map((repo) => snapshot(repo.repoId, repo.repoId === 'r1' ? 'main' : 'dev'))): FakeScmApi {
  const scm = fakeScmApi({ views: [views], snapshots, decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE });
  vi.mocked(scm.artifacts).mockImplementation(async (request): Promise<ScmArtifactsResult> => ({ ok: true, artifacts: LISTS[request.group] ?? ({ group: request.group, rows: [] } as ScmArtifacts) }));
  return scm;
}

async function mountSection(scm: FakeScmApi, expanded: string[] = [], shell: FakeShellApi = fakeShellApi()): Promise<{ wrapper: VueWrapper; shell: FakeShellApi; expansions: string[][] }> {
  const store = createScmStore(scm);
  await store.start();
  const expansions: string[][] = [];
  const wrapper: VueWrapper = mount(RepositoriesSection, {
    props: {
      api: shell,
      projectKey: 'p1',
      platform: 'win32',
      expanded,
      collapsed: false,
      // the sidebar keeps the expanded rows the section reports, and hands them back
      onExpanded: (rows: string[]) => {
        expansions.push(rows);
        void wrapper.setProps({ expanded: rows });
      },
    },
    global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, shell, expansions };
}

const row = (wrapper: VueWrapper, kind: string, name: string) => {
  const found = wrapper.findAll('[data-testid="repositories-row"]').find((each) => each.attributes('data-kind') === kind && each.attributes('data-name') === name);
  if (!found) throw new Error(`no ${kind} row ${name}: ${rowNames(wrapper).join(', ')}`);
  return found;
};
const rowNames = (wrapper: VueWrapper): string[] => wrapper.findAll('[data-testid="repositories-row"]').map((each) => `${each.attributes('data-kind')}:${each.attributes('data-name') ?? each.text()}`);
const labels = (items: readonly OverlayMenuItem[]): string[] => items.map((item) => (item.kind === 'separator' ? '-' : item.label));
const english = (key: string): string => shellI18n.global.t(`scm.${key}`, 1, { locale: 'en' });

describe('the Repositories section', () => {
  it('reads a group only once it is expanded, and again on artifactsChanged only while it stays expanded', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const { wrapper } = await mountSection(scm);
    expect(rowNames(wrapper)).toEqual(['group:branches', 'group:stashes', 'group:tags', 'group:worktrees']);
    expect(scm.artifacts).not.toHaveBeenCalled();

    await row(wrapper, 'group', 'tags').get('[data-testid="repositories-twistie"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(scm.artifacts).mock.calls).toEqual([[{ repoId: 'r1', group: 'tags' }]]);
    expect(row(wrapper, 'tag', 'v1.0').exists()).toBe(true);

    // a change to a group never read reads nothing; one to the expanded group reads it again
    scm.artifactsChanged({ repoId: 'r1', groups: ['branches', 'stashes'] });
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(1);
    scm.artifactsChanged({ repoId: 'r1', groups: ['tags'] });
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(2);

    // collapsed, a change only marks it stale; expanding again reads it once
    await row(wrapper, 'group', 'tags').get('[data-testid="repositories-twistie"]').trigger('click');
    scm.artifactsChanged({ repoId: 'r1', groups: ['tags'] });
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(2);
    await row(wrapper, 'group', 'tags').get('[data-testid="repositories-twistie"]').trigger('click');
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(3);
  });

  it('selects a row on click without expanding it, expands on the twistie, and reports the expanded ids', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const { wrapper, expansions } = await mountSection(scm, [groupRowId(ROOT, 'branches')]);
    expect(rowNames(wrapper).slice(0, 3)).toEqual(['group:branches', 'folder:feat', 'branch:main']);
    expect(row(wrapper, 'branch', 'main').attributes('data-head')).toBe('true');

    await row(wrapper, 'folder', 'feat').trigger('click');
    expect(row(wrapper, 'folder', 'feat').attributes('aria-selected')).toBe('true');
    expect(row(wrapper, 'folder', 'feat').attributes('aria-expanded')).toBe('false');
    expect(expansions).toEqual([]);

    await row(wrapper, 'folder', 'feat').get('[data-testid="repositories-twistie"]').trigger('click');
    await flushPromises();
    expect(expansions).toEqual([[groupRowId(ROOT, 'branches'), folderRowId(ROOT, 'branches', 'feat')]]);
    expect(rowNames(wrapper).slice(0, 5)).toEqual(['group:branches', 'folder:feat', 'branch:feat/b', 'branch:feat/a', 'branch:main']);
    expect(row(wrapper, 'branch', 'feat/b').get('[data-testid="repositories-description"]').text()).toBe(`${HASH_B.slice(0, 7)} \u2022 feat/b work`);
  });

  // happy-dom lays nothing out, so this pins the structure; scm-repositories.spec.ts measures it in Chromium.
  it('gives the name priority over the time on one clipped wrapping line, and draws a repeated time\'s rule the row\'s full height', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const { wrapper } = await mountSection(scm, [groupRowId(ROOT, 'branches'), folderRowId(ROOT, 'branches', 'feat')]);
    const shown = row(wrapper, 'branch', 'feat/b');
    const line = shown.get('[data-testid="repositories-label"]').element.parentElement!;
    expect(line.getAttribute('data-testid')).toBe('repositories-line');
    expect(line.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'content-start', 'overflow-hidden', 'h-full', 'min-w-0', 'flex-1']));
    for (const part of ['repositories-description', 'repositories-time']) expect(shown.get(`[data-testid="${part}"]`).element.parentElement).toBe(line);
    // feat/a's time repeats feat/b's: a rule the row's height, no short bar
    const repeated = row(wrapper, 'branch', 'feat/a').get('[data-testid="repositories-time"]');
    expect(repeated.attributes('data-hidden')).toBe('true');
    expect(repeated.classes()).toEqual(expect.arrayContaining(['h-full', 'border-l']));
    expect(repeated.classes()).not.toContain('h-3.5');
    expect(shown.get('[data-testid="repositories-time"]').classes()).not.toContain('border-l');
  });

  it('shares one selected repository with Source control: a row selects its repository, and the picker moves the highlight', async () => {
    const scm = scmFor(view([ROOT, NESTED], 'r1'));
    const { wrapper } = await mountSection(scm);
    expect(row(wrapper, 'repo', 'acme').attributes('aria-selected')).toBe('true');
    expect(row(wrapper, 'repo', 'lib').get('[data-testid="repositories-description"]').text()).toBe('dev');

    await row(wrapper, 'repo', 'lib').trigger('click');
    expect(scm.select).toHaveBeenCalledWith({ projectKey: 'p1', repoId: 'r2' });
    scm.pushView(view([ROOT, NESTED], 'r2'));
    await flushPromises();
    expect(row(wrapper, 'repo', 'lib').attributes('aria-selected')).toBe('true');
    expect(row(wrapper, 'repo', 'acme').attributes('aria-selected')).toBe('false');

    // Source control's picker selects the first again: its row takes the highlight
    scm.pushView(view([ROOT, NESTED], 'r1'));
    await flushPromises();
    expect(row(wrapper, 'repo', 'acme').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('[data-testid="repositories-selection"]').attributes('style')).toContain('translateY(0px)');
  });

  it('runs a stash row\'s Apply Stash as the same call as Source control\'s Stashes group', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const { wrapper } = await mountSection(scm, [groupRowId(ROOT, 'stashes')]);
    await row(wrapper, 'stash', HASH_B).get('[data-testid="repositories-action-applyStash"]').trigger('click');
    await flushPromises();
    const fromRepositories = vi.mocked(scm.run).mock.calls.at(-1)![0];

    const other = scmFor(view([ROOT], 'r1'));
    vi.mocked(other.artifacts).mockResolvedValue({ ok: true, artifacts: { group: 'stashes', rows: [stash] } });
    const store = createScmStore(other);
    await store.start();
    const section = mount(ScmSection, {
      props: { api: fakeShellApi(), projectKey: 'p1', projectName: 'alpha', platform: 'win32', viewMode: 'list', sortKey: 'path', collapsed: false },
      global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } },
      attachTo: document.body,
    });
    mounted.push(section);
    await flushPromises();
    await section.get('[data-testid="scm-stash-apply"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(other.run).mock.calls.at(-1)![0]).toEqual(fromRepositories);
    expect(fromRepositories).toEqual({ op: 'stashApply', repoId: 'r1', pop: false, target: { index: 0, hash: HASH_B } });
  });

  it('builds VS Code\'s branch, tag, worktree and Stash menus, with Checkout and Delete off on HEAD', () => {
    const items = toOverlayMenu(branchRowMenu({ current: false, commit: commit(HASH_A, 's') }), english);
    expect(labels(items)).toEqual(['Checkout', 'Checkout (Detached)', '-', 'Merge', 'Rebase', '-', 'Create from...', 'Delete', '-', 'Compare with...', '-', 'Copy Branch Name', 'Copy Commit Hash']);
    const head = toOverlayMenu(branchRowMenu({ current: true, commit: null }), english);
    expect(head.flatMap((item) => (item.kind === 'item' && item.disabled ? [item.id] : []))).toEqual(['checkoutRef', 'deleteRef']);
    expect(labels(toOverlayMenu(tagRowMenu({ current: false, commit: commit(HASH_A, 's') }), english))).toEqual(['Checkout', 'Checkout (Detached)', '-', 'Delete', '-', 'Compare with...', '-', 'Copy Tag Name', 'Copy Commit Hash']);
    expect(labels(toOverlayMenu(worktreeRowMenu({ main: false, current: false, branch: 'wt', commit: commit(HASH_A, 's') }), english))).toEqual(['Open', '-', 'Delete', '-', 'Copy Branch Name', 'Copy Commit Hash', 'Copy Worktree Path']);
    expect(labels(toOverlayMenu(repositoryStashMenu(true), english))).toEqual(['Stash', '-', 'Stash Staged', 'Stash (Include Untracked)']);
    expect(labels(toOverlayMenu(repositoryStashMenu(false), english))).toEqual(['Stash', '-', 'Stash (Include Untracked)']);
    for (const id of ['compareRef', 'copyCommitHash', 'openWorktree']) expect(actionOf(id)).toBe(id);
  });

  it('runs Compare with... and the copies on the row\'s own refname, and Open on the worktree\'s path with its tooltip', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const shell = fakeShellApi();
    const { wrapper } = await mountSection(scm, [groupRowId(ROOT, 'tags'), groupRowId(ROOT, 'worktrees')], shell);
    shell.answerNext({ kind: 'menu', itemId: 'compareRef' });
    await row(wrapper, 'tag', 'v1.0').trigger('contextmenu');
    await flushPromises();
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'compareRef', repoId: 'r1', ref: 'refs/tags/v1.0' });
    shell.answerNext({ kind: 'menu', itemId: 'copyCommitHash' });
    await row(wrapper, 'tag', 'v1.0').trigger('contextmenu');
    await flushPromises();
    expect(scm.copy).toHaveBeenLastCalledWith({ repoId: 'r1', kind: 'commitHash', value: 'refs/tags/v1.0' });

    const open = row(wrapper, 'worktree', 'C:\\w\\acme').get('[data-testid="repositories-action-openWorktree"]');
    expect(open.attributes('aria-label')).toBe('Open');
    expect(open.attributes('title')).toBe('Show project folder');
    await open.trigger('click');
    await flushPromises();
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'openWorktree', repoId: 'r1', path: 'C:\\w\\acme' });
  });

  it('shows Source control\'s trust state for an untrusted project and reads nothing', async () => {
    const scm = scmFor(view([], '', { state: 'untrusted', selectedRepoId: null }), []);
    const { wrapper, shell } = await mountSection(scm, [groupRowId(ROOT, 'branches')]);
    expect(wrapper.get('[data-testid="scm-state"]').attributes('data-state')).toBe('untrusted');
    expect(wrapper.find('[data-testid="repositories-tree"]').exists()).toBe(false);
    expect(scm.artifacts).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="scm-state-action"]').trigger('click');
    expect(shell.grantTrust).toHaveBeenCalledWith('p1');
  });

  it('offers Reopen Closed Repositories... in its title while one is closed, and collapses every row at once', async () => {
    const scm = scmFor(view([ROOT, NESTED], 'r1', { closedCount: 1 }));
    const { wrapper, expansions } = await mountSection(scm, [repoRowId(ROOT), groupRowId(ROOT, 'branches')]);
    const reopen = wrapper.get('[data-testid="repositories-reopen-closed"]');
    expect(reopen.attributes('aria-label')).toBe('Reopen Closed Repositories...');
    await reopen.trigger('click');
    expect(scm.run).toHaveBeenLastCalledWith({ op: 'reopenClosed', projectKey: 'p1' });
    await wrapper.get('[data-testid="repositories-collapse-all"]').trigger('click');
    expect(expansions.at(-1)).toEqual([]);
  });

  it('opens the Stash menu from the Stashes group\'s inline Stash, and stashes only what the user picks there', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const shell = fakeShellApi();
    let answer!: (picked: OverlayAnswer) => void;
    vi.mocked(shell.requestOverlay).mockImplementationOnce((request) => {
      shell.overlayRequests.push(request);
      return new Promise((resolve) => { answer = resolve; });
    });
    const { wrapper } = await mountSection(scm, [], shell);
    await row(wrapper, 'group', 'stashes').get('[data-testid="repositories-action-stash"]').trigger('click');
    await flushPromises();
    expect(scm.run).not.toHaveBeenCalled();
    expect(shell.overlayRequests).toHaveLength(1);
    expect(shell.overlayRequests[0]).toMatchObject({ kind: 'menu', label: 'Stash' });
    answer({ kind: 'menu', itemId: 'stashIncludeUntracked' });
    await flushPromises();
    expect(vi.mocked(scm.run).mock.calls).toEqual([[{ op: 'stash', repoId: 'r1', scope: 'includeUntracked' }]]);
  });

  it('reads a group main answered unknown for no more until the view drops its repository', async () => {
    const scm = scmFor(view([ROOT, NESTED], 'r1'));
    vi.mocked(scm.artifacts).mockResolvedValue({ ok: false, reason: 'unknown' });
    const { wrapper } = await mountSection(scm, [repoRowId(NESTED), groupRowId(NESTED, 'tags')]);
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(1);
    // gone shows nothing under the group, and other changes to the rows read nothing
    expect(rowNames(wrapper)).toEqual(['repo:acme', 'repo:lib', 'group:branches', 'group:stashes', 'group:tags', 'group:worktrees']);
    expect(row(wrapper, 'group', 'tags').attributes('aria-busy')).toBeUndefined();
    scm.pushSnapshot(snapshot('r2', 'feat'));
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(1);

    scm.pushView(view([ROOT], 'r1'));
    await flushPromises();
    scm.pushView(view([ROOT, NESTED], 'r1'));
    await flushPromises();
    expect(scm.artifacts).toHaveBeenCalledTimes(2);
  });

  it('reads a failed group again when it shows again, never on another change of the rows', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    vi.mocked(scm.artifacts).mockImplementationOnce(async () => ({ ok: false, reason: 'failed' }));
    const { wrapper } = await mountSection(scm, [groupRowId(ROOT, 'tags')]);
    expect(wrapper.get('[data-kind="note"]').text()).toBe(shellI18n.global.t('repositories.note.failed'));
    await twistie(wrapper, 'branches');
    expect(vi.mocked(scm.artifacts).mock.calls.map(([request]) => request.group)).toEqual(['tags', 'branches']);
    await twistie(wrapper, 'tags');
    await twistie(wrapper, 'tags');
    expect(vi.mocked(scm.artifacts).mock.calls.map(([request]) => request.group)).toEqual(['tags', 'branches', 'tags']);
    expect(row(wrapper, 'tag', 'v1.0').exists()).toBe(true);
  });

  it('leaves out of its next report the folder rows a fresh Branches list no longer holds', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const { wrapper, expansions } = await mountSection(scm, [groupRowId(ROOT, 'branches'), folderRowId(ROOT, 'branches', 'feat'), folderRowId(ROOT, 'branches', 'old')]);
    await twistie(wrapper, 'tags');
    expect(expansions).toEqual([[groupRowId(ROOT, 'branches'), folderRowId(ROOT, 'branches', 'feat'), groupRowId(ROOT, 'tags')]]);
  });

  it('builds its rows again only when a repository or its HEAD changes, and then reuses an unchanged group\'s rows', async () => {
    const many: ScmArtifacts = { group: 'tags', rows: Array.from({ length: 2000 }, (_, index) => ({ ...tag(`v${index}`), commit: { ...commit(HASH_A, 'release'), date: NOW - index * 60_000 } })) };
    const scm = scmFor(view([NESTED, ROOT], 'r1'));
    vi.mocked(scm.artifacts).mockImplementation(async (request) => ({ ok: true, artifacts: request.group === 'tags' ? many : { group: request.group, rows: [] } as ScmArtifacts }));
    const { wrapper } = await mountSection(scm, [repoRowId(ROOT), groupRowId(ROOT, 'tags')]);
    expect(row(wrapper, 'tag', 'v0').exists()).toBe(true);
    const format = vi.spyOn(Intl.RelativeTimeFormat.prototype, 'format');
    // a status push that leaves every HEAD where it was builds nothing
    scm.pushSnapshot({ ...snapshot('r1', 'main'), groups: { merge: [], index: [], workingTree: [], untracked: [] } });
    await flushPromises();
    expect(format).not.toHaveBeenCalled();
    // another repository's HEAD moved: its row changes, and the 2000 tag rows are reused, times and all
    scm.pushSnapshot(snapshot('r2', 'feat'));
    await flushPromises();
    expect(row(wrapper, 'repo', 'lib').get('[data-testid="repositories-description"]').text()).toBe('feat');
    expect(format).not.toHaveBeenCalled();
  });

  it('moves with the arrow keys, expands with ArrowRight and jumps by type-ahead', async () => {
    const scm = scmFor(view([ROOT], 'r1'));
    const { wrapper, expansions } = await mountSection(scm);
    const tree = wrapper.get('[data-testid="repositories-tree"]');
    await row(wrapper, 'group', 'branches').trigger('focus');
    await tree.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(expansions).toEqual([[groupRowId(ROOT, 'branches')]]);
    await tree.trigger('keydown', { key: 'w' });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-name')).toBe('worktrees');
    await tree.trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-name')).toBe('branches');
  });
});
