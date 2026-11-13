// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, Transition, type Ref } from 'vue';
import AccountChip from '../forge/AccountChip.vue';
import { SECTION_CHIP_ROOM } from '../components/sidebar-section';
import ContextMenu from '../overlay/components/ContextMenu.vue';
import { checkFailedNotice, chipServers } from '../forge/repo-accounts';
import { applyShellLocale, shellI18n } from '../i18n';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import type { OverlayAnswer, OverlayMenuItem, OverlayRequest } from '../../preload/overlay-channels';
import type { RepoAccountOption, RepoAccountsView, RepoServerAccounts } from '../../../shared/forge/bindings';

const mounted: VueWrapper[] = [];

beforeEach(async () => {
  await applyShellLocale('en');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

// sample data
const ASTEF: RepoAccountOption = { id: 'indigital|1', login: 'astefanopoulos', name: 'Alexios Stefanopoulos', needsSignIn: false, canPush: true };
const ADMIN: RepoAccountOption = { id: 'indigital|2', login: 'astef-admin', name: 'Admin account', needsSignIn: false, canPush: true };
const ALEXIOS: RepoAccountOption = { id: 'gitlab.com|1', login: 'alexios-s', name: 'Alexios S.', needsSignIn: false, canPush: true };
const WORK: RepoAccountOption = { id: 'gitlab.com|2', login: 'work-alexios', name: 'Alexios at Indigital', needsSignIn: false, canPush: false };

type Settled = Extract<RepoServerAccounts, { account: RepoAccountOption }>;
const INDIGITAL: Settled = { serverId: 'indigital', server: 'gitlab.indigital.gr', kind: 'gitlab', remotes: ['origin'], isPush: true, repoPath: 'grp/damocles', state: 'auto', how: 'onlyAccount', account: ASTEF, accounts: [ASTEF, ADMIN] };
const GITLAB: Settled = { serverId: 'gitlab.com', server: 'gitlab.com', kind: 'gitlab', remotes: ['upstream'], isPush: false, repoPath: 'alexios-s/damocles', state: 'chosen', how: 'bound', account: ALEXIOS, accounts: [ALEXIOS, WORK] };

// a server with no resolved account
const unresolved = ({ account: _account, how: _how, ...server }: Settled, state: Exclude<RepoServerAccounts['state'], Settled['state']>): RepoServerAccounts => ({ ...server, state });

interface Run {
  readonly wrapper: VueWrapper;
  readonly requests: OverlayRequest[];
  readonly forge: { chooseAccount: ReturnType<typeof vi.fn>; openAccounts: ReturnType<typeof vi.fn> };
}

function mountChip(servers: readonly RepoServerAccounts[], options: { compact?: boolean; answer?: OverlayAnswer; saved?: boolean; room?: Ref<number> } = {}): Run {
  const requests: OverlayRequest[] = [];
  const forge = {
    repoAccounts: vi.fn(),
    chooseAccount: vi.fn(async () => options.saved ?? true),
    openAccounts: vi.fn(async () => undefined),
    onChanged: vi.fn(() => () => undefined),
  };
  const api = {
    forge,
    requestOverlay: vi.fn(async (request: OverlayRequest) => {
      requests.push(request);
      return options.answer ?? { kind: 'dismissed' };
    }),
  } as unknown as DamoclesShellApi;
  const view: RepoAccountsView = { projectKey: 'C:/work/damocles', project: 'damocles', servers };
  const wrapper = mount(AccountChip, {
    props: { api, repoId: 'repo-1', view, servers, compact: options.compact ?? false },
    global: { plugins: [shellI18n], provide: options.room ? { [SECTION_CHIP_ROOM]: options.room } : {} },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return { wrapper, requests, forge };
}

const chip = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="forge-account-chip"]')!;
// the label's parts, which the flex gap sets apart on screen
const label = (): string => [...document.querySelector('[data-testid="forge-account-chip-label"]')!.children].map((part) => part.textContent!.trim()).filter(Boolean).join(' ');
type Item = Extract<OverlayMenuItem, { kind: 'item' }>;
const menuOf = (run: Run): Extract<OverlayRequest, { kind: 'menu' }> => run.requests[0] as Extract<OverlayRequest, { kind: 'menu' }>;

describe('AccountChip', () => {
  it('names every server in the contract words, shows the push server with auto and +N, and lists every server in its title', () => {
    mountChip([INDIGITAL, GITLAB]);
    expect(chip().getAttribute('aria-label')).toBe('Accounts: astefanopoulos on gitlab.indigital.gr, chosen automatically; alexios-s on gitlab.com, chosen by you');
    expect(chip().getAttribute('title')).toBe('astefanopoulos on gitlab.indigital.gr, chosen automatically\nalexios-s on gitlab.com, chosen by you');
    expect(chip().getAttribute('aria-haspopup')).toBe('menu');
    expect(label()).toBe('A astefanopoulos auto +1');
  });

  it('shows Choose account in the warning tone when nothing resolved', () => {
    mountChip([unresolved(GITLAB, 'choose')]);
    expect(label()).toBe('Choose account');
    expect(chip().className).toContain('--d-warning');
    expect(chip().getAttribute('aria-label')).toBe('Accounts: gitlab.com, no account chosen');
  });

  it('shows sign in again in the warning tone', () => {
    mountChip([{ ...INDIGITAL, state: 'signInAgain', account: { ...ADMIN, needsSignIn: true } }]);
    expect(label()).toBe('A astef-admin · sign in again');
    expect(chip().className).toContain('--d-warning');
    expect(chip().getAttribute('aria-label')).toBe('Accounts: astef-admin on gitlab.indigital.gr, sign in again');
  });

  it("shows Git's own credentials", () => {
    mountChip([unresolved(INDIGITAL, 'ownCredentials')]);
    expect(label()).toBe("Git's own credentials");
    expect(chip().getAttribute('aria-label')).toBe("Accounts: gitlab.indigital.gr, Git's own credentials");
  });

  it('shows a muted Sign in for a server with no account, named for the sign-in', () => {
    mountChip([{ ...unresolved(GITLAB, 'signIn'), server: 'github.com', serverId: 'github.com', kind: 'github', accounts: [] }]);
    expect(label()).toBe('Sign in');
    expect(chip().className).not.toContain('--d-warning');
    expect(chip().getAttribute('aria-label')).toBe('Sign in to github.com');
    expect(chip().getAttribute('title')).toBe("No github.com account. Git's own credentials answer.");
  });

  it('shrinks to the avatar beside the worktree chip, keeping its name', () => {
    mountChip([INDIGITAL, GITLAB], { compact: true });
    expect(label()).toBe('A');
    expect(chip().getAttribute('aria-label')).toContain('astefanopoulos on gitlab.indigital.gr');
  });

  it('opens one submenu per server when there are several, with radio items, avatars and hints', async () => {
    const run = mountChip([INDIGITAL, GITLAB]);
    chip().click();
    await flushPromises();
    const menu = menuOf(run);
    expect(menu.label).toBe('Accounts for damocles');
    expect(menu.caption).toBe('damocles · 2 servers');
    const submenus = menu.items.filter((item) => item.kind === 'submenu');
    expect(submenus.map((item) => item.label)).toEqual(['gitlab.indigital.gr', 'gitlab.com']);
    const indigital = submenus[0]!;
    expect(indigital.kind === 'submenu' && indigital.hint).toBe('astefanopoulos · chosen automatically');
    const radios = (indigital.kind === 'submenu' ? indigital.items : []).filter((item): item is Item => item.kind === 'item');
    expect(radios.map((item) => [item.label, item.checked, item.radio])).toEqual([
      ['astefanopoulos', true, true],
      ['astef-admin', false, true],
      ["Use Git's own credentials", false, true],
      ['Sign in to gitlab.indigital.gr…', undefined, undefined],
    ]);
    expect(radios[0]!.hint).toBe('Chosen automatically · can push');
    expect(radios[0]!.avatar).toEqual({ login: 'astefanopoulos' });
    const leaves = menu.items.filter((item): item is Item => item.kind === 'item').map((item) => item.label);
    expect(leaves).toEqual(['Sign in…', 'Open Git hosting settings']);
  });

  it('binds the picked account and announces it politely', async () => {
    const run = mountChip([INDIGITAL, GITLAB], { answer: { kind: 'menu', itemId: 'pick:0:1' } });
    chip().click();
    await flushPromises();
    expect(run.forge.chooseAccount).toHaveBeenCalledWith('repo-1', 'indigital', ADMIN.id);
    expect(run.wrapper.emitted('announce')).toEqual([['damocles now uses astef-admin on gitlab.indigital.gr.', false]]);
  });

  it("binds Git's own credentials as null, and alerts when main does not save", async () => {
    const run = mountChip([GITLAB], { answer: { kind: 'menu', itemId: 'own:0' }, saved: false });
    chip().click();
    await flushPromises();
    expect(run.forge.chooseAccount).toHaveBeenCalledWith('repo-1', 'gitlab.com', null);
    expect(run.wrapper.emitted('announce')).toEqual([['Damocles could not save this choice. Try again.', true]]);
  });

  it('opens Settings › Models & accounts › Git hosting at the server with its sign-in panel for Sign in to <server>…', async () => {
    const run = mountChip([GITLAB], { answer: { kind: 'menu', itemId: 'signIn:0' } });
    chip().click();
    await flushPromises();
    const menu = menuOf(run);
    expect(menu.caption).toBe('damocles · gitlab.com');
    expect(menu.items.filter((item): item is Item => item.kind === 'item').map((item) => item.label)).toEqual(['alexios-s', 'work-alexios', "Use Git's own credentials", 'Sign in to gitlab.com…', 'Open Git hosting settings']);
    expect(run.forge.openAccounts).toHaveBeenCalledWith({ serverId: 'gitlab.com', signIn: true });
  });

  it("leads the Sign in chip's menu with signing in, then Git's own credentials that hides the chip, then the settings", async () => {
    const run = mountChip([{ ...unresolved(GITLAB, 'signIn'), server: 'github.com', serverId: 'github.com', kind: 'github', accounts: [] }]);
    chip().click();
    await flushPromises();
    expect(menuOf(run).items.map((item) => (item.kind === 'separator' ? '-' : `${item.label}${item.kind === 'item' && item.hint ? ` (${item.hint})` : ''}`))).toEqual([
      'Sign in to github.com…',
      "Use Git's own credentials (Hides this for the project)",
      '-',
      'Open Git hosting settings',
    ]);
  });

  it('opens its menu from the keyboard with ArrowDown', async () => {
    const run = mountChip([GITLAB]);
    chip().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(run.requests).toHaveLength(1);
  });

  it('words the check-failure notice by what push uses meanwhile, and shows none for Git\'s own credentials or an account that must sign in again', () => {
    const t = shellI18n.global.t as (key: string, values: Record<string, unknown>) => string;
    expect(checkFailedNotice({ ...GITLAB, checkFailed: true }, t)).toBe('Damocles could not reach gitlab.com to check your accounts. Push still uses the account you chose.');
    expect(checkFailedNotice({ ...INDIGITAL, checkFailed: true }, t)).toBe('Damocles could not reach gitlab.indigital.gr to check your accounts. Push still uses astefanopoulos.');
    expect(checkFailedNotice({ ...unresolved(GITLAB, 'choose'), checkFailed: true }, t)).toBe('Damocles could not reach gitlab.com to check which of your accounts can push here.');
    expect(checkFailedNotice({ ...unresolved(GITLAB, 'ownCredentials'), checkFailed: true }, t)).toBeUndefined();
    expect(checkFailedNotice({ ...INDIGITAL, how: 'access', state: 'signInAgain', account: { ...ASTEF, needsSignIn: true }, checkFailed: true }, t)).toBeUndefined();
    expect(checkFailedNotice(GITLAB, t)).toBeUndefined();
  });

  it("shows no chip for a project whose only server was sent to Git's own credentials without an account there", () => {
    expect(chipServers({ projectKey: 'k', project: 'website', servers: [{ ...unresolved(GITLAB, 'ownCredentials'), accounts: [] }] })).toEqual([]);
    expect(chipServers({ projectKey: 'k', project: 'p', servers: [] })).toEqual([]);
    expect(chipServers(null)).toEqual([]);
    expect(chipServers({ projectKey: 'k', project: 'p', servers: [INDIGITAL] })).toHaveLength(1);
  });

  it("leaves out a server sent to Git's own credentials without an account there, while the project's other servers show", () => {
    const hidden: RepoServerAccounts = { ...unresolved(GITLAB, 'ownCredentials'), server: 'github.com', serverId: 'github.com', kind: 'github', accounts: [] };
    const servers = chipServers({ projectKey: 'k', project: 'damocles', servers: [hidden, INDIGITAL, GITLAB] });
    expect(servers.map((server) => server.serverId)).toEqual(['indigital', 'gitlab.com']);
    mountChip(servers);
    expect(chip().getAttribute('aria-label')).not.toContain('github.com');
    expect(label()).toBe('A astefanopoulos auto +1');
  });

  it('says SSO required or not approved by the organization for an account its organization refused', async () => {
    const { canPush: _astefPush, ...astef } = ASTEF;
    const { canPush: _adminPush, ...admin } = ADMIN;
    const run = mountChip([{ ...unresolved(INDIGITAL, 'choose'), accounts: [{ ...astef, ssoRequired: true }, { ...admin, appNotApproved: true }] }]);
    chip().click();
    await flushPromises();
    const accounts = menuOf(run).items.filter((item): item is Item => item.kind === 'item' && item.avatar !== undefined);
    expect(accounts.map((item) => item.hint)).toEqual(['Alexios Stefanopoulos · SSO required', 'Admin account · not approved by the organization']);
  });

  it('lines every label up in its menu: an icon sits in a slot of the avatar\'s size beside the account rows', async () => {
    const run = mountChip([GITLAB]);
    chip().click();
    await flushPromises();
    const menu = mount(ContextMenu, { props: { request: menuOf(run) }, global: { plugins: [shellI18n] }, attachTo: document.body });
    const leads = menu.findAll('[data-menu-item]').map((row) => row.element.firstElementChild!);
    expect(leads).toHaveLength(5);
    expect(leads.filter((lead) => lead.hasAttribute('data-menu-icon'))).toHaveLength(3);
    // ForgeAvatar's item size: every leading slot is as wide, so every label starts at the same edge
    expect(leads.map((lead) => lead.classList.contains('size-5'))).toEqual([true, true, true, true, true]);
    menu.unmount();
    const plain = mount(ContextMenu, { props: { request: { kind: 'menu', label: 'Plain', anchor: { x: 0, y: 0, width: 0, height: 0 }, items: [{ kind: 'item', id: 'a', label: 'With icon', icon: 'settings' }, { kind: 'item', id: 'b', label: 'Without' }] } }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(plain);
    expect(plain.findAll('[data-menu-icon]').map((slot) => slot.classes())).toEqual([
      expect.arrayContaining(['size-3.25']),
      expect.arrayContaining(['size-3.25']),
    ]);
  });
});

describe('AccountChip: a fixed label is whole or absent', () => {
  // happy-dom lays nothing out: a text needs 6px a character, and the header leaves it the room less 40px
  function layOut(room: Ref<number>): void {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return (this.textContent ?? '').length * 6;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return Math.min((this.textContent ?? '').length * 6, room.value - 40);
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('folds Choose account to its icon where it would be cut, keeps its words in the name and title, and unfolds when the room grows', async () => {
    const room = ref(100);
    layOut(room);
    mountChip([unresolved(GITLAB, 'choose')], { room });
    await flushPromises();
    expect(label()).toBe('');
    expect(chip().className).toContain('--d-warning');
    expect(chip().getAttribute('aria-label')).toBe('Accounts: gitlab.com, no account chosen');
    expect(chip().getAttribute('title')).toBe('gitlab.com, no account chosen');
    room.value = 200;
    await flushPromises();
    expect(label()).toBe('Choose account');
  });

  it('folds when it enters after the loading chip left, as Source Control shows it once the check settles', async () => {
    const room = ref(100);
    layOut(room);
    const shown = ref(false);
    const servers = [unresolved(GITLAB, 'choose')];
    const api = { forge: { chooseAccount: vi.fn(), openAccounts: vi.fn() }, requestOverlay: vi.fn() } as unknown as DamoclesShellApi;
    // ScmSection's out-in swap mounts the chip from the leave's end, outside a render flush
    const Parent = defineComponent({
      setup: () => () => h(Transition, { name: 't-chip', mode: 'out-in' }, () => (shown.value
        ? h(AccountChip, { api, repoId: 'repo-1', view: { projectKey: 'C:/work/damocles', project: 'damocles', servers }, servers, compact: false })
        : h('span', { 'data-testid': 'forge-account-chip-loading' }))),
    });
    mounted.push(mount(Parent, { global: { plugins: [shellI18n], provide: { [SECTION_CHIP_ROOM]: room }, stubs: { transition: false } }, attachTo: document.body }));
    shown.value = true;
    await vi.waitFor(() => expect(document.querySelector('[data-testid="forge-account-chip"]')).not.toBeNull());
    await flushPromises();
    expect(label()).toBe('');
  });

  it('measures the new label when the state changes', async () => {
    const room = ref(100);
    layOut(room);
    const run = mountChip([unresolved(GITLAB, 'choose')], { room });
    await flushPromises();
    expect(label()).toBe('');
    const signIn = [{ ...unresolved(GITLAB, 'signIn'), accounts: [] }];
    await run.wrapper.setProps({ servers: signIn, view: { projectKey: 'C:/work/damocles', project: 'damocles', servers: signIn } });
    await flushPromises();
    expect(label()).toBe('Sign in');
  });

  it('keeps a login, which is the user\'s data, cut with an ellipsis rather than folded', async () => {
    const room = ref(60);
    layOut(room);
    mountChip([INDIGITAL], { room });
    await flushPromises();
    expect(label()).toBe('A astefanopoulos auto');
  });
});
