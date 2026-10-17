// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { OverlayRequest } from '../../preload/overlay-channels';
import type { ScmHistoryCommit, ScmHistoryLoad, ScmHistoryResult, ScmRepoSnapshot, ScmView } from '../../preload/scm-channels';
import type { GraphRefChoice } from '../../preload/shell-channels';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import GraphSection from '../graph/GraphSection.vue';
import RefPicker from '../graph/RefPicker.vue';
import {
  type GraphListRow,
  type ListOptions,
  chipText,
  choiceOfSelection,
  composeListRows,
  headInChoice,
  keptChoice,
  laneListRows,
  lanePath,
  pickerRefs,
  pickerRows,
  refChangeAction,
  selectionOf,
  shortFromNow,
  shortRefName,
  toggleSelection,
} from '../graph/graph-model';

const buildListRows = (commits: readonly ScmHistoryCommit[], load: ScmHistoryLoad | undefined, options: ListOptions): GraphListRow[] =>
  composeListRows(laneListRows(commits, load, options), options);
import { laneMetrics } from '../graph/lanes';
import { graphCommitCall, graphCommitMenu, graphRefCall, graphRefMenu, toOverlayMenu } from '../scm/scm-menus';
import { FakeResizeObserver, fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS, type FakeScmApi, type FakeShellApi } from './fakes';

const hash = (n: number): string => n.toString(16).padStart(40, '0');
const NOW = Date.UTC(2026, 0, 10, 12);
const commit = (n: number, parents: number[], subject: string, refs: ScmHistoryCommit['refs'] = []): ScmHistoryCommit =>
  ({ hash: hash(n), parents: parents.map(hash), author: 'Ada', email: 'ada@example.com', authorDate: NOW - n * 60_000, subject, refs });
const MAIN = { id: 'refs/heads/main', name: 'main', kind: 'branch' as const, current: true };
const LOAD: ScmHistoryLoad = { headRefs: { head: { id: 'refs/heads/main', name: 'main', revision: hash(1) } }, ahead: 0, behind: 0, resolvedRefs: ['refs/heads/main'] };
// 1 is HEAD; 2 merges 3 (main) and 4 (feature); both come from 5
const MERGED = [commit(1, [2], 'Add request id', [MAIN]), commit(2, [3, 4], "Merge branch 'feat'"), commit(3, [5], 'Fix N+1'), commit(4, [5], 'Document the API'), commit(5, [], 'Initial commit')];

const labels = { auto: 'Auto', all: 'All', refs: (n: number) => `${n} refs` };

describe('the Graph ref choice', () => {
  it('names the choice on the chip: Auto, All, the one ref, or the count', () => {
    expect(chipText('auto', labels)).toBe('Auto');
    expect(chipText('all', labels)).toBe('All');
    expect(chipText(['refs/remotes/origin/main'], labels)).toBe('origin/main');
    expect(chipText(['refs/heads/a', 'refs/tags/v1'], labels)).toBe('2 refs');
    expect(shortRefName('refs/tags/v1.0')).toBe('v1.0');
  });

  it('drops refs that no longer exist and falls back to Auto when none is left', () => {
    expect(keptChoice(['refs/heads/a', 'refs/heads/b'], ['refs/heads/a'])).toEqual(['refs/heads/a']);
    expect(keptChoice(['refs/heads/gone'], ['refs/heads/main', 'refs/remotes/origin/main'])).toBe('auto');
    expect(keptChoice('all', [])).toBe('all');
  });

  it('picks as VS Code\'s picker: Auto and All alone, a ref clears them, nothing picked accepts as Auto, at most 50 refs', () => {
    let selection = selectionOf('auto');
    selection = toggleSelection(selection, 'refs/heads/a');
    expect(selection).toEqual({ kind: 'refs', refs: ['refs/heads/a'] });
    selection = toggleSelection(selection, 'all');
    expect(selection).toEqual({ kind: 'all' });
    selection = toggleSelection(selection, 'all');
    expect(choiceOfSelection(selection)).toBe('auto');
    const full = { kind: 'refs' as const, refs: Array.from({ length: 50 }, (_, i) => `refs/heads/b${i}`) };
    expect(toggleSelection(full, 'refs/heads/one-more')).toBe(full);
    expect(toggleSelection(full, 'refs/heads/b0')).toEqual({ kind: 'refs', refs: full.refs.slice(1) });
  });

  it('lists Auto and All, then each group with its matches, filtered as typed', () => {
    const refs = [{ id: 'refs/heads/main', name: 'main' }, { id: 'refs/remotes/origin/main', name: 'origin/main' }, { id: 'refs/tags/v1', name: 'v1' }];
    expect(pickerRows(refs, '', { auto: 'Auto', all: 'All' }).map((row) => (row.kind === 'ref' ? row.ref.name : row.kind === 'group' ? `#${row.group}` : row.id)))
      .toEqual(['auto', 'all', '#branches', 'main', '#remotes', 'origin/main', '#tags', 'v1']);
    expect(pickerRows(refs, 'ORIGIN', { auto: 'Auto', all: 'All' }).map((row) => (row.kind === 'ref' ? row.ref.name : row.kind === 'group' ? `#${row.group}` : row.id)))
      .toEqual(['#remotes', 'origin/main']);
  });

  it('allows Go to Current only while HEAD\'s ref is in the choice', () => {
    expect(headInChoice('auto', LOAD)).toBe(true);
    expect(headInChoice(['refs/heads/main'], LOAD)).toBe(true);
    expect(headInChoice(['refs/heads/side'], { ...LOAD, resolvedRefs: ['refs/heads/side'] })).toBe(false);
  });
});

describe('the Graph rows', () => {
  it('follows VS Code\'s refresh rule: an engine change reloads; a background one reloads at the top, else marks Outdated', () => {
    expect(refChangeAction(false, false)).toBe('reload');
    expect(refChangeAction(true, true)).toBe('reload');
    expect(refChangeAction(true, false)).toBe('outdated');
  });

  it('flattens an expanded commit into its meta, message, stat and file rows, then a loading row while a page is read', () => {
    const details = new Map([[hash(2), { state: 'ready' as const, details: { hash: hash(2), parents: [hash(3), hash(4)], message: 'Merge\n\nbody', messageTruncated: false, author: 'Ada', email: 'a@x', authorDate: NOW, stat: { files: 2, insertions: 3, deletions: 1 }, files: [{ path: 'a.ts', status: 'M' as const }, { path: 'b.ts', status: 'A' as const }], filesTruncated: false } }]]);
    const rows = buildListRows(MERGED, LOAD, { rowHeight: 26, laneWidth: 11, expanded: new Set([hash(2)]), details, more: 'loading' });
    expect(rows.map((row) => row.kind)).toEqual(['commit', 'commit', 'meta', 'message', 'stat', 'file', 'file', 'commit', 'commit', 'commit', 'more']);
    expect(rows.find((row) => row.kind === 'message')).toMatchObject({ lines: 3 });
    expect(rows.filter((row) => row.kind === 'file').map((row) => (row.kind === 'file' ? row.last : null))).toEqual([false, true]);
    const pending = buildListRows(MERGED, LOAD, { rowHeight: 26, laneWidth: 11, expanded: new Set([hash(4)]), details: new Map() });
    expect(pending.map((row) => row.kind)).toEqual(['commit', 'commit', 'commit', 'commit', 'meta', 'note', 'commit']);
  });

  it('keeps the lanes and geometry of one pass while commits expand and their details arrive, and a closed commit\'s row as it was', () => {
    const lanes = laneListRows(MERGED, LOAD, { rowHeight: 26, laneWidth: 11 });
    const closed = composeListRows(lanes, { expanded: new Set(), details: new Map() });
    const open = composeListRows(lanes, { expanded: new Set([hash(2)]), details: new Map() });
    expect(open[0]).toBe(closed[0]);
    expect(open[2]!.kind).toBe('meta');
    const geometry = (row: (typeof open)[number] | undefined) => (row?.kind === 'commit' ? row.geometry : undefined);
    expect(geometry(open[1])).toBe(geometry(closed[1]));
    expect(open[1]).toMatchObject({ kind: 'commit', expanded: true });
  });

  it('gives each tree row its place among its siblings: commits among the rows of the list, details among their commit\'s', () => {
    const details = new Map([[hash(2), { state: 'ready' as const, details: { hash: hash(2), parents: [hash(3), hash(4)], message: 'Merge', messageTruncated: false, author: 'Ada', email: 'a@x', authorDate: NOW, stat: { files: 1, insertions: 1, deletions: 0 }, files: [{ path: 'a.ts', status: 'M' as const }], filesTruncated: false } }]]);
    const rows = buildListRows(MERGED, LOAD, { rowHeight: 26, laneWidth: 11, expanded: new Set([hash(2)]), details });
    expect(rows.map((row) => (row.kind === 'more' ? null : row.position))).toEqual([1, 2, 1, 2, 3, 4, 3, 4, 5]);
    expect(rows.flatMap((row) => (row.kind === 'meta' || row.kind === 'message' || row.kind === 'stat' || row.kind === 'file' || row.kind === 'note' ? [row.size] : []))).toEqual([4, 4, 4, 4]);
  });

  it('ends the list with a loading row while a page is read, and a row to try again once a page failed', () => {
    const base = { rowHeight: 26, laneWidth: 11, expanded: new Set<string>(), details: new Map() };
    expect(buildListRows(MERGED, LOAD, { ...base, more: 'loading' }).at(-1)).toEqual({ kind: 'more', key: 'more', state: 'loading' });
    expect(buildListRows(MERGED, LOAD, { ...base, more: 'failed' }).at(-1)).toEqual({ kind: 'more', key: 'more', state: 'failed' });
    expect(buildListRows(MERGED, LOAD, base).at(-1)!.kind).toBe('commit');
  });

  it('offers the picker the refs that fit, always keeping the chosen ones, and counts those left out', () => {
    const listed = Array.from({ length: 6 }, (_, i) => ({ id: `refs/tags/t${i}`, name: `t${i}` }));
    expect(pickerRefs(listed, ['refs/tags/t5'], 3)).toEqual({ refs: [listed[0], listed[1], listed[5]], omitted: 3 });
    expect(pickerRefs(listed, 'auto', 3)).toEqual({ refs: listed.slice(0, 3), omitted: 3 });
    expect(pickerRefs(listed, 'all', 10)).toEqual({ refs: listed, omitted: 0 });
    // a chosen ref that no longer exists is not offered
    expect(pickerRefs(listed.slice(0, 2), ['refs/tags/gone'], 10)).toEqual({ refs: listed.slice(0, 2), omitted: 0 });
  });

  it('inserts Incoming Changes at the merge base while the upstream is shown', () => {
    const upstream = { id: 'refs/remotes/origin/main', name: 'origin/main', revision: hash(10) };
    const commits = [commit(10, [11], 'Upstream two'), commit(11, [3], 'Upstream one'), commit(1, [3], 'Local', [MAIN]), commit(3, [], 'Base')];
    const load = { ...LOAD, headRefs: { ...LOAD.headRefs, upstream }, mergeBase: hash(3), behind: 2, ahead: 1, resolvedRefs: ['refs/heads/main', upstream.id] };
    const rows = buildListRows(commits, load, { rowHeight: 26, laneWidth: 11, expanded: new Set(), details: new Map() });
    expect(rows.map((row) => (row.kind === 'changes' ? row.direction : row.kind))).toEqual(['commit', 'commit', 'outgoing', 'commit', 'incoming', 'commit']);
  });

  it('lights the hovered commit\'s lane: its first parents down and the first children in its lane up, not the other branch', () => {
    const rows = buildListRows(MERGED, LOAD, { rowHeight: 26, laneWidth: 11, expanded: new Set(), details: new Map() });
    expect([...lanePath(rows, hash(4))].sort()).toEqual([hash(4), hash(5)].sort());
    expect(lanePath(rows, hash(3)).has(hash(1))).toBe(true);
    expect(lanePath(rows, hash(3)).has(hash(4))).toBe(false);
  });

  it('shows a row\'s age compactly, as the prototype does, months never read as minutes', () => {
    expect(shortFromNow(NOW - 20 * 60_000, NOW, 'en')).toBe('20m');
    expect(shortFromNow(NOW - 2 * 3_600_000, NOW, 'en')).toBe('2h');
    expect(shortFromNow(NOW - 90 * 86_400_000, NOW, 'en')).toBe('3 mths');
    expect(shortFromNow(NOW - 10_000, NOW, 'en')).toBe('now');
  });

  it('puts lanes on whole device pixels at any font and scale, an odd stroke centred on a pixel', () => {
    expect(laneMetrics(16, 1)).toEqual({ width: 11, stroke: 2, ring: 2, offset: 0 });
    const scaled = laneMetrics(16, 1.25);
    expect(scaled.width * 1.25).toBe(Math.round(scaled.width * 1.25));
    expect(scaled.stroke * 1.25).toBe(3);
    expect(scaled.offset).toBe(0.4);
    const larger = laneMetrics(20, 1.5);
    expect(Number.isInteger(larger.width * 1.5)).toBe(true);
  });
});

describe('the Graph menus', () => {
  const english = (key: string): string => shellI18n.global.t(`scm.${key}`, 1, { locale: 'en' });

  it('builds the commit menu in the plan\'s order, Compare with Remote and Compare with Merge Base off without an upstream or a base', () => {
    const items = toOverlayMenu(graphCommitMenu({ hasUpstream: false, hasBase: false, operation: null }), english);
    expect(items.map((item) => (item.kind === 'separator' ? '-' : item.label))).toEqual([
      'Open Changes', '-', 'Checkout (Detached)', 'Create Branch...', 'Create Tag...', 'Cherry Pick', '-',
      'Compare with...', 'Compare with Remote', 'Compare with Merge Base', '-', 'Copy Commit ID', 'Copy Commit Message', '-',
      'Add to Chat', 'Explain Changes',
    ]);
    // row actions with VS Code's chat icons, never disabled
    expect(items.slice(-2)).toMatchObject([{ id: 'addCommitToChat', icon: 'message-square-plus' }, { id: 'explainCommit', icon: 'sparkles' }]);
    expect(items.slice(-2).some((item) => item.kind === 'item' && item.disabled)).toBe(false);
    const off = Object.fromEntries(items.flatMap((item) => (item.kind === 'item' ? [[item.id, item.disabledReason ?? null]] : [])));
    expect(off).toMatchObject({ compareWithRemote: 'No upstream', compareWithMergeBase: 'No base', compareCommit: null });
    const on = toOverlayMenu(graphCommitMenu({ hasUpstream: true, hasBase: true, operation: null }), english);
    expect(on.some((item) => item.kind === 'item' && item.disabled)).toBe(false);
    // git cannot cherry-pick while a merge, rebase or cherry-pick is in progress, as the palette command says
    const picking = toOverlayMenu(graphCommitMenu({ hasUpstream: true, hasBase: true, operation: 'cherryPick' }), english);
    expect(picking.find((item) => item.kind === 'item' && item.id === 'cherryPick')).toMatchObject({ disabled: true, disabledReason: 'Cherry pick in progress' });
    expect(picking.filter((item) => item.kind === 'item' && item.disabled)).toHaveLength(1);
  });

  it('sends each commit action with the full hash, and the copies as main\'s commitId and commitMessage kinds', () => {
    const h = hash(7);
    expect(graphCommitCall('checkoutCommit', 'r1', h)).toEqual({ run: { op: 'checkout', repoId: 'r1', detached: true, commit: h } });
    expect(graphCommitCall('createBranchAtCommit', 'r1', h)).toEqual({ run: { op: 'createBranch', repoId: 'r1', from: false, commit: h } });
    expect(graphCommitCall('cherryPick', 'r1', h)).toEqual({ run: { op: 'cherryPick', repoId: 'r1', commit: h } });
    expect(graphCommitCall('copyCommitMessage', 'r1', h)).toEqual({ copy: { repoId: 'r1', kind: 'commitMessage', value: h } });
    // the chat actions name the commit alone; main and core read its content and Explain's prompt
    expect(graphCommitCall('addCommitToChat', 'r1', h)).toEqual({ run: { op: 'addCommitToChat', repoId: 'r1', commit: h } });
    expect(graphCommitCall('explainCommit', 'r1', h)).toEqual({ run: { op: 'explainCommit', repoId: 'r1', commit: h } });
  });

  it('builds the ref menu by kind: Delete Branch off on HEAD\'s branch, Delete Remote Branch off on its upstream', () => {
    const ids = (nodes: ReturnType<typeof graphRefMenu>) => toOverlayMenu(nodes, english).flatMap((item) => (item.kind === 'item' ? [`${item.id}${item.disabled ? ' (off)' : ''}`] : []));
    expect(ids(graphRefMenu({ id: 'refs/heads/main', current: true }, undefined))).toEqual(['checkoutRef (off)', 'deleteBranchRef (off)']);
    expect(ids(graphRefMenu({ id: 'refs/heads/a', current: false }, undefined))).toEqual(['checkoutRef', 'deleteBranchRef']);
    expect(ids(graphRefMenu({ id: 'refs/remotes/origin/main', current: false }, 'refs/remotes/origin/main'))).toEqual(['checkoutRef', 'deleteRemoteBranchRef (off)']);
    expect(ids(graphRefMenu({ id: 'refs/tags/v1', current: false }, undefined))).toEqual(['checkoutRef', 'deleteTagRef']);
    expect(graphRefMenu({ id: 'HEAD', current: true }, undefined)).toEqual([]);
    expect(graphRefCall('deleteRemoteBranchRef', 'r1', 'refs/remotes/origin/a')).toEqual({ run: { op: 'deleteRemoteBranch', repoId: 'r1', ref: 'refs/remotes/origin/a' } });
  });
});

const ROOT = { repoId: 'r1', label: 'acme', displayPath: '', kind: 'root' as const, root: '/w/acme' };
const view = (extra: Partial<ScmView> = {}): ScmView => ({ projectKey: 'p1', state: 'ready', repos: [ROOT], selectedRepoId: 'r1', closedCount: 0, unsafePaths: [], parentCount: 0, ...extra });
const snapshot: ScmRepoSnapshot = {
  repoId: 'r1', projectKey: 'p1', head: { type: 'branch', name: 'main' }, commit: { hash: hash(1), subject: 'Add request id' }, operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [] }, tooManyChanges: false, busy: false, upstream: null, remotes: [], running: null, lastRemote: null, revision: 0,
};
const page = (commits: readonly ScmHistoryCommit[], load: ScmHistoryLoad = LOAD): ScmHistoryResult => ({ ok: true, page: { commits, load } });

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

async function mountGraph(scm: FakeScmApi, choices: Record<string, GraphRefChoice> = {}, shell: FakeShellApi = fakeShellApi()): Promise<{ wrapper: VueWrapper; shell: FakeShellApi; emitted: Array<[string, GraphRefChoice]> }> {
  const store = createScmStore(scm);
  await store.start();
  const emitted: Array<[string, GraphRefChoice]> = [];
  const wrapper = mount(GraphSection, {
    props: { api: shell, projectKey: 'p1', choices, collapsed: false, onChoice: (root: string, choice: GraphRefChoice) => emitted.push([root, choice]) },
    global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, shell, emitted };
}

const scmWith = (result: ScmHistoryResult, extra: Partial<ScmView> = {}): FakeScmApi => {
  const scm = fakeScmApi({ views: [view(extra)], snapshots: [snapshot], decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE });
  vi.mocked(scm.history).mockResolvedValue(result);
  return scm;
};
const graphRows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="graph-row"]');

describe('the Graph section', () => {
  it('shows the trust message in an untrusted project and asks main for no history', async () => {
    const scm = scmWith(page(MERGED), { state: 'untrusted', repos: [], selectedRepoId: null });
    const { wrapper } = await mountGraph(scm);
    expect(wrapper.get('[data-testid="scm-state"]').attributes('data-state')).toBe('untrusted');
    expect(wrapper.get('[data-testid="scm-state"]').text()).toContain('Trust this folder to see its history.');
    expect(scm.history).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="graph-ref-chip"]').exists()).toBe(false);
  });

  it('says No commits yet. for an unborn HEAD', async () => {
    const { wrapper } = await mountGraph(scmWith({ ok: false, reason: 'empty' }));
    expect(wrapper.get('[data-testid="graph-state"]').text()).toBe('No commits yet.');
  });

  it('shows a bidirectional control character in a subject and an author escaped', async () => {
    const tricky = { ...commit(1, [], 'Fix \u202Egnp.exe', [MAIN]), author: 'Eve\u200F' };
    const { wrapper } = await mountGraph(scmWith(page([tricky])));
    expect(graphRows(wrapper)[0]!.get('[data-testid="graph-subject"]').text()).toBe('Fix \\u{202E}gnp.exe');
    expect(graphRows(wrapper)[0]!.get('[data-testid="graph-author"]').text()).toBe('Eve\\u{200F}');
  });

  it('reloads on an engine ref change, and on a background one only at the top, else shows Outdated until the top', async () => {
    const scm = scmWith(page(MERGED));
    const { wrapper } = await mountGraph(scm);
    expect(scm.history).toHaveBeenCalledTimes(1);
    scm.artifactsChanged({ repoId: 'r1', groups: ['branches'], refs: 'engine' });
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(2);
    scm.artifactsChanged({ repoId: 'r1', groups: ['stashes'] });
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(2);

    const tree = wrapper.get('[data-testid="graph-tree"]').element as HTMLElement;
    tree.scrollTop = 120;
    scm.artifactsChanged({ repoId: 'r1', groups: ['remoteBranches'], refs: 'background' });
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="graph-outdated"]').exists()).toBe(true);
    tree.scrollTop = 0;
    await wrapper.get('[data-testid="graph-tree"]').trigger('scroll');
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(3);
    expect(wrapper.find('[data-testid="graph-outdated"]').exists()).toBe(false);
    scm.artifactsChanged({ repoId: 'r1', groups: ['remoteBranches'], refs: 'background' });
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(4);
  });

  it('reads the next page with the cursor of the load, so it reads the same snapshot', async () => {
    const scm = scmWith({ ok: true, page: { commits: MERGED.slice(0, 2), load: LOAD, cursor: 'c1' } });
    vi.mocked(scm.history).mockResolvedValueOnce({ ok: true, page: { commits: MERGED.slice(0, 2), load: LOAD, cursor: 'c1' } })
      .mockResolvedValueOnce({ ok: true, page: { commits: MERGED.slice(2) } });
    const { wrapper } = await mountGraph(scm);
    await flushPromises();
    expect(scm.history).toHaveBeenLastCalledWith({ repoId: 'r1', refs: 'auto', cursor: 'c1' });
    expect(graphRows(wrapper)).toHaveLength(5);
  });

  it('drops a page read a reload replaced, so its loading row goes and the next page reads from the new load', async () => {
    const scm = scmWith(page(MERGED));
    let answerStale: (result: ScmHistoryResult) => void = () => {};
    vi.mocked(scm.history)
      .mockResolvedValueOnce({ ok: true, page: { commits: MERGED.slice(0, 2), load: LOAD, cursor: 'old' } })
      .mockImplementationOnce(() => new Promise((resolve) => {
        answerStale = resolve;
      }))
      .mockResolvedValueOnce({ ok: true, page: { commits: MERGED.slice(0, 2), load: LOAD, cursor: 'new' } })
      .mockResolvedValueOnce({ ok: true, page: { commits: MERGED.slice(2) } });
    const { wrapper } = await mountGraph(scm);
    // the first page asked for the next one, which is still under way when an engine change reloads
    expect(scm.history).toHaveBeenNthCalledWith(2, { repoId: 'r1', refs: 'auto', cursor: 'old' });
    expect(wrapper.find('[data-testid="graph-more"]').exists()).toBe(true);
    scm.artifactsChanged({ repoId: 'r1', groups: ['branches'], refs: 'engine' });
    await flushPromises();
    answerStale({ ok: true, page: { commits: [commit(9, [], 'From the replaced load')] } });
    await flushPromises();
    expect(scm.history).toHaveBeenNthCalledWith(4, { repoId: 'r1', refs: 'auto', cursor: 'new' });
    expect(wrapper.find('[data-testid="graph-more"]').exists()).toBe(false);
    expect(graphRows(wrapper).map((row) => row.get('[data-testid="graph-subject"]').text())).toEqual(MERGED.map((each) => each.subject));
  });

  it('is a tree with a roving tabindex: arrows move, Enter expands and reads the details, Shift+F10 opens the commit menu once', async () => {
    const scm = scmWith(page(MERGED));
    const { wrapper, shell } = await mountGraph(scm);
    expect(wrapper.get('[data-testid="graph-tree"]').attributes('role')).toBe('tree');
    const first = graphRows(wrapper)[0]!;
    expect(first.attributes('tabindex')).toBe('0');
    expect(graphRows(wrapper)[1]!.attributes('tabindex')).toBe('-1');
    const tree = wrapper.get('[data-testid="graph-tree"]');
    await tree.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(graphRows(wrapper)[1]!.attributes('tabindex')).toBe('0');
    await tree.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(graphRows(wrapper)[1]!.attributes('aria-expanded')).toBe('true');
    expect(scm.commitDetails).toHaveBeenCalledWith({ repoId: 'r1', hash: hash(2) });
    await tree.trigger('keydown', { key: ' ' });
    expect(graphRows(wrapper)[1]!.attributes('aria-expanded')).toBe('false');

    // the menu stays up until answered; the context-menu key's release sends a contextmenu event meanwhile, and one menu opens
    let close: (answer: { kind: 'dismissed' }) => void = () => {};
    vi.mocked(shell.requestOverlay).mockImplementationOnce(() => new Promise((resolve) => {
      close = resolve;
    }));
    await tree.trigger('keydown', { key: 'ContextMenu' });
    await graphRows(wrapper)[1]!.trigger('contextmenu');
    await flushPromises();
    expect(vi.mocked(shell.requestOverlay).mock.calls.map(([request]) => request.kind)).toEqual(['menu']);
    expect(vi.mocked(shell.requestOverlay).mock.calls[0]![0]).toMatchObject({ kind: 'menu', label: `Actions for commit ${hash(2).slice(0, 8)}` });
    close({ kind: 'dismissed' });
    await flushPromises();
    await tree.trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(vi.mocked(shell.requestOverlay)).toHaveBeenCalledTimes(2);
  });

  it('opens the ref menu from a focused badge with Shift+F10, and runs Delete Branch through the slice 11b flow', async () => {
    const feature = { id: 'refs/heads/feat', name: 'feat', kind: 'branch' as const, current: false };
    const scm = scmWith(page([commit(1, [2], 'Add request id', [MAIN]), commit(2, [], 'Start', [feature])]));
    const shell = fakeShellApi();
    shell.answerNext({ kind: 'menu', itemId: 'deleteBranchRef' });
    const { wrapper } = await mountGraph(scm, {}, shell);
    const featBadge = wrapper.get('[data-testid="graph-badge"][data-ref="refs/heads/feat"]');
    expect(featBadge.attributes('title')).toBe('feat\nRight-click for Checkout and Delete');
    expect(featBadge.attributes('aria-label')).toBe('branch feat');
    await featBadge.trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(shell.overlayRequests.at(-1)).toMatchObject({ kind: 'menu', label: 'Actions for feat' });
    expect(scm.run).toHaveBeenCalledWith({ op: 'deleteBranch', repoId: 'r1', ref: 'refs/heads/feat' });
  });

  it('shows a ref name\'s hidden characters on the chip, in the ref menu and a commit menu\'s caption, and keeps the raw ref as the choice', async () => {
    const bidi = { id: 'refs/heads/main\u202Eevil', name: 'main\u202Eevil', kind: 'branch' as const, current: false };
    const scm = scmWith({ ok: true, page: { commits: [commit(1, [2], 'Fix\u202Elogin', [MAIN]), commit(2, [], 'Start', [bidi])], load: { ...LOAD, resolvedRefs: ['refs/heads/main\u202Eevil'] } } });
    const shell = fakeShellApi();
    const { wrapper, emitted } = await mountGraph(scm, { '/w/acme': ['refs/heads/main\u202Eevil'] }, shell);
    expect(wrapper.get('[data-testid="graph-ref-chip-text"]').text()).toBe('main\\u{202E}evil');
    expect(wrapper.get('[data-testid="graph-ref-chip"]').attributes('aria-label')).toContain('main\\u{202E}evil');
    expect(wrapper.get('[data-testid="graph-ref-chip"]').attributes('aria-label')).not.toContain('\u202E');
    expect(emitted.every(([, choice]) => JSON.stringify(choice) === JSON.stringify(['refs/heads/main\u202Eevil']))).toBe(true);
    await wrapper.get('[data-testid="graph-badge"][data-ref="refs/heads/main\u202Eevil"]').trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(shell.overlayRequests.at(-1)).toMatchObject({ kind: 'menu', label: 'Actions for main\\u{202E}evil' });
    await graphRows(wrapper)[0]!.trigger('contextmenu');
    await flushPromises();
    expect(shell.overlayRequests.at(-1)).toMatchObject({ kind: 'menu', caption: `${hash(1).slice(0, 8)} Fix\\u{202E}login` });
    expect(JSON.stringify(shell.overlayRequests)).not.toContain('\u202E');
  });

  it('asks the ref picker with the repository\'s refs and keeps the answer for the repository; the chip names a kept choice', async () => {
    const scm = scmWith(page(MERGED));
    vi.mocked(scm.artifacts).mockImplementation(async (request) => {
      if (request.group === 'branches') return { ok: true, artifacts: { group: 'branches', rows: [{ ref: 'refs/heads/main', name: 'main', commit: null, current: true, upstream: null }] } };
      if (request.group === 'tags') return { ok: true, artifacts: { group: 'tags', rows: [{ ref: 'refs/tags/v1', name: 'v1', commit: null, annotated: false, current: false }] } };
      return { ok: true, artifacts: { group: 'remoteBranches', rows: [] } };
    });
    const shell = fakeShellApi();
    shell.answerNext({ kind: 'refPicker', choice: ['refs/heads/main', 'refs/tags/v1'] });
    const { wrapper, emitted } = await mountGraph(scm, { '/w/acme': ['refs/heads/main', 'refs/heads/gone'] }, shell);
    expect(wrapper.get('[data-testid="graph-ref-chip-text"]').text()).toBe('2 refs');
    // the load resolved main alone: the gone ref drops out of the kept choice
    expect(emitted).toEqual([['/w/acme', ['refs/heads/main']]]);
    await wrapper.get('[data-testid="graph-ref-chip"]').trigger('click');
    await flushPromises();
    const request = shell.overlayRequests.find((each): each is Extract<OverlayRequest, { kind: 'refPicker' }> => each.kind === 'refPicker')!;
    expect(request.refs).toEqual([{ id: 'refs/heads/main', name: 'main' }, { id: 'refs/tags/v1', name: 'v1' }]);
    expect(request.selected).toEqual(['refs/heads/main']);
    expect(emitted.at(-1)).toEqual(['/w/acme', ['refs/heads/main', 'refs/tags/v1']]);
  });

  it('tells the picker when a group of refs could not be read, rather than offering an empty list', async () => {
    const scm = scmWith(page(MERGED));
    vi.mocked(scm.artifacts).mockImplementation(async (request) => {
      if (request.group === 'tags') return { ok: false, reason: 'failed' };
      if (request.group === 'branches') return { ok: true, artifacts: { group: 'branches', rows: [{ ref: 'refs/heads/main', name: 'main', commit: null, current: true, upstream: null }] } };
      return { ok: true, artifacts: { group: 'remoteBranches', rows: [] } };
    });
    const shell = fakeShellApi();
    shell.answerNext({ kind: 'dismissed' });
    const { wrapper } = await mountGraph(scm, {}, shell);
    await wrapper.get('[data-testid="graph-ref-chip"]').trigger('click');
    await flushPromises();
    expect(shell.overlayRequests.find((each) => each.kind === 'refPicker')).toMatchObject({ refs: [{ id: 'refs/heads/main', name: 'main' }], failed: true, omitted: 0 });
  });

  it('shows a page that failed as a row to try again, which reads the same page; scrolling never retries it on its own', async () => {
    const scm = scmWith(page(MERGED));
    vi.mocked(scm.history)
      .mockResolvedValueOnce({ ok: true, page: { commits: MERGED.slice(0, 2), load: LOAD, cursor: 'c1' } })
      .mockResolvedValueOnce({ ok: false, reason: 'failed' })
      .mockResolvedValueOnce({ ok: true, page: { commits: MERGED.slice(2) } });
    const { wrapper } = await mountGraph(scm);
    await flushPromises();
    const more = wrapper.get('[data-testid="graph-more"]');
    expect(more.attributes('data-state')).toBe('failed');
    expect(more.text()).toContain('Couldn\'t load more history.');
    await wrapper.get('[data-testid="graph-tree"]').trigger('scroll');
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(2);
    await more.get('[data-testid="graph-more-retry"]').trigger('click');
    await flushPromises();
    expect(scm.history).toHaveBeenNthCalledWith(3, { repoId: 'r1', refs: 'auto', cursor: 'c1' });
    expect(wrapper.find('[data-testid="graph-more"]').exists()).toBe(false);
    expect(graphRows(wrapper)).toHaveLength(5);
  });

  it('drops a load the choice changed under, so the old choice\'s pruning never replaces the new one', async () => {
    const scm = scmWith(page(MERGED));
    let answerOld: (result: ScmHistoryResult) => void = () => {};
    vi.mocked(scm.history)
      .mockImplementationOnce(() => new Promise((resolve) => {
        answerOld = resolve;
      }))
      .mockResolvedValueOnce(page(MERGED, { ...LOAD, resolvedRefs: ['refs/heads/side'] }));
    const { wrapper, emitted } = await mountGraph(scm, { '/w/acme': ['refs/heads/main', 'refs/heads/gone'] });
    await wrapper.setProps({ choices: { '/w/acme': ['refs/heads/side'] } });
    answerOld(page(MERGED, { ...LOAD, resolvedRefs: ['refs/heads/main'] }));
    await flushPromises();
    expect(emitted).toEqual([]);
    expect(scm.history).toHaveBeenLastCalledWith({ repoId: 'r1', refs: ['refs/heads/side'] });
    expect(scm.history).toHaveBeenCalledTimes(2);
  });

  it('loads once when the shown repository changes, whose HEAD differs too', async () => {
    const other = { ...ROOT, repoId: 'r2', label: 'other', root: '/w/other' };
    const scm = fakeScmApi({ views: [view({ repos: [ROOT, other] })], snapshots: [snapshot, { ...snapshot, repoId: 'r2', head: { type: 'branch', name: 'develop' } }], decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE });
    vi.mocked(scm.history).mockResolvedValue(page(MERGED));
    await mountGraph(scm);
    expect(scm.history).toHaveBeenCalledTimes(1);
    scm.pushView(view({ repos: [ROOT, other], selectedRepoId: 'r2' }));
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(2);
    expect(scm.history).toHaveBeenLastCalledWith({ repoId: 'r2', refs: 'auto' });
  });

  it('loads no second time for the choice it pruned itself', async () => {
    const scm = scmWith(page(MERGED));
    const { wrapper, emitted } = await mountGraph(scm, { '/w/acme': ['refs/heads/main', 'refs/heads/gone'] });
    expect(emitted).toEqual([['/w/acme', ['refs/heads/main']]]);
    await wrapper.setProps({ choices: { '/w/acme': ['refs/heads/main'] } });
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(1);
  });

  it('names an expanded commit\'s message row by its message, escaped, and places each row among its siblings', async () => {
    const scm = scmWith({ ok: true, page: { commits: MERGED, load: LOAD, cursor: 'more' } });
    vi.mocked(scm.history).mockResolvedValueOnce({ ok: true, page: { commits: MERGED, load: LOAD, cursor: 'more' } }).mockImplementation(() => new Promise(() => {}));
    vi.mocked(scm.commitDetails).mockResolvedValue({ ok: true, details: { hash: hash(2), parents: [hash(3), hash(4)], message: 'Merge \u202Efeat\n\nWhy it was merged.', messageTruncated: false, author: 'Ada', email: 'a@x', authorDate: NOW, files: [], filesTruncated: false } });
    const { wrapper } = await mountGraph(scm);
    await graphRows(wrapper)[1]!.trigger('click');
    await flushPromises();
    const message = wrapper.get('[data-testid="graph-detail"][data-kind="message"]');
    expect(message.attributes('aria-label')).toBe('Commit message: Merge \\u{202E}feat\n\nWhy it was merged.');
    expect(message.attributes('aria-posinset')).toBe('2');
    expect(message.attributes('aria-setsize')).toBe('2');
    // more commits follow, so the list's size is not known yet
    expect(graphRows(wrapper)[0]!.attributes('aria-posinset')).toBe('1');
    expect(graphRows(wrapper)[0]!.attributes('aria-setsize')).toBe('-1');
  });

  it('shows a tab in an expanded commit\'s message as whitespace, while other control characters stay escaped', async () => {
    const scm = scmWith({ ok: true, page: { commits: MERGED, load: LOAD, cursor: 'more' } });
    vi.mocked(scm.history).mockResolvedValueOnce({ ok: true, page: { commits: MERGED, load: LOAD, cursor: 'more' } }).mockImplementation(() => new Promise(() => {}));
    vi.mocked(scm.commitDetails).mockResolvedValue({ ok: true, details: { hash: hash(2), parents: [hash(3), hash(4)], message: 'Merge\r\n\r\n# Conflicts:\r\n#\tconflict.ts\u0007', messageTruncated: false, author: 'Ada', email: 'a@x', authorDate: NOW, files: [], filesTruncated: false } });
    const { wrapper } = await mountGraph(scm);
    await graphRows(wrapper)[1]!.trigger('click');
    await flushPromises();
    const message = wrapper.get('[data-testid="graph-detail"][data-kind="message"]');
    expect(message.get('[data-testid="graph-message"]').element.textContent).toBe('Merge\n\n# Conflicts:\n#\tconflict.ts\\u{7}');
    expect(message.attributes('aria-label')).toBe('Commit message: Merge\n\n# Conflicts:\n#\tconflict.ts\\u{7}');
  });
});

describe('the ref picker', () => {
  const REFS = [{ id: 'refs/heads/main', name: 'main' }, { id: 'refs/heads/feat', name: 'feat' }, { id: 'refs/tags/v1', name: 'v1' }];
  const mountPicker = (selected: GraphRefChoice): VueWrapper => {
    const wrapper = mount(RefPicker, { props: { request: { kind: 'refPicker', anchor: { x: 10, y: 10, width: 40, height: 20 }, refs: REFS, selected, failed: false, omitted: 0 } }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
  };
  const optionOf = (wrapper: VueWrapper, item: string) => wrapper.get(`[data-testid="graph-ref-option"][data-item="${item}"]`);

  it('checks the current choice, clears Auto when a ref is picked, and answers the refs picked', async () => {
    const wrapper = mountPicker('auto');
    await flushPromises();
    expect(optionOf(wrapper, 'auto').attributes('aria-selected')).toBe('true');
    expect(optionOf(wrapper, 'auto').attributes('aria-label')).toBe('Auto, current branch, its upstream and base');
    await optionOf(wrapper, 'refs/heads/feat').trigger('click');
    await optionOf(wrapper, 'refs/tags/v1').trigger('click');
    expect(optionOf(wrapper, 'auto').attributes('aria-selected')).toBe('false');
    await wrapper.get('[data-testid="graph-ref-ok"]').trigger('click');
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'refPicker', choice: ['refs/heads/feat', 'refs/tags/v1'] }]]);
  });

  it('says when refs could not be read and how many the list left out, whatever the filter', async () => {
    const wrapper = mount(RefPicker, { props: { request: { kind: 'refPicker', anchor: { x: 10, y: 10, width: 40, height: 20 }, refs: REFS, selected: 'auto', failed: true, omitted: 3 } }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    expect(wrapper.get('[data-testid="graph-ref-failed"]').text()).toBe('Some references could not be loaded.');
    expect(wrapper.get('[data-testid="graph-ref-omitted"]').text()).toBe('3 more references not shown');
    await wrapper.get('[data-testid="graph-ref-filter"]').setValue('zzz');
    expect(wrapper.find('[data-testid="graph-ref-omitted"]').exists()).toBe(true);
    const plain = mountPicker('auto');
    await flushPromises();
    expect(plain.find('[data-testid="graph-ref-failed"]').exists()).toBe(false);
    expect(plain.find('[data-testid="graph-ref-omitted"]').exists()).toBe(false);
  });

  it('answers Auto when nothing is left picked, and Space toggles the active option from the filter', async () => {
    const wrapper = mountPicker(['refs/heads/main']);
    await flushPromises();
    const filter = wrapper.get('[data-testid="graph-ref-filter"]');
    await filter.setValue('feat');
    await filter.trigger('keydown', { key: ' ' });
    expect(optionOf(wrapper, 'refs/heads/feat').attributes('aria-selected')).toBe('true');
    await filter.trigger('keydown', { key: ' ' });
    await filter.setValue('main');
    await filter.trigger('keydown', { key: ' ' });
    await filter.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'refPicker', choice: 'auto' }]]);
  });
});
