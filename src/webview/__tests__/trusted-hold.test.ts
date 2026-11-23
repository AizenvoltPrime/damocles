// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import App from '@/App.vue';
import { i18n } from '@/i18n';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';

// the setup file ends the shown hold at once; this file is about the real one, in the chat page as VS Code hosts it
vi.unmock('@/composables/trusted-hold');

if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

const mounted: VueWrapper[] = [];
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const card = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const ready = (testId: string): string | null | undefined => card(testId)?.getAttribute('data-trusted-ready');
const button = (testId: string, text: string): HTMLElement | undefined => [...(card(testId)?.querySelectorAll<HTMLElement>('button') ?? [])].find((candidate) => candidate.textContent?.trim() === text);
const isReady = (testId: string): Promise<void> => vi.waitFor(() => expect(ready(testId)).toBe('true'), { timeout: 3000, interval: 20 });

function bash(id: string, command: string): void {
  usePermissionStore().addPermission(id, { owner: { kind: 'main' }, toolName: 'Bash', toolInput: { command }, command });
}

describe('a request just shown, where the host checks no visibility', () => {
  it('takes no answer for its first 500 ms, on a permission card and an elicitation card alike', async () => {
    useSettingsStore().setHostCapabilities(VSCODE_HOST_CAPABILITIES);
    const posted = vi.spyOn(acquireVsCodeApi!(), 'postMessage');
    const answers = (): unknown[] => posted.mock.calls.map(([message]) => message).filter((message) => ['approveEdit', 'answerElicitation'].includes((message as { type: string }).type));
    bash('e1', 'ls');
    useElicitationStore().addElicitation({ serverName: 'jira', message: 'Token?', mode: 'url', elicitationId: 'el1', url: 'https://example.test/' });
    mounted.push(mount(App, { global: { plugins: [i18n] }, attachTo: document.body }));
    await flushPromises();
    await vi.waitFor(() => expect(card('elicitation-card')).not.toBeNull());

    expect(ready('permission-card')).toBe('false');
    expect(ready('elicitation-card')).toBe('false');
    expect(card('permission-card')!.querySelector('[role="listbox"]')!.getAttribute('aria-disabled')).toBe('true');
    card('permission-card')!.querySelector<HTMLElement>('[data-testid="permission-option-yes"]')!.click();
    button('elicitation-card', 'Accept')!.click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(answers()).toEqual([]);

    await isReady('permission-card');
    await isReady('elicitation-card');
    expect(card('permission-card')!.querySelector('[role="listbox"]')!.hasAttribute('aria-disabled')).toBe(false);
  });

  it('holds the request that replaces an answered one, so the second click of a double-click answers nothing', async () => {
    useSettingsStore().setHostCapabilities(VSCODE_HOST_CAPABILITIES);
    const posted = vi.spyOn(acquireVsCodeApi!(), 'postMessage');
    const answered = (): string[] => posted.mock.calls.map(([message]) => message as { type: string; toolUseId?: string; elicitationId?: string })
      .filter((message) => message.type === 'approveEdit' || message.type === 'answerElicitation')
      .map((message) => message.toolUseId ?? message.elicitationId ?? '');
    bash('e1', 'ls');
    bash('e2', 'rm -rf build');
    const elicitations = useElicitationStore();
    elicitations.addElicitation({ serverName: 'jira', message: 'First?', mode: 'url', elicitationId: 'el1', url: 'https://example.test/1' });
    elicitations.addElicitation({ serverName: 'jira', message: 'Second?', mode: 'url', elicitationId: 'el2', url: 'https://example.test/2' });
    mounted.push(mount(App, { global: { plugins: [i18n] }, attachTo: document.body }));
    await flushPromises();
    await isReady('permission-card');
    await isReady('elicitation-card');

    const yes = (): void => card('permission-card')?.querySelector<HTMLElement>('[data-testid="permission-option-yes"]')?.click();
    const accept = (): void => button('elicitation-card', 'Accept')?.click();
    const firstPermission = card('permission-card');
    const firstElicitation = card('elicitation-card');
    const firstAccept = button('elicitation-card', 'Accept')!;
    yes();
    accept();
    // the second click of each double-click, on whatever the page shows by then
    yes();
    accept();
    firstPermission!.querySelector<HTMLElement>('[data-testid="permission-option-yes"]')!.click();
    firstAccept.click();
    await flushPromises();
    expect(answered()).toEqual(['e1', 'el1']);

    // the next request is a new element, and it starts held
    await vi.waitFor(() => {
      expect(card('permission-card')).not.toBeNull();
      expect(card('permission-card')).not.toBe(firstPermission);
      expect(card('elicitation-card')).not.toBeNull();
      expect(card('elicitation-card')).not.toBe(firstElicitation);
    });
    expect(ready('permission-card')).toBe('false');
    expect(ready('elicitation-card')).toBe('false');
    yes();
    accept();
    await flushPromises();
    expect(answered()).toEqual(['e1', 'el1']);
    expect(Object.keys(usePermissionStore().pendingPermissions)).toEqual(['e2']);
    expect(elicitations.pendingElicitations.map((request) => request.elicitationId)).toEqual(['el2']);

    await isReady('permission-card');
    await isReady('elicitation-card');
    yes();
    accept();
    await flushPromises();
    expect(answered()).toEqual(['e1', 'el1', 'e2', 'el2']);
  });
});
