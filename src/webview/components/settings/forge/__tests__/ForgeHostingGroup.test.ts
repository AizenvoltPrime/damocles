// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { applyLocale, i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage, type WebviewToExtensionMessage } from '@shared/types/messages';
import { MAX_FORGE_FIELD_CHARS, MAX_FORGE_TOKEN_CHARS, type ForgeAccountSummary, type ForgeAccountsState, type ForgeServerSummary, type ForgeSignInState } from '@shared/forge/accounts';
import { settingsViewHandlers, type SettingsHandlerContext } from '@/composables/message-handler/handlers/settings-handlers';
import { useUIStore } from '@/stores/useUIStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import SettingsModal from '../../SettingsModal.vue';
import { NO_HOST_SETTINGS, type SettingsScopeView } from '../../settings-rows';
import type { SettingsTarget } from '@shared/settings-sections';

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

let posted: WebviewToExtensionMessage[] = [];
const mounted: VueWrapper[] = [];

const REFUSAL = 'This token is missing the api scope. Create one with the scopes above and try again.';
const ALL_ROUTES = { browser: {}, device: {}, token: {} } as const;
const REDIRECTS = { gitlab: 'http://127.0.0.1/callback', github: 'http://127.0.0.1/callback' };

const GITHUB: ForgeServerSummary = {
  id: 'github.com', kind: 'github', flavor: 'github.com', host: 'github.com', baseUrl: 'https://github.com', builtIn: true,
  gitHosts: ['github.com', 'ssh.github.com'], pendingGitHosts: [], hasClientSecret: false, routes: ALL_ROUTES, tokenScopes: ['repo', 'workflow', 'read:user', 'user:email', 'read:org'],
};
const GITLAB: ForgeServerSummary = {
  id: 'gitlab.com', kind: 'gitlab', flavor: 'gitlab', host: 'gitlab.com', baseUrl: 'https://gitlab.com', builtIn: true,
  gitHosts: ['gitlab.com', 'altssh.gitlab.com'], pendingGitHosts: [], hasClientSecret: false, routes: ALL_ROUTES, tokenScopes: ['api'],
};
const INDIGITAL: ForgeServerSummary = {
  id: 'gitlab.indigital.gr', kind: 'gitlab', flavor: 'gitlab', host: 'gitlab.indigital.gr', baseUrl: 'https://gitlab.indigital.gr', builtIn: false,
  version: '17.9', gitHosts: ['gitlab.indigital.gr', 'git.indigital.gr'], pendingGitHosts: [], oauthClientId: 'indigital-app', hasClientSecret: false,
  redirectUri: 'http://127.0.0.1/callback', routes: ALL_ROUTES, tokenScopes: ['api'],
};
const ALEXIOS: ForgeAccountSummary = {
  id: 'gitlab.com|7', serverId: 'gitlab.com', login: 'alexios-s', name: 'Alexios S.', route: 'browser', scopes: ['api', 'write_repository'],
  agentShells: true, needsSignIn: false, addedAt: Date.UTC(2026, 10, 3, 12), bindings: { projects: 3, hosts: 1 }, orgAccess: [],
};
const ASTEF: ForgeAccountSummary = {
  id: 'gitlab.indigital.gr|11', serverId: 'gitlab.indigital.gr', login: 'astefanopoulos', name: 'Alexios Stefanopoulos', avatarKey: 'av-11', route: 'browser',
  scopes: ['api'], agentShells: true, needsSignIn: false, addedAt: Date.UTC(2026, 10, 1, 12), bindings: { projects: 1, hosts: 0 }, orgAccess: [],
};
const ADMIN: ForgeAccountSummary = {
  id: 'gitlab.indigital.gr|12', serverId: 'gitlab.indigital.gr', login: 'astef-admin', route: 'token', scopes: ['api'],
  agentShells: false, needsSignIn: true, needsSignInAt: Date.UTC(2026, 10, 7, 12), addedAt: Date.UTC(2026, 9, 1, 12), bindings: { projects: 0, hosts: 0 }, orgAccess: [],
};

function forgeState(over: Partial<ForgeAccountsState> = {}): ForgeAccountsState {
  return { status: 'ready', servers: [GITHUB, GITLAB, INDIGITAL], accounts: [ALEXIOS, ASTEF, ADMIN], notices: [], redirectUris: REDIRECTS, showAvatars: true, ...over };
}

function context(): SettingsHandlerContext {
  return { stores: { settingsStore: useSettingsStore(), uiStore: useUIStore(), extensionUiStore: useExtensionUiStore(), voiceJarvisStore: useVoiceJarvisStore() } };
}

type SettingsMessage = Extract<ExtensionToWebviewMessage, { type: keyof typeof settingsViewHandlers }>;

/** As a settings view gets core's message: its handler runs, and the panels listening on the bridge hear it. */
async function receive(message: SettingsMessage): Promise<void> {
  (settingsViewHandlers[message.type] as (message: SettingsMessage, ctx: SettingsHandlerContext) => void)(message, context());
  window.dispatchEvent(new MessageEvent('message', { data: message }));
  await flushPromises();
}

const signIn = (serverId: string, state: ForgeSignInState): Promise<void> => receive({ type: 'forgeSignInState', serverId, state });

async function open(options: { forge?: boolean; scopeView?: SettingsScopeView; target?: SettingsTarget } = {}): Promise<VueWrapper> {
  useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, forgeAccounts: options.forge ?? true });
  const wrapper = mount(SettingsModal, {
    props: { host: NO_HOST_SETTINGS, footer: { kind: 'hostSettings' }, backdrop: 'blur', target: options.target ?? { section: 'accounts' }, ...(options.scopeView ? { scopeView: options.scopeView } : {}) },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const q = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E | null => root.querySelector<E>(selector);
const byTestId = (id: string, root: ParentNode = document): HTMLElement | null => q(`[data-testid="${id}"]`, root);
const serverRow = (id: string): HTMLElement => byTestId(`settings-row-forge-server-${id}`)!;
const button = (name: string, root: ParentNode = document): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>('button')].find((each) => (each.getAttribute('aria-label') ?? each.textContent?.trim()) === name);
const radio = (name: string, root: ParentNode = document): HTMLButtonElement | undefined => [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((each) => each.textContent?.trim() === name);
const byLabel = (text: string): HTMLInputElement => {
  const label = [...document.querySelectorAll('label')].find((each) => each.textContent?.trim() === text)!;
  return document.getElementById(label.htmlFor) as HTMLInputElement;
};
const sent = <T extends WebviewToExtensionMessage['type']>(type: T): Extract<WebviewToExtensionMessage, { type: T }>[] => posted.filter((message): message is Extract<WebviewToExtensionMessage, { type: T }> => message.type === type);

async function click(element: HTMLElement | undefined): Promise<void> {
  if (!element) throw new Error('no such control');
  element.click();
  await flushPromises();
}

async function fill(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as WebviewToExtensionMessage));
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  applyLocale('en');
});

describe('Git hosting group: placement and states', () => {
  it('shows nothing where the host has no forge accounts (the VS Code build)', async () => {
    await open({ forge: false });
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    expect(byTestId('forge-hosting')).toBeNull();
    expect(document.body.textContent).not.toContain('Git hosting');
  });

  it('lists no Git hosting row on a scope tab that lists only the keys it may write (a remote chat\'s host and Project tabs)', async () => {
    await open({ scopeView: { listed: (meta) => (meta.keys ?? []).length > 0 } });
    expect(byTestId('forge-loading')).toBeNull();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ status: 'error', error: { kind: 'brokenFile', message: { message: 'Damocles could not read its accounts file.' } }, notices: [{ id: 'n1', kind: 'revokeFailed', message: { message: 'Revoke it by hand.' } }] }) });
    expect(byTestId('forge-hosting')).toBeNull();
    expect(byTestId('forge-error')).toBeNull();
    expect(byTestId('forge-notice')).toBeNull();
    expect(byTestId('forge-hosting-head')).toBeNull();
    expect(q('[data-testid^="settings-row-forge-"]')).toBeNull();
  });

  it('sits under the AI provider rows and shows a loading skeleton shaped like a server row until the first forgeAccountsChanged', async () => {
    await open();
    const loading = byTestId('forge-loading')!;
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.getAttribute('aria-label')).toBe('Loading Git hosting accounts');
    expect(loading.querySelectorAll('.d-sheen').length).toBeGreaterThan(0);
    const head = byTestId('forge-hosting-head')!;
    expect(head.textContent?.trim()).toBe('Git hosting');
    expect(byTestId('settings-row-account-anthropic')!.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(head.compareDocumentPosition(byTestId('settings-row-damocles.explore.model')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await receive({ type: 'forgeAccountsChanged', state: forgeState({ status: 'loading' }) });
    expect(byTestId('forge-loading')).not.toBeNull();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    expect(byTestId('forge-loading')).toBeNull();
    expect(serverRow('gitlab.com')).not.toBeNull();
  });

  it('keeps the rows readable under a broken file banner whose Show file asks core to reveal the file, and says why it could not', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ status: 'error', error: { kind: 'brokenFile', message: { message: 'Damocles could not read its accounts file.' } } }) });
    const banner = byTestId('forge-error')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('Damocles could not read its accounts file.');
    await click(button('Show file', banner));
    const reveal = sent('forgeRevealAccountsFile')[0]!;
    expect(reveal).toEqual({ type: 'forgeRevealAccountsFile', requestId: expect.any(String) });
    expect(serverRow('gitlab.indigital.gr').textContent).toContain('astefanopoulos');
    await receive({ type: 'forgeAccountActionResult', requestId: 'another-view', ok: false, message: { message: 'Not this one.' } });
    expect(byTestId('forge-reveal-error')).toBeNull();
    await receive({ type: 'forgeAccountActionResult', requestId: reveal.requestId, ok: false, message: { message: 'Damocles could not show the file.' } });
    const failed = byTestId('forge-reveal-error')!;
    expect(failed.getAttribute('role')).toBe('alert');
    expect(failed.textContent?.trim()).toBe('Damocles could not show the file.');
    expect(button('Show file', banner)!.getAttribute('aria-describedby')).toBe(failed.id);
  });

  it('offers neither Show file nor Add server when no file could be read', async () => {
    await open();
    const message = { message: 'Damocles could not read its Git hosting accounts. Restart Damocles to try again.' };
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ status: 'error', error: { kind: 'loadFailed', message }, servers: [], accounts: [] }) });
    const banner = byTestId('forge-error')!;
    expect(banner.textContent).toContain('Restart Damocles to try again.');
    expect(button('Show file', banner)).toBeUndefined();
    expect(byTestId('settings-row-forge-add-server')).toBeNull();
  });

  it('in the empty state gives gitlab.com a primary Add account that explains why, and github.com a plain one', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB], accounts: [] }) });
    const gitlab = button('Add account: gitlab.com')!;
    expect(gitlab.classList.contains('sm-button-primary')).toBe(true);
    expect(serverRow('gitlab.com').textContent).toContain('Sign in to push without a password prompt');
    expect(button('Add account: github.com')!.classList.contains('sm-button-primary')).toBe(false);
    expect(serverRow('github.com').textContent).toContain("Git's own credentials answer for github.com.");
  });

  it('draws server rows with their mark, a version badge for self-managed servers, Edit server for added ones, then Add server', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    const indigital = serverRow('gitlab.indigital.gr');
    expect(indigital.getAttribute('role')).toBe('group');
    expect(byTestId('forge-version-badge', indigital)!.textContent).toBe('GitLab 17.9');
    expect(indigital.textContent).toContain('Self-managed. Signs in through your own OAuth app.');
    expect(button('Edit server: gitlab.indigital.gr', indigital)).toBeDefined();
    expect(button('Edit server: gitlab.com')).toBeUndefined();
    expect(byTestId('forge-version-badge', serverRow('gitlab.com'))).toBeNull();
    expect(serverRow('gitlab.com').textContent).toContain('1 account');
    expect(serverRow('gitlab.com').querySelector('svg[data-forge-mark="gitlab"]')).not.toBeNull();
    expect(serverRow('github.com').querySelector('svg[data-forge-mark="github"]')).not.toBeNull();
    const addRow = byTestId('settings-row-forge-add-server')!;
    expect(addRow.textContent).toContain('Add a server');
    expect(indigital.compareDocumentPosition(addRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a failed revoke notice with its revoke page and dismiss, both through core', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ notices: [{ id: 'n1', kind: 'revokeFailed', message: { message: 'Revoke the token of alexios-s on gitlab.com by hand.' } }] }) });
    const notice = byTestId('forge-notice')!;
    expect(notice.getAttribute('role')).toBe('alert');
    await click(button('Open the revoke page', notice));
    await click(button('Dismiss', notice));
    expect(sent('forgeOpenPage')).toEqual([{ type: 'forgeOpenPage', page: 'revoke', noticeId: 'n1' }]);
    expect(sent('forgeDismissNotice')).toEqual([{ type: 'forgeDismissNotice', noticeId: 'n1' }]);
  });

  it('is localized', async () => {
    applyLocale('el');
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    expect(byTestId('forge-hosting-head')!.textContent?.trim()).toBe('Φιλοξενία Git');
    expect(button('Προσθήκη λογαριασμού: gitlab.com')).toBeDefined();
  });
});

describe('Git hosting group: account lines', () => {
  it('shows avatar, name, login and route, a status with its own icon and words, and Manage', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    const line = byTestId('forge-account-astefanopoulos')!;
    expect(line.textContent).toContain('Alexios Stefanopoulos');
    expect(line.textContent).toContain('astefanopoulos · browser sign-in');
    expect(line.querySelector('[role="status"]')!.textContent?.trim()).toBe('Signed in');
    expect(line.querySelector('.sm-account-dot')).not.toBeNull();
    const refused = byTestId('forge-account-astef-admin')!;
    expect(refused.querySelector('[role="status"]')!.textContent?.trim()).toBe('Token refused');
    expect(refused.querySelector('[role="status"] svg.lucide-triangle-alert')).not.toBeNull();
    expect(button('Manage: astef-admin on gitlab.indigital.gr')).toBeDefined();
  });

  it('fades the avatar in over the initial in a fixed box once it loads, and shows only the initial when avatars are off', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    const avatar = byTestId('forge-avatar', byTestId('forge-account-astefanopoulos')!)!;
    expect(avatar.textContent?.trim()).toBe('A');
    expect(avatar.classList.contains('size-7')).toBe(true);
    const image = byTestId('forge-avatar-image', avatar) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('app://damocles/forge/avatar/av-11');
    expect(image.classList.contains('absolute')).toBe(true);
    expect(image.classList.contains('opacity-0')).toBe(true);
    image.dispatchEvent(new Event('load'));
    await nextTick();
    expect(image.classList.contains('d-fade-in')).toBe(true);
    expect(byTestId('forge-avatar-image', byTestId('forge-account-alexios-s')!)).toBeNull();

    await receive({ type: 'forgeAccountsChanged', state: forgeState({ showAvatars: false }) });
    expect(byTestId('forge-avatar-image')).toBeNull();
  });

  it('names organization access problems on the line, and both actions ask core for the page', async () => {
    await open();
    const sso: ForgeAccountSummary = { ...ALEXIOS, id: 'github.com|1', serverId: 'github.com', login: 'astefanopoulos', orgAccess: [{ kind: 'ssoRequired', org: 'indigital' }, { kind: 'appNotApproved', org: 'acme' }] };
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ accounts: [sso] }) });
    const line = byTestId('forge-account-astefanopoulos')!;
    expect(line.textContent).toContain('acme has not approved Damocles');
    await click(button('Authorize Damocles for indigital', line));
    await click(button('Request approval', line));
    expect(sent('forgeOpenPage')).toEqual([
      { type: 'forgeOpenPage', page: 'orgAccess', accountId: 'github.com|1', org: 'indigital' },
      { type: 'forgeOpenPage', page: 'orgAccess', accountId: 'github.com|1', org: 'acme' },
    ]);
  });
});

describe('Git hosting group: Manage, the agent-shells switch and sign-out', () => {
  it('opens one account at a time, with the switch and its hint, the sign-in date and Sign in again', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: alexios-s on gitlab.com'));
    const manage = byTestId('forge-manage')!;
    const toggle = manage.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const hint = document.getElementById(toggle.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toContain("git in the agent's shells signs in as alexios-s on gitlab.com.");
    expect(document.getElementById(toggle.getAttribute('aria-labelledby')!)!.textContent).toBe('Agent shells may use this account');
    expect(manage.textContent).toMatch(/Signed in with the browser on (3 November 2026|November 3, 2026)\. The access token renews by itself\./);
    expect(button('Sign in again', manage)).toBeDefined();
    expect(button('Manage: alexios-s on gitlab.com')!.getAttribute('aria-expanded')).toBe('true');

    await click(button('Manage: astefanopoulos on gitlab.indigital.gr'));
    expect(document.querySelectorAll('[data-testid="forge-manage"]').length).toBe(1);
    expect(button('Manage: alexios-s on gitlab.com')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('holds the sent switch value through any publish until core answers that write, then announces it', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: alexios-s on gitlab.com'));
    const toggle = byTestId('forge-manage')!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await click(toggle);
    const write = sent('forgeSetAgentShells')[0]!;
    expect(write).toEqual({ type: 'forgeSetAgentShells', requestId: expect.any(String), accountId: 'gitlab.com|7', agentShells: false });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // a publish of Settings opening's checks lands before core handled the write
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ accounts: [{ ...ALEXIOS, agentShells: false }, ASTEF, ADMIN] }) });
    expect(byTestId('forge-manage')!.textContent).not.toContain('Agent shells no longer use alexios-s.');
    await receive({ type: 'forgeAccountActionResult', requestId: write.requestId, ok: true });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(byTestId('forge-manage')!.textContent).toContain('Agent shells no longer use alexios-s.');
    expect(byTestId('forge-manage')!.textContent).toContain("git in the agent's shells gets nothing for gitlab.com");
  });

  it('shows the stored switch value again with core\'s reason when it refuses the write', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: alexios-s on gitlab.com'));
    const toggle = byTestId('forge-manage')!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await click(toggle);
    const write = sent('forgeSetAgentShells')[0]!;
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await receive({ type: 'forgeAccountActionResult', requestId: write.requestId, ok: false, message: { message: 'Damocles could not save the change because {0} does not parse.', args: ['accounts.json'] } });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const error = byTestId('forge-agent-shells-error')!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent?.trim()).toBe('Damocles could not save the change because accounts.json does not parse.');
    expect(toggle.getAttribute('aria-describedby')).toContain(error.id);
  });

  it('shows a refused token warning first, the token note, and a primary Enter a new token that opens the Token route for that account', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: astef-admin on gitlab.indigital.gr'));
    const manage = byTestId('forge-manage')!;
    const first = manage.firstElementChild!;
    expect(first.getAttribute('role')).toBe('note');
    expect(first.textContent).toMatch(/gitlab\.indigital\.gr refused this token on (7 November 2026|November 7, 2026)\./);
    expect(manage.textContent).toContain('The agent could read this token. A personal access token does not renew');
    const enter = button('Enter a new token', manage)!;
    expect(enter.classList.contains('sm-button-primary')).toBe(true);
    await click(enter);
    expect(radio('Token', serverRow('gitlab.indigital.gr'))!.getAttribute('aria-checked')).toBe('true');
    await fill(byLabel('Personal access token'), 'glpat-new');
    await click(button('Sign in', serverRow('gitlab.indigital.gr')));
    expect(sent('forgeSignIn')).toEqual([{ type: 'forgeSignIn', serverId: 'gitlab.indigital.gr', route: 'token', token: 'glpat-new', agentShells: false, reauthAccountId: 'gitlab.indigital.gr|12' }]);
  });

  it('signs in again by the browser with the account\'s own agent-shells switch', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ accounts: [{ ...ALEXIOS, agentShells: false }, ASTEF, ADMIN] }) });
    await click(button('Manage: alexios-s on gitlab.com'));
    await click(button('Sign in again', byTestId('forge-manage')!));
    expect(radio('Browser', serverRow('gitlab.com'))!.getAttribute('aria-checked')).toBe('true');
    await click(button('Sign in with the browser', serverRow('gitlab.com')));
    expect(sent('forgeSignIn')).toEqual([{ type: 'forgeSignIn', serverId: 'gitlab.com', route: 'browser', agentShells: false, reauthAccountId: 'gitlab.com|7' }]);
  });

  it('starts the token route\'s switch at the account\'s own value on Sign in again', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: astefanopoulos on gitlab.indigital.gr'));
    await click(button('Sign in again', byTestId('forge-manage')!));
    await click(radio('Token', serverRow('gitlab.indigital.gr')));
    expect(byTestId('forge-sign-in')!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    await fill(byLabel('Personal access token'), 'glpat-new');
    await click(button('Sign in', serverRow('gitlab.indigital.gr')));
    expect(sent('forgeSignIn')).toEqual([{ type: 'forgeSignIn', serverId: 'gitlab.indigital.gr', route: 'token', token: 'glpat-new', agentShells: true, reauthAccountId: 'gitlab.indigital.gr|11' }]);
  });

  it('confirms sign-out in a dialog stating the revoke and the projects and hosts using it; Cancel sends nothing, Sign out sends it', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: alexios-s on gitlab.com'));
    await click(byTestId('forge-sign-out')!);
    const dialog = byTestId('forge-sign-out-confirm')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('Sign out of alexios-s on gitlab.com?');
    expect(dialog.textContent).toContain('Damocles revokes its token on the server and forgets which projects and hosts used this account.');
    expect(dialog.textContent).toContain('3 projects use it; they ask again the next time you push.');
    expect(dialog.textContent).toContain('It is the default account of 1 remote host.');
    await click(byTestId('confirm-cancel', dialog)!);
    expect(sent('forgeSignOut')).toEqual([]);

    await click(byTestId('forge-sign-out')!);
    await click(byTestId('confirm-action', byTestId('forge-sign-out-confirm')!)!);
    expect(sent('forgeSignOut')).toEqual([{ type: 'forgeSignOut', requestId: expect.any(String), accountId: 'gitlab.com|7' }]);
  });

  it('words a token account\'s sign-out as an attempt, and names no projects or hosts when none use it', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: astef-admin on gitlab.indigital.gr'));
    await click(byTestId('forge-sign-out')!);
    const dialog = byTestId('forge-sign-out-confirm')!;
    expect(dialog.textContent).toContain('Damocles tries to revoke this personal access token on the server');
    expect(dialog.textContent).not.toContain('uses it');
    expect(dialog.textContent).not.toContain('default account of');
  });

  it('reopens Manage with core\'s reason when it refuses a sign-out, and keeps the line', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Manage: alexios-s on gitlab.com'));
    await click(byTestId('forge-sign-out')!);
    await click(byTestId('confirm-action', byTestId('forge-sign-out-confirm')!)!);
    expect(byTestId('forge-manage')).toBeNull();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await receive({ type: 'forgeAccountActionResult', requestId: sent('forgeSignOut')[0]!.requestId, ok: false, message: { message: 'This account is no longer signed in.' } });
    const manage = byTestId('forge-manage', byTestId('forge-account-alexios-s')!)!;
    const error = byTestId('forge-sign-out-error', manage)!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent?.trim()).toBe('This account is no longer signed in.');
    expect(byTestId('forge-sign-out', manage)!.getAttribute('aria-describedby')).toBe(error.id);
  });
});

describe('Git hosting group: sign-in panel', () => {
  it('replays the sign-in journey: Token, the refusal shown verbatim with a shake, then Signed in as work-alexios', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    const add = button('Add account: gitlab.com')!;
    await click(add);
    expect(add.getAttribute('aria-expanded')).toBe('true');
    const row = serverRow('gitlab.com');
    expect([...row.querySelectorAll('span')].some((span) => span.textContent === 'Sign in to gitlab.com')).toBe(true);
    expect(row.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Sign-in method');
    await click(radio('Token', row));
    expect(radio('Token', row)!.getAttribute('aria-checked')).toBe('true');
    expect([...row.querySelectorAll('li')].map((chip) => chip.textContent?.trim())).toContain('api');
    const field = byLabel('Personal access token');
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    await fill(field, 'glpat-read-only');
    await click(button('Sign in', row));
    expect(sent('forgeSignIn')).toEqual([{ type: 'forgeSignIn', serverId: 'gitlab.com', route: 'token', token: 'glpat-read-only', agentShells: false }]);
    expect(byLabel('Personal access token').value).toBe('');

    await signIn('gitlab.com', { phase: 'starting' });
    await signIn('gitlab.com', { phase: 'finishing' });
    expect(row.textContent).toContain('Checking your account…');
    await signIn('gitlab.com', { phase: 'idle', error: { kind: 'input', message: { message: REFUSAL } } });
    const refusal = byTestId('forge-token-refusal')!;
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent?.trim()).toBe(REFUSAL);
    expect(byLabel('Personal access token').closest('.sm-input')!.classList.contains('d-shake')).toBe(true);
    expect(byLabel('Personal access token').getAttribute('aria-invalid')).toBe('true');

    await fill(byLabel('Personal access token'), 'glpat-Xq3vR8sT2mN6kP1wZ4yB');
    await click(button('Sign in', row));
    expect(sent('forgeSignIn')).toHaveLength(2);
    const added: ForgeAccountSummary = { ...ALEXIOS, id: 'gitlab.com|9', login: 'work-alexios', name: 'Alexios at Indigital', route: 'token', agentShells: false };
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ accounts: [ALEXIOS, added, ASTEF, ADMIN] }) });
    await signIn('gitlab.com', { phase: 'signedIn', accountId: 'gitlab.com|9', login: 'work-alexios' });
    const done = byTestId('forge-signed-in', row)!;
    expect(done.getAttribute('role')).toBe('status');
    expect(done.textContent?.trim()).toBe('Signed in as work-alexios');
    expect(byTestId('forge-sign-in')).toBeNull();
    expect(byTestId('forge-account-work-alexios')!.classList.contains('d-row-arrive')).toBe(true);
    expect(document.activeElement).toBe(button('Add account: gitlab.com'));
  });

  it('asks for a token before sending an empty one', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(radio('Token'));
    await click(button('Sign in', serverRow('gitlab.com')));
    expect(sent('forgeSignIn')).toEqual([]);
    expect(byTestId('forge-token-refusal')!.textContent?.trim()).toBe('Paste a token first.');
  });

  it('disables a route the server cannot offer and shows its reason as the hint', async () => {
    await open();
    const reason = { message: 'This build has no OAuth app for github.com. Sign in with a token.' };
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [{ ...GITHUB, routes: { browser: { reason }, device: { reason }, token: {} } }] }) });
    await click(button('Add account: github.com'));
    const browser = radio('Browser')!;
    expect(browser.disabled).toBe(true);
    expect(radio('Device code')!.disabled).toBe(true);
    expect(radio('Token')!.getAttribute('aria-checked')).toBe('true');
    const hint = document.getElementById(browser.getAttribute('aria-describedby')!)!;
    expect(hint.textContent?.trim()).toBe(`Browser, Device code: ${reason.message}`);
  });

  it('runs the browser phase: sends the route with agent shells on, reopens the page through core, and Cancel returns focus to Add account', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: github.com'));
    expect(radio('Browser')!.getAttribute('aria-checked')).toBe('true');
    await click(button('Sign in with the browser'));
    expect(sent('forgeSignIn')).toEqual([{ type: 'forgeSignIn', serverId: 'github.com', route: 'browser', agentShells: true }]);
    await signIn('github.com', { phase: 'browser' });
    expect(byTestId('forge-sign-in-status')!.textContent?.trim()).toBe('Waiting for the browser');
    expect(radio('Browser')).toBeUndefined();
    await click(byTestId('provider-sign-in-open-again')!);
    expect(sent('forgeOpenPage')).toEqual([{ type: 'forgeOpenPage', page: 'signIn', serverId: 'github.com' }]);
    byTestId('forge-sign-in-cancel')!.focus();
    await click(byTestId('forge-sign-in-cancel')!);
    expect(sent('forgeSignInCancel')).toEqual([{ type: 'forgeSignInCancel', serverId: 'github.com' }]);
    await signIn('github.com', { phase: 'idle', error: { kind: 'cancelled', message: { message: 'Sign-in cancelled.' } } });
    expect(byTestId('forge-sign-in')).toBeNull();
    expect(document.activeElement).toBe(button('Add account: github.com'));
  });

  it('runs the device phase: shows the code, focuses Copy, copies and opens through core, and counts down from expiresAt', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 9, 12));
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(radio('Device code'));
    button('Get a code')!.focus();
    await click(button('Get a code'));
    expect(sent('forgeSignIn')).toEqual([{ type: 'forgeSignIn', serverId: 'gitlab.com', route: 'device', agentShells: true }]);
    await signIn('gitlab.com', { phase: 'deviceCode', userCode: 'WDJB-MJHT', verificationUri: 'https://gitlab.com/oauth/device', expiresAt: Date.now() + 15 * 60_000 });
    expect(byTestId('provider-sign-in-code')!.textContent).toBe('WDJB-MJHT');
    expect(document.activeElement).toBe(byTestId('provider-sign-in-copy'));
    expect(byTestId('provider-sign-in-countdown')!.textContent).toContain('15:00');
    vi.advanceTimersByTime(8_000);
    await nextTick();
    expect(byTestId('provider-sign-in-countdown')!.textContent).toContain('14:52');

    await click(byTestId('provider-sign-in-copy')!);
    expect(sent('forgeSignInCopyCode')).toEqual([{ type: 'forgeSignInCopyCode', serverId: 'gitlab.com' }]);
    expect(sent('forgeOpenPage')).toEqual([{ type: 'forgeOpenPage', page: 'signIn', serverId: 'gitlab.com' }]);
    await receive({ type: 'forgeSignInCopyCodeAck', serverId: 'github.com', ok: true });
    expect(serverRow('gitlab.com').textContent).not.toContain('Code copied');
    await receive({ type: 'forgeSignInCopyCodeAck', serverId: 'gitlab.com', ok: true });
    expect(serverRow('gitlab.com').textContent).toContain('Code copied');

    await click(byTestId('forge-sign-in-cancel')!);
    expect(sent('forgeSignInCancel')).toEqual([{ type: 'forgeSignInCancel', serverId: 'gitlab.com' }]);
  });

  it('opens at a server with its sign-in panel for a forgeServer target, which the settled sign-in core posts again leaves open', async () => {
    await open({ target: { section: 'accounts', forgeServer: 'gitlab.com', forgeSignIn: true } });
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    const row = serverRow('gitlab.com');
    expect(byTestId('forge-sign-in', row)).not.toBeNull();
    expect(byTestId('forge-sign-in', serverRow('github.com'))).toBeNull();
    await signIn('gitlab.com', { phase: 'signedIn', accountId: ALEXIOS.id, login: ALEXIOS.login });
    expect(byTestId('forge-sign-in', row)).not.toBeNull();
    expect(byTestId('forge-signed-in', row)?.textContent?.trim() ?? '').toBe('');
  });

  it('opens at an account with its Manage open for a forgeAccount target (the refused notice\'s Open Git hosting settings)', async () => {
    const scrolled: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      scrolled.push(this.dataset['accountId'] ?? '');
    });
    await open({ target: { section: 'accounts', forgeServer: 'gitlab.indigital.gr', forgeAccount: ASTEF.id } });
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    const line = byTestId('forge-account-astefanopoulos')!;
    expect(byTestId('forge-manage', line)).not.toBeNull();
    expect(byTestId('forge-manage', byTestId('forge-account-astef-admin')!)).toBeNull();
    expect(button('Manage: astefanopoulos on gitlab.indigital.gr')!.getAttribute('aria-expanded')).toBe('true');
    expect(scrolled).toEqual([ASTEF.id]);
    // a later accounts change keeps what the user did since
    await click(button('Manage: astefanopoulos on gitlab.indigital.gr'));
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    expect(byTestId('forge-manage', line)).toBeNull();
  });

  it('opens no Manage for an account the target names on another server', async () => {
    await open({ target: { section: 'accounts', forgeServer: 'gitlab.com', forgeAccount: ASTEF.id } });
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    expect(byTestId('forge-manage')).toBeNull();
  });

  it('opens on a flow core is already running when the view attaches mid sign-in', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await signIn('gitlab.com', { phase: 'browser' });
    expect(byTestId('forge-sign-in', serverRow('gitlab.com'))).not.toBeNull();
    expect(button('Add account: gitlab.com')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the token page through core', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(radio('Token'));
    await click(button('Open the token page'));
    expect(sent('forgeOpenPage')).toEqual([{ type: 'forgeOpenPage', page: 'token', serverId: 'gitlab.com' }]);
  });
});

describe('Git hosting group: server form', () => {
  it('adds a server: kind, client id, git hosts, the redirect URI with Copy and the registration steps', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    const addServer = button('Add server', byTestId('settings-row-forge-add-server')!)!;
    await click(addServer);
    const form = byTestId('forge-server-form')!;
    expect(document.activeElement).toBe(byLabel('Server URL'));
    expect(byTestId('forge-redirect-uri', form)!.textContent).toBe(REDIRECTS.gitlab);
    expect(byTestId('forge-registration-steps', form)!.textContent).toContain('Untick Confidential.');
    expect(form.textContent).not.toContain('Client secret');

    await click(radio('GitHub Enterprise', form));
    expect(byTestId('forge-redirect-uri', form)!.textContent).toBe(REDIRECTS.github);
    expect(byLabel('Client secret').type).toBe('password');
    expect(byTestId('forge-registration-steps', form)!.textContent).toContain('Enable Device Flow');

    await click(byTestId('forge-copy-redirect-uri', form)!);
    const copy = sent('forgeCopyRedirectUri')[0]!;
    expect(copy).toMatchObject({ type: 'forgeCopyRedirectUri', kind: 'github' });
    await receive({ type: 'forgeCopyRedirectUriAck', requestId: copy.requestId, ok: true });
    expect(form.textContent).toContain('Copied');

    await fill(byLabel('Server URL'), ' https://ghe.example.com ');
    await fill(byLabel('OAuth app client id (optional)'), 'Iv1.abc');
    await fill(byLabel('Client secret'), 's3cret');
    await fill(byLabel('Other git hosts (optional)'), 'git.example.com, git2.example.com');
    await click(byTestId('forge-server-submit', form)!);
    const add = sent('forgeAddServer')[0]!;
    expect(add).toMatchObject({ url: 'https://ghe.example.com', kind: 'github', clientId: 'Iv1.abc', clientSecret: 's3cret', gitHosts: ['git.example.com', 'git2.example.com'] });
    expect(byLabel('Client secret').value).toBe('');
  });

  it('validates the URL on submit: names the fix from core, marks the field and focuses it', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add server', byTestId('settings-row-forge-add-server')!));
    await fill(byLabel('Server URL'), 'http://user@gitlab.example.com');
    await click(byTestId('forge-server-submit')!);
    const request = sent('forgeAddServer')[0]!;
    const fix = 'Use an https:// address without a user name, query or fragment.';
    byTestId('forge-server-cancel')!.focus();
    await receive({ type: 'forgeServerFormResult', requestId: request.requestId, ok: false, field: 'url', message: { message: fix } });
    const refusal = byTestId('forge-server-refusal')!;
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent?.trim()).toBe(fix);
    expect(byLabel('Server URL').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(byLabel('Server URL'));
  });

  it('closes on success and says what it added, which a later publish leaves as it is', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB], accounts: [] }) });
    await click(button('Add server', byTestId('settings-row-forge-add-server')!));
    await fill(byLabel('Server URL'), 'https://gitlab.indigital.gr');
    await click(byTestId('forge-server-submit')!);
    const request = sent('forgeAddServer')[0]!;
    await receive({ type: 'forgeServerFormResult', requestId: request.requestId, ok: true, serverId: 'gitlab.indigital.gr' });
    expect(byTestId('forge-server-form')).toBeNull();
    expect(byTestId('forge-server-outcome')!.textContent?.trim()).toBe('Added gitlab.indigital.gr.');
    // the version a later sign-in reads changes neither the words nor what the status line announces
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ accounts: [] }) });
    expect(byTestId('forge-server-outcome')!.textContent?.trim()).toBe('Added gitlab.indigital.gr.');
  });

  it('leaves the web host of a path-prefixed server out of Other git hosts', async () => {
    await open();
    const prefixed: ForgeServerSummary = { ...INDIGITAL, id: 'example.com/gitlab', host: 'example.com/gitlab', baseUrl: 'https://example.com/gitlab', gitHosts: ['example.com', 'git.example.com'] };
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB, prefixed], accounts: [] }) });
    await click(button('Edit server: example.com/gitlab'));
    expect(byLabel('Other git hosts (optional)').value).toBe('git.example.com');
  });

  it('edits a server filled in, and removes it only after a confirmation naming its accounts', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Edit server: gitlab.indigital.gr'));
    const form = byTestId('forge-server-form', serverRow('gitlab.indigital.gr'))!;
    expect(byLabel('Server URL').value).toBe('https://gitlab.indigital.gr');
    expect(byLabel('Server URL').disabled).toBe(true);
    expect(byLabel('OAuth app client id (optional)').value).toBe('indigital-app');
    expect(byLabel('Other git hosts (optional)').value).toBe('git.indigital.gr');
    await click(byTestId('forge-server-submit', form)!);
    expect(sent('forgeEditServer')[0]).toMatchObject({ serverId: 'gitlab.indigital.gr', clientId: 'indigital-app', gitHosts: ['git.indigital.gr'] });
    await receive({ type: 'forgeServerFormResult', requestId: sent('forgeEditServer')[0]!.requestId, ok: true, serverId: 'gitlab.indigital.gr' });

    await click(button('Edit server: gitlab.indigital.gr'));
    await click(byTestId('forge-server-remove')!);
    const dialog = byTestId('forge-remove-server-confirm')!;
    expect(dialog.textContent).toContain('Remove gitlab.indigital.gr?');
    expect(dialog.textContent).toContain('signs out of its 2 accounts first');
    expect(sent('forgeRemoveServer')).toEqual([]);
    await click(byTestId('confirm-action', dialog)!);
    expect(sent('forgeRemoveServer')[0]).toMatchObject({ serverId: 'gitlab.indigital.gr' });
    // Core publishes the list without the server before it answers, so the row and its form are gone first.
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB], accounts: [ALEXIOS] }) });
    expect(byTestId('settings-row-forge-server-gitlab.indigital.gr')).toBeNull();
    await receive({ type: 'forgeServerFormResult', requestId: sent('forgeRemoveServer')[0]!.requestId, ok: true, serverId: 'gitlab.indigital.gr' });
    expect(byTestId('forge-server-outcome')!.textContent?.trim()).toBe('Removed gitlab.indigital.gr.');
    expect(document.activeElement).toBe(button('Add server', byTestId('settings-row-forge-add-server')!));
  });
});

describe('Git hosting group: sign-in panel edge cases', () => {
  it('keeps an error with the route that failed, so another route shows no refusal', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: github.com'));
    await click(button('Sign in with the browser'));
    await signIn('github.com', { phase: 'starting' });
    await signIn('github.com', { phase: 'idle', error: { kind: 'network', message: { message: 'Port 53710 is in use. Sign in with a device code or a token.' } } });
    expect(byTestId('forge-sign-in-error')!.textContent?.trim()).toBe('Port 53710 is in use. Sign in with a device code or a token.');
    await click(radio('Token'));
    expect(byTestId('forge-token-refusal')).toBeNull();
    expect(byLabel('Personal access token').getAttribute('aria-invalid')).toBeNull();
    expect(byTestId('forge-sign-in-error')).toBeNull();
    await click(radio('Browser'));
    expect(byTestId('forge-sign-in-error')).not.toBeNull();
  });

  it('cancels a flow core has not answered yet, and its first states never reopen the closed panel', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: github.com'));
    await click(button('Sign in with the browser'));
    await click(byTestId('forge-sign-in-cancel')!);
    expect(sent('forgeSignInCancel')).toEqual([{ type: 'forgeSignInCancel', serverId: 'github.com' }]);
    expect(byTestId('forge-sign-in')).toBeNull();
    await signIn('github.com', { phase: 'starting' });
    expect(byTestId('forge-sign-in')).toBeNull();
    await signIn('github.com', { phase: 'idle', error: { kind: 'cancelled', message: { message: 'Sign-in cancelled.' } } });
    expect(byTestId('forge-sign-in')).toBeNull();
    await click(button('Add account: github.com'));
    expect(byTestId('forge-sign-in')).not.toBeNull();
  });

  it('keeps Cancel while finishing, says "Checking your account" once, and returns focus to the start button after a failure', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: github.com'));
    await click(button('Sign in with the browser'));
    await signIn('github.com', { phase: 'browser' });
    await signIn('github.com', { phase: 'finishing' });
    const panel = byTestId('forge-sign-in')!;
    const status = byTestId('forge-sign-in-status', panel)!;
    expect(status.classList.contains('sr-only')).toBe(true);
    expect(status.textContent?.trim()).toBe('Checking your account');
    expect(byTestId('forge-sign-in-checking', panel)!.getAttribute('aria-hidden')).toBe('true');
    const cancel = byTestId('forge-sign-in-cancel', panel)!;
    cancel.focus();
    await signIn('github.com', { phase: 'idle', error: { kind: 'provider', message: { message: 'github.com could not complete the sign-in.' } } });
    expect(document.activeElement).toBe(button('Sign in with the browser'));
    expect(byTestId('forge-sign-in-error')!.textContent?.trim()).toBe('github.com could not complete the sign-in.');
  });

  it('cancels a running flow from finishing too', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(button('Sign in with the browser'));
    await signIn('gitlab.com', { phase: 'finishing' });
    await click(byTestId('forge-sign-in-cancel')!);
    expect(sent('forgeSignInCancel')).toEqual([{ type: 'forgeSignInCancel', serverId: 'gitlab.com' }]);
  });

  it('shows core\'s refusal of a second sign-in in the panel that asked for it', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(button('Sign in with the browser', serverRow('gitlab.com')));
    await signIn('gitlab.com', { phase: 'browser' });
    await click(button('Add account: github.com'));
    await click(button('Sign in with the browser', serverRow('github.com')));
    await signIn('github.com', { phase: 'idle', error: { kind: 'input', message: { message: 'Finish or cancel the sign-in to {0} first.', args: ['gitlab.com'] } } });
    const refusal = byTestId('forge-sign-in-error', serverRow('github.com'))!;
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent?.trim()).toBe('Finish or cancel the sign-in to gitlab.com first.');
    expect(byTestId('forge-sign-in-error', serverRow('gitlab.com'))).toBeNull();
  });

  it('shows an expired device code\'s error, and Get a code starts over', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(radio('Device code'));
    await click(button('Get a code'));
    await signIn('gitlab.com', { phase: 'deviceCode', userCode: 'WDJB-MJHT', verificationUri: 'https://gitlab.com/oauth/device', expiresAt: Date.now() + 1000 });
    await signIn('gitlab.com', { phase: 'idle', error: { kind: 'expired', message: { message: 'The code expired. Get a new one.' } } });
    expect(byTestId('forge-sign-in-error')!.textContent?.trim()).toBe('The code expired. Get a new one.');
    await click(button('Get a code'));
    expect(sent('forgeSignIn')).toHaveLength(2);
    await signIn('gitlab.com', { phase: 'starting' });
    expect(byTestId('forge-sign-in-error')).toBeNull();
  });

  it('cancels a running flow from Add account, which no later state of it reopens', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(button('Sign in with the browser'));
    await signIn('gitlab.com', { phase: 'browser' });
    await click(button('Add account: gitlab.com'));
    expect(sent('forgeSignInCancel')).toEqual([{ type: 'forgeSignInCancel', serverId: 'gitlab.com' }]);
    expect(byTestId('forge-sign-in')).toBeNull();
    expect(button('Add account: gitlab.com')!.getAttribute('aria-expanded')).toBe('false');
    await signIn('gitlab.com', { phase: 'browser' });
    expect(byTestId('forge-sign-in')).toBeNull();
  });

  it('bounds the token field at the length core takes', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add account: gitlab.com'));
    await click(radio('Token'));
    expect(byLabel('Personal access token').maxLength).toBe(MAX_FORGE_TOKEN_CHARS);
  });
});

describe('Git hosting group: server form fields', () => {
  it('wires each field to its own error and hint, and shakes only the refused field', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add server', byTestId('settings-row-forge-add-server')!));
    for (const label of ['Server URL', 'OAuth app client id (optional)']) expect(byLabel(label).maxLength).toBe(MAX_FORGE_FIELD_CHARS);
    const urlHint = document.getElementById(byLabel('Server URL').getAttribute('aria-describedby')!)!;
    expect(urlHint.textContent).toContain('https only.');
    await fill(byLabel('Server URL'), 'https://gitlab.example.com');
    await fill(byLabel('OAuth app client id (optional)'), 'bad id');
    await click(byTestId('forge-server-submit')!);
    const fix = 'Paste the client id exactly as the server shows it.';
    await receive({ type: 'forgeServerFormResult', requestId: sent('forgeAddServer')[0]!.requestId, ok: false, field: 'clientId', message: { message: fix } });
    const clientId = byLabel('OAuth app client id (optional)');
    const error = document.getElementById(clientId.getAttribute('aria-describedby')!)!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent?.trim()).toBe(fix);
    expect(clientId.getAttribute('aria-invalid')).toBe('true');
    expect(clientId.closest('.sm-input')!.classList.contains('d-shake')).toBe(true);
    expect(byLabel('Server URL').closest('.sm-input')!.classList.contains('d-shake')).toBe(false);
    expect(document.activeElement).toBe(clientId);
    expect(new Set([...document.querySelectorAll('[data-testid="forge-server-form"] [id]')].map((element) => element.id)).size)
      .toBe(document.querySelectorAll('[data-testid="forge-server-form"] [id]').length);
  });

  it('asks for the client secret again after a refused save cleared it', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await click(button('Add server', byTestId('settings-row-forge-add-server')!));
    await click(radio('GitHub Enterprise'));
    expect(byLabel('Client secret').maxLength).toBe(MAX_FORGE_FIELD_CHARS);
    await fill(byLabel('Server URL'), 'https://ghe.example.com');
    await fill(byLabel('OAuth app client id (optional)'), 'Iv1.abc');
    await fill(byLabel('Client secret'), 's3cret');
    await click(byTestId('forge-server-submit')!);
    await receive({ type: 'forgeServerFormResult', requestId: sent('forgeAddServer')[0]!.requestId, ok: false, field: 'url', message: { message: 'This server is already in the list. Use its Add account button.' } });
    expect(byLabel('Client secret').value).toBe('');
    const hint = byTestId('forge-client-secret-hint')!;
    expect(hint.textContent?.trim()).toBe('Enter the client secret again. Damocles clears it after each save.');
    expect(byLabel('Client secret').getAttribute('aria-describedby')).toBe(hint.id);
    await fill(byLabel('Client secret'), 's');
    expect(byTestId('forge-client-secret-hint')!.textContent?.trim()).toBe('GitHub needs it for browser sign-in. It stays in this computer\'s secret store.');
  });
});

describe('Git hosting group: hosts found in clone addresses', () => {
  const learning: ForgeServerSummary = { ...INDIGITAL, pendingGitHosts: ['git2.indigital.gr', 'ci.indigital.gr'] };

  it('lists them in Edit server with why, and Confirm adds the host to Other git hosts once core answers', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB, learning] }) });
    expect(byTestId('forge-pending-hosts')).toBeNull();
    await click(button('Edit server: gitlab.indigital.gr'));
    const section = byTestId('forge-pending-hosts')!;
    expect(section.textContent).toContain("Damocles found these hosts in this server's clone addresses. It manages a host only after you confirm it");
    const list = section.querySelector('[aria-labelledby]')!;
    expect(document.getElementById(list.getAttribute('aria-labelledby')!)!.textContent).toBe('Hosts found in clone addresses');
    await click(button('Confirm git2.indigital.gr', section));
    const confirm = sent('forgeConfirmGitHost')[0]!;
    expect(confirm).toEqual({ type: 'forgeConfirmGitHost', requestId: expect.any(String), serverId: 'gitlab.indigital.gr', host: 'git2.indigital.gr' });
    expect(button('Confirm git2.indigital.gr', section)!.disabled).toBe(true);
    expect(byTestId('forge-pending-host-git2.indigital.gr')!.getAttribute('aria-busy')).toBe('true');
    // core publishes the server without the pending host before it answers
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB, { ...learning, gitHosts: [...learning.gitHosts, 'git2.indigital.gr'], pendingGitHosts: ['ci.indigital.gr'] }] }) });
    await receive({ type: 'forgeServerFormResult', requestId: confirm.requestId, ok: true, serverId: 'gitlab.indigital.gr' });
    expect(byLabel('Other git hosts (optional)').value).toBe('git.indigital.gr, git2.indigital.gr');
    const outcome = byTestId('forge-pending-host-outcome')!;
    expect(outcome.getAttribute('role')).toBe('status');
    expect(outcome.textContent?.trim()).toBe('Added git2.indigital.gr to Other git hosts.');
    expect(document.activeElement).toBe(button('Confirm ci.indigital.gr'));
    await click(byTestId('forge-server-submit')!);
    expect(sent('forgeEditServer')[0]).toMatchObject({ gitHosts: ['git.indigital.gr', 'git2.indigital.gr'] });
  });

  it('dismisses a host, and shows a refusal under that host with its buttons back', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB, learning] }) });
    await click(button('Edit server: gitlab.indigital.gr'));
    await click(button('Dismiss ci.indigital.gr'));
    const dismiss = sent('forgeDismissGitHost')[0]!;
    expect(dismiss).toMatchObject({ serverId: 'gitlab.indigital.gr', host: 'ci.indigital.gr' });
    const refused = 'This server is no longer in the list.';
    await receive({ type: 'forgeServerFormResult', requestId: dismiss.requestId, ok: false, field: 'gitHosts', message: { message: refused } });
    const item = byTestId('forge-pending-host-ci.indigital.gr')!;
    const error = byTestId('forge-pending-host-refusal', item)!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent?.trim()).toBe(refused);
    expect(button('Dismiss ci.indigital.gr', item)!.disabled).toBe(false);
    expect(button('Confirm ci.indigital.gr', item)!.getAttribute('aria-describedby')).toBe(error.id);
    // the form's own Save is not refused by a host's answer
    expect(byTestId('forge-server-refusal')).toBeNull();

    await click(button('Dismiss ci.indigital.gr', item));
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB, { ...learning, pendingGitHosts: ['git2.indigital.gr'] }] }) });
    await receive({ type: 'forgeServerFormResult', requestId: sent('forgeDismissGitHost')[1]!.requestId, ok: true, serverId: 'gitlab.indigital.gr' });
    expect(byTestId('forge-pending-host-outcome')!.textContent?.trim()).toBe('Dismissed ci.indigital.gr. Damocles does not propose it again.');
    expect(byLabel('Other git hosts (optional)').value).toBe('git.indigital.gr');
  });
});

describe('Git hosting group: search and wording', () => {
  async function search(text: string): Promise<void> {
    const input = byTestId('settings-search') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await flushPromises();
  }

  it('shows the Add server row for a search only its own words match', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await search('self-managed gitlab');
    expect(byTestId('settings-row-forge-add-server')).not.toBeNull();
    expect(byTestId('settings-row-forge-server-gitlab.com')).toBeNull();
  });

  it('finds a server by its host', async () => {
    await open();
    await receive({ type: 'forgeAccountsChanged', state: forgeState() });
    await search('indigital');
    expect(byTestId('settings-row-forge-server-gitlab.indigital.gr')).not.toBeNull();
    expect(byTestId('settings-row-forge-server-github.com')).toBeNull();
  });

  it('calls a ghe.com tenant with its own OAuth app a tenant, never self-managed', async () => {
    await open();
    const tenant: ForgeServerSummary = { ...GITHUB, id: 'acme.ghe.com', host: 'acme.ghe.com', baseUrl: 'https://acme.ghe.com', flavor: 'ghe.com', builtIn: false, oauthClientId: 'Iv1.acme', gitHosts: ['acme.ghe.com'], redirectUri: REDIRECTS.github };
    await receive({ type: 'forgeAccountsChanged', state: forgeState({ servers: [GITHUB, GITLAB, tenant], accounts: [] }) });
    const row = serverRow('acme.ghe.com');
    expect(row.textContent).toContain('GitHub Enterprise Cloud tenant. Signs in through your own OAuth app.');
    expect(row.textContent).not.toContain('Self-managed');
  });

  it('heads the group like the other Accounts groups, below the modal title\'s level', async () => {
    await open();
    expect(byTestId('forge-hosting-head')!.tagName).toBe('DIV');
  });
});
