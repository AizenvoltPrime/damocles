// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmChange, ScmRepoSnapshot, ScmUpstream, ScmView } from '../../preload/scm-channels';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE, type ScmStore } from '../scm/scm-store';
import ScmSection from '../scm/ScmSection.vue';
import SyncButton from '../scm/SyncButton.vue';
import { FakeResizeObserver, fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS, type FakeScmApi, type FakeShellApi } from './fakes';

const ORIGIN_MAIN: ScmUpstream = { remote: 'origin', branch: 'main', ahead: 0, behind: 0 };

const snapshot = (extra: Partial<ScmRepoSnapshot> = {}): ScmRepoSnapshot => ({
  repoId: 'r1',
  projectKey: 'p1',
  head: { type: 'branch', name: 'main' },
  commit: { hash: 'h1', subject: 'Initial commit' },
  operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [] },
  tooManyChanges: false,
  busy: false,
  upstream: ORIGIN_MAIN,
  remotes: ['origin'],
  running: null,
  lastRemote: null,
  revision: 0,
  ...extra,
});

const view = (repoIds: readonly string[] = ['r1']): ScmView => ({
  projectKey: 'p1',
  state: 'ready',
  repos: repoIds.map((repoId) => ({ repoId, label: repoId, displayPath: repoId, kind: 'nested' as const, root: `/w/alpha/${repoId}` })),
  selectedRepoId: repoIds[0]!,
  closedCount: 0,
  unsafePaths: [],
  parentCount: 0,
});

const change = (path: string): ScmChange => ({ path, status: 'MODIFIED', letter: 'M', tone: 'modified', strike: false });

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

async function storeWith(snapshots: readonly ScmRepoSnapshot[], repoIds: readonly string[] = ['r1'], settings = SCM_SETTINGS): Promise<{ scm: FakeScmApi; store: ScmStore }> {
  const scm = fakeScmApi({ views: [view(repoIds)], snapshots, decorations: [], settings, clone: NO_CLONE });
  const store = createScmStore(scm);
  await store.start();
  return { scm, store };
}

async function mountSync(current: ScmRepoSnapshot, committing = false) {
  const { scm, store } = await storeWith([current]);
  const wrapper = mount(SyncButton, { props: { snapshot: current, committing }, global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, scm, button: () => wrapper.get('[data-testid="scm-sync"]') };
}

// transitions: run the real <Transition>s, whose hooks a test needs, rather than test-utils' stubs
async function mountSection(snapshots: readonly ScmRepoSnapshot[], settings = SCM_SETTINGS, transitions = false): Promise<{ wrapper: VueWrapper; scm: FakeScmApi; shell: FakeShellApi; store: ScmStore }> {
  const { scm, store } = await storeWith(snapshots, snapshots.map((each) => each.repoId), settings);
  const shell = fakeShellApi();
  const wrapper = mount(ScmSection, {
    props: { api: shell, projectKey: 'p1', projectName: 'alpha', platform: 'win32', viewMode: 'list', sortKey: 'path', collapsed: false },
    global: { plugins: [shellI18n], provide: { [SCM_STORE]: store }, ...(transitions ? { stubs: { transition: false } } : {}) },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, scm, shell, store };
}

describe('the sync button', () => {
  it('publishes a branch without an upstream, labelled Publish with VS Code\'s Publish Branch name', async () => {
    const { button, scm } = await mountSync(snapshot({ upstream: null }));
    expect(button().attributes()).toMatchObject({ 'data-mode': 'publish', 'aria-label': 'Publish Branch', title: 'Publish Branch' });
    expect(button().get('[data-testid="scm-sync-label"]').text()).toBe('Publish');
    await button().trigger('click');
    expect(scm.run).toHaveBeenCalledWith({ op: 'publish', repoId: 'r1' });
  });

  it("shows behind↓ then ahead↑, titled with VS Code's sync tooltip, and syncs without forcing a rebase", async () => {
    const both = await mountSync(snapshot({ upstream: { ...ORIGIN_MAIN, behind: 2, ahead: 1 } }));
    expect(both.button().get('[data-testid="scm-sync-label"]').text()).toBe('2↓1↑');
    expect(both.button().attributes('aria-label')).toBe('Pull 2 and push 1 commits between origin/main');
    await both.button().trigger('click');
    expect(both.scm.run).toHaveBeenCalledWith({ op: 'sync', repoId: 'r1', rebase: false });
    expect((await mountSync(snapshot({ upstream: { ...ORIGIN_MAIN, ahead: 3 } }))).button().attributes('aria-label')).toBe('Push 3 commits to origin/main');
    expect((await mountSync(snapshot({ upstream: { ...ORIGIN_MAIN, behind: 4 } }))).button().attributes('aria-label')).toBe('Pull 4 commits from origin/main');
    expect((await mountSync(snapshot())).button().attributes('aria-label')).toBe('Synchronize Changes');
  });

  it('words the sync tooltip for one commit in the singular, in English and Greek', async () => {
    const tooltips = async (): Promise<string[]> => Promise.all([{ behind: 1 }, { ahead: 1 }, { behind: 1, ahead: 1 }, { behind: 2, ahead: 1 }].map(
      async (counts) => (await mountSync(snapshot({ upstream: { ...ORIGIN_MAIN, ...counts } }))).button().attributes('aria-label')!,
    ));
    expect(await tooltips()).toEqual([
      'Pull 1 commit from origin/main', 'Push 1 commit to origin/main', 'Pull 1 and push 1 commit between origin/main', 'Pull 2 and push 1 commits between origin/main',
    ]);
    shellI18n.global.locale.value = 'el';
    expect(await tooltips()).toEqual([
      'Έλξη 1 υποβολής από origin/main', 'Ώθηση 1 υποβολής στο origin/main', 'Έλξη 1 και ώθηση 1 υποβολής με το origin/main', 'Έλξη 2 και ώθηση 1 υποβολών με το origin/main',
    ]);
  });

  it('spins and refuses a click while a remote operation runs, and while a commit runs', async () => {
    const running = await mountSync(snapshot({ running: 'pull', upstream: { ...ORIGIN_MAIN, behind: 1 } }));
    expect(running.button().attributes()).toMatchObject({ 'aria-busy': 'true', 'aria-disabled': 'true', title: 'Synchronizing Changes…', 'data-running': 'pull' });
    expect(running.button().find('.d-spinning').exists()).toBe(true);
    await running.button().trigger('click');
    expect(running.scm.run).not.toHaveBeenCalled();
    const committing = await mountSync(snapshot(), true);
    expect(committing.button().attributes()).toMatchObject({ 'aria-disabled': 'true', title: 'Committing Changes…' });
  });

  it('offers no command on a detached HEAD or an unborn branch, shows it disabled and says why', async () => {
    const cases = [
      [snapshot({ head: { type: 'detached', commit: 'abc1234' }, upstream: null }), 'A detached HEAD has no branch to synchronize'],
      [snapshot({ head: { type: 'unborn', name: 'main' }, commit: null, upstream: null }), 'The branch has no commits to synchronize yet'],
    ] as const;
    for (const [current, reason] of cases) {
      const { button, scm } = await mountSync(current);
      expect(button().attributes()).toMatchObject({ 'data-mode': 'none', 'aria-disabled': 'true', 'aria-label': reason, title: reason });
      expect(button().classes()).toContain('opacity-50');
      expect(button().find('[data-testid="scm-sync-label"]').exists()).toBe(false);
      await button().trigger('click');
      expect(scm.run).not.toHaveBeenCalled();
    }
    // running and committing keep their full look
    expect((await mountSync(snapshot(), true)).button().classes()).not.toContain('opacity-50');
  });

  it('rolls a changed count and lights the arrow whose count grew, but not for another repository', async () => {
    const { wrapper } = await mountSync(snapshot({ upstream: { ...ORIGIN_MAIN, behind: 1 } }));
    expect(wrapper.findAll('[data-testid="scm-sync-pulse"]')).toHaveLength(0);
    await wrapper.setProps({ snapshot: snapshot({ upstream: { ...ORIGIN_MAIN, behind: 3 } }) });
    expect(wrapper.get('[data-testid="scm-sync-behind"]').text()).toBe('3');
    expect(wrapper.findAll('[data-testid="scm-sync-pulse"]').map((pulse) => pulse.text())).toEqual(['↓']);
    // the glow leaves once it has faded, so a count here says what is lit now
    wrapper.get('[data-testid="scm-sync-pulse"]').element.dispatchEvent(new Event('animationend'));
    await flushPromises();
    expect(wrapper.findAll('[data-testid="scm-sync-pulse"]')).toHaveLength(0);
    await wrapper.setProps({ snapshot: snapshot({ repoId: 'r2', upstream: { ...ORIGIN_MAIN, behind: 4, ahead: 5 } }) });
    expect(wrapper.findAll('[data-testid="scm-sync-pulse"]')).toHaveLength(0);
  });

  it("rolls another repository's counts the way they moved, not the way the last repository's did", async () => {
    const { store } = await storeWith([snapshot()]);
    const wrapper = mount(SyncButton, {
      props: { snapshot: snapshot({ upstream: { ...ORIGIN_MAIN, behind: 3 } }), committing: false },
      global: { plugins: [shellI18n], provide: { [SCM_STORE]: store }, stubs: { transition: false } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    await wrapper.setProps({ snapshot: snapshot({ upstream: { ...ORIGIN_MAIN, behind: 1 } }) });
    expect(wrapper.find('.t-swap-down-leave-active').text()).toBe('3');
    await flushPromises();
    await wrapper.setProps({ snapshot: snapshot({ repoId: 'r2', upstream: { ...ORIGIN_MAIN, behind: 5 } }) });
    const leaving = wrapper.findAll('[aria-hidden="true"]').filter((each) => each.text() === '1');
    expect(leaving.map((each) => each.classes().filter((name) => name.endsWith('leave-active')))).toEqual([['t-swap-leave-active']]);
  });

  it('keeps the test id on the live number only while a swapped count or label leaves, the leaving copy hidden from AT', async () => {
    const { scm, store } = await storeWith([snapshot()]);
    const current = snapshot({ upstream: { ...ORIGIN_MAIN, behind: 0 } });
    const wrapper = mount(SyncButton, { props: { snapshot: current, committing: false }, global: { plugins: [shellI18n], provide: { [SCM_STORE]: store }, stubs: { transition: false } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    await wrapper.setProps({ snapshot: snapshot({ upstream: { ...ORIGIN_MAIN, behind: 1 } }) });
    const live = wrapper.findAll('[data-testid="scm-sync-behind"]');
    expect(live.map((each) => each.text())).toEqual(['1']);
    const leaving = wrapper.findAll('.t-swap-leave-active');
    expect(leaving.map((each) => [each.text(), each.attributes('aria-hidden'), each.attributes('data-testid')])).toEqual([['0', 'true', undefined]]);
    await wrapper.setProps({ snapshot: snapshot({ upstream: null }) });
    expect(wrapper.findAll('[data-testid="scm-sync-label"]').map((each) => each.text())).toEqual(['Publish']);
    expect(scm.run).not.toHaveBeenCalled();
  });

  it('coasts the arrows to their next full turn as the spin ends, and stays still under reduced motion', async () => {
    const { wrapper } = await mountSync(snapshot({ running: 'sync' }));
    const spinner = (): HTMLElement => wrapper.get('[data-testid="scm-sync"] > span').element as HTMLElement;
    const transform = vi.spyOn(window, 'getComputedStyle').mockReturnValue({ transform: 'matrix(0, 1, -1, 0, 0, 0)' } as CSSStyleDeclaration);
    await wrapper.setProps({ snapshot: snapshot() });
    expect(spinner().classList.contains('d-settle')).toBe(true);
    expect(spinner().style.getPropertyValue('--settle-from')).toBe('90deg');
    expect(spinner().style.getPropertyValue('--settle-time')).toBe('0.9s');
    // the icon's own swap ends first and bubbles; only the spinner's coast ends the settle
    spinner().firstElementChild!.dispatchEvent(new Event('animationend', { bubbles: true }));
    await flushPromises();
    expect(spinner().classList.contains('d-settle')).toBe(true);
    spinner().dispatchEvent(new Event('animationend'));
    await flushPromises();
    expect(spinner().className).not.toContain('d-settle');
    // reduced motion ends the spin at once, so no angle is left to settle from
    await wrapper.setProps({ snapshot: snapshot({ running: 'sync' }) });
    transform.mockReturnValue({ transform: 'none' } as CSSStyleDeclaration);
    await wrapper.setProps({ snapshot: snapshot() });
    expect(spinner().className).not.toContain('d-settle');
    expect(spinner().className).not.toContain('d-spinning');
  });

  it('sits beside the branch in the branch row only while the repository has a remote, the branch marked local until published', async () => {
    const tracking = (await mountSection([snapshot()])).wrapper;
    expect(tracking.get('[data-testid="scm-branch-row"]').findAll('[data-testid]').map((each) => each.attributes('data-testid')).filter((id) => id === 'scm-branch' || id === 'scm-sync')).toEqual(['scm-branch', 'scm-sync']);
    expect(tracking.get('[data-testid="scm-branch"]').attributes('title')).toBe('Checkout to... (tracking origin/main)');
    expect(tracking.find('[data-testid="scm-branch-local"]').exists()).toBe(false);
    const local = (await mountSection([snapshot({ remotes: [], upstream: null })])).wrapper;
    expect(local.get('[data-testid="scm-branch"]').text()).toBe('mainlocal');
    expect(local.get('[data-testid="scm-branch"]').attributes('title')).toBe('Checkout to... (not published yet)');
    expect(local.find('[data-testid="scm-sync"]').exists()).toBe(false);
  });
});

describe('the progress row', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  const rows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="scm-progress"]');

  it('labels each remote operation as AD4 does, after a short delay, and its Cancel cancels that repository\'s operation', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    for (const [op, label] of [['fetch', 'Fetching…'], ['pull', 'Pulling…'], ['push', 'Pushing…'], ['sync', 'Syncing…']] as const) {
      scm.pushSnapshot(snapshot({ running: op }));
      await flushPromises();
      await flushPromises();
      expect(rows(wrapper)).toHaveLength(0);
      vi.advanceTimersByTime(150);
      await flushPromises();
      const label_ = wrapper.get('[data-testid="scm-progress-label"]');
      expect(label_.text()).toBe(label);
      expect(label_.attributes('role')).toBeUndefined();
      expect(label_.attributes('aria-live')).toBeUndefined();
      expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({ 'aria-labelledby': label_.attributes('id') });
      expect(wrapper.get('[role="progressbar"]').attributes('aria-label')).toBeUndefined();
      expect(wrapper.get('[data-testid="scm-progress-cancel"]').attributes('aria-describedby')).toBe(label_.attributes('id'));
      scm.pushSnapshot(snapshot());
      await flushPromises();
      await flushPromises();
      vi.advanceTimersByTime(1500);
      await flushPromises();
      expect(rows(wrapper)).toHaveLength(0);
    }
    scm.pushSnapshot(snapshot({ running: 'pull' }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    const cancel = wrapper.get('[data-testid="scm-progress-cancel"]');
    expect(cancel.text()).toBe('Cancel');
    (cancel.element as HTMLElement).focus();
    await cancel.trigger('click');
    await cancel.trigger('click');
    expect(scm.run).toHaveBeenCalledTimes(1);
    expect(scm.run).toHaveBeenCalledWith({ op: 'cancel', repoId: 'r1' });
    // marked, not disabled, so the focus it holds stays
    expect(cancel.attributes('aria-disabled')).toBe('true');
    expect(cancel.attributes('disabled')).toBeUndefined();
    expect(document.activeElement).toBe(cancel.element);
  });

  it('announces in one live region, there before any text, when a row shows and how it ended', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    const status = () => wrapper.get('[data-testid="scm-progress-status"]');
    expect(status().attributes()).toMatchObject({ role: 'status', 'aria-live': 'polite' });
    expect(status().text()).toBe('');
    const run = async (op: 'fetch' | 'push', outcome: 'ok' | 'failed' | 'cancelled', seq: number): Promise<string[]> => {
      const heard: string[] = [];
      scm.pushSnapshot(snapshot({ running: op, lastRemote: seq > 1 ? { op, outcome: 'ok', stashKept: false, seq: seq - 1 } : null }));
      await flushPromises();
      vi.advanceTimersByTime(150);
      await flushPromises();
      heard.push(status().text());
      scm.pushSnapshot(snapshot({ lastRemote: { op, outcome, stashKept: false, seq } }));
      await flushPromises();
      heard.push(status().text());
      vi.advanceTimersByTime(1500);
      await flushPromises();
      return heard;
    };
    expect(await run('fetch', 'ok', 1)).toEqual(['Fetching…', 'Fetch finished']);
    expect(await run('push', 'failed', 2)).toEqual(['Pushing…', 'Push failed']);
    expect(await run('fetch', 'cancelled', 3)).toEqual(['Fetching…', 'Fetch cancelled']);
    expect(wrapper.findAll('[data-testid="scm-progress-status"]')).toHaveLength(1);

    scm.pushClone({ running: { name: 'acme-api' }, last: null });
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    expect(status().text()).toBe('Cloning acme-api…');
    scm.pushClone({ running: null, last: { outcome: 'ok', seq: 1 } });
    await flushPromises();
    expect(status().text()).toBe('Cloned acme-api');
  });

  it('says nothing for an operation whose row never showed', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    scm.pushSnapshot(snapshot({ running: 'fetch' }));
    await flushPromises();
    vi.advanceTimersByTime(100);
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'fetch', outcome: 'ok', stashKept: false, seq: 1 } }));
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-progress-status"]').text()).toBe('');
  });

  it("puts focus back in the tree when the row whose Cancel holds it ends", async () => {
    const { wrapper, scm } = await mountSection([snapshot({ groups: { merge: [], index: [], workingTree: [change('a.ts')], untracked: [] } })], SCM_SETTINGS, true);
    scm.pushSnapshot(snapshot({ running: 'fetch', groups: { merge: [], index: [], workingTree: [change('a.ts')], untracked: [] } }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    const cancel = wrapper.get('[data-testid="scm-progress-cancel"]');
    (cancel.element as HTMLElement).focus();
    await cancel.trigger('click');
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'fetch', outcome: 'cancelled', stashKept: false, seq: 1 }, groups: { merge: [], index: [], workingTree: [change('a.ts')], untracked: [] } }));
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-row-key')).toBe('group:workingTree');

    // a row that finished keeps showing its check, but its Cancel goes
    scm.pushSnapshot(snapshot({ running: 'fetch', lastRemote: { op: 'fetch', outcome: 'cancelled', stashKept: false, seq: 1 }, groups: { merge: [], index: [], workingTree: [change('a.ts')], untracked: [] } }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    (wrapper.get('[data-testid="scm-progress-cancel"]').element as HTMLElement).focus();
    (wrapper.get('[data-row-key="workingTree:a.ts"]').element as HTMLElement).dispatchEvent(new Event('focus'));
    (wrapper.get('[data-testid="scm-progress-cancel"]').element as HTMLElement).focus();
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'fetch', outcome: 'ok', stashKept: false, seq: 2 }, groups: { merge: [], index: [], workingTree: [change('a.ts')], untracked: [] } }));
    await flushPromises();
    expect(wrapper.get('[data-testid="scm-progress"]').attributes('data-phase')).toBe('done');
    expect(document.activeElement?.getAttribute('data-row-key')).toBe('workingTree:a.ts');
  });

  it('takes the test id and the status off a row as it leaves', async () => {
    const { scm, store } = await storeWith([snapshot()]);
    const wrapper = mount(ScmSection, {
      props: { api: fakeShellApi(), projectKey: 'p1', projectName: 'alpha', platform: 'win32', viewMode: 'list', sortKey: 'path', collapsed: false },
      global: { plugins: [shellI18n], provide: { [SCM_STORE]: store }, stubs: { transition: false } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    scm.pushSnapshot(snapshot({ running: 'fetch' }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(1);
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'fetch', outcome: 'cancelled', stashKept: false, seq: 1 } }));
    await nextTick();
    await nextTick();
    const leaving = wrapper.get('.t-progress-leave-active');
    expect(leaving.attributes('aria-hidden')).toBe('true');
    // its label's id goes too, so no id names two elements while a new row with that slot enters
    expect(leaving.find('[id]').exists()).toBe(false);
    expect(rows(wrapper)).toHaveLength(0);
  });

  it('never shows a row for an operation shorter than the delay', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    scm.pushSnapshot(snapshot({ running: 'fetch' }));
    await flushPromises();
    await flushPromises();
    vi.advanceTimersByTime(100);
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'fetch', outcome: 'ok', stashKept: false, seq: 1 } }));
    await flushPromises();
    await flushPromises();
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
  });

  it('holds a check after main says the operation succeeded, a danger tint after it failed, and nothing after a cancel', async () => {
    const { wrapper, scm } = await mountSection([snapshot({ lastRemote: { op: 'fetch', outcome: 'failed', stashKept: false, seq: 4 } })]);
    const runThen = async (outcome: 'ok' | 'failed' | 'cancelled', seq: number): Promise<void> => {
      scm.pushSnapshot(snapshot({ running: 'push', lastRemote: { op: 'fetch', outcome: 'failed', stashKept: false, seq: seq - 1 } }));
      await flushPromises();
      vi.advanceTimersByTime(150);
      await flushPromises();
      scm.pushSnapshot(snapshot({ lastRemote: { op: 'push', outcome, stashKept: false, seq } }));
      await flushPromises();
      await flushPromises();
    };
    await runThen('ok', 5);
    expect(rows(wrapper).map((row) => row.attributes('data-phase'))).toEqual(['done']);
    expect(wrapper.find('[data-testid="scm-progress-cancel"]').exists()).toBe(false);
    vi.advanceTimersByTime(900);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
    await runThen('failed', 6);
    expect(rows(wrapper).map((row) => row.attributes('data-phase'))).toEqual(['failed']);
    vi.advanceTimersByTime(1400);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
    await runThen('cancelled', 7);
    expect(rows(wrapper)).toHaveLength(0);
  });

  it('holds a warning tint after a pull that went through but kept the stash, and says where the changes are', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    const status = () => wrapper.get('[data-testid="scm-progress-status"]');
    const runThen = async (op: 'pull' | 'sync', outcome: 'ok' | 'failed' | 'cancelled', seq: number): Promise<void> => {
      scm.pushSnapshot(snapshot({ running: op, lastRemote: seq > 1 ? { op, outcome: 'ok', stashKept: false, seq: seq - 1 } : null }));
      await flushPromises();
      vi.advanceTimersByTime(150);
      await flushPromises();
      scm.pushSnapshot(snapshot({ lastRemote: { op, outcome, stashKept: true, seq } }));
      await flushPromises();
      await flushPromises();
    };
    await runThen('pull', 'ok', 1);
    expect(rows(wrapper).map((row) => row.attributes('data-phase'))).toEqual(['warning']);
    expect(status().text()).toBe('Pull finished. Your changes could not be applied back and are kept in the stash list');
    // as long as a failure, since it asks the user to act
    vi.advanceTimersByTime(900);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(1);
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);

    await runThen('sync', 'failed', 2);
    expect(rows(wrapper).map((row) => row.attributes('data-phase'))).toEqual(['failed']);
    expect(status().text()).toBe('Sync stopped before pushing. Your changes could not be applied back and are kept in the stash list');
    vi.advanceTimersByTime(1400);
    await flushPromises();

    await runThen('pull', 'cancelled', 3);
    expect(rows(wrapper)).toHaveLength(0);
    expect(status().text()).toBe('Pull cancelled. Your changes could not be applied back and are kept in the stash list');
  });

  it('waits for an outcome that arrives after the operation ends, and leaves without one if none comes', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    scm.pushSnapshot(snapshot({ running: 'sync' }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    scm.pushSnapshot(snapshot());
    await flushPromises();
    await flushPromises();
    expect(rows(wrapper).map((row) => row.attributes('data-phase'))).toEqual(['running']);
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'sync', outcome: 'ok', stashKept: false, seq: 1 } }));
    await flushPromises();
    await flushPromises();
    expect(rows(wrapper).map((row) => row.attributes('data-phase'))).toEqual(['done']);
    vi.advanceTimersByTime(900);
    scm.pushSnapshot(snapshot({ running: 'sync', lastRemote: { op: 'sync', outcome: 'ok', stashKept: false, seq: 1 } }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'sync', outcome: 'ok', stashKept: false, seq: 1 } }));
    await flushPromises();
    await flushPromises();
    vi.advanceTimersByTime(1500);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
  });

  it('shows the clone by its folder name, whatever repository is shown, and Cancel cancels the clone', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    scm.pushClone({ running: { name: 'acme-api' }, last: null });
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    expect(rows(wrapper).map((row) => [row.attributes('data-kind'), row.get('[data-testid="scm-progress-label"]').text()])).toEqual([['clone', 'Cloning acme-api…']]);
    await wrapper.get('[data-testid="scm-progress-cancel"]').trigger('click');
    expect(scm.run).toHaveBeenCalledWith({ op: 'cancelClone' });
    scm.pushClone({ running: null, last: { outcome: 'cancelled', seq: 1 } });
    await flushPromises();
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
  });

  it("drops another repository's row on a repository switch, and shows none for its operation", async () => {
    const { wrapper, scm } = await mountSection([snapshot(), snapshot({ repoId: 'r2' })]);
    scm.pushSnapshot(snapshot({ running: 'fetch' }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    expect(rows(wrapper).map((row) => row.attributes('data-kind'))).toEqual(['fetch']);
    scm.pushView({ ...view(['r1', 'r2']), selectedRepoId: 'r2' });
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
    vi.advanceTimersByTime(1500);
    scm.pushSnapshot(snapshot({ lastRemote: { op: 'fetch', outcome: 'ok', stashKept: false, seq: 1 } }));
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(0);
  });

  it('glides what follows by both rows when the clone row and the operation row come in one patch', async () => {
    const { wrapper, scm } = await mountSection([snapshot()], SCM_SETTINGS, true);
    // happy-dom lays nothing out: an in-flow progress row is 32px tall, pushing every later sibling down
    const inFlowRow = (element: Element): boolean => element.querySelector(':scope > .d-progress-card') !== null && !element.classList.contains('t-progress-leave-active');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      let top = 0;
      for (let previous = this.previousElementSibling; previous; previous = previous.previousElementSibling) if (inFlowRow(previous)) top += 32;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    scm.pushClone({ running: { name: 'zeta' }, last: null });
    scm.pushSnapshot(snapshot({ running: 'fetch' }));
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    expect(rows(wrapper)).toHaveLength(2);
    const content = wrapper.get('[data-testid="scm-progress-status"]').element.parentElement!.lastElementChild as HTMLElement;
    expect(content.classList.contains('d-shift')).toBe(true);
    expect(content.style.getPropertyValue('--shift')).toBe('-64px');
  });

  it('keeps the clone row and the operation row apart, the clone first', async () => {
    const { wrapper, scm } = await mountSection([snapshot()]);
    scm.pushSnapshot(snapshot({ running: 'fetch' }));
    await flushPromises();
    scm.pushClone({ running: { name: 'zeta' }, last: null });
    await flushPromises();
    vi.advanceTimersByTime(150);
    await flushPromises();
    expect(rows(wrapper).map((row) => row.attributes('data-kind'))).toEqual(['clone', 'fetch']);
  });
});

describe('the source control requests', () => {
  it('sends Commit & Push and Commit & Sync with postCommit, and a plain commit without it', async () => {
    const { wrapper, scm, shell } = await mountSection([snapshot({ groups: { merge: [], index: [change('a.ts')], workingTree: [], untracked: [] } })]);
    await wrapper.get('[data-testid="scm-commit-message"]').setValue('Ship it');
    for (const [itemId, postCommit] of [['commitPush', 'push'], ['commitSync', 'sync']] as const) {
      shell.answerNext({ kind: 'menu', itemId });
      await wrapper.get('[data-testid="scm-commit-menu"]').trigger('click');
      await flushPromises();
      expect(scm.commit).toHaveBeenLastCalledWith({ repoId: 'r1', message: expect.any(String), variant: { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false }, postCommit });
    }
    await wrapper.get('[data-testid="scm-commit"]').trigger('click');
    await flushPromises();
    expect(Object.keys(vi.mocked(scm.commit).mock.lastCall![0])).toEqual(['repoId', 'message', 'variant']);
  });

  it('puts Publish Branch in place of the commit button on an unpublished branch with nothing to commit', async () => {
    const { wrapper, scm } = await mountSection([snapshot({ upstream: null })]);
    const publish = wrapper.get('[data-testid="scm-publish"]');
    expect(publish.text()).toBe('Publish Branch');
    expect(publish.attributes('title')).toBe('Publish Branch "main"');
    expect(wrapper.find('[data-testid="scm-commit-split"]').exists()).toBe(false);
    await publish.trigger('click');
    expect(scm.run).toHaveBeenCalledWith({ op: 'publish', repoId: 'r1' });
    const changed = await mountSection([snapshot({ upstream: null, groups: { merge: [], index: [], workingTree: [change('a.ts')], untracked: [] } })]);
    expect(changed.wrapper.find('[data-testid="scm-publish"]').exists()).toBe(false);
  });

  it("spins Publish only for a publish it started, and holds it while any remote operation runs", async () => {
    const { wrapper, scm } = await mountSection([snapshot({ upstream: null })]);
    const publish = () => wrapper.get('[data-testid="scm-publish"]');
    // Push Tags runs as push too: busy, but no publish of this button's
    for (const running of ['push', 'fetch'] as const) {
      scm.pushSnapshot(snapshot({ upstream: null, running }));
      await flushPromises();
      expect(publish().attributes(), running).toMatchObject({ 'aria-disabled': 'true', title: 'Synchronizing Changes…' });
      expect(publish().attributes('aria-busy'), running).toBeUndefined();
      expect(publish().find('.d-spinning').exists(), running).toBe(false);
      await publish().trigger('click');
      expect(scm.run, running).not.toHaveBeenCalled();
    }

    let reply!: (value: { ok: true }) => void;
    vi.mocked(scm.run).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    scm.pushSnapshot(snapshot({ upstream: null }));
    await flushPromises();
    expect(publish().attributes('aria-disabled')).toBeUndefined();
    await publish().trigger('click');
    expect(scm.run).toHaveBeenCalledWith({ op: 'publish', repoId: 'r1' });
    // waiting on main's remote pick: held, no spinner until the push runs
    expect(publish().attributes('aria-disabled')).toBe('true');
    expect(publish().find('.d-spinning').exists()).toBe(false);
    scm.pushSnapshot(snapshot({ upstream: null, running: 'push' }));
    await flushPromises();
    expect(publish().attributes()).toMatchObject({ 'aria-busy': 'true', 'aria-disabled': 'true', title: 'Publishing Branch "main"…' });
    expect(publish().find('.d-spinning').exists()).toBe(true);
    await publish().trigger('click');
    expect(scm.run).toHaveBeenCalledTimes(1);
    reply({ ok: true });
    scm.pushSnapshot(snapshot({ upstream: null }));
    await flushPromises();
    expect(publish().attributes('aria-busy')).toBeUndefined();
    expect(publish().attributes('aria-disabled')).toBeUndefined();
  });

  it('moves focus between Publish and the commit button as one replaces the other, the leaving copy without its test ids', async () => {
    const staged = { merge: [], index: [change('a.ts')], workingTree: [], untracked: [] };
    const { wrapper, scm } = await mountSection([snapshot({ upstream: null, groups: staged })], SCM_SETTINGS, true);
    (wrapper.get('[data-testid="scm-commit"]').element as HTMLElement).focus();
    scm.pushSnapshot(snapshot({ upstream: null }));
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="scm-publish"]').element);
    const leaving = wrapper.get('.t-morph-leave-active');
    expect(leaving.attributes()).toMatchObject({ 'aria-hidden': 'true' });
    expect(leaving.attributes('data-testid')).toBeUndefined();
    expect(leaving.find('[data-testid]').exists()).toBe(false);

    scm.pushSnapshot(snapshot({ upstream: null, groups: staged }));
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="scm-commit"]').element);
    // a swap the user was not on leaves focus where it is
    (wrapper.get('[data-testid="scm-commit-message"]').element as HTMLElement).focus();
    scm.pushSnapshot(snapshot({ upstream: null }));
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="scm-commit-message"]').element);
  });

  it('runs each Pull, Push and Remote item as its request, the force variants only while allowed', async () => {
    const { wrapper, scm, shell } = await mountSection([snapshot()], { ...SCM_SETTINGS, allowForcePush: true });
    const expected = {
      sync: { op: 'sync', repoId: 'r1', rebase: false },
      syncRebase: { op: 'sync', repoId: 'r1', rebase: true },
      pull: { op: 'pull', repoId: 'r1', rebase: false },
      pullRebase: { op: 'pull', repoId: 'r1', rebase: true },
      pullFrom: { op: 'pullFrom', repoId: 'r1' },
      push: { op: 'push', repoId: 'r1', to: false, force: false, followTags: false },
      pushForce: { op: 'push', repoId: 'r1', to: false, force: true, followTags: false },
      pushTo: { op: 'push', repoId: 'r1', to: true, force: false, followTags: false },
      pushToForce: { op: 'push', repoId: 'r1', to: true, force: true, followTags: false },
      fetch: { op: 'fetch', repoId: 'r1', scope: 'default' },
      fetchPrune: { op: 'fetch', repoId: 'r1', scope: 'prune' },
      fetchAll: { op: 'fetch', repoId: 'r1', scope: 'all' },
      addRemote: { op: 'addRemote', repoId: 'r1' },
      removeRemote: { op: 'removeRemote', repoId: 'r1' },
      clone: { op: 'clone', recursive: false },
    };
    for (const [action, request] of Object.entries(expected)) {
      // the items More Actions also lists at its top level are answered from there, the rest from Pull, Push ›
      const itemId = ['pull', 'push', 'fetch', 'clone', 'addRemote', 'removeRemote'].includes(action) ? action : `pullPush:${action}`;
      shell.answerNext({ kind: 'menu', itemId });
      await wrapper.get('[data-testid="scm-more-actions"]').trigger('click');
      await flushPromises();
      expect(scm.run, action).toHaveBeenLastCalledWith(request);
    }
    const pullPush = shell.overlayRequests.at(-1);
    const items = pullPush?.kind === 'menu' ? pullPush.items : [];
    expect(JSON.stringify(items)).toContain('"pullPush:pushForce"');
  });

  it('offers Clone Repository beside Initialize Repository when the project has no repository', async () => {
    const scm = fakeScmApi({ views: [{ ...view(), state: 'noRepository', repos: [], selectedRepoId: null }], snapshots: [], decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE });
    const store = createScmStore(scm);
    await store.start();
    const wrapper = mount(ScmSection, {
      props: { api: fakeShellApi(), projectKey: 'p1', projectName: 'alpha', platform: 'win32', viewMode: 'list', sortKey: 'path', collapsed: false },
      global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    const clone = wrapper.get('[data-testid="scm-state-secondary"]');
    expect(clone.text()).toBe('Clone Repository');
    await clone.trigger('click');
    expect(scm.run).toHaveBeenCalledWith({ op: 'clone', recursive: false });
  });
});
