// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import ClonePicker from '../overlay/components/ClonePicker.vue';
import { applyShellLocale, shellI18n } from '../i18n';
import type { PopupAnswer } from '../../preload/overlay-channels';
import type { CloneAccount, CloneRow, CloneSearchAnswer, CloneStartAnswer } from '../../../shared/forge/clone';
import { fakeOverlayApi, opened, type FakeOverlayApi } from './fakes';

// sample data
const IDG: CloneAccount = { accountId: 'idg|1', login: 'astefanopoulos', serverId: 'idg', serverName: 'gitlab.indigital.gr', kind: 'gitlab', needsSignIn: false };
const GLC: CloneAccount = { accountId: 'glc|2', login: 'alexios-s', serverId: 'glc', serverName: 'gitlab.com', kind: 'gitlab', needsSignIn: false };
const GH: CloneAccount = { accountId: 'gh|3', login: 'alexios', serverId: 'gh', serverName: 'github.com', kind: 'github', needsSignIn: false };
const DAMOCLES: CloneRow = { key: 'idg-damocles', namespace: 'grp', name: 'damocles', description: 'Desktop agent shell', visibility: 'private', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
const INTRANET: CloneRow = { key: 'idg-intranet', namespace: 'grp/platform', name: 'intranet', description: 'Company intranet', visibility: 'internal' };
const SITE: CloneRow = { key: 'glc-site', namespace: 'alexios-s', name: 'personal-site', description: 'My website', visibility: 'public', pill: 'fork' };
const DOTFILES: CloneRow = { key: 'gh-dotfiles', namespace: 'alexios', name: 'dotfiles', visibility: 'public' };

const mounted: VueWrapper[] = [];

beforeEach(async () => {
  await applyShellLocale('en');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

// A search's answer the test settles when it chooses, by account.
function deferredSearches(api: FakeOverlayApi): Map<string, Array<(answer: Omit<CloneSearchAnswer, 'requestId' | 'accountId'>) => void>> {
  const waiting = new Map<string, Array<(answer: Omit<CloneSearchAnswer, 'requestId' | 'accountId'>) => void>>();
  vi.mocked(api.forgeCloneSearch).mockImplementation((accountId: string, _query: string, requestId: number) => new Promise((resolve) => {
    waiting.set(accountId, [...(waiting.get(accountId) ?? []), (answer) => resolve(opened({ requestId, accountId, ...answer } as CloneSearchAnswer))]);
  }));
  return waiting;
}

async function open(api: FakeOverlayApi, accounts: readonly CloneAccount[] = [IDG, GLC, GH], protocol: 'https' | 'ssh' = 'https'): Promise<VueWrapper> {
  vi.mocked(api.forgeCloneAccounts).mockResolvedValue(opened({ accounts, protocol }));
  const wrapper = mount(ClonePicker, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const combobox = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const optionNames = (): string[] => [...document.querySelectorAll('[role="option"]')].map((option) => option.getAttribute('aria-label')!);
const testIds = (id: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

async function type(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.get('[role="combobox"]').setValue(text);
  vi.advanceTimersByTime(300);
  await flushPromises();
}

describe('ClonePicker', () => {
  it('names the combobox and its placeholder as the design does, with the hint for the accounts', async () => {
    const api = fakeOverlayApi();
    await open(api);
    expect(combobox().getAttribute('aria-label')).toBe('Repository');
    expect(combobox().placeholder).toBe('Search your repositories, or paste a URL');
    expect(testIds('clone-picker-hint')[0]!.textContent).toContain('Repositories from your 3 accounts. The clone uses the account it was listed under.');
    expect(combobox().maxLength).toBe(2048);
  });

  it('says over ssh that the clone uses the user\'s SSH keys and the project the listed account', async () => {
    await open(fakeOverlayApi(), [IDG], 'ssh');
    expect(testIds('clone-picker-hint')[0]!.textContent).toContain('Repositories from your account. The clone uses your SSH keys, and the new project uses the account it was listed under.');
  });

  it('asks each server once for a burst of keystrokes, with the query cut to what main takes', async () => {
    const api = fakeOverlayApi();
    const wrapper = await open(api, [IDG, GLC]);
    vi.mocked(api.forgeCloneSearch).mockClear();
    for (const text of ['i', 'in', 'int', 'intr', 'intra']) await wrapper.get('[role="combobox"]').setValue(text);
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(vi.mocked(api.forgeCloneSearch).mock.calls.map(([accountId, query]) => [accountId, query])).toEqual([[IDG.accountId, 'intra'], [GLC.accountId, 'intra']]);
    vi.mocked(api.forgeCloneSearch).mockClear();
    await type(wrapper, 'word '.repeat(80));
    expect(vi.mocked(api.forgeCloneSearch).mock.calls.map(([, query]) => query.length)).toEqual([256, 256]);
  });

  it('lists an account with no repository as such under an empty query', async () => {
    await open(fakeOverlayApi(), [IDG]);
    expect(testIds('clone-picker-none').map((row) => row.textContent!.trim())).toEqual(['No repositories']);
    expect(testIds('clone-picker-none')[0]!.getAttribute('aria-disabled')).toBe('true');
  });

  it('loads each account on its own: one section answers while another still searches', async () => {
    const api = fakeOverlayApi();
    const waiting = deferredSearches(api);
    await open(api);
    waiting.get(GLC.accountId)![0]!({ rows: [SITE] });
    await flushPromises();
    expect(optionNames()).toEqual(['alexios-s/personal-site, public, alexios-s on gitlab.com']);
    expect(testIds('clone-picker-loading').map((row) => row.textContent!.trim())).toEqual(['Searching gitlab.indigital.gr…', 'Searching github.com…']);
    expect(testIds('clone-picker-busy')).toHaveLength(1);
    waiting.get(IDG.accountId)![0]!({ rows: [DAMOCLES, INTRANET] });
    await flushPromises();
    expect(optionNames()).toEqual([
      'grp/damocles, private, astefanopoulos on gitlab.indigital.gr',
      'grp/platform/intranet, internal, astefanopoulos on gitlab.indigital.gr',
      'alexios-s/personal-site, public, alexios-s on gitlab.com',
    ]);
    expect(testIds('clone-picker-updated')[0]!.textContent).toBe('2 hours ago');
    expect(testIds('clone-picker-pill').map((pill) => pill.textContent)).toEqual(['private', 'internal', 'fork']);
  });

  it('shows a server that did not answer in its own section, and Try again asks only that server again', async () => {
    const api = fakeOverlayApi();
    const waiting = deferredSearches(api);
    const wrapper = await open(api);
    waiting.get(IDG.accountId)![0]!({ rows: [DAMOCLES] });
    waiting.get(GLC.accountId)![0]!({ rows: [SITE] });
    waiting.get(GH.accountId)![0]!({ error: 'unreachable' });
    await flushPromises();
    const retry = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.getAttribute('aria-label') === 'github.com did not answer. Try again')!;
    expect(retry.closest('[role="group"]')!.getAttribute('aria-label')).toBe('alexios on github.com');
    vi.mocked(api.forgeCloneSearch).mockClear();
    await wrapper.get(`#${CSS.escape(retry.id)}`).trigger('click');
    await flushPromises();
    expect(api.forgeCloneSearch).toHaveBeenCalledTimes(1);
    expect(api.forgeCloneSearch).toHaveBeenCalledWith(GH.accountId, '', expect.any(Number));
    expect(optionNames()).toContain('grp/damocles, private, astefanopoulos on gitlab.indigital.gr');
    waiting.get(GH.accountId)![1]!({ rows: [DOTFILES] });
    await flushPromises();
    expect(optionNames()).toContain('alexios/dotfiles, public, alexios on github.com');
  });

  it('drops a section\'s answer to an older query', async () => {
    const api = fakeOverlayApi();
    const waiting = deferredSearches(api);
    const wrapper = await open(api, [IDG]);
    await type(wrapper, 'intra');
    waiting.get(IDG.accountId)![1]!({ rows: [INTRANET] });
    waiting.get(IDG.accountId)![0]!({ rows: [DAMOCLES] });
    await flushPromises();
    expect(optionNames()).toEqual(['grp/platform/intranet, internal, astefanopoulos on gitlab.indigital.gr']);
    expect(document.querySelector('mark')!.textContent).toBe('intra');
  });

  it('says when nothing matched in any account, and Clear the search lists them again', async () => {
    const api = fakeOverlayApi();
    const wrapper = await open(api, [IDG, GLC]);
    await type(wrapper, 'zzz');
    expect(testIds('clone-picker-no-results')[0]!.textContent).toContain('No repository matched "zzz" in your 2 accounts.');
    expect(document.querySelectorAll('[role="group"]')).toHaveLength(0);
    vi.mocked(api.forgeCloneSearch).mockClear();
    await wrapper.get('[data-testid="clone-picker-clear"]').trigger('click');
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(combobox().value).toBe('');
    expect(document.activeElement).toBe(combobox());
    expect(api.forgeCloneSearch).toHaveBeenCalledWith(IDG.accountId, '', expect.any(Number));
    expect(testIds('clone-picker-no-results')).toHaveLength(0);
  });

  it('turns a pasted URL into one Clone from URL row, which Enter clones', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.forgeClonePaste).mockResolvedValue(opened({ row: { displayPath: 'git.indigital.gr/platform/api', protocol: 'ssh', serverName: 'gitlab.indigital.gr', login: 'astefanopoulos' } }));
    const wrapper = await open(api);
    vi.mocked(api.forgeCloneSearch).mockClear();
    await type(wrapper, 'git@git.indigital.gr:platform/api.git');
    expect(api.forgeClonePaste).toHaveBeenCalledWith('git@git.indigital.gr:platform/api.git');
    expect(api.forgeCloneSearch).not.toHaveBeenCalled();
    expect(optionNames()).toEqual(['Clone from URL, git.indigital.gr/platform/api, with your SSH keys, for astefanopoulos on gitlab.indigital.gr']);
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.forgeCloneStart).toHaveBeenCalledWith({ pasteText: 'git@git.indigital.gr:platform/api.git' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('sends an absolute folder to main as a paste, so a local repository still clones from the picker', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.forgeClonePaste).mockResolvedValue(opened({ row: { displayPath: 'C:/repos/tool' } }));
    const wrapper = await open(api, [IDG]);
    await type(wrapper, 'C:/repos/tool');
    expect(api.forgeClonePaste).toHaveBeenCalledWith('C:/repos/tool');
    expect(optionNames()).toEqual(['Clone from URL, C:/repos/tool']);
  });

  it('reads a pasted git clone command and a folder path with spaces as a paste, never as search words', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.forgeClonePaste).mockImplementation(async (text: string) => opened({ row: { displayPath: text.replace(/^git clone /, '') } }));
    const wrapper = await open(api, [IDG]);
    vi.mocked(api.forgeCloneSearch).mockClear();
    await type(wrapper, 'git clone https://gitlab.indigital.gr/grp/damocles.git');
    expect(api.forgeClonePaste).toHaveBeenLastCalledWith('git clone https://gitlab.indigital.gr/grp/damocles.git');
    await type(wrapper, 'C:\\My Repos\\tool');
    expect(api.forgeClonePaste).toHaveBeenLastCalledWith('C:\\My Repos\\tool');
    expect(optionNames()).toEqual(['Clone from URL, C:\\My Repos\\tool']);
    expect(api.forgeCloneSearch).not.toHaveBeenCalled();
  });

  it('names the account a pasted https URL clones as', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.forgeClonePaste).mockResolvedValue(opened({ row: { displayPath: 'gitlab.indigital.gr/grp/damocles.git', protocol: 'https', serverName: 'gitlab.indigital.gr', login: 'astefanopoulos' } }));
    const wrapper = await open(api, [IDG]);
    await type(wrapper, 'https://gitlab.indigital.gr/grp/damocles.git');
    expect(testIds('clone-picker-paste-account')[0]!.textContent).toBe('as astefanopoulos on gitlab.indigital.gr');
  });

  it('says when core could not read the accounts, and Try again asks again', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.forgeCloneAccounts).mockResolvedValueOnce(opened({ empty: 'notLoaded' as const }));
    const wrapper = mount(ClonePicker, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    expect(testIds('clone-picker-empty')[0]!.textContent).toContain('Damocles could not read your GitHub and GitLab accounts. Try again, or paste a repository URL above.');
    expect(testIds('clone-picker-open-accounts')).toHaveLength(0);
    vi.mocked(api.forgeCloneAccounts).mockResolvedValueOnce(opened({ accounts: [IDG], protocol: 'https' as const }));
    await wrapper.get('[data-testid="clone-picker-retry-accounts"]').trigger('click');
    await flushPromises();
    expect(testIds('clone-picker-empty')).toHaveLength(0);
    expect(document.querySelectorAll('[role="group"]')).toHaveLength(1);
    expect(document.activeElement).toBe(combobox());
  });

  it('says why there is nothing to list with no account, offers Accounts settings, and still takes a paste', async () => {
    const api = fakeOverlayApi();
    const wrapper = mount(ClonePicker, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    expect(testIds('clone-picker-empty')[0]!.textContent).toContain('No GitHub or GitLab account yet. Sign in to pick from your repositories, or paste a repository URL above.');
    expect(testIds('clone-picker-hint')).toHaveLength(0);
    await wrapper.get('[data-testid="clone-picker-open-accounts"]').trigger('click');
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'cloneFromAccount', openAccounts: true }]]);
    vi.mocked(api.forgeClonePaste).mockResolvedValue(opened({ row: { displayPath: 'example.org/me/tool' } }));
    await type(wrapper, 'https://example.org/me/tool.git');
    expect(testIds('clone-picker-empty')).toHaveLength(0);
    expect(optionNames()).toEqual(['Clone from URL, example.org/me/tool']);
  });

  it('clones the active row with its account by key, and keeps the picker open with the reason when main refuses', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.forgeCloneSearch).mockImplementation(async (accountId: string, _query: string, requestId: number) => opened({ requestId, accountId, rows: accountId === IDG.accountId ? [DAMOCLES, INTRANET] : [] }));
    vi.mocked(api.forgeCloneStart).mockResolvedValueOnce(opened({ kind: 'refused', reason: 'That repository is no longer listed. Search again.' }));
    const wrapper = await open(api, [IDG]);
    const input = wrapper.get('[role="combobox"]');
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(combobox().getAttribute('aria-activedescendant')).toBe(document.querySelectorAll('[role="option"]')[1]!.id);
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.forgeCloneStart).toHaveBeenCalledWith({ accountId: IDG.accountId, key: INTRANET.key });
    expect(document.querySelector('[role="alert"]')!.textContent!.trim()).toBe('That repository is no longer listed. Search again.');
    expect(wrapper.emitted('answer')).toBeUndefined();
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('offers Accounts settings for an account whose server refused its sign-in, which is never searched', async () => {
    const api = fakeOverlayApi();
    const wrapper = await open(api, [{ ...GH, needsSignIn: true }]);
    expect(api.forgeCloneSearch).not.toHaveBeenCalled();
    expect(optionNames()).toEqual(['Sign in again to github.com']);
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'cloneFromAccount', openAccounts: true }]]);
  });

  it('says when a server refused to list an account\'s repositories, and offers Accounts settings', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.forgeCloneSearch).mockImplementation(async (accountId: string, _query: string, requestId: number) => opened({ requestId, accountId, error: 'refused' as const }));
    const wrapper = await open(api, [GH]);
    expect(optionNames()).toEqual(['github.com refused to list the repositories of alexios. Open Git hosting settings']);
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'cloneFromAccount', openAccounts: true }]]);
  });

  it('shows nothing for a search main aborted because a newer one replaced it', async () => {
    const api = fakeOverlayApi();
    const rejects: Array<(error: Error) => void> = [];
    vi.mocked(api.forgeCloneSearch).mockImplementationOnce(() => new Promise((_resolve, reject) => rejects.push(reject)));
    const wrapper = await open(api, [GLC]);
    await type(wrapper, 'site');
    rejects[0]!(new Error('aborted'));
    await flushPromises();
    expect(optionNames()).toEqual([]);
    expect(testIds('clone-picker-error')).toHaveLength(0);
  });

  it('answers dismissed on Escape', async () => {
    const api = fakeOverlayApi();
    const wrapper = await open(api);
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('answers dismissed on Escape from a focused button too', async () => {
    const api = fakeOverlayApi();
    const wrapper = await open(api, [IDG]);
    await type(wrapper, 'zzz');
    const clear = wrapper.get('[data-testid="clone-picker-clear"]');
    (clear.element as HTMLElement).focus();
    await clear.trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
  });

  it('closes on Escape while a clone starts, and shows nothing when main answers that it cancelled the clone', async () => {
    const api = fakeOverlayApi();
    let answer: (value: PopupAnswer<CloneStartAnswer>) => void = () => undefined;
    vi.mocked(api.forgeCloneSearch).mockImplementation(async (accountId: string, _query: string, requestId: number) => opened({ requestId, accountId, rows: [DAMOCLES] }));
    vi.mocked(api.forgeCloneStart).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const wrapper = await open(api, [IDG]);
    const input = wrapper.get('[role="combobox"]');
    await input.trigger('keydown', { key: 'Enter' });
    await input.trigger('keydown', { key: 'Escape' });
    answer(opened<CloneStartAnswer>({ kind: 'cancelled' }));
    await flushPromises();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'dismissed' }]]);
    expect(testIds('clone-picker-failed')).toHaveLength(0);
  });
});
