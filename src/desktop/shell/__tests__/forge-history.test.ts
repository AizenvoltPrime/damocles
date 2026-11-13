// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ScmBlameCommit, ScmHistoryCommit, ScmHistoryLoad, ScmHistoryResult, ScmRepoSnapshot, ScmView } from '../../preload/scm-channels';
import type { HistoryForgeContext } from '../../../shared/forge/history';
import ForgeAvatar from '@/components/settings/forge/ForgeAvatar.vue';
import { shellI18n } from '../i18n';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import GraphSection from '../graph/GraphSection.vue';
import BlameCard from '../editor/BlameCard.vue';
import { avatarBatches, createAvatarAsks } from '../forge/history-view';
import { FakeResizeObserver, fakeScmApi, fakeShellApi, NO_CLONE, SCM_SETTINGS, type FakeScmApi, type FakeShellApi } from './fakes';

// History details: author avatars in the Graph and blame, references as links, and "Merged in !45".

const hash = (n: number): string => n.toString(16).padStart(40, '0');
const NOW = Date.UTC(2026, 0, 10, 12);
const commit = (n: number, author: string, email: string, subject = `Change ${n}`): ScmHistoryCommit =>
  ({ hash: hash(n), parents: n < 9 ? [hash(n + 1)] : [], author, email, authorDate: NOW - n * 60_000, subject, refs: [] });
const LOAD: ScmHistoryLoad = { headRefs: { head: { id: 'refs/heads/main', name: 'main', revision: hash(1) } }, ahead: 0, behind: 0, resolvedRefs: ['refs/heads/main'] };
const PAGE_1 = [commit(1, 'Alexios Stefanopoulos', 'A.Stefanopoulos@indigital.gr', 'Add the account chip to Source Control (#123)'), commit(2, 'Maria K.', 'maria@indigital.gr'), commit(3, 'Alexios Stefanopoulos', 'a.stefanopoulos@indigital.gr')];
const PAGE_2 = [commit(4, 'Maria K.', 'maria@indigital.gr'), commit(5, 'Nikos P.', 'nikos@indigital.gr')];
const GITLAB: HistoryForgeContext = { kind: 'gitlab', serverName: 'gitlab.indigital.gr', showAvatars: true };
const MESSAGE = 'Add the account chip to Source Control (#123)\n\nFollow-up to !45 and damocles/forge#12.';

const ROOT = { repoId: 'r1', label: 'damocles', displayPath: '', kind: 'root' as const, root: '/w/damocles' };
const view: ScmView = { projectKey: 'p1', state: 'ready', repos: [ROOT], selectedRepoId: 'r1', closedCount: 0, unsafePaths: [], parentCount: 0 };
const snapshot: ScmRepoSnapshot = {
  repoId: 'r1', projectKey: 'p1', head: { type: 'branch', name: 'main' }, commit: { hash: hash(1), subject: 'Add the account chip' }, operation: null,
  groups: { merge: [], index: [], workingTree: [], untracked: [] }, tooManyChanges: false, busy: false, upstream: null, remotes: [], running: null, lastRemote: null, revision: 0,
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

function scmWith(...pages: ScmHistoryResult[]): FakeScmApi {
  const scm = fakeScmApi({ views: [view], snapshots: [snapshot], decorations: [], settings: SCM_SETTINGS, clone: NO_CLONE });
  for (const result of pages) vi.mocked(scm.history).mockResolvedValueOnce(result);
  vi.mocked(scm.commitDetails).mockImplementation(async ({ hash: asked }) => ({ ok: true, details: { hash: asked, parents: [], message: MESSAGE, messageTruncated: false, author: 'Alexios Stefanopoulos', email: 'a.stefanopoulos@indigital.gr', authorDate: NOW, files: [], filesTruncated: false } }));
  return scm;
}

async function mountGraph(scm: FakeScmApi, shell: FakeShellApi): Promise<VueWrapper> {
  const store = createScmStore(scm);
  await store.start();
  const wrapper = mount(GraphSection, {
    props: { api: shell, projectKey: 'p1', choices: {}, collapsed: false },
    global: { plugins: [shellI18n], provide: { [SCM_STORE]: store } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const shellWith = (context: HistoryForgeContext | null): FakeShellApi => {
  const shell = fakeShellApi();
  if (context) shell.forge.contexts.set('r1', context);
  shell.forge.avatarKeys.set('a.stefanopoulos@indigital.gr', 'k-alexios');
  return shell;
};
const graphRows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="graph-row"]');
const detail = (wrapper: VueWrapper, kind: string) => wrapper.find(`[data-testid="graph-detail"][data-kind="${kind}"]`);

describe('avatar batching (history-view.ts)', () => {
  it('asks each lower-cased email once, with the oldest commit naming it, in calls of at most 100 authors', () => {
    const asked = new Set<string>();
    const authors = [
      { sha: hash(1), email: 'A.Stef@x.gr', name: 'Alexios' },
      { sha: hash(2), email: 'a.stef@x.gr', name: 'Alexios' },
      { sha: hash(3), email: '', name: 'No email' },
      { sha: hash(4), email: ' a.STEF@x.gr ', name: 'Alexios' },
      { sha: hash(5), email: `${'x'.repeat(320)}@x.gr`, name: 'Too long' },
      ...Array.from({ length: 150 }, (_, index) => ({ sha: hash(10 + index), email: `dev${index}@x.gr`, name: `Dev ${index}` })),
    ];
    const batches = avatarBatches(authors, asked);
    expect(batches.map((batch) => batch.length)).toEqual([100, 51]);
    // the newest commit may not be pushed yet; the last one listed is the likeliest the server knows
    expect(batches[0]![0]).toEqual({ sha: hash(4), email: 'a.STEF@x.gr', name: 'Alexios' });
    expect(avatarBatches([{ sha: hash(9), email: 'DEV3@x.gr', name: 'Dev 3' }, { sha: hash(8), email: ' new@x.gr', name: 'New' }], asked)).toEqual([[{ sha: hash(8), email: 'new@x.gr', name: 'New' }]]);
  });

  it('leaves out an author whose email or name holds NUL, which main would refuse with the whole call, and never cuts a surrogate pair', () => {
    const name = `${'n'.repeat(255)}🦊`;
    const batches = avatarBatches([
      { sha: hash(1), email: 'nul@x.gr', name: 'Bad\0Name' },
      { sha: hash(2), email: 'n\0l@x.gr', name: 'Bad email' },
      { sha: hash(3), email: 'fox@x.gr', name },
    ], new Set());
    expect(batches).toEqual([[{ sha: hash(3), email: 'fox@x.gr', name: 'n'.repeat(255) }]]);
  });

  it('asks an email that got no key, or whose picture failed, once more and then no more', () => {
    const asks = createAvatarAsks();
    const maria = { sha: hash(2), email: 'maria@x.gr', name: 'Maria' };
    const alexios = { sha: hash(1), email: 'a@x.gr', name: 'Alexios' };
    const [first] = asks.batches([alexios, maria]);
    asks.settle(first!, { 'a@x.gr': 'k-a' });
    expect(asks.batches([alexios, maria])).toEqual([[maria]]);
    asks.settle([maria], undefined);
    expect(asks.batches([alexios, maria])).toEqual([]);
    expect(asks.pictureFailed('A@x.gr')).toBe(true);
    expect(asks.batches([alexios, maria])).toEqual([[alexios]]);
    expect(asks.pictureFailed('a@x.gr')).toBe(false);
    expect(asks.batches([alexios, maria])).toEqual([]);
  });
});

describe('Graph avatars', () => {
  it('asks once per page that rendered, for its new authors and once more for one that got no key, and draws each row\'s avatar with the name unchanged', async () => {
    let first!: (result: ScmHistoryResult) => void;
    const scm = scmWith();
    vi.mocked(scm.history)
      .mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
      .mockResolvedValueOnce({ ok: true, page: { commits: PAGE_2, load: LOAD } });
    const shell = shellWith(GITLAB);
    const wrapper = await mountGraph(scm, shell);
    expect(shell.forge.historyContext).toHaveBeenCalledWith('r1');
    expect(shell.forge.authorAvatars).not.toHaveBeenCalled();
    // the first page, short enough that the second loads as its rows end in view
    first({ ok: true, page: { commits: PAGE_1, load: LOAD, cursor: 'c2' } });
    await flushPromises();
    expect(scm.history).toHaveBeenCalledTimes(2);
    // Alexios by his older commit; Maria got no key on the first page, so the second asks for her once more
    expect(vi.mocked(shell.forge.authorAvatars).mock.calls).toEqual([
      ['r1', [{ sha: hash(3), email: 'a.stefanopoulos@indigital.gr', name: 'Alexios Stefanopoulos' }, { sha: hash(2), email: 'maria@indigital.gr', name: 'Maria K.' }]],
      ['r1', [{ sha: hash(4), email: 'maria@indigital.gr', name: 'Maria K.' }, { sha: hash(5), email: 'nikos@indigital.gr', name: 'Nikos P.' }]],
    ]);
    const head = graphRows(wrapper)[0]!;
    expect(head.attributes('aria-label')).toMatch(/^Add the account chip to Source Control \(#123\), Alexios Stefanopoulos, [^,]+, current$/);
    const avatar = head.get('[data-testid="forge-avatar"]');
    expect(avatar.attributes('aria-hidden')).toBe('true');
    expect(avatar.classes()).toContain('@max-[17.5rem]/row:hidden');
    expect(avatar.text()).toBe('A');
    expect(avatar.get('img').attributes('src')).toBe('app://damocles/forge/avatar/k-alexios');
    // Maria has no picture: her initial on the tint, and no image to break
    expect(graphRows(wrapper)[1]!.get('[data-testid="forge-avatar"]').find('img').exists()).toBe(false);
  });

  it('drops a key whose picture fails, showing the initial, and asks for that author once more', async () => {
    const shell = shellWith(GITLAB);
    const wrapper = await mountGraph(scmWith({ ok: true, page: { commits: PAGE_1, load: LOAD } }), shell);
    expect(shell.forge.authorAvatars).toHaveBeenCalledTimes(1);
    await graphRows(wrapper)[0]!.get('[data-testid="forge-avatar"] img').trigger('error');
    await flushPromises();
    // Maria, who got no key the first time, comes along for her one more ask
    expect(vi.mocked(shell.forge.authorAvatars).mock.calls[1]).toEqual(['r1', [{ sha: hash(3), email: 'a.stefanopoulos@indigital.gr', name: 'Alexios Stefanopoulos' }, { sha: hash(2), email: 'maria@indigital.gr', name: 'Maria K.' }]]);
    expect(graphRows(wrapper)[0]!.get('[data-testid="forge-avatar"] img').attributes('src')).toBe('app://damocles/forge/avatar/k-alexios');
    // a second failure is the last: the initial stays
    await graphRows(wrapper)[0]!.get('[data-testid="forge-avatar"] img').trigger('error');
    await flushPromises();
    expect(shell.forge.authorAvatars).toHaveBeenCalledTimes(2);
    expect(graphRows(wrapper)[0]!.find('[data-testid="forge-avatar"] img').exists()).toBe(false);
  });

  it('never holds the history back while avatars are asked', async () => {
    const scm = scmWith({ ok: true, page: { commits: PAGE_1, load: LOAD } });
    const shell = shellWith(GITLAB);
    vi.mocked(shell.forge.authorAvatars).mockImplementation(() => new Promise(() => undefined));
    const wrapper = await mountGraph(scm, shell);
    expect(graphRows(wrapper)).toHaveLength(3);
    expect(graphRows(wrapper)[0]!.get('[data-testid="forge-avatar"]').text()).toBe('A');
  });

  it('asks nothing and draws no avatar with no registered server, or with showAvatars off; a forge change asks again', async () => {
    const none = shellWith(null);
    const noServer = await mountGraph(scmWith({ ok: true, page: { commits: PAGE_1, load: LOAD } }), none);
    expect(none.forge.authorAvatars).not.toHaveBeenCalled();
    expect(noServer.find('[data-testid="forge-avatar"]').exists()).toBe(false);

    const off = shellWith({ ...GITLAB, showAvatars: false });
    const wrapper = await mountGraph(scmWith({ ok: true, page: { commits: PAGE_1, load: LOAD } }), off);
    expect(off.forge.authorAvatars).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="forge-avatar"]').exists()).toBe(false);

    off.forge.contexts.set('r1', GITLAB);
    off.forge.changed({});
    await flushPromises();
    expect(off.forge.authorAvatars).toHaveBeenCalledTimes(1);
    expect(graphRows(wrapper)[0]!.get('[data-testid="forge-avatar"] img').attributes('src')).toBe('app://damocles/forge/avatar/k-alexios');

    off.forge.contexts.set('r1', { ...GITLAB, showAvatars: false });
    off.forge.changed({});
    await flushPromises();
    expect(wrapper.find('[data-testid="forge-avatar"]').exists()).toBe(false);
    expect(off.forge.authorAvatars).toHaveBeenCalledTimes(1);
  });
});

describe('commit details', () => {
  async function expand(shell: FakeShellApi): Promise<VueWrapper> {
    const wrapper = await mountGraph(scmWith({ ok: true, page: { commits: PAGE_1, load: LOAD } }), shell);
    await graphRows(wrapper)[0]!.trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('draws the author\'s avatar in the meta row and links #123, !45 and damocles/forge#12, which open by id only', async () => {
    const shell = shellWith(GITLAB);
    const wrapper = await expand(shell);
    expect(detail(wrapper, 'meta').get('[data-testid="forge-avatar"] img').attributes('src')).toBe('app://damocles/forge/avatar/k-alexios');
    const message = detail(wrapper, 'message');
    expect(message.get('[data-testid="graph-message"]').text()).toBe(MESSAGE);
    const links = message.findAll('[role="link"]');
    expect(links.map((link) => link.text())).toEqual(['#123', '!45', 'damocles/forge#12']);
    expect(links[0]!.classes()).toContain('text-(--d-accent-text)');
    // the focused row's links are in the tab order, the others' not
    expect(links[0]!.attributes('tabindex')).toBe('-1');

    await links[1]!.trigger('click');
    await links[2]!.trigger('click');
    expect(shell.forge.link).toHaveBeenNthCalledWith(1, { action: 'openReference', repoId: 'r1', reference: { sigil: '!', number: 45 } });
    expect(shell.forge.link).toHaveBeenNthCalledWith(2, { action: 'openReference', repoId: 'r1', reference: { sigil: '#', number: 12, path: 'damocles/forge' } });
  });

  it('leaves the message as text and asks for no merge request with no registered server; GitHub never links !45', async () => {
    const none = shellWith(null);
    const plain = await expand(none);
    expect(detail(plain, 'message').findAll('[role="link"]')).toHaveLength(0);
    expect(none.forge.containingChange).not.toHaveBeenCalled();
    expect(detail(plain, 'meta').find('[data-testid="forge-avatar"]').exists()).toBe(false);

    const github = await expand(shellWith({ kind: 'github', serverName: 'github.com', showAvatars: true }));
    expect(detail(github, 'message').findAll('[role="link"]').map((link) => link.text())).toEqual(['#123', 'damocles/forge#12']);
  });

  it('names the merged MR in the status row beside the pipeline, and its link opens it', async () => {
    const shell = shellWith(GITLAB);
    shell.forge.commits.set(hash(1), { status: 'ready', pipeline: { id: 99_001, number: 4312, state: 'passed', serverName: 'gitlab.indigital.gr', kind: 'gitlab' } });
    shell.forge.containing.set(hash(1), { kind: 'mergeRequest', number: 45, serverName: 'gitlab.indigital.gr' });
    const wrapper = await expand(shell);
    expect(shell.forge.containingChange).toHaveBeenCalledWith('r1', hash(1));
    const row = detail(wrapper, 'status');
    expect(row.attributes('aria-label')).toBe('Pipeline #4312 passed, Merged in !45');
    expect(row.get('[data-testid="graph-merged-text"]').text()).toBe('Merged in !45');
    // beside a pipeline, a narrow card sheds "Merged in" for the bare link, which the row's name still words
    expect(row.get('[data-testid="graph-merged-text"]').classes()).toContain('@max-[18rem]/card:hidden');
    expect(row.get('[data-testid="graph-merged-short"]').classes()).toContain('@min-[18rem]/card:hidden');
    expect(row.get('[data-testid="graph-merged-short"]').text()).toBe('!45');
    expect(row.get('[data-testid="graph-ci-link"]').text()).toBe('Pipeline #4312 passed');
    await row.get('[data-testid="graph-merged-link"]').trigger('click');
    expect(shell.forge.link).toHaveBeenCalledWith({ action: 'openReference', repoId: 'r1', reference: { sigil: '!', number: 45 } });
  });

  it('shows the row for a merged pull request alone when there is no pipeline, and Enter opens it', async () => {
    const shell = shellWith({ kind: 'github', serverName: 'github.com', showAvatars: true });
    shell.forge.containing.set(hash(1), { kind: 'pullRequest', number: 12, serverName: 'github.com' });
    const wrapper = await expand(shell);
    const row = detail(wrapper, 'status');
    expect(row.text()).toBe('Merged in #12');
    expect(row.find('[data-testid="graph-ci-link"]').exists()).toBe(false);
    await row.trigger('focus');
    await wrapper.get('[data-testid="graph-tree"]').trigger('keydown', { key: 'Enter' });
    expect(shell.forge.link).toHaveBeenCalledWith({ action: 'openReference', repoId: 'r1', reference: { sigil: '#', number: 12 } });
  });

  it('puts the focused row\'s links in the tab order with a resting underline, and renders markup in a message as text', async () => {
    const shell = shellWith(GITLAB);
    const scm = scmWith({ ok: true, page: { commits: PAGE_1, load: LOAD } });
    vi.mocked(scm.commitDetails).mockImplementation(async ({ hash: asked }) => ({ ok: true, details: { hash: asked, parents: [], message: 'Fix <img src=x onerror=alert(1)> in #7', messageTruncated: false, author: 'A', email: 'a@x.gr', authorDate: NOW, files: [], filesTruncated: false } }));
    const wrapper = await mountGraph(scm, shell);
    await graphRows(wrapper)[0]!.trigger('click');
    await flushPromises();
    const message = detail(wrapper, 'message');
    expect(message.find('img').exists()).toBe(false);
    expect(message.get('[data-testid="graph-message"]').text()).toBe('Fix <img src=x onerror=alert(1)> in #7');
    await message.trigger('focus');
    const link = message.get('[role="link"]');
    expect(link.attributes('tabindex')).toBe('0');
    expect(link.classes()).toEqual(expect.arrayContaining(['underline', 'decoration-dotted', 'hover:decoration-solid']));
  });

  it('reads no CI status and shows no checking row with no registered server', async () => {
    const shell = shellWith(null);
    const wrapper = await expand(shell);
    expect(shell.forge.commitStatus).not.toHaveBeenCalled();
    expect(detail(wrapper, 'status').exists()).toBe(false);
  });

  it('asks a commit\'s merged change once while an ask is out, however often the commit opens', async () => {
    const shell = shellWith(GITLAB);
    let answer!: (change: null) => void;
    vi.mocked(shell.forge.containingChange).mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const wrapper = await expand(shell);
    await graphRows(wrapper)[0]!.trigger('click');
    await graphRows(wrapper)[0]!.trigger('click');
    await flushPromises();
    expect(shell.forge.containingChange).toHaveBeenCalledTimes(1);
    answer(null);
    await flushPromises();
  });

  it('drops the merged change and the CI row once no registered server is left', async () => {
    const shell = shellWith(GITLAB);
    shell.forge.commits.set(hash(1), { status: 'ready', pipeline: { id: 99_001, number: 4312, state: 'passed', serverName: 'gitlab.indigital.gr', kind: 'gitlab' } });
    shell.forge.containing.set(hash(1), { kind: 'mergeRequest', number: 45, serverName: 'gitlab.indigital.gr' });
    const wrapper = await expand(shell);
    expect(detail(wrapper, 'status').exists()).toBe(true);
    shell.forge.contexts.delete('r1');
    shell.forge.changed({});
    await flushPromises();
    expect(detail(wrapper, 'status').exists()).toBe(false);
    expect(detail(wrapper, 'message').findAll('[role="link"]')).toHaveLength(0);
  });

  it('keeps Checking CI and merge requests… while the CI status is read', async () => {
    const shell = shellWith(GITLAB);
    vi.mocked(shell.forge.commitStatus).mockImplementation(() => new Promise(() => undefined));
    shell.forge.containing.set(hash(1), { kind: 'mergeRequest', number: 45, serverName: 'gitlab.indigital.gr' });
    const wrapper = await expand(shell);
    expect(detail(wrapper, 'status').text()).toBe('Checking CI and merge requests…');
  });
});

describe('the blame card', () => {
  const COMMIT: ScmBlameCommit = { hash: '4e1a9c2b'.padEnd(40, '0'), author: 'Alexios Stefanopoulos', authorEmail: 'a.stefanopoulos@indigital.gr', authorTime: NOW, committerTime: NOW, summary: 'Add the account chip to Source Control (#123)' };
  const card = (props: Record<string, unknown>): VueWrapper => {
    const wrapper = mount(BlameCard, { props: { commit: COMMIT, ago: '2 hours ago', ...props }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    return wrapper;
  };

  it('puts the author\'s picture over the initial, links the summary\'s #123 and says Merged in !45 in the meta line', async () => {
    const wrapper = card({ avatarKey: 'k-alexios', forgeKind: 'gitlab', merged: { kind: 'mergeRequest', number: 45, serverName: 'gitlab.indigital.gr' } });
    const avatar = wrapper.get('[data-testid="forge-avatar"]');
    expect(avatar.text()).toBe('A');
    expect(avatar.get('img').attributes('src')).toBe('app://damocles/forge/avatar/k-alexios');
    const link = wrapper.get('[data-testid="blame-card-ref"]');
    expect(link.attributes('role')).toBe('link');
    expect(link.text()).toBe('#123');
    expect(wrapper.get('[data-testid="blame-card-merged"]').text()).toBe('Merged in !45');
    await link.trigger('click');
    await wrapper.get('[data-testid="blame-card-merged-link"]').trigger('click');
    expect(wrapper.emitted('openReference')).toEqual([[{ sigil: '#', number: 123 }]]);
    expect(wrapper.emitted('openMerged')).toHaveLength(1);
  });

  it('keeps the initial and plain text with no picture, no registered server and no merge request, and offers no server action', () => {
    const wrapper = card({});
    expect(wrapper.get('[data-testid="forge-avatar"]').text()).toBe('A');
    expect(wrapper.find('[data-testid="forge-avatar"] img').exists()).toBe(false);
    expect(wrapper.find('[role="link"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="blame-card-merged"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="blame-open-on-server"]').exists()).toBe(false);
  });

  it('names its server action as the Graph menu does, and marks Open Commit as the action Show Line Blame focuses', async () => {
    const wrapper = card({ forgeKind: 'github', avatarKey: 'k-alexios' });
    expect(wrapper.get('[data-testid="blame-open-on-server"]').text()).toBe('Open Commit on Server');
    expect(wrapper.get('[data-blame-first]').attributes('data-testid')).toBe('blame-open-commit');
    await wrapper.get('[data-testid="forge-avatar"] img').trigger('error');
    expect(wrapper.emitted('avatarFailed')).toHaveLength(1);
  });
});

describe('the avatar placeholder (ForgeAvatar.vue)', () => {
  it('fades the image in over the initial once loaded, in a fixed box, and keeps the initial when the image fails', async () => {
    const wrapper = mount(ForgeAvatar, { props: { login: 'Ölga', avatarKey: 'k1', size: 'chip' } });
    mounted.push(wrapper);
    expect(wrapper.get('[data-testid="forge-avatar"]').classes()).toEqual(expect.arrayContaining(['size-3.5', 'relative', 'overflow-hidden']));
    expect(wrapper.text()).toBe('Ö');
    const image = wrapper.get('img');
    expect(image.classes()).toContain('opacity-0');
    await image.trigger('load');
    expect(image.classes()).toContain('d-fade-in');
    await image.trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toBe('Ö');
    expect(wrapper.emitted('failed')).toHaveLength(1);
  });

  it('shows a picture it already showed without the fade when a scroll mounts its row again', async () => {
    const first = mount(ForgeAvatar, { props: { login: 'Maria', avatarKey: 'k-remount', size: 'chip' } });
    mounted.push(first);
    await first.get('img').trigger('load');
    expect(first.get('img').classes()).toContain('d-fade-in');
    first.unmount();
    mounted.splice(mounted.indexOf(first), 1);
    const again = mount(ForgeAvatar, { props: { login: 'Maria', avatarKey: 'k-remount', size: 'chip' } });
    mounted.push(again);
    expect(again.get('img').classes()).not.toContain('opacity-0');
    expect(again.get('img').classes()).not.toContain('d-fade-in');
  });

  it('takes the first grapheme as the initial, so a combining mark or an emoji stays whole', () => {
    const combining = mount(ForgeAvatar, { props: { login: 'e\u0301lise' } });
    const emoji = mount(ForgeAvatar, { props: { login: '🦊 fox' } });
    mounted.push(combining, emoji);
    expect(combining.text()).toBe('E\u0301');
    expect(emoji.text()).toBe('🦊');
  });
});
