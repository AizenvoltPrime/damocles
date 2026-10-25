// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ProviderSignInField from '../ProviderSignInField.vue';
import { i18n, applyLocale } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { ProviderSignInState } from '@shared/types/settings';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';

const bridge = vi.hoisted(() => ({
  posted: [] as WebviewToExtensionMessage[],
  listeners: new Set<(m: ExtensionToWebviewMessage) => void>(),
}));
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => bridge.posted.push(m),
    onMessage: (fn: (m: ExtensionToWebviewMessage) => void) => {
      bridge.listeners.add(fn);
      return () => bridge.listeners.delete(fn);
    },
  }),
}));

async function receive(message: ExtensionToWebviewMessage): Promise<void> {
  for (const fn of bridge.listeners) fn(message);
  await flushPromises();
}

const writeText = vi.fn(async () => {});

const mounted: VueWrapper[] = [];
function mountField(provider: 'xai' | 'openrouter' | 'github-copilot' = 'xai') {
  const wrapper = mount(ProviderSignInField, { props: { provider }, attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

async function setState(state: ProviderSignInState, provider: 'xai' | 'openrouter' | 'github-copilot' = 'xai'): Promise<void> {
  useSettingsStore().setProviderSignInState(provider, state);
  await flushPromises();
}

async function setSignedIn(signedIn: boolean): Promise<void> {
  useSettingsStore().setKeyProviderStatus('xai', { configured: false, external: null, signedIn, preferApiKey: false });
  await flushPromises();
}

const status = (wrapper: VueWrapper) => wrapper.find('[role="status"][data-testid="provider-sign-in-status"]');
const byTestId = (wrapper: VueWrapper, id: string) => wrapper.find(`[data-testid="${id}"]`);
const disabled = (wrapper: VueWrapper, id: string) => byTestId(wrapper, id).attributes('disabled') !== undefined;
const DEVICE_CODE: ProviderSignInState = { phase: 'deviceCode', userCode: 'WXYZ-1234', verificationUri: 'https://accounts.x.ai/device' };
const DOMAIN_PROMPT: ProviderSignInState = { phase: 'prompt', prompt: 'enterpriseDomain' };

beforeEach(() => {
  bridge.posted.length = 0;
  bridge.listeners.clear();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  setActivePinia(createPinia());
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.useRealTimers();
  applyLocale('en');
  document.body.innerHTML = '';
});

describe('ProviderSignInField', () => {
  it('offers Sign in with xAI, says it uses the account API access billed per token, and starts the flow', async () => {
    const wrapper = mountField();
    const start = byTestId(wrapper, 'provider-sign-in-start');
    expect(start.text()).toBe('Sign in with xAI');
    expect(wrapper.text()).toContain("Signs in with your xAI account's API access, so the account needs API access. Requests bill per token");
    expect(wrapper.text()).not.toMatch(/SuperGrok|Premium/);
    expect(byTestId(wrapper, 'provider-sign-out').exists()).toBe(false);
    expect(status(wrapper).text()).toBe('');

    await start.trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignIn', provider: 'xai' }]);
  });

  // The account row's status region announces the credential; a second region saying it too would announce it twice.
  it('shows Signed in outside its live region, and signs out', async () => {
    const wrapper = mountField();
    await setSignedIn(true);
    expect(byTestId(wrapper, 'provider-sign-in-signed-in').text()).toBe('Signed in');
    expect(byTestId(wrapper, 'provider-sign-in-signed-in').element.closest('[role="status"]')).toBeNull();
    expect(status(wrapper).text()).toBe('');
    await byTestId(wrapper, 'provider-sign-out').trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignOut', provider: 'xai' }]);

    await setSignedIn(false);
    expect(byTestId(wrapper, 'provider-sign-out').exists()).toBe(false);
    expect(byTestId(wrapper, 'provider-sign-in-signed-in').exists()).toBe(false);
  });

  it('announces each phase in the live region', async () => {
    const wrapper = mountField();
    const announced: string[] = [];
    for (const state of [
      { phase: 'starting' },
      DOMAIN_PROMPT,
      DEVICE_CODE,
      { phase: 'browser', paste: false },
      { phase: 'finishing' },
    ] satisfies ProviderSignInState[]) {
      await setState(state);
      announced.push(status(wrapper).text());
    }
    expect(announced).toEqual([
      'Starting sign-in…',
      'Enter your enterprise domain to continue.',
      'Your code is ready. Copy it and open the sign-in page.',
      'Waiting for the browser. Finish signing in on the page it opened.',
      'Finishing…',
    ]);
    expect(byTestId(wrapper, 'provider-sign-in-cancel').exists()).toBe(false);
  });

  it('shows the code, moves focus to Copy code and open page, and asks core to copy the code and open the page, sending neither', async () => {
    const wrapper = mountField();
    await byTestId(wrapper, 'provider-sign-in-start').trigger('click');
    (document.activeElement as HTMLElement | null)?.blur();
    await setState({ phase: 'starting' });
    await setState(DEVICE_CODE);

    expect(byTestId(wrapper, 'provider-sign-in-code').element.tagName).toBe('CODE');
    expect(byTestId(wrapper, 'provider-sign-in-code').text()).toBe('WXYZ-1234');
    expect(wrapper.text()).toContain('Sign-in page: https://accounts.x.ai/device');
    const copy = byTestId(wrapper, 'provider-sign-in-copy');
    expect(copy.text()).toBe('Copy code and open page');
    expect(document.activeElement).toBe(copy.element);

    bridge.posted.length = 0;
    await copy.trigger('click');
    expect(bridge.posted).toEqual([
      { type: 'providerSignInCopyCode', provider: 'xai' },
      { type: 'providerSignInOpenPage', provider: 'xai' },
    ]);
    expect(writeText).not.toHaveBeenCalled();
    expect(disabled(wrapper, 'provider-sign-in-copy')).toBe(true);

    await receive({ type: 'providerSignInCopyCodeAck', provider: 'openrouter', ok: true });
    expect(wrapper.text()).not.toContain('Code copied');
    await receive({ type: 'providerSignInCopyCodeAck', provider: 'xai', ok: true });
    expect(wrapper.text()).toContain('Code copied');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(disabled(wrapper, 'provider-sign-in-copy')).toBe(false);
  });

  it('says so when core could not copy the code', async () => {
    const wrapper = mountField();
    await setState(DEVICE_CODE);
    await byTestId(wrapper, 'provider-sign-in-copy').trigger('click');
    await receive({ type: 'providerSignInCopyCodeAck', provider: 'xai', ok: false });
    expect(wrapper.find('[role="alert"]').text()).toBe('Could not copy the code. Type it on the sign-in page.');
    expect(wrapper.text()).not.toContain('Code copied');
    expect(bridge.posted.at(-1)).toEqual({ type: 'providerSignInOpenPage', provider: 'xai' });
  });

  it('counts down to the expiry outside the live region, and stops ticking at 0:00', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wrapper = mountField();
    await setState({ ...DEVICE_CODE, expiresAt: 1_000_000 + 125_000 });
    const countdown = byTestId(wrapper, 'provider-sign-in-countdown');
    expect(countdown.text()).toBe('Code expires in 2:05');
    expect(countdown.element.closest('[role="status"]')).toBeNull();
    expect(countdown.attributes('aria-live')).toBeUndefined();

    vi.advanceTimersByTime(5_000);
    await flushPromises();
    expect(byTestId(wrapper, 'provider-sign-in-countdown').text()).toBe('Code expires in 2:00');
    expect(status(wrapper).text()).toBe('Your code is ready. Copy it and open the sign-in page.');

    vi.advanceTimersByTime(200_000);
    await flushPromises();
    expect(byTestId(wrapper, 'provider-sign-in-countdown').text()).toBe('Code expires in 0:00');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the ticker when the phase leaves the device code, and on unmount', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wrapper = mountField();
    await setState({ ...DEVICE_CODE, expiresAt: 1_000_000 + 600_000 });
    expect(vi.getTimerCount()).toBe(1);
    await setState({ phase: 'finishing' });
    expect(vi.getTimerCount()).toBe(0);

    await setState({ ...DEVICE_CODE, expiresAt: 1_000_000 + 600_000 });
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    mounted.length = 0;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels, shows the fixed error as an alert and returns focus to Sign in', async () => {
    const wrapper = mountField();
    await setState(DEVICE_CODE);
    await byTestId(wrapper, 'provider-sign-in-cancel').trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignInCancel', provider: 'xai' }]);

    await setState({ phase: 'idle', error: { kind: 'cancelled', message: 'Sign-in cancelled' } });
    const alert = wrapper.find('[role="alert"]');
    expect(alert.text()).toBe('Sign-in cancelled');
    expect(alert.element.closest('[role="status"]')).toBeNull();
    expect(status(wrapper).text()).toBe('');
    expect(document.activeElement).toBe(byTestId(wrapper, 'provider-sign-in-start').element);

    await setState({ phase: 'starting' });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('sends each request once and holds its control until core answers', async () => {
    const wrapper = mountField();
    await setSignedIn(true);
    const start = byTestId(wrapper, 'provider-sign-in-start');
    await start.trigger('click');
    await start.trigger('click');
    await byTestId(wrapper, 'provider-sign-out').trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignIn', provider: 'xai' }]);
    expect(disabled(wrapper, 'provider-sign-in-start')).toBe(true);
    expect(disabled(wrapper, 'provider-sign-out')).toBe(true);

    await setState(DEVICE_CODE);
    await byTestId(wrapper, 'provider-sign-in-cancel').trigger('click');
    await byTestId(wrapper, 'provider-sign-in-cancel').trigger('click');
    expect(bridge.posted.filter((m) => m.type === 'providerSignInCancel')).toHaveLength(1);
    expect(disabled(wrapper, 'provider-sign-in-cancel')).toBe(true);

    await setState({ phase: 'idle', error: { kind: 'cancelled', message: 'Sign-in cancelled' } });
    expect(disabled(wrapper, 'provider-sign-in-start')).toBe(false);
    await byTestId(wrapper, 'provider-sign-out').trigger('click');
    await byTestId(wrapper, 'provider-sign-out').trigger('click');
    expect(bridge.posted.filter((m) => m.type === 'providerSignOut')).toHaveLength(1);
    await setSignedIn(false);
    expect(disabled(wrapper, 'provider-sign-in-start')).toBe(false);
  });

  it('returns focus to Sign in after a finish', async () => {
    const wrapper = mountField();
    await setState({ phase: 'finishing' });
    await setState({ phase: 'idle' });
    await setSignedIn(true);
    expect(document.activeElement).toBe(byTestId(wrapper, 'provider-sign-in-start').element);
    expect(byTestId(wrapper, 'provider-sign-in-signed-in').text()).toBe('Signed in');
  });

  it('leaves focus where the user moved it outside the field', async () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    mountField();
    await setState({ phase: 'starting' });
    outside.focus();
    await setState(DEVICE_CODE);
    expect(document.activeElement).toBe(outside);
  });

  it('labels the paste field visibly, focuses it, and sends the trimmed answer only on Enter or Continue', async () => {
    const wrapper = mountField();
    await setState({ phase: 'browser', paste: true });
    const input = wrapper.find('input');
    const label = byTestId(wrapper, 'provider-sign-in-answer-label');
    expect(label.text()).toBe('Paste the code or the final page address');
    expect(label.element.tagName).toBe('LABEL');
    expect(label.attributes('for')).toBe(input.attributes('id'));
    expect(document.activeElement).toBe(input.element);

    await input.trigger('keydown.enter');
    expect(bridge.posted).toEqual([]);
    expect(wrapper.find('[role="alert"]').text()).toBe('Enter a value.');

    await input.setValue('  code#state  ');
    await input.trigger('keydown.enter');
    expect(bridge.posted).toEqual([{ type: 'providerSignInAnswer', provider: 'xai', input: 'code#state' }]);
    expect(input.attributes('disabled')).toBeDefined();

    await setState({ phase: 'browser', paste: true, invalid: true });
    await input.setValue('other');
    await byTestId(wrapper, 'provider-sign-in-submit').trigger('click');
    expect(bridge.posted.at(-1)).toEqual({ type: 'providerSignInAnswer', provider: 'xai', input: 'other' });
  });

  // pi sends the auth URL, then starts the paste prompt, so core posts the browser phase twice.
  it('focuses the paste field when OpenRouter offers it after the browser phase began', async () => {
    const wrapper = mountField('openrouter');
    await byTestId(wrapper, 'provider-sign-in-start').trigger('click');
    await setState({ phase: 'starting' }, 'openrouter');
    await setState({ phase: 'browser', paste: false }, 'openrouter');
    expect(wrapper.find('input').exists()).toBe(false);
    await setState({ phase: 'browser', paste: true }, 'openrouter');
    expect(document.activeElement).toBe(wrapper.find('input').element);
  });

  it('sends nothing when the paste field loses focus, the window included', async () => {
    const wrapper = mountField('openrouter');
    await setState({ phase: 'browser', paste: true }, 'openrouter');
    const input = wrapper.find('input');
    await input.setValue('half-typ');
    await input.trigger('blur');
    window.dispatchEvent(new Event('blur'));
    await byTestId(wrapper, 'provider-sign-in-open-again').trigger('click');
    await byTestId(wrapper, 'provider-sign-in-cancel').trigger('click');
    expect(bridge.posted).toEqual([
      { type: 'providerSignInOpenPage', provider: 'openrouter' },
      { type: 'providerSignInCancel', provider: 'openrouter' },
    ]);
  });

  it('offers Sign in with OpenRouter, and Open page again while the browser flow waits', async () => {
    const wrapper = mountField('openrouter');
    expect(byTestId(wrapper, 'provider-sign-in-start').text()).toBe('Sign in with OpenRouter');
    expect(byTestId(wrapper, 'provider-sign-in-open-again').exists()).toBe(false);

    await setState({ phase: 'browser', paste: false }, 'openrouter');
    await byTestId(wrapper, 'provider-sign-in-open-again').trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignInOpenPage', provider: 'openrouter' }]);
  });

  it('says why core refused an answer', async () => {
    const wrapper = mountField();
    await setState({ phase: 'browser', paste: true, invalid: true });
    expect(wrapper.find('[role="alert"]').text()).toBe('That entry is too long. Paste only the code or the page address.');
    await setState({ ...DOMAIN_PROMPT, invalid: true });
    expect(wrapper.find('[role="alert"]').text()).toBe('Enter a host name such as company.ghe.com, or continue without a domain.');
  });

  it('shows no paste field when the browser flow takes no paste', async () => {
    const wrapper = mountField();
    await setState({ phase: 'browser', paste: false });
    expect(wrapper.find('input').exists()).toBe(false);
  });

  it('labels and focuses the enterprise domain field, and sends a domain on Enter', async () => {
    const wrapper = mountField('github-copilot');
    await setState(DOMAIN_PROMPT, 'github-copilot');
    const input = wrapper.find('input');
    expect(input.attributes('aria-label')).toBe('Enterprise domain');
    expect(input.attributes('placeholder')).toBe('company.ghe.com');
    expect(byTestId(wrapper, 'provider-sign-in-answer-label').text()).toBe('Enterprise domain');
    expect(document.activeElement).toBe(input.element);

    await input.setValue(' github.example.com ');
    await input.trigger('keydown.enter');
    expect(bridge.posted).toEqual([{ type: 'providerSignInAnswer', provider: 'github-copilot', input: 'github.example.com' }]);
  });

  it.each([['an empty', ''], ['a blank', '   ']])('answers %s domain on Enter with github.com', async (_case, typed) => {
    const wrapper = mountField('github-copilot');
    await setState(DOMAIN_PROMPT, 'github-copilot');
    const input = wrapper.find('input');
    await input.setValue(typed);
    await input.trigger('keydown.enter');
    expect(bridge.posted).toEqual([{ type: 'providerSignInAnswer', provider: 'github-copilot', input: '' }]);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('sends only the blank answer when a typed domain is left by blur and Continue without a domain', async () => {
    const wrapper = mountField('github-copilot');
    await setState(DOMAIN_PROMPT, 'github-copilot');
    const input = wrapper.find('input');
    await input.setValue('acme.ghe.com');
    await input.trigger('blur');
    window.dispatchEvent(new Event('blur'));
    await byTestId(wrapper, 'provider-sign-in-skip').trigger('click');
    await byTestId(wrapper, 'provider-sign-in-skip').trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignInAnswer', provider: 'github-copilot', input: '' }]);
  });

  it('is localized', async () => {
    applyLocale('el');
    const wrapper = mountField();
    expect(byTestId(wrapper, 'provider-sign-in-start').text()).toBe('Σύνδεση με xAI');
    await setState(DEVICE_CODE);
    expect(byTestId(wrapper, 'provider-sign-in-copy').text()).toBe('Αντιγραφή κωδικού και άνοιγμα σελίδας');
    expect(status(wrapper).text()).toBe('Ο κωδικός σας είναι έτοιμος. Αντιγράψτε τον και ανοίξτε τη σελίδα σύνδεσης.');
    await setState(DOMAIN_PROMPT);
    expect(byTestId(wrapper, 'provider-sign-in-submit').text()).toBe('Συνέχεια');
  });
});
