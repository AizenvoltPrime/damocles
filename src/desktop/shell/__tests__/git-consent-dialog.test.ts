// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { GitCredentialConsent } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi, type FakeOverlayApi } from './fakes';

// a consent without a Git hosting account
const PLAIN: GitCredentialConsent = { hostName: 'prod-1', credentialHost: 'gitlab.indigital.gr', targetHelper: false };
const FORGE: GitCredentialConsent = { ...PLAIN, forgeAccount: { serverLabel: 'gitlab.indigital.gr', login: 'astefanopoulos', reason: 'access', repoPath: 'grp/damocles' } };

let api: FakeOverlayApi;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  api = fakeOverlayApi();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function open(consent: GitCredentialConsent): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge: createOverlaySettingsBridge(api) },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
  await flushPromises();
  api.request('q1', { kind: 'gitCredentialConsent', ...consent });
  await flushPromises();
}

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="git-consent"]')!;
const button = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-testid="git-consent-${id}"]`)!;
const text = (element: Element): string => element.textContent!.replace(/\s+/g, ' ').trim();
const description = (): HTMLElement => document.getElementById(dialog().getAttribute('aria-describedby')!)!;

describe('GitConsentDialog', () => {
  it('without an account, asks for the credential manager exactly as before', async () => {
    await open(PLAIN);
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    expect(text(dialog().querySelector('h2')!)).toBe('prod-1 wants to use your saved credentials for gitlab.indigital.gr');
    expect(text(description())).toContain("Git on prod-1 wants the credentials saved on this computer. Damocles only reads them, and prod-1 can't change or erase them.");
    expect(document.querySelector('[data-testid="git-consent-account"]')).toBeNull();
    expect(document.querySelector('[data-testid="git-consent-stop"]')).toBeNull();
    expect([...dialog().querySelectorAll('button')].map(text)).toEqual(['Deny', 'Always for prod-1', 'Allow once']);
    await vi.waitFor(() => expect(document.activeElement).toBe(button('deny')));
  });

  it('names the account Damocles chose in the title and the hosts line, says why, and ends with how to stop being asked', async () => {
    await open(FORGE);
    expect(text(dialog().querySelector('h2')!)).toBe('Let prod-1 sign in to gitlab.indigital.gr as astefanopoulos?');
    const described = text(description());
    expect(described).toContain('Git on prod-1 asked for gitlab.indigital.gr. Damocles chose astefanopoulos automatically because it is your only account there that can push to grp/damocles.');
    expect(described).not.toContain('credentials saved on this computer');
    const hosts = document.querySelector('[data-testid="git-consent-hosts"]')!;
    expect(text(hosts.querySelector('[data-testid="git-consent-account"]')!)).toBe('A astefanopoulos');
    expect(text(hosts.querySelector('[data-testid="git-consent-host"]')!)).toContain('prod-1');
    const stop = document.querySelector('[data-testid="git-consent-stop"]')!;
    expect(text(stop)).toBe('To stop being asked, choose the account in Source Control or set a default for prod-1 in Settings, Remote hosts.');
    // the stop line is the description's last part
    expect(description().lastElementChild).toBe(stop);
    expect([...dialog().querySelectorAll('button')].map(text)).toEqual(['Deny', 'Always for prod-1', 'Allow once']);
    await vi.waitFor(() => expect(document.activeElement).toBe(button('deny')));
  });

  it.each([
    ['onlyAccount', 'Damocles chose astefanopoulos automatically because it is your only account on gitlab.indigital.gr.'],
    ['usernameHint', "Damocles chose astefanopoulos automatically because the repository's remote URL names it."],
    ['access', 'Damocles chose astefanopoulos automatically because it is your only account on gitlab.indigital.gr that can push to this repository.'],
    ['accessRead', 'Damocles chose astefanopoulos automatically because none of your accounts on gitlab.indigital.gr can push to this repository and it is the only one that can read it.'],
  ] as const)('says why for %s', async (reason, why) => {
    await open({ ...PLAIN, forgeAccount: { serverLabel: 'gitlab.indigital.gr', login: 'astefanopoulos', reason } });
    expect(text(description())).toContain(why);
  });

  it('says an account that can only read reads the named repository, never that it can push', async () => {
    await open({ ...PLAIN, forgeAccount: { serverLabel: 'gitlab.indigital.gr', login: 'astefanopoulos', reason: 'accessRead', repoPath: 'grp/damocles' } });
    const described = text(description());
    expect(described).toContain('Damocles chose astefanopoulos automatically because none of your accounts there can push to grp/damocles and it is the only one that can read it.');
    expect(described).not.toContain('that can push to');
  });

  it.each([
    ['deny', 'deny'],
    ['always', 'always'],
    ['once', 'once'],
  ] as const)('answers %s from its button with the account named', async (id, choice) => {
    await open(FORGE);
    button(id).click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'gitCredentialConsent', choice }));
  });

  it('answers Deny on Escape with the account named', async () => {
    await open(FORGE);
    await vi.waitFor(() => expect(document.activeElement).toBe(button('deny')));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'gitCredentialConsent', choice: 'deny' }));
  });
});
