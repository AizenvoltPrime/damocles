// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmChange, ScmRepoSnapshot, ScmTimelineEntry, ScmTimelineResult, ScmView } from '../../preload/scm-channels';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import TimelineTab from '../editor/TimelineTab.vue';
import { fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS } from './fakes';

const entry = (index: number): ScmTimelineEntry => ({ hash: index.toString(16).padStart(40, '0'), parents: [], subject: `commit ${index}`, message: `commit ${index}`, author: 'A', email: 'a@x', committerDate: 0, path: 'a.txt' });
const page = (from: number, cursor?: string, hasStaged = false): ScmTimelineResult => ({ ok: true, entries: Array.from({ length: 3 }, (_value, index) => entry(from + index)), ...(cursor !== undefined ? { cursor } : {}), hasStaged, committed: true });
const staged: ScmChange = { path: 'a.txt', status: 'INDEX_MODIFIED', letter: 'M', tone: 'modified', strike: false };

const snapshot = (revision: number, extra: Partial<ScmRepoSnapshot> = {}): ScmRepoSnapshot => ({
  repoId: 'r1',
  projectKey: 'p1',
  head: { type: 'branch', name: 'main' },
  commit: { hash: 'h1', subject: 'top' },
  operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [] },
  tooManyChanges: false,
  busy: false,
  upstream: null,
  remotes: [],
  running: null,
  lastRemote: null,
  revision,
  ...extra,
});

const VIEW: ScmView = { projectKey: 'p1', state: 'ready', repos: [{ repoId: 'r1', label: 'alpha', displayPath: '', kind: 'root', root: '/w/alpha' }], selectedRepoId: 'r1', closedCount: 0, unsafePaths: [], parentCount: 0 };
const tab = { id: 't', kind: 'timeline', title: 'a.txt', displayPath: 'a.txt', dirty: false, readOnly: false, conflict: false, timeline: { repoId: 'r1', path: 'a.txt' } } as ShellEditorTab & { timeline: NonNullable<ShellEditorTab['timeline']> };

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

async function setup(timeline: (request: { cursor?: string }) => Promise<ScmTimelineResult>) {
  const scmApi = fakeScmApi({ views: [VIEW], snapshots: [snapshot(1)], decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE });
  vi.mocked(scmApi.timeline).mockImplementation(timeline as never);
  const scm = createScmStore(scmApi);
  await scm.start();
  const api = Object.assign(fakeShellApi(), { scm: scmApi });
  const wrapper = mount(TimelineTab, { props: { api, tab }, global: { plugins: [shellI18n], provide: { [SCM_STORE]: scm } }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { scmApi, wrapper, timeline: vi.mocked(scmApi.timeline) };
}

describe('the Timeline tab', () => {
  it('reads nothing again for a status that moves neither HEAD nor the file\'s staged state, keeping the pages loaded', async () => {
    const { scmApi, timeline } = await setup(async (request) => (request.cursor === undefined ? page(0, 'c1') : page(3)));
    await timeline.mock.results[0]!.value;
    const calls = timeline.mock.calls.length;
    scmApi.pushSnapshot(snapshot(2));
    scmApi.pushSnapshot(snapshot(3, { groups: { merge: [], index: [], workingTree: [{ ...staged, path: 'other.txt', status: 'MODIFIED' }], untracked: [] } }));
    await flushPromises();
    expect(timeline.mock.calls.length).toBe(calls);
  });

  it('leads with Staged Changes as the file enters the index, with no git read', async () => {
    const { scmApi, wrapper, timeline } = await setup(async () => page(0));
    const calls = timeline.mock.calls.length;
    scmApi.pushSnapshot(snapshot(2, { groups: { merge: [], index: [staged], workingTree: [], untracked: [] } }));
    await flushPromises();
    expect(timeline.mock.calls.length).toBe(calls);
    expect(wrapper.find('[data-testid="timeline-staged"]').exists()).toBe(true);
  });

  it('reads the first page again once HEAD moves, after a Load more still running', async () => {
    let finishMore: (result: ScmTimelineResult) => void = () => undefined;
    const { scmApi, wrapper, timeline } = await setup((request) => (request.cursor === undefined ? Promise.resolve(page(0, 'c1')) : new Promise((resolve) => { finishMore = resolve; })));
    await wrapper.get('[data-testid="timeline-more"]').trigger('click');
    scmApi.pushSnapshot(snapshot(2, { commit: { hash: 'h2', subject: 'new' } }));
    await flushPromises();
    const firstPages = (): number => timeline.mock.calls.filter(([request]) => request.cursor === undefined).length;
    expect(firstPages()).toBe(1);
    finishMore(page(3));
    await flushPromises();
    expect(firstPages()).toBe(2);
  });
});
