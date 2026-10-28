// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { CloseRemoteRow } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi, opened, type FakeOverlayApi } from './fakes';

const ROW: CloseRemoteRow = { hostId: 'h1', panelId: 'p1', title: 'Rotate logs', projectLabel: 'api', hostLabel: 'prod-1', status: 'running' };

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

async function open(rows: readonly CloseRemoteRow[]): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge: createOverlaySettingsBridge(api) },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
  await flushPromises();
  api.request('q1', { kind: 'closeRemote', rows });
  await flushPromises();
}

const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="close-remote-${id}"]`)!;
const rowsShown = () => [...document.querySelectorAll<HTMLElement>('[data-testid="close-remote-row"]')];

describe('close dialog', () => {
  it('lists each chat with its project, host and status, and focuses Keep running', async () => {
    await open([ROW, { ...ROW, panelId: 'p2', title: '', status: 'waiting' }]);
    expect(document.querySelector('[data-testid="close-remote"] h2')!.textContent!.trim()).toBe('Quit Damocles?');
    expect([...document.querySelectorAll('[data-testid="close-remote"] button:not([role="checkbox"])')].map((shown) => shown.textContent!.trim())).toEqual(['Cancel', 'Stop agents', 'Keep running']);
    await vi.waitFor(() => expect(document.activeElement).toBe(button('keep')));
    const [first, second] = rowsShown();
    expect(first!.textContent).toContain('Rotate logs');
    expect(first!.textContent).toContain('api');
    expect(first!.querySelector('[data-testid="host-name-badge"]')!.textContent!.trim()).toBe('prod-1');
    expect(first!.querySelector('[data-testid="close-remote-status"]')!.textContent!.trim()).toBe('Working');
    expect(first!.querySelector('[data-testid="close-remote-status"] .d-spinning')).not.toBeNull();
    expect(second!.textContent).toContain('New chat');
    expect(second!.querySelector('[data-testid="close-remote-status"]')!.textContent!.trim()).toBe('Waiting for your answer');
    expect(second!.querySelector('.d-spinning')).toBeNull();
  });

  it("tints each row's host badge with its tone and follows a rename or recolor at once", async () => {
    await open([{ ...ROW, hostTone: 'danger' }, { ...ROW, panelId: 'p2', hostId: 'h2', hostLabel: 'lab' }]);
    const badges = (): Element[] => rowsShown().map((row) => row.querySelector('[data-testid="host-name-badge"]')!);
    expect(badges()[0]!.classList.contains('d-tone-danger')).toBe(true);
    expect(badges()[1]!.classList.contains('d-tone-muted')).toBe(true);
    api.closeRemoteRows([{ ...ROW, hostLabel: 'prod-eu', hostTone: 'info' }, { ...ROW, panelId: 'p2', hostId: 'h2', hostLabel: 'lab' }]);
    await flushPromises();
    expect(badges()[0]!.classList.contains('d-tone-info')).toBe(true);
    // the badge swaps the old name for the new one
    await vi.waitFor(() => expect(badges()[0]!.textContent).toContain('prod-eu'));
  });

  it('answers Keep running with Don\'t ask again ticked', async () => {
    await open([ROW]);
    document.querySelector<HTMLElement>('[data-testid="close-remote-dont-ask"]')!.click();
    await flushPromises();
    button('keep').click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'closeRemote', choice: 'keep', dontAskAgain: true }));
  });

  it('answers Stop agents without it, and Cancel never carries it', async () => {
    await open([ROW]);
    button('stop').click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'closeRemote', choice: 'stop', dontAskAgain: false }));
    api.request('q2', { kind: 'closeRemote', rows: [ROW] });
    await flushPromises();
    document.querySelector<HTMLElement>('[data-testid="close-remote-dont-ask"]')!.click();
    await flushPromises();
    button('cancel').click();
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q2', { kind: 'closeRemote', choice: 'cancel', dontAskAgain: false }));
  });

  it('answers Cancel on Escape', async () => {
    await open([ROW]);
    await vi.waitFor(() => expect(document.activeElement).toBe(button('keep')));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('q1', { kind: 'closeRemote', choice: 'cancel', dontAskAgain: false }));
  });

  it('follows the live rows main pushes: the status, the token note and a finished chat', async () => {
    await open([ROW]);
    api.closeRemoteRows([{ ...ROW, tokenNote: { provider: 'anthropic', minutesLeft: 23 } }]);
    await flushPromises();
    expect(document.querySelector('[data-testid="close-remote-token-note"]')!.textContent!.trim()).toBe('Claude token valid for 23 min');
    api.closeRemoteRows([{ ...ROW, status: 'signIn', tokenNote: { provider: 'github-copilot', minutesLeft: 1 } }]);
    await flushPromises();
    // the pill swaps in once the old one has left
    await vi.waitFor(() => expect(document.querySelector('[data-testid="close-remote-status"]')!.textContent!.trim()).toBe('Sign-in needed'));
    expect(document.querySelector('[data-testid="close-remote-token-note"]')!.textContent!.trim()).toBe('GitHub Copilot token valid for 1 min');
    api.closeRemoteRows([{ ...ROW, status: 'signIn', tokenNote: { provider: 'kimi-coding', minutesLeft: 5 } }]);
    await flushPromises();
    expect(document.querySelector('[data-testid="close-remote-token-note"]')!.textContent!.trim()).toBe('Kimi Code token valid for 5 min');
    api.closeRemoteRows([{ ...ROW, status: 'idle' }]);
    await flushPromises();
    expect(rowsShown()[0]!.dataset.status).toBe('idle');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="close-remote-status"]')!.textContent!.trim()).toBe('Finished'));
    expect(document.querySelector('[data-testid="close-remote-token-note"]')).toBeNull();
  });

  it('names a provider it has no name for by its id, an Object.prototype key included', async () => {
    await open([{ ...ROW, tokenNote: { provider: 'constructor', minutesLeft: 3 } }]);
    expect(document.querySelector('[data-testid="close-remote-token-note"]')!.textContent!.trim()).toBe('constructor token valid for 3 min');
  });

  it('warns once per host whose agents stop at logout and allows background work there', async () => {
    await open([{ ...ROW, lingerWarning: true }, { ...ROW, panelId: 'p2', lingerWarning: true }]);
    const warnings = document.querySelectorAll('[data-testid="close-remote-linger"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.textContent).toContain('prod-1 ends your processes when you log out there, so these agents stop then.');
    vi.mocked(api.allowBackgroundWork).mockResolvedValueOnce(opened({ result: 'refused' as const, user: 'deploy' }));
    document.querySelector<HTMLElement>('[data-testid="allow-background-work-button"]')!.click();
    await flushPromises();
    expect(api.allowBackgroundWork).toHaveBeenCalledWith('h1');
    expect(document.querySelector('[data-testid="linger-command"]')!.textContent).toBe('sudo loginctl enable-linger deploy');
  });
});
