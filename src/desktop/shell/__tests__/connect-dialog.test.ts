// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { HOST_PARSE_REFUSALS, SHARED_HOME_SEPARATOR, SSH_FAILURE_CODES, type ConnectStepEvent, type HostCardInfo, type HostParseResult, type NameCheck, type OverlayRequest, type PasswordlessResult, type PopupAnswer, type RemoteBrowseResult, type RemoveServerResult } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import HostNameField from '../overlay/components/HostNameField.vue';
import StepTimeline from '../overlay/components/StepTimeline.vue';
import RemoteFolderBrowser from '../overlay/components/RemoteFolderBrowser.vue';
import HostCard from '../overlay/components/HostCard.vue';
import InstallFolderField from '../overlay/components/InstallFolderField.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { failureText, hostNotices, refusalText } from '../overlay/connect-text';
import en from '../locales/en.json';
import el from '../locales/el.json';
import { breadcrumbs, childPath } from '../overlay/remote-paths';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi, opened, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];
const track = <T extends VueWrapper>(wrapper: T): T => {
  mounted.push(wrapper);
  return wrapper;
};
const global = { plugins: [shellI18n] };
const t = (key: string, values?: Record<string, unknown>, plural?: number): string => (plural === undefined ? shellI18n.global.t(key, values ?? {}) : shellI18n.global.t(key, values ?? {}, plural));

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const PROD: HostCardInfo = {
  hostId: 'h1',
  name: 'prod',
  destinationLabel: 'deploy@10.0.0.7:22',
  connection: 'offline',
  signInNeeded: false,
  recentFolders: ['/srv/app'],
  projectFolders: [],
  notices: [],
  allowBypass: false,
  passwordless: false,
  keyInstalledByDamocles: false,
  lingerEnabledByDamocles: false,
};

describe('host name field', () => {
  async function mountField(check: (name: string) => Promise<NameCheck | undefined>) {
    const wrapper = track(mount(HostNameField, { props: { label: 'Name', check, modelValue: 'billing-prod', 'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }) }, global, attachTo: document.body }));
    return wrapper;
  }

  it('shows main\'s refusal as the user types, names the clash, tints the field and shakes it on a refused Enter', async () => {
    const check = vi.fn(async (name: string): Promise<NameCheck> => (name.trim().toLowerCase() === 'prod' ? { ok: false, reason: 'taken', clashWith: 'prod' } : { ok: true, name: name.trim() }));
    const wrapper = await mountField(check);
    const input = wrapper.get('input');
    await input.setValue('Prod');
    await flushPromises();
    expect(check).toHaveBeenLastCalledWith('Prod');
    expect(wrapper.get('[role="alert"]').text()).toBe('Another host is already called prod');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(input.attributes('aria-describedby')).toBe(wrapper.get('[role="alert"]').attributes('id'));
    expect(input.classes()).toContain('border-(--d-danger)');
    expect(input.classes()).not.toContain('d-shake');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(input.classes()).toContain('d-shake');
    expect(wrapper.emitted('submit')).toBeUndefined();
    // the shake plays once per refusal: it comes off when it ends and goes back on at the next refused Enter
    await input.trigger('animationend');
    expect(input.classes()).not.toContain('d-shake');
    await input.setValue('billing');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(input.attributes('aria-invalid')).toBeUndefined();
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.emitted('submit')).toEqual([['billing']]);
  });

  it('localizes every refusal main gives, and ignores an answer to text the user has since replaced', async () => {
    for (const [reason, text] of [['empty', 'Enter a name.'], ['tooLong', 'Use at most 64 characters.'], ['controlChars', 'Remove the control characters.'], ['bidiChars', 'Remove the text direction characters.']] as const) {
      const wrapper = await mountField(async () => ({ ok: false, reason }));
      await wrapper.get('input').setValue('x');
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toBe(text);
    }
    let release: (check: NameCheck) => void = () => undefined;
    const slow = new Promise<NameCheck>((resolve) => { release = resolve; });
    const check = vi.fn().mockReturnValueOnce(slow).mockResolvedValue({ ok: true, name: 'ok' });
    const wrapper = await mountField(check);
    await wrapper.get('input').setValue('a\u202E');
    await wrapper.get('input').setValue('ok');
    await flushPromises();
    release({ ok: false, reason: 'bidiChars' });
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('says the name could not be checked when main\'s check fails, and Escape cancels', async () => {
    const wrapper = await mountField(async () => { throw new Error('ipc'); });
    await wrapper.get('input').setValue('x');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('The name could not be checked. Try again.');
    await wrapper.get('input').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
});

const step = (event: Partial<ConnectStepEvent>): ConnectStepEvent => ({ attemptId: 'a1', hostId: 'h1', step: 'connecting', visited: ['connecting'], notices: [], ...event });

describe('step timeline', () => {
  const mountTimeline = (event: ConnectStepEvent) => track(mount(StepTimeline, { props: { event, hostName: 'prod', otherDevices: 0, setInstallFolder: vi.fn(async () => ({ ok: true as const })) }, global, attachTo: document.body }));
  const rows = (wrapper: VueWrapper) => wrapper.findAll('li[data-step]').map((row) => [row.attributes('data-step'), row.attributes('data-state')]);

  it('lists the steps with the current one active and gives the progressbar the current step and its download progress', async () => {
    const wrapper = mountTimeline(step({ step: 'installing', visited: ['connecting', 'authenticating', 'checking', 'installing'], progress: 0.42 }));
    expect(rows(wrapper)).toEqual([['connecting', 'done'], ['authenticating', 'done'], ['checking', 'done'], ['installing', 'active'], ['starting', 'pending']]);
    const bar = wrapper.get('[role="progressbar"]');
    expect(bar.attributes()).toMatchObject({ 'aria-label': 'Connecting to prod', 'aria-valuemin': '0', 'aria-valuemax': '5', 'aria-valuenow': '3', 'aria-valuetext': 'Installing, 42%' });
    expect(wrapper.get('[data-testid="install-progress"]').attributes('style')).toContain('scaleX(0.42)');
    // the progressbar holds no interactive child, which its role would hide
    expect(bar.findAll('button, input').length).toBe(0);
    expect(wrapper.find('li[data-state="active"] .timeline-spinner').exists()).toBe(true);
    expect(wrapper.find('li[data-state="active"] .timeline-ellipsis').text()).toBe('…');
  });

  it('drops Installing once the attempt went past it, and reads Connected when it finished', async () => {
    const wrapper = mountTimeline(step({ step: 'starting', visited: ['connecting', 'authenticating', 'checking', 'starting'] }));
    expect(rows(wrapper).map(([name]) => name)).toEqual(['connecting', 'authenticating', 'checking', 'starting']);
    await wrapper.setProps({ event: step({ step: 'connected', visited: ['connecting', 'authenticating', 'checking', 'starting'] }) });
    expect(rows(wrapper).every(([, state]) => state === 'done')).toBe(true);
    expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({ 'aria-valuenow': '4', 'aria-valuetext': 'Connected' });
  });

  it('tints the failed step, says why in the user\'s language and offers Choose install folder after noexec', async () => {
    const wrapper = mountTimeline(step({ step: 'failed', visited: ['connecting', 'authenticating', 'checking'], failure: { code: 'noexec', params: { folder: '/home/u/.damocles/server' } } }));
    expect(rows(wrapper)).toEqual([['connecting', 'done'], ['authenticating', 'done'], ['checking', 'failed']]);
    expect(wrapper.get('[role="alert"]').text()).toBe('Programs cannot run from /home/u/.damocles/server on prod. Choose another install folder.');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toBe('Failed at Checking server');
    const choose = wrapper.findAll('button').find((button) => button.text() === 'Choose install folder');
    await choose!.trigger('click');
    expect(wrapper.find('input[aria-label="Install folder"]').exists()).toBe(true);
  });

  it('localizes every failure code main sends, and a changed host key offers no retry', () => {
    for (const code of ['glibcTooOld', 'timedOut', 'permissionDenied', 'hashMismatch', 'handshakeFailed'] as const) {
      const wrapper = mountTimeline(step({ step: 'failed', failure: { code, params: { found: '2.17', needed: '2.28' } } }));
      expect(wrapper.get('[role="alert"]').text()).not.toContain('remote.failure');
    }
    const glibc = mountTimeline(step({ step: 'failed', visited: ['connecting', 'authenticating', 'checking'], failure: { code: 'glibcTooOld', params: { found: '2.17', needed: '2.28' } } }));
    expect(glibc.get('[role="alert"]').text()).toBe('prod runs glibc 2.17. Damocles needs 2.28 or newer.');
    const changed = mountTimeline(step({ step: 'failed', failure: { code: 'hostKeyChanged', params: { host: 'prod' } } }));
    expect(changed.findAll('button').map((button) => button.text())).not.toContain('Retry');
  });

  it('asks for a secret in its step and answers with what the user typed', async () => {
    const wrapper = mountTimeline(step({ step: 'authenticating', visited: ['connecting', 'authenticating'], prompt: { promptId: 'p1', kind: 'secret', secretKind: 'password', text: 'deploy@10.0.0.7\'s password:' } }));
    await flushPromises();
    const field = wrapper.get('input[aria-label="Password"]');
    expect(field.attributes('type')).toBe('password');
    expect(document.activeElement).toBe(field.element);
    await field.setValue('hunter2');
    await wrapper.get('[data-testid="secret-prompt"]').trigger('submit');
    expect(wrapper.emitted('answer')).toEqual([['p1', 'hunter2', false]]);
    expect(wrapper.find('[data-testid="secret-remember"]').exists()).toBe(false);
  });

  it('masks every kind of secret, a code and an unknown prompt included, until the user shows it', async () => {
    for (const secretKind of ['password', 'passphrase', 'pin', 'otp', 'other'] as const) {
      const wrapper = mountTimeline(step({ step: 'authenticating', visited: ['connecting', 'authenticating'], prompt: { promptId: 'p1', kind: 'secret', secretKind, text: 'Enter PIN for authenticator:' } }));
      await flushPromises();
      const field = wrapper.get('[data-testid="secret-prompt"] input:not([role="checkbox"])');
      expect(field.attributes('type'), secretKind).toBe('password');
      const toggle = wrapper.get('[data-testid="secret-show"]');
      expect(toggle.attributes('type')).toBe('button');
      expect(toggle.attributes('aria-label')).toBe('Show typed text');
      expect(toggle.attributes('aria-pressed')).toBe('false');
      await toggle.trigger('click');
      expect(field.attributes('type'), secretKind).toBe('text');
      expect(toggle.attributes('aria-pressed')).toBe('true');
      expect(toggle.attributes('title')).toBe('Hide typed text');
      await toggle.trigger('click');
      expect(field.attributes('type'), secretKind).toBe('password');
      wrapper.unmount();
    }
  });

  it('labels a PIN field, and names the show toggle in en and el', async () => {
    const wrapper = mountTimeline(step({ step: 'authenticating', visited: ['connecting', 'authenticating'], prompt: { promptId: 'p1', kind: 'secret', secretKind: 'pin', text: 'Enter PIN for ED25519-SK key /home/ada/.ssh/id_ed25519_sk:' } }));
    await flushPromises();
    expect(wrapper.find('input[aria-label="PIN"]').exists()).toBe(true);
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      for (const key of ['pin', 'show', 'hide']) expect(shellI18n.global.te(`remote.timeline.secret.${key}`), `${locale} ${key}`).toBe(true);
      expect(shellI18n.global.te('remote.passwordless.failure.keyPairIncomplete'), locale).toBe(true);
    }
    shellI18n.global.locale.value = 'en';
  });

  it('offers Remember on this computer only when main does, unchecked, and answers with the choice', async () => {
    const asked = { promptId: 'p1', kind: 'secret' as const, secretKind: 'password' as const, text: "deploy@10.0.0.7's password:" };
    const wrapper = mountTimeline(step({ step: 'authenticating', visited: ['connecting', 'authenticating'], prompt: { ...asked, offerRemember: true } }));
    await flushPromises();
    const box = wrapper.get('[data-testid="secret-prompt"] [role="checkbox"]');
    expect(box.attributes('aria-checked')).toBe('false');
    expect(wrapper.get(`label[for="${box.attributes('id')}"]`).text()).toBe('Remember on this computer');
    await box.trigger('click');
    await wrapper.get('input[aria-label="Password"]').setValue('hunter2');
    await wrapper.get('[data-testid="secret-prompt"]').trigger('submit');
    expect(wrapper.emitted('answer')).toEqual([['p1', 'hunter2', true]]);
  });
});

describe('remote folder browser', () => {
  const LISTING: Extract<RemoteBrowseResult, { ok: true }> = { ok: true, path: '/srv', parent: '/', home: '/home/u', separator: '/', folders: [{ name: 'app', projectKey: 'ssh:h1|/srv/app' }, { name: 'backups' }, { name: 'billing' }, { name: 'reports' }] };
  async function mountBrowser(browse = vi.fn(async (path?: string): Promise<RemoteBrowseResult> => (path === '/srv/billing' ? { ...LISTING, path: '/srv/billing', parent: '/srv', folders: [] } : LISTING))) {
    const wrapper = track(mount(RemoteFolderBrowser, { props: { hostName: 'prod', recentFolders: ['/srv/app'], browse }, global, attachTo: document.body }));
    await flushPromises();
    return { wrapper, browse };
  }
  const list = (wrapper: VueWrapper) => wrapper.get('[role="listbox"]');
  const active = (wrapper: VueWrapper) => wrapper.find(`#${CSS.escape(list(wrapper).attributes('aria-activedescendant') ?? '-')}`);

  it('lists the folders in a focused listbox and marks the one that is already a project', async () => {
    const { wrapper } = await mountBrowser();
    expect(document.activeElement).toBe(list(wrapper).element);
    expect(list(wrapper).attributes('aria-label')).toBe('Folders');
    const options = wrapper.findAll('[role="option"]');
    expect(options.map((option) => option.text())).toEqual(['appAlready a project', 'backups', 'billing', 'reports']);
    expect(options[0]!.attributes('data-project-key')).toBe('ssh:h1|/srv/app');
    expect(options.slice(1).every((option) => option.find('[data-testid="already-project"]').exists() === false)).toBe(true);
    // a double-click enters the folder, never selects its name
    expect(options.every((option) => option.classes('select-none'))).toBe(true);
    expect(wrapper.findAll('nav[aria-label="Path"] button').map((button) => button.text())).toEqual(['/', 'srv']);
  });

  it('jumps by type-ahead: a prefix typed quickly, and a repeated letter cycles', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { wrapper } = await mountBrowser();
      await list(wrapper).trigger('keydown', { key: 'b' });
      expect(active(wrapper).text()).toBe('backups');
      await list(wrapper).trigger('keydown', { key: 'b' });
      expect(active(wrapper).text()).toBe('billing');
      vi.advanceTimersByTime(600);
      await list(wrapper).trigger('keydown', { key: 'r' });
      expect(active(wrapper).text()).toBe('reports');
      vi.advanceTimersByTime(600);
      await list(wrapper).trigger('keydown', { key: 'b' });
      await list(wrapper).trigger('keydown', { key: 'i' });
      expect(active(wrapper).text()).toBe('billing');
      expect(active(wrapper).attributes('aria-selected')).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks the folder that is already a project, which main selects instead of adding it again', async () => {
    const { wrapper } = await mountBrowser();
    await list(wrapper).trigger('keydown', { key: 'a' });
    await list(wrapper).trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('pick')).toEqual([['/srv/app']]);
  });

  it('enters a folder on double-click and opens the current folder when nothing is selected', async () => {
    const { wrapper, browse } = await mountBrowser();
    await wrapper.findAll('[role="option"]')[2]!.trigger('dblclick');
    await flushPromises();
    expect(browse).toHaveBeenLastCalledWith('/srv/billing');
    expect(wrapper.get('[data-testid="folder-target"]').text()).toBe('/srv/billing');
    await wrapper.findAll('button').find((button) => button.text() === 'Open')!.trigger('click');
    expect(wrapper.emitted('pick')).toEqual([['/srv/billing']]);
  });

  it('shows the newest listing asked for, whichever answers last, and stays busy until it answers', async () => {
    const answers = new Map<string, (result: RemoteBrowseResult) => void>();
    const browse = vi.fn((path?: string): Promise<RemoteBrowseResult> => (path === undefined ? Promise.resolve(LISTING) : new Promise((resolve) => answers.set(path, resolve))));
    const { wrapper } = await mountBrowser(browse);
    const target = () => wrapper.get('[data-testid="folder-target"]').text();
    const listingOf = (path: string, parent: string): RemoteBrowseResult => ({ ...LISTING, path, parent, folders: [] });
    await wrapper.findAll('[role="option"]')[1]!.trigger('dblclick');
    await wrapper.findAll('[role="option"]')[2]!.trigger('dblclick');
    answers.get('/srv/backups')!(listingOf('/srv/backups', '/srv'));
    await flushPromises();
    expect(target()).toBe('/srv');
    expect(list(wrapper).attributes('aria-busy')).toBe('true');
    answers.get('/srv/billing')!(listingOf('/srv/billing', '/srv'));
    await flushPromises();
    expect(target()).toBe('/srv/billing');
    expect(list(wrapper).attributes('aria-busy')).toBeUndefined();
    // the newer request answers first; the older answer that follows changes nothing
    const crumbs = () => wrapper.findAll('nav[aria-label="Path"] button');
    await crumbs()[0]!.trigger('click');
    await crumbs()[1]!.trigger('click');
    answers.get('/srv')!(LISTING);
    await flushPromises();
    expect(target()).toBe('/srv');
    answers.get('/')!(listingOf('/', ''));
    await flushPromises();
    expect(target()).toBe('/srv');
    expect(list(wrapper).attributes('aria-busy')).toBeUndefined();
  });

  it('names the folder and the helper macOS needs Full Disk Access for', async () => {
    const { wrapper } = await mountBrowser(vi.fn(async (path?: string): Promise<RemoteBrowseResult> => (path === '/Users/u/Documents' ? { ok: false, error: 'eperm-privacy', folder: '/Users/u/Documents' } : { ...LISTING, path: '/Users/u', folders: [{ name: 'Documents' }] })));
    await wrapper.get('[role="option"]').trigger('dblclick');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('macOS kept Damocles out of /Users/u/Documents. To open folders there, give /usr/libexec/sshd-keygen-wrapper Full Disk Access in System Settings, Privacy & Security, on that Mac.');
  });
});

describe('install folder field', () => {
  it('filters the folder browser on Enter without saving the path box', async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const browse = vi.fn(async (): Promise<RemoteBrowseResult> => ({ ok: true, path: '/srv', parent: '/', home: '/home/u', separator: '/', folders: [{ name: 'opt' }] }));
    const wrapper = track(mount(InstallFolderField, { props: { current: '/srv/damocles', hostName: 'prod', save, browse }, global, attachTo: document.body }));
    await wrapper.get('[data-testid="install-folder-browse"]').trigger('click');
    await flushPromises();
    const filter = wrapper.get<HTMLInputElement>('[data-testid="install-folder-browser"] input[aria-label="Filter folders"]');
    await filter.setValue('op');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    filter.element.dispatchEvent(enter);
    await flushPromises();
    // no form holds the filter, so Enter in it submits nothing
    expect(filter.element.form).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="install-folder-browser"]').exists()).toBe(true);
    await wrapper.get('[data-testid="install-folder-form"]').trigger('submit');
    expect(save).toHaveBeenCalledWith('/srv/damocles');
  });
});

describe('remote paths', () => {
  it('joins and splits POSIX and Windows paths at their own separator and root', () => {
    expect(childPath('/', 'srv', '/')).toBe('/srv');
    expect(childPath('/srv', 'app', '/')).toBe('/srv/app');
    expect(childPath('C:\\', 'Users', '\\')).toBe('C:\\Users');
    expect(breadcrumbs('/srv/app', '/')).toEqual([{ label: '/', path: '/' }, { label: 'srv', path: '/srv' }, { label: 'app', path: '/srv/app' }]);
    expect(breadcrumbs('C:\\Users\\u', '\\')).toEqual([{ label: 'C:\\', path: 'C:\\' }, { label: 'Users', path: 'C:\\Users' }, { label: 'u', path: 'C:\\Users\\u' }]);
  });
});

describe('host card', () => {
  it('shows a used-up watch limit with the inotify command, the probe notices, and warns about a clock skew past 2 minutes either way', () => {
    const views = hostNotices({ name: 'prod', notices: [{ code: 'watchLimit', params: { project: 'billing', suggested: 524288, limit: 8192 } }, { code: 'noGitBash', params: {} }], clockSkewMs: -185_000 }, t, 'en');
    expect(views).toEqual([
      { key: 'watchLimit', text: 'prod ran out of file watches for billing, so changes in some of its folders are not shown. Damocles changes nothing; to raise the limit, run:', command: 'sudo sysctl fs.inotify.max_user_watches=524288' },
      { key: 'noGitBash', text: 'Git Bash is not installed on prod, so the agent\'s Bash tool is unavailable there. The PowerShell tool still works.' },
      { key: 'clockSkew', text: 'prod\'s clock is 3 minutes behind this computer\'s. Sign-ins and file times may be wrong.' },
    ]);
    expect(hostNotices({ name: 'prod', notices: [], clockSkewMs: 119_000 }, t, 'en')).toEqual([]);
  });

  it('names the other machines sharing the home, with the plural for several, in English and Greek', () => {
    const shared = (hosts: string) => hostNotices({ name: 'prod', notices: [{ code: 'sharedHome', params: { hosts } }] }, t, shellI18n.global.locale.value);
    expect(shared('lab-03')).toEqual([{ key: 'sharedHome', text: 'lab-03 also runs Damocles in this home. Chats and memories are shared between them.' }]);
    expect(shared(['lab-03', 'lab-04', 'lab-05'].join(SHARED_HOME_SEPARATOR))[0]!.text).toBe('lab-03, lab-04, and lab-05 also run Damocles in this home. Chats and memories are shared between them.');
    shellI18n.global.locale.value = 'el';
    expect(shared('lab-03')[0]!.text).toBe('Το lab-03 εκτελεί επίσης το Damocles σε αυτόν τον αρχικό φάκελο. Οι συνομιλίες και οι μνήμες είναι κοινές μεταξύ τους.');
    expect(shared(['lab-03', 'lab-04'].join(SHARED_HOME_SEPARATOR))[0]!.text).toBe('Τα lab-03 και lab-04 εκτελούν επίσης το Damocles σε αυτόν τον αρχικό φάκελο. Οι συνομιλίες και οι μνήμες είναι κοινές μεταξύ τους.');
  });

  const mountCard = (rename = vi.fn(async (name: string): Promise<NameCheck> => ({ ok: true, name }))) => track(mount(HostCard, {
    props: { host: PROD, runs: [{ id: 'r1', title: 'npm run dev', state: 'running' as const, canOpen: false }, { id: 'r2', title: 'htop', state: 'background' as const, canOpen: true }], checkName: vi.fn(async (name: string): Promise<NameCheck> => (name === 'staging' ? { ok: false, reason: 'taken', clashWith: 'staging' } : { ok: true, name })), rename, setInstallFolder: vi.fn(async () => ({ ok: true as const })), browse: vi.fn(async () => undefined), allowBackgroundWork: vi.fn(async () => ({ result: 'enabled' as const })) },
    global,
    attachTo: document.body,
  }));

  it('renames in place: Escape restores the old name, a clash shakes and stays open, Enter saves', async () => {
    const rename = vi.fn(async (name: string): Promise<NameCheck> => ({ ok: true, name }));
    const wrapper = mountCard(rename);
    await wrapper.get('button[aria-label="Rename prod"]').trigger('click');
    await flushPromises();
    const field = () => wrapper.get<HTMLInputElement>('input[aria-label="Host name"]');
    expect(document.activeElement).toBe(field().element);
    await field().setValue('prod-x');
    await field().trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('input[aria-label="Host name"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="host-card-name"]').text()).toBe('prod');
    expect(rename).not.toHaveBeenCalled();
    await wrapper.get('button[aria-label="Rename prod"]').trigger('click');
    await flushPromises();
    await field().setValue('staging');
    await field().trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(field().classes()).toContain('d-shake');
    expect(wrapper.get('[role="alert"]').text()).toBe('Another host is already called staging');
    expect(rename).not.toHaveBeenCalled();
    await field().setValue('prod-1');
    await field().trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(rename).toHaveBeenCalledWith('prod-1');
    expect(wrapper.find('input[aria-label="Host name"]').exists()).toBe(false);
  });

  it('keeps the card named by the host while its heading is the name field', async () => {
    const wrapper = mountCard();
    const section = wrapper.get('[data-testid="host-card"]');
    await wrapper.get('button[aria-label="Rename prod"]').trigger('click');
    await flushPromises();
    const label = document.getElementById(section.attributes('aria-labelledby')!);
    expect(label?.textContent).toBe('prod');
    expect(label?.classList.contains('sr-only')).toBe(true);
  });

  it('says in place that a rename was not saved when main\'s call fails, keeping the field open', async () => {
    const wrapper = mountCard(vi.fn(async (): Promise<NameCheck> => {
      throw new Error('store write failed');
    }));
    await wrapper.get('button[aria-label="Rename prod"]').trigger('click');
    await flushPromises();
    const field = wrapper.get<HTMLInputElement>('input[aria-label="Host name"]');
    await field.setValue('prod-1');
    await field.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.get('[data-testid="host-name-error"]').text()).toBe('The name could not be saved. Try again.');
    expect(wrapper.find('input[aria-label="Host name"]').exists()).toBe(true);
    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(wrapper.get('[data-testid="host-name-error"]').text()).toBe('Δεν ήταν δυνατή η αποθήκευση του ονόματος. Δοκιμάστε ξανά.');
  });

  it('draws an uncolored host\'s icon muted, as its badge is, and a colored one in its tone', async () => {
    const wrapper = mountCard();
    expect(wrapper.get('[data-testid="host-card-icon"]').classes()).toContain('d-tone-muted');
    await wrapper.setProps({ host: { ...PROD, color: 'danger' } });
    expect(wrapper.get('[data-testid="host-card-icon"]').classes()).toContain('d-tone-danger');
  });

  it('shows a control or bidi character in a device name or a run title as its escape', () => {
    const wrapper = track(mount(HostCard, {
      props: { host: { ...PROD, connection: 'connected', devices: [{ deviceName: 'LAP\u202ETOP', self: true }] }, runs: [{ id: 'r1', title: 'top\u202Egol', state: 'running' as const, canOpen: false }], checkName: vi.fn(), rename: vi.fn(), setInstallFolder: vi.fn(), browse: vi.fn(), allowBackgroundWork: vi.fn() },
      global,
    }));
    expect(wrapper.get('[data-testid="host-device"]').text()).toContain('LAP\\u{202E}TOP');
    expect(wrapper.get('[data-testid="host-run"]').text()).toContain('top\\u{202E}gol');
    expect(wrapper.get('[data-testid="host-run"] button').attributes('aria-label')).toBe('Kill top\\u{202E}gol');
  });

  it('shows a used-up watch limit as a notice naming the project, with the sysctl command as code', () => {
    const wrapper = track(mount(HostCard, {
      props: { host: { ...PROD, connection: 'connected', notices: [{ code: 'watchLimit', params: { project: 'billing', suggested: 524288 } }] }, runs: [], checkName: vi.fn(), rename: vi.fn(), setInstallFolder: vi.fn(), browse: vi.fn(), allowBackgroundWork: vi.fn() },
      global,
    }));
    const notice = wrapper.get('[data-testid="host-notice"]');
    expect(notice.attributes('data-code')).toBe('watchLimit');
    expect(notice.text()).toContain('prod ran out of file watches for billing');
    expect(notice.get('code').text()).toBe('sudo sysctl fs.inotify.max_user_watches=524288');
  });

  it('shows the machines sharing the home as a notice with the people icon', () => {
    const wrapper = track(mount(HostCard, {
      props: { host: { ...PROD, connection: 'connected', notices: [{ code: 'sharedHome', params: { hosts: 'lab-03' } }] }, runs: [], checkName: vi.fn(), rename: vi.fn(), setInstallFolder: vi.fn(), browse: vi.fn(), allowBackgroundWork: vi.fn() },
      global,
    }));
    const notice = wrapper.get('[data-testid="host-notice"]');
    expect(notice.attributes('data-code')).toBe('sharedHome');
    expect(notice.text()).toBe('lab-03 also runs Damocles in this home. Chats and memories are shared between them.');
    expect(notice.find('svg.lucide-users').exists()).toBe(true);
    expect(notice.find('code').exists()).toBe(false);
  });

  it('lists the running terminals with Kill on each and Open on one this device can show, and asks for the log', async () => {
    const wrapper = mountCard();
    const rows = wrapper.findAll('[data-testid="host-run"]');
    expect(rows.map((row) => row.findAll('button').map((button) => [button.attributes('aria-label'), button.text()]))).toEqual([
      [['Kill npm run dev', 'Kill']],
      [['Open htop', 'Open'], ['Kill htop', 'Kill']],
    ]);
    await wrapper.get('button[aria-label="Kill npm run dev"]').trigger('click');
    expect(wrapper.emitted('kill')).toEqual([['r1']]);
    await wrapper.get('button[aria-label="Open htop"]').trigger('click');
    expect(wrapper.emitted('openRun')).toEqual([['r2']]);
    await wrapper.findAll('button').find((button) => button.text() === 'Show log')!.trigger('click');
    expect(wrapper.emitted('showLog')).toHaveLength(1);
  });
});

describe('connect dialog', () => {
  let api: FakeOverlayApi;
  beforeEach(() => {
    api = fakeOverlayApi();
    FakeResizeObserver.instances = [];
  });

  async function openConnect(request: Partial<Extract<OverlayRequest, { kind: 'connect' }>> = {}): Promise<VueWrapper> {
    const wrapper = track(mount(OverlayApp, {
      props: { api, settingsBridge: createOverlaySettingsBridge(api) },
      global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    }));
    await flushPromises();
    api.request('c1', { kind: 'connect', hosts: [PROD], sshConfigAliases: ['lab'], ...request });
    await flushPromises();
    await flushPromises();
    return wrapper;
  }
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const press = (key: string): void => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

  it('opens on the host list with the search box focused, cards for saved hosts and ssh aliases, and arrow keys between them', async () => {
    await openConnect();
    expect(dialog().getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Connect to host');
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Search hosts or enter a new one'));
    const cards = [...dialog().querySelectorAll<HTMLElement>('[data-connect-card]')];
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(['prod, deploy@10.0.0.7:22, Not connected', 'lab, from ~/.ssh/config']);
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[0]);
    press('ArrowDown');
    expect(document.activeElement).toBe(cards[1]);
    press('ArrowUp');
    press('ArrowUp');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search hosts or enter a new one');
  });

  it('staggers the first 8 cards 40 ms apart, saved hosts then aliases, and enters every later card with the eighth', async () => {
    const hosts = Array.from({ length: 6 }, (_, index) => ({ ...PROD, hostId: `h${index}`, name: `prod-${index}` }));
    await openConnect({ hosts, sshConfigAliases: ['a', 'b', 'c', 'd'] });
    const delays = [...dialog().querySelectorAll<HTMLElement>('.host-card')].map((card) => card.style.getPropertyValue('--card-index'));
    expect(delays).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '7', '7']);
  });

  it('parses a typed host live, shows its options as written and names a refused option', async () => {
    vi.mocked(api.parseHost).mockImplementation(async (input: string) => (input.includes('-F')
      ? opened({ ok: false as const, refused: '-F', reason: 'option' as const })
      : opened({ ok: true as const, destinationLabel: 'deploy@10.0.0.9', options: [{ name: '-J', value: 'jump@bastion:2222' }], prefillName: '10.0.0.9', nameCheck: { ok: true as const, name: '10.0.0.9' } })));
    await openConnect();
    const search = dialog().querySelector<HTMLInputElement>('input')!;
    search.value = 'ssh -J jump@bastion:2222 deploy@10.0.0.9';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="new-host-card"]')!.textContent).toContain('Connect to deploy@10.0.0.9');
    expect([...dialog().querySelectorAll('[data-testid="parsed-options"] li')].map((item) => item.textContent?.trim())).toEqual(['-J jump@bastion:2222']);
    search.value = 'ssh -F /tmp/x deploy@10.0.0.9';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="new-host-card"]')).toBeNull();
    expect(dialog().querySelector('[role="alert"]')!.textContent!.trim()).toBe('-F is not allowed. Damocles passes only -l, -p, -i, -J, -4, -6, -C and allowed -o options to ssh.');
  });

  it('holds back a missing value while the typed text still matches a card, and shows a refused value at once', async () => {
    let reason: 'missing' | 'value' = 'missing';
    vi.mocked(api.parseHost).mockImplementation(async () => opened({ ok: false as const, refused: 'Port', reason }));
    await openConnect();
    const search = dialog().querySelector<HTMLInputElement>('input')!;
    search.value = 'deploy@10.0.0.7';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="new-host-refused"]')).toBeNull();
    reason = 'value';
    search.value = 'deploy@10.0.0.';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="new-host-refused"]')!.textContent!.trim()).toBe('The value given to Port is not allowed.');
  });

  it('names a new host before saving it, prefilled, and starts the attempt with the name main accepted', async () => {
    vi.mocked(api.parseHost).mockResolvedValue(opened({ ok: true as const, destinationLabel: 'deploy@10.0.0.9', options: [], prefillName: '10.0.0.9', nameCheck: { ok: true as const, name: '10.0.0.9' } }));
    vi.mocked(api.checkHostName).mockImplementation(async (name: string) => opened(name.trim().toLowerCase() === 'prod' ? { ok: false as const, reason: 'taken' as const, clashWith: 'prod' } : { ok: true as const, name: name.trim() }));
    await openConnect();
    const search = dialog().querySelector<HTMLInputElement>('input')!;
    search.value = 'deploy@10.0.0.9';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    dialog().querySelector<HTMLElement>('[data-testid="new-host-card"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('input[aria-label="Name"]')).not.toBeNull());
    const name = dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(name.value).toBe('10.0.0.9');
    await vi.waitFor(() => expect(document.activeElement).toBe(name));
    name.value = 'Prod';
    name.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('Another host is already called prod');
    name.value = 'billing-prod';
    name.dispatchEvent(new Event('input'));
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenCalledWith({ input: 'deploy@10.0.0.9', name: 'billing-prod' }));
    await vi.waitFor(() => expect(dialog().querySelector('[role="progressbar"]')).not.toBeNull());
  });

  it('offers a new host only for the text in the box now, never the parse of what was typed before', async () => {
    const pending = new Map<string, (result: PopupAnswer<HostParseResult>) => void>();
    vi.mocked(api.parseHost).mockImplementation((input: string) => new Promise((resolve) => pending.set(input, resolve)));
    const parsedAs = (destination: string) => opened({ ok: true as const, destinationLabel: destination, options: [], prefillName: destination, nameCheck: { ok: true as const, name: destination } });
    await openConnect();
    const search = dialog().querySelector<HTMLInputElement>('input')!;
    const type = (text: string) => {
      search.value = text;
      search.dispatchEvent(new Event('input'));
    };
    type('deploy@10.0.0.9');
    await flushPromises();
    pending.get('deploy@10.0.0.9')!(parsedAs('deploy@10.0.0.9'));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="new-host-card"]')!.textContent).toContain('deploy@10.0.0.9');
    type('deploy@10.0.0.99');
    await flushPromises();
    expect(dialog().querySelector('[data-testid="new-host-card"]')).toBeNull();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(dialog().querySelector('input[aria-label="Name"]')).toBeNull();
    pending.get('deploy@10.0.0.99')!(parsedAs('deploy@10.0.0.99'));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="new-host-card"]')!.textContent).toContain('deploy@10.0.0.99');
  });

  it('opens a saved host\'s card with its name field open from the failed timeline\'s Edit host, and a new host\'s typed text from it', async () => {
    vi.mocked(api.startConnect).mockResolvedValue(opened({ ok: true as const, attemptId: 'a1', hostId: 'h1' }));
    await openConnect({ hostId: 'h1' });
    api.connectStep(step({ step: 'failed', failure: { code: 'refused', params: {} } }));
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Retry'));
    [...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Edit host')!.click();
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Host name'));
    expect(dialog().querySelector('[data-testid="host-card"]')).not.toBeNull();
    expect(api.hostRuns).toHaveBeenCalledWith('h1');

    vi.mocked(api.parseHost).mockResolvedValue(opened({ ok: true as const, destinationLabel: 'deploy@10.0.0.9', options: [], prefillName: '10.0.0.9', nameCheck: { ok: true as const, name: '10.0.0.9' } }));
    vi.mocked(api.startConnect).mockResolvedValue(opened({ ok: true as const, attemptId: 'a2', hostId: 'h2' }));
    dialog().querySelector<HTMLInputElement>('input[aria-label="Host name"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    [...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Back')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('input[aria-label="Search hosts or enter a new one"]')).not.toBeNull());
    const search = dialog().querySelector<HTMLInputElement>('input[aria-label="Search hosts or enter a new one"]')!;
    search.value = 'deploy@10.0.0.9';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    dialog().querySelector<HTMLElement>('[data-testid="new-host-card"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('input[aria-label="Name"]')).not.toBeNull());
    dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenLastCalledWith({ input: 'deploy@10.0.0.9', name: '10.0.0.9' }));
    api.connectStep(step({ attemptId: 'a2', hostId: 'h2', step: 'failed', failure: { code: 'refused', params: {} } }));
    await vi.waitFor(() => expect([...dialog().querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Edit host')).toBe(true));
    [...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Edit host')!.click();
    await vi.waitFor(() => expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Search hosts or enter a new one"]')?.value).toBe('deploy@10.0.0.9'));
  });

  it('runs a saved host\'s attempt in the timeline, and Escape cancels it and closes the dialog', async () => {
    vi.mocked(api.startConnect).mockResolvedValue(opened({ ok: true as const, attemptId: 'a1', hostId: 'h1' }));
    await openConnect({ hostId: 'h1' });
    expect(api.startConnect).toHaveBeenCalledWith({ hostId: 'h1' });
    api.connectStep(step({ step: 'authenticating', visited: ['connecting', 'authenticating'] }));
    await vi.waitFor(() => expect(dialog().querySelector('[role="progressbar"]')).not.toBeNull());
    expect(dialog().querySelector('[role="progressbar"]')!.getAttribute('aria-valuetext')).toBe('Authenticating');
    press('Escape');
    await flushPromises();
    expect(api.cancelConnect).toHaveBeenCalledWith('a1');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'dismissed' }));
  });

  it('moves focus from the vanished Cancel to the failed step\'s first action', async () => {
    vi.mocked(api.startConnect).mockResolvedValue(opened({ ok: true as const, attemptId: 'a1', hostId: 'h1' }));
    await openConnect({ hostId: 'h1' });
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toMatch(/^Cancel/));
    api.connectStep(step({ step: 'failed', failure: { code: 'refused', params: {} } }));
    await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Retry'));
  });

  it('asks about an unknown host key in an alert dialog and answers ssh with Connect', async () => {
    await openConnect({ hostId: 'h1', attempt: step({ step: 'connecting', prompt: { promptId: 'k1', kind: 'hostKey', host: '10.0.0.7', keyType: 'ED25519', fingerprint: 'SHA256:q3V8k1Lr9yGfT0w2' } }) });
    const alert = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="host-key-unknown"]')!;
    expect(alert.textContent).toContain('First connection to prod');
    expect(alert.querySelector('[data-testid="host-key-fingerprint"]')!.textContent).toBe('ED25519 SHA256:q3V8k1Lr9yGfT0w2');
    expect(api.startConnect).not.toHaveBeenCalled();
    [...alert.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Connect')!.click();
    await flushPromises();
    expect(api.answerConnect).toHaveBeenCalledWith('a1', 'k1', 'connect', false);
  });

  it('shows a changed host key as a danger alert dialog with the ssh-keygen command to copy and no retry', async () => {
    await openConnect({ hostId: 'h1', attempt: step({ step: 'failed', visited: ['connecting'], failure: { code: 'hostKeyChanged', params: { host: '[10.0.0.7]:2222', command: 'ssh-keygen -R "[10.0.0.7]:2222"' } } }) });
    const alert = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="host-key-changed"]')!;
    expect(alert.textContent).toContain('prod\'s host key has changed');
    // opened with the dialog, the modal stacks over it: assistive tech finds the modal, not the dialog behind it
    expect(alert.closest('[aria-hidden="true"]')).toBeNull();
    expect(dialog().closest('[aria-hidden="true"]')).not.toBeNull();
    // main's command, quoted for this computer's shell, shown exactly as main copies it
    expect(alert.querySelector('[data-testid="host-key-command"]')!.textContent).toBe('ssh-keygen -R "[10.0.0.7]:2222"');
    expect(document.activeElement?.textContent?.trim()).toBe('Close');
    [...alert.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Copy command')!.click();
    await flushPromises();
    expect(api.copyHostKeyCommand).toHaveBeenCalledWith('h1');
    expect([...dialog().querySelectorAll('button')].map((button) => button.textContent?.trim())).not.toContain('Retry');
  });

  it('offers no command to copy when main names no known_hosts host for a changed key', async () => {
    await openConnect({ hostId: 'h1', attempt: step({ step: 'failed', visited: ['connecting'], failure: { code: 'hostKeyChanged', params: {} } }) });
    const alert = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="host-key-changed"]')!;
    expect(alert.querySelector('[data-testid="host-key-command"]')).toBeNull();
    expect([...alert.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['Close']);
  });

  it('opens a connected host\'s folders straight away and picks one through main', async () => {
    await openConnect({ hosts: [{ ...PROD, connection: 'connected' }], hostId: 'h1' });
    await vi.waitFor(() => expect(api.browseHost).toHaveBeenCalledWith('h1', undefined));
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Open a folder on prod');
    [...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === '/srv/app')!.click();
    await flushPromises();
    expect(api.pickHostFolder).toHaveBeenCalledWith('h1', '/srv/app');
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'dismissed' }));
  });

  it('is a remote core\'s file picker: the same folder browser, inside its roots, listing files and answering the picked file', async () => {
    vi.mocked(api.browseHost).mockImplementation(async (_hostId: string, path?: string) => opened(path === '/srv/app/docs'
      ? { ok: true as const, path, parent: '/srv/app', home: '/srv/app', root: '/srv/app', separator: '/' as const, folders: [], files: ['plan.md'] }
      : { ok: true as const, path: '/srv/app', home: '/srv/app', root: '/srv/app', separator: '/' as const, folders: [{ name: 'docs' }], files: ['README.md'] }));
    await openConnect({ hosts: [], sshConfigAliases: [], hostId: 'h1', pick: { mode: 'file', hostName: 'prod', roots: ['/srv/app'], title: 'Select Plan File to Inject' } });
    await vi.waitFor(() => expect(api.browseHost).toHaveBeenCalledWith('h1', undefined));
    expect(dialog().getAttribute('data-testid')).toBe('connect-dialog');
    expect(dialog().getAttribute('data-pick-mode')).toBe('file');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('prod: Select Plan File to Inject');
    expect(dialog().querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Folders and files');
    const entries = () => [...dialog().querySelectorAll<HTMLElement>('[data-testid="folder-entry"]')];
    await vi.waitFor(() => expect(entries().map((entry) => [entry.dataset['kind'], entry.textContent?.trim()])).toEqual([['folder', 'docs'], ['file', 'README.md']]));
    // no crumb above the root, the roots as chips, and Choose waits for a file
    expect([...dialog().querySelectorAll('nav[aria-label="Path"] button')].map((button) => button.textContent?.trim())).toEqual(['app']);
    expect([...dialog().querySelectorAll('[data-testid="recent-folder"]')].map((chip) => chip.textContent?.trim())).toEqual(['/srv/app']);
    const confirm = () => dialog().querySelector<HTMLButtonElement>('[data-testid="folder-browser-confirm"]')!;
    expect(confirm().textContent?.trim()).toBe('Choose');
    expect(confirm().disabled).toBe(true);
    entries()[0]!.click();
    await flushPromises();
    expect(confirm().disabled).toBe(true);
    entries()[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await vi.waitFor(() => expect(entries().map((entry) => entry.textContent?.trim())).toEqual(['plan.md']));
    entries()[0]!.click();
    await flushPromises();
    confirm().click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'connect', path: '/srv/app/docs/plan.md' }));
    // a picker adds no project
    expect(api.pickHostFolder).not.toHaveBeenCalled();
  });

  it('is a remote core\'s folder picker with its button label, and Cancel answers nothing picked', async () => {
    await openConnect({ hosts: [], sshConfigAliases: [], hostId: 'h1', pick: { mode: 'folder', hostName: 'prod', roots: ['/home/u'], buttonLabel: 'Use Folder' } });
    await vi.waitFor(() => expect(api.browseHost).toHaveBeenCalledWith('h1', undefined));
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Choose a folder on prod');
    expect(dialog().querySelector('[data-testid="folder-browser-confirm"]')?.textContent?.trim()).toBe('Use Folder');
    dialog().querySelector<HTMLButtonElement>('[data-testid="folder-browser-cancel"]')!.click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'dismissed' }));
  });

  it('opens a host\'s card from its details button, kills a run and follows a rename main pushes', async () => {
    vi.mocked(api.hostRuns).mockResolvedValue(opened([{ id: 'r1', title: 'bash', state: 'running' as const, canOpen: false }]));
    await openConnect();
    dialog().querySelector<HTMLElement>('button[aria-label="Details for prod"]')!.click();
    await flushPromises();
    expect(api.hostRuns).toHaveBeenCalledWith('h1');
    await vi.waitFor(() => expect(dialog().querySelector('button[aria-label="Kill bash"]')).not.toBeNull());
    dialog().querySelector<HTMLElement>('button[aria-label="Kill bash"]')!.click();
    await flushPromises();
    expect(api.killHostRun).toHaveBeenCalledWith('h1', 'r1');
    api.connectHosts([{ ...PROD, name: 'prod-1' }]);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="host-card-name"]')!.textContent).toBe('prod-1'));
  });

  it('lists the runs again when the card\'s host connects or drops, as after Remove Damocles server', async () => {
    vi.mocked(api.hostRuns).mockResolvedValue(opened([{ id: 'r1', title: 'bash', state: 'running' as const, canOpen: false }]));
    await openConnect({ hosts: [{ ...PROD, connection: 'connected' }] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for prod"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('button[aria-label="Kill bash"]')).not.toBeNull());
    vi.mocked(api.hostRuns).mockResolvedValue(opened([]));
    api.connectHosts([{ ...PROD, connection: 'offline' }]);
    await vi.waitFor(() => expect(api.hostRuns).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(dialog().querySelector('button[aria-label="Kill bash"]')).toBeNull());
    // a change that leaves the connection as it was lists nothing again
    api.connectHosts([{ ...PROD, name: 'prod-1', connection: 'offline' }]);
    await flushPromises();
    expect(api.hostRuns).toHaveBeenCalledTimes(2);
  });

  it('opens another device\'s terminal from the card and makes way for its tab, listing the runs again when main refuses', async () => {
    vi.mocked(api.hostRuns).mockResolvedValue(opened([{ id: 'r2', title: 'htop', state: 'background' as const, canOpen: true }]));
    vi.mocked(api.openHostRun).mockRejectedValueOnce(new Error('gone'));
    await openConnect();
    dialog().querySelector<HTMLElement>('button[aria-label="Details for prod"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('button[aria-label="Open htop"]')).not.toBeNull());
    dialog().querySelector<HTMLElement>('button[aria-label="Open htop"]')!.click();
    await vi.waitFor(() => expect(api.hostRuns).toHaveBeenCalledTimes(2));
    expect(api.openHostRun).toHaveBeenCalledWith('h1', 'r2');
    expect(dialog().querySelector('[role="alert"]')?.textContent?.trim()).toBe('That did not work. Try again, or see the log.');
    expect(api.answer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(dialog().querySelector('button[aria-label="Open htop"]')).not.toBeNull());
    dialog().querySelector<HTMLElement>('button[aria-label="Open htop"]')!.click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'dismissed' }));
    expect(api.openHostRun).toHaveBeenCalledTimes(2);
  });

  it('opens on a host card with its name field open when asked to rename, connecting nothing', async () => {
    await openConnect({ hostId: 'h1', card: 'rename' });
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Host name'));
    expect(dialog().querySelector('[data-testid="host-card"]')).not.toBeNull();
    expect((document.activeElement as HTMLInputElement).value).toBe('prod');
    expect(api.startConnect).not.toHaveBeenCalled();
    // back on the list and into the card again, the card opens as usual
    dialog().querySelector<HTMLInputElement>('input[aria-label="Host name"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    [...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Back')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('button[aria-label="Details for prod"]')).not.toBeNull());
    dialog().querySelector<HTMLElement>('button[aria-label="Details for prod"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="host-card-name"]')).not.toBeNull());
    expect(dialog().querySelector('input[aria-label="Host name"]')).toBeNull();
  });

  // A pointer press reaches the page before its click; reka's dismissable layers decide on it.
  const pressPointer = async (element: HTMLElement): Promise<void> => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    element.click();
    await flushPromises();
  };
  const openCardOf = async (): Promise<void> => {
    dialog().querySelector<HTMLElement>('button[aria-label="Details for prod"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="host-card"] [data-testid="forget-host"]')).not.toBeNull());
  };

  it('asks Forget host over the card as a nested alert dialog, whose buttons take the pointer and the keyboard and leave the Connect dialog open', async () => {
    await openConnect();
    await openCardOf();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="forget-host"]')!);
    const forget = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="forget-host-dialog"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(forget.textContent).toContain('Forget prod?');
    await vi.waitFor(() => expect(document.activeElement).toBe(forget.querySelector('[data-testid="forget-host-cancel"]')));
    // the Connect dialog's focus trap steps aside, so the keyboard reaches every button of the question
    const confirm = forget.querySelector<HTMLElement>('[data-testid="forget-host-confirm"]')!;
    confirm.focus();
    await flushPromises();
    expect(document.activeElement).toBe(confirm);
    await pressPointer(forget.querySelector<HTMLElement>('[data-testid="forget-host-cancel"]')!);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="forget-host-dialog"][data-state="open"]')).toBeNull());
    expect(api.forgetHost).not.toHaveBeenCalled();
    // a dismissed dialog leaves inert, and answers once its exit ends
    expect(dialog().closest('[inert]')).toBeNull();
    expect(api.answer).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-testid="host-card"]')).not.toBeNull();

    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="forget-host"]')!);
    const again = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[data-testid="forget-host-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    await pressPointer(again.querySelector<HTMLElement>('[data-testid="forget-host-confirm"]')!);
    expect(api.forgetHost).toHaveBeenCalledWith('h1');
    // a dismissed dialog leaves inert, and answers once its exit ends
    expect(dialog().closest('[inert]')).toBeNull();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('gives main\'s question stacked over it, the trust question of a picked folder, the pointer and the keyboard, and stays open', async () => {
    await openConnect({ hosts: [], sshConfigAliases: [], hostId: 'h1', pick: { mode: 'folder', hostName: 'prod', roots: ['/home/u'] } });
    await vi.waitFor(() => expect(api.browseHost).toHaveBeenCalledWith('h1', undefined));
    api.request('m1', { kind: 'message', severity: 'warning', message: 'Do you trust the authors of the files in /srv/app?', actions: ['Trust Folder'], cancelLabel: 'Don\'t Trust' });
    const question = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="overlay-message"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(question.querySelector('[data-testid="overlay-message-cancel"]')));
    // the Connect dialog's focus trap steps aside, and its content takes no pointer while the question is up
    const trust = question.querySelector<HTMLElement>('[data-testid="overlay-message-action-0"]')!;
    trust.focus();
    await flushPromises();
    expect(document.activeElement).toBe(trust);
    expect(dialog().style.pointerEvents).toBe('none');
    await pressPointer(trust);
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('m1', { kind: 'message', action: 0 }));
    expect(api.answer).toHaveBeenCalledTimes(1);
    expect(dialog().querySelector('[data-testid="folder-browser-confirm"]')).not.toBeNull();
  });

  it('asks Remove Damocles server over the card as a nested alert dialog that Cancel and Remove server answer', async () => {
    await openConnect({ hosts: [{ ...PROD, connection: 'connected' }] });
    await openCardOf();
    const open = async (): Promise<HTMLElement> => {
      await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="remove-server"]')!);
      return vi.waitFor(() => {
        const shown = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"][data-testid="remove-server-dialog"]')].find((shown) => shown.dataset['state'] !== 'closed');
        expect(shown).not.toBeNull();
        return shown!;
      });
    };
    let removal = await open();
    await vi.waitFor(() => expect(document.activeElement).toBe(removal.querySelector('[data-testid="remove-server-cancel"]')));
    await pressPointer(removal.querySelector<HTMLElement>('[data-testid="remove-server-cancel"]')!);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="remove-server-dialog"][data-state="open"]')).toBeNull());
    expect(api.removeServer).not.toHaveBeenCalled();
    // a dismissed dialog leaves inert, and answers once its exit ends
    expect(dialog().closest('[inert]')).toBeNull();
    expect(api.answer).not.toHaveBeenCalled();
    removal = await open();
    // main publishes the removal's end before it answers
    vi.mocked(api.removeServer).mockImplementationOnce(async () => {
      api.pushHostOperations({ hostId: 'h1', removal: { result: { ok: true, notices: [] } } });
      return opened({ ok: true, notices: [] });
    });
    await pressPointer(removal.querySelector<HTMLElement>('[data-testid="remove-server-confirm"]')!);
    expect(api.removeServer).toHaveBeenCalledWith('h1', { removeKey: false, disableLinger: false });
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="remove-server-result"]')?.textContent).toContain('prod'));
    // a dismissed dialog leaves inert, and answers once its exit ends
    expect(dialog().closest('[inert]')).toBeNull();
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('keeps the dialog open on a click beside it while a removal runs in the card, and closes on one once it is done', async () => {
    let finish!: (answer: PopupAnswer<RemoveServerResult>) => void;
    vi.mocked(api.removeServer).mockImplementationOnce(() => {
      api.pushHostOperations({ hostId: 'h1', removal: {} });
      return new Promise((resolve) => (finish = resolve));
    });
    await openConnect({ hosts: [{ ...PROD, connection: 'connected' }] });
    await openCardOf();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="remove-server"]')!);
    const removal = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[data-testid="remove-server-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    await pressPointer(removal.querySelector<HTMLElement>('[data-testid="remove-server-confirm"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="remove-server-progress"]')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="remove-server-dialog"][data-state="open"]')).toBeNull());
    const beside = document.body.appendChild(document.createElement('div'));
    await pressPointer(beside);
    // a dismissed dialog leaves inert, and answers once its exit ends
    expect(dialog().closest('[inert]')).toBeNull();
    expect(api.answer).not.toHaveBeenCalled();
    api.pushHostOperations({ hostId: 'h1', removal: { result: { ok: true, notices: [] } } });
    finish(opened({ ok: true, notices: [] }));
    await flushPromises();
    await pressPointer(beside);
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'dismissed' }));
  });

  it('keeps the dialog open on a click beside it while a passwordless setup runs in the card', async () => {
    let finish!: (answer: PopupAnswer<PasswordlessResult>) => void;
    const steps = { generate: 'running', install: 'pending', verify: 'pending' } as const;
    vi.mocked(api.setUpPasswordless).mockImplementationOnce(() => {
      api.pushHostOperations({ hostId: 'h1', passwordless: { steps } });
      return new Promise((resolve) => (finish = resolve));
    });
    await openConnect({ hosts: [{ ...PROD, connection: 'connected' }] });
    await openCardOf();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="passwordless-start"]')!);
    const beside = document.body.appendChild(document.createElement('div'));
    await pressPointer(beside);
    expect(dialog().closest('[inert]')).toBeNull();
    expect(api.answer).not.toHaveBeenCalled();
    api.pushHostOperations({ hostId: 'h1', passwordless: { steps: { generate: 'done', install: 'done', verify: 'done' }, result: { ok: true } } });
    finish(opened({ ok: true }));
    await flushPromises();
    await pressPointer(beside);
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'dismissed' }));
  });

  it('shows a setup main runs on a card opened after it started, and keeps the dialog open on a click beside it', async () => {
    api.pushHostOperations({ hostId: 'h1', passwordless: { steps: { generate: 'done', install: 'running', verify: 'pending' } } });
    await openConnect({ hosts: [{ ...PROD, connection: 'connected' }] });
    await openCardOf();
    await vi.waitFor(() => expect([...dialog().querySelectorAll<HTMLElement>('[data-testid="passwordless-step"]')].map((step) => step.dataset.state)).toEqual(['done', 'running', 'pending']));
    expect(dialog().querySelector('[data-testid="passwordless-start"]')).toBeNull();
    const beside = document.body.appendChild(document.createElement('div'));
    await pressPointer(beside);
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('opens the folder browser of a connected host from its card', async () => {
    await openConnect({ hosts: [{ ...PROD, connection: 'connected' }] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for prod"]')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="host-card"] [data-testid="host-card-open-folder"]')).not.toBeNull());
    const button = dialog().querySelector<HTMLElement>('[data-testid="host-card"] [data-testid="host-card-open-folder"]')!;
    expect(button.textContent?.trim()).toBe('Open folder on prod...');
    button.click();
    await vi.waitFor(() => expect(api.browseHost).toHaveBeenCalledWith('h1', undefined));
    expect(api.startConnect).not.toHaveBeenCalled();
  });
});

describe('removing a remote project with live terminals', () => {
  it('asks in a danger dialog with Cancel focused, Keep running, and End terminals as the danger fill', async () => {
    const api = fakeOverlayApi();
    track(mount(OverlayApp, {
      props: { api, settingsBridge: createOverlaySettingsBridge(api) },
      global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    }));
    await flushPromises();
    api.request('m1', { kind: 'message', severity: 'danger', message: 'End its 2 terminals on prod-1?', actions: ['Keep running', 'End terminals'], cancelLabel: 'Cancel' });
    await flushPromises();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="overlay-message"] button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Cancel', 'Keep running', 'End terminals']);
    await vi.waitFor(() => expect(document.activeElement).toBe(buttons[0]));
    expect(buttons[2]!.className).toContain('bg-(--d-danger)');
    expect(buttons[1]!.className).not.toContain('bg-(--d-danger)');
    buttons[1]!.click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('m1', { kind: 'message', action: 0 }));
  });
});

describe('connect texts', () => {
  const keys = (value: unknown, prefix = ''): string[] => (typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${prefix}${key}.`))
    : [prefix.slice(0, -1)]);

  it('has an en and el text for every failure code main sends, and the same remote keys in both', () => {
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      for (const code of [...SSH_FAILURE_CODES, 'handshakeFailed'] as const) expect(shellI18n.global.te(`remote.failure.${code}`), `${locale} ${code}`).toBe(true);
    }
    shellI18n.global.locale.value = 'en';
    expect(keys(el.remote).sort()).toEqual(keys(en.remote).sort());
  });

  it('gives a reason that changes what the user does its own text', () => {
    expect(failureText({ code: 'noexec', params: { folder: '/opt/x', reason: 'notWritable' } }, 'prod', t)).toBe('Damocles cannot create or write /opt/x on prod. Choose another install folder.');
    expect(failureText({ code: 'unknown', params: { reason: 'sshMissing' } }, 'prod', t)).toBe('No OpenSSH client was found on this computer. Install OpenSSH and try again.');
    expect(failureText({ code: 'unknown', params: { reason: 'installLocked' } }, 'prod', t)).toBe('The connection to prod failed. Show log has the details.');
    expect(failureText({ code: 'permissionDenied', params: { hop: 'jump@bastion' } }, 'prod', t)).toBe('jump@bastion, a jump host on the way to prod, refused the sign-in. Check your key, agent or password.');
    expect(failureText({ code: 'permissionDenied', params: {} }, 'prod', t)).toBe('prod refused the sign-in. Check your key, agent or password.');
    expect(refusalText({ refused: 'command', reason: 'command' }, t)).toBe('Remove the command after the host. Damocles starts its own server there.');
    expect(refusalText({ refused: '-p', reason: 'value' }, t)).toBe('The value given to -p is not allowed.');
    expect(refusalText({ refused: 'port', reason: 'destination' }, t)).toBe('The port must be a number from 1 to 65535.');
    expect(refusalText({ refused: 'destination', reason: 'destination' }, t)).toBe('Type a host as user@host, host:port or a pasted ssh command.');
    expect(failureText({ code: 'destinationRefused', params: { setting: 'IdentityFile' } }, 'prod', t)).toBe('Damocles no longer accepts the saved IdentityFile of prod, so ssh did not start. Forget the host and add it again.');
  });

  it('has an en and el text for every refusal main gives', () => {
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      for (const reason of HOST_PARSE_REFUSALS) expect(shellI18n.global.te(`remote.connect.refusal.${reason}`), `${locale} ${reason}`).toBe(true);
      for (const part of ['host', 'user', 'port']) expect(shellI18n.global.te(`remote.connect.refusal.destination_${part}`), `${locale} ${part}`).toBe(true);
      for (const code of ['publickeyNotPreferred', 'accountFailed', 'restricted', 'configUnreadable', 'installFailed']) expect(shellI18n.global.te(`remote.passwordless.failure.${code}`), `${locale} ${code}`).toBe(true);
    }
    shellI18n.global.locale.value = 'en';
  });
});
