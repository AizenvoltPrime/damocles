// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import CustomProviderAuthPanel from '../CustomProviderAuthPanel.vue';
import { i18n, applyLocale } from '@/i18n';
import { useSettingsStore, type KeyProviderStatus } from '@/stores/useSettingsStore';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import { KEY_PROVIDER_IDS, type AccountProviderId } from '@shared/settings-sections';

const bridge = vi.hoisted(() => ({
  posted: [] as WebviewToExtensionMessage[],
  listeners: [] as Array<(m: ExtensionToWebviewMessage) => void>,
}));
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => bridge.posted.push(m),
    onMessage: (fn: (m: ExtensionToWebviewMessage) => void) => {
      bridge.listeners.push(fn);
      return () => {};
    },
  }),
}));

const CREDENTIALS = { typesafe: 'ok', openrouter: 'ok', openai: 'ok' } as const;

function setStatus(provider: AccountProviderId, status: Partial<KeyProviderStatus>): void {
  useSettingsStore().setKeyProviderStatus(provider, { configured: false, external: null, signedIn: false, preferApiKey: false, ...status });
}

const mounted: VueWrapper[] = [];
function mountPanel(provider: AccountProviderId) {
  const wrapper = mount(CustomProviderAuthPanel, { props: { provider }, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  bridge.posted.length = 0;
  bridge.listeners.length = 0;
  setActivePinia(createPinia());
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  applyLocale('en');
});

describe('CustomProviderAuthPanel (TypeSafe)', () => {
  it('names the active memory judge', async () => {
    const wrapper = mountPanel('typesafe');
    const store = useSettingsStore();

    store.setMemoryJudgeStatus({ kind: 'classifier', via: 'openrouter' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Jev (OpenRouter)');
    expect(wrapper.find('[role="status"] [data-testid="memory-judge"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="memory-judge-rejected"]').exists()).toBe(false);

    store.setMemoryJudgeStatus({ kind: 'classifier', via: 'typesafe' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Jev (TypeSafe)');

    store.setMemoryJudgeStatus({ kind: 'classifier', via: 'openai' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: GPT-6 Luna (Decisions API)');

    store.setMemoryJudgeStatus({ kind: 'model', model: 'anthropic/claude-haiku-5-5' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Haiku 5.5');

    store.setMemoryJudgeStatus({ kind: 'model', model: 'openai-codex/gpt-6-luna' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: GPT-6 Luna');
  });

  it('says why a chosen judge cannot run instead of naming another', async () => {
    const wrapper = mountPanel('typesafe');
    const store = useSettingsStore();
    store.setMemoryJudgeStatus({ kind: 'none', forced: { choice: 'jev-typesafe', reason: 'no-key' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Memory judge: none. Jev (TypeSafe) is the chosen judge but cannot run: its key is not set. Merges and reranks wait until it can.',
    );

    store.setMemoryJudgeStatus({ kind: 'none', forced: { choice: 'gpt-6-luna-classifier', reason: 'chatgpt-active' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toContain(
      'GPT-6 Luna (Decisions API) is the chosen judge but cannot run: Sign in with ChatGPT is the active OpenAI credential, and the Decisions API accepts only an API key.',
    );

    store.setMemoryJudgeStatus({ kind: 'none', forced: { choice: 'claude-sonnet-5-5', reason: 'signed-out' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toContain('Sonnet 5.5 is the chosen judge but cannot run: its provider is signed out.');
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Κριτής μνήμης: κανένας. Ο επιλεγμένος κριτής Sonnet 5.5 δεν μπορεί να εκτελεστεί: ο πάροχός του δεν είναι συνδεδεμένος. Οι συγχωνεύσεις και οι ανακατατάξεις περιμένουν μέχρι να μπορεί.',
    );
  });

  it('names a stored judge outside the catalog by its value and says this version does not offer it', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setMemoryJudgeStatus({ kind: 'none', forced: { choice: 'claude-opus-1', reason: 'unrecognized' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Memory judge: none. claude-opus-1 is the chosen judge but cannot run: this version of Damocles does not offer it. Merges and reranks wait until it can.',
    );
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Κριτής μνήμης: κανένας. Ο επιλεγμένος κριτής claude-opus-1 δεν μπορεί να εκτελεστεί: αυτή η έκδοση του Damocles δεν τον προσφέρει. Οι συγχωνεύσεις και οι ανακατατάξεις περιμένουν μέχρι να μπορεί.',
    );
  });

  it('names each refused provider and why, inside the status region', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setMemoryJudgeStatus({
      kind: 'model',
      model: 'anthropic/claude-haiku-5-5',
      rejected: [
        { via: 'typesafe', reason: 'unauthorized' },
        { via: 'openrouter', reason: 'payment-required' },
        { via: 'openai', reason: 'forbidden' },
      ],
    }, CREDENTIALS);
    await nextTick();

    const lines = wrapper.findAll('[role="status"] [data-testid="memory-judge-rejected"]').map((line) => line.text());
    expect(lines).toEqual([
      'Jev (TypeSafe) skipped: the key was not accepted. Damocles tries it again in 5 minutes, or at once when you save its key.',
      'Jev (OpenRouter) skipped: the account has no credit. Damocles tries it again in 5 minutes, or at once when you save its key.',
      'GPT-6 Luna (Decisions API) skipped: the key has no access to the classifier. Damocles tries it again in 5 minutes, or at once when you save its key.',
    ]);
  });

  it('says the judge model is not known yet instead of claiming none is configured', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setMemoryJudgeStatus({ kind: 'unknown' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: the judge model, shown once a chat has started');
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Κριτής μνήμης: το μοντέλο του κριτή, που εμφανίζεται μόλις ξεκινήσει μια συνομιλία');
  });

  it('announces a failed save as an alert', async () => {
    const wrapper = mountPanel('typesafe');
    await wrapper.find('input').setValue('ts-key');
    await wrapper.find('input').trigger('keydown.enter');
    const set = bridge.posted.find((m) => m.type === 'setProviderApiKey');
    for (const fn of bridge.listeners) fn({ type: 'setProviderApiKeyAck', provider: 'typesafe', requestId: (set as { requestId: string }).requestId, ok: false, error: 'keyring locked' });
    await nextTick();
    expect(wrapper.find('[role="alert"]').text()).toBe('keyring locked');
  });

  it('shows no judge line on other providers', async () => {
    useSettingsStore().setMemoryJudgeStatus({ kind: 'classifier', via: 'typesafe' }, CREDENTIALS);
    const wrapper = mountPanel('deepseek');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').exists()).toBe(false);
  });
});

describe('CustomProviderAuthPanel (GitHub Copilot)', () => {
  it('offers the sign-in alone, with no key field, and says what signing in turns on', async () => {
    const wrapper = mountPanel('github-copilot');
    expect(wrapper.find('[data-testid="provider-sign-in"]').exists()).toBe(true);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('API Key');
    expect(wrapper.find('[data-testid="provider-sign-in-start"]').text()).toBe('Sign in with GitHub');
    expect(wrapper.text()).toContain('every model your plan allows');
    await wrapper.find('[data-testid="provider-sign-in-start"]').trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignIn', provider: 'github-copilot' }]);
  });

  it('asks for an enterprise domain, which blank leaves on github.com', async () => {
    const wrapper = mountPanel('github-copilot');
    useSettingsStore().setProviderSignInState('github-copilot', { phase: 'prompt', prompt: 'enterpriseDomain' });
    await nextTick();
    const input = wrapper.find('input');
    expect(input.attributes('placeholder')).toBe('company.ghe.com');
    expect(input.attributes('aria-label')).toBe('Enterprise domain');
    await input.setValue('company.ghe.com');
    await input.trigger('keydown.enter');
    expect(bridge.posted.at(-1)).toEqual({ type: 'providerSignInAnswer', provider: 'github-copilot', input: 'company.ghe.com' });

    useSettingsStore().setProviderSignInState('github-copilot', { phase: 'prompt', prompt: 'enterpriseDomain', invalid: true });
    await nextTick();
    await wrapper.find('[data-testid="provider-sign-in-skip"]').trigger('click');
    expect(bridge.posted.at(-1)).toEqual({ type: 'providerSignInAnswer', provider: 'github-copilot', input: '' });
  });

  it('names the sign-in as the active credential', async () => {
    const wrapper = mountPanel('github-copilot');
    setStatus('github-copilot', { signedIn: true, active: 'signIn' });
    await nextTick();
    expect(wrapper.find('[data-testid="credential-active"]').text()).toBe('Active credential: sign-in');
    expect(wrapper.find('[data-testid="prefer-api-key"]').exists()).toBe(false);
  });
});

describe.each(KEY_PROVIDER_IDS)('CustomProviderAuthPanel (%s)', (provider) => {
  const other = KEY_PROVIDER_IDS.find((id) => id !== provider)!;

  it('saves under its provider from the keyboard, settles only on its own ack, and shows its own state', async () => {
    const wrapper = mountPanel(provider);
    expect(wrapper.find('input').attributes('aria-label')).toBe('API Key');
    expect(wrapper.find('button[aria-label="Show key"]').exists()).toBe(true);

    await wrapper.find('input').setValue(' the-key ');
    await wrapper.find('input').trigger('keydown.enter');
    expect(bridge.posted).toHaveLength(1);
    const set = bridge.posted[0] as Extract<WebviewToExtensionMessage, { type: 'setProviderApiKey' }>;
    expect(set).toMatchObject({ type: 'setProviderApiKey', provider, key: 'the-key' });

    const ack = (message: ExtensionToWebviewMessage): void => {
      for (const fn of bridge.listeners) fn(message);
    };
    ack({ type: 'setProviderApiKeyAck', provider, requestId: 'someone-else', ok: true });
    ack({ type: 'setProviderApiKeyAck', provider: other, requestId: set.requestId, ok: true });
    await nextTick();
    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    ack({ type: 'setProviderApiKeyAck', provider, requestId: set.requestId, ok: true });
    await nextTick();
    expect(wrapper.findAll('[role="status"]').map((region) => region.text())).toContain('API key saved');
    expect(wrapper.find('input').attributes('disabled')).toBeUndefined();

    setStatus(other, { configured: true });
    await nextTick();
    expect(wrapper.find('button[aria-label="Clear API key"]').exists()).toBe(false);
    setStatus(provider, { configured: true });
    await nextTick();
    expect(wrapper.text()).toContain('Configured');
    await wrapper.find('button[aria-label="Clear API key"]').trigger('click');
    expect(bridge.posted.at(-1)).toMatchObject({ type: 'clearProviderApiKey', provider });
  });
});

describe('CustomProviderAuthPanel (OpenRouter)', () => {
  it('is localized', async () => {
    applyLocale('el');
    const wrapper = mountPanel('openrouter');
    await nextTick();
    expect(wrapper.find('input').attributes('aria-label')).toBe('Κλειδί API');
  });
});

describe('CustomProviderAuthPanel credential precedence', () => {
  const active = (wrapper: VueWrapper) => wrapper.find('[data-testid="credential-active"]');
  const preferSwitch = (wrapper: VueWrapper) => wrapper.find('[data-testid="prefer-api-key"]');

  it.each([
    ['signIn', 'Active credential: sign-in'],
    ['apiKey', 'Active credential: API key'],
    ['external', 'Active credential: key set outside Damocles'],
    ['none', 'Active credential: none'],
  ] as const)('announces %s as the active credential', async (value, text) => {
    const wrapper = mountPanel('xai');
    setStatus('xai', { active: value });
    await nextTick();
    expect(active(wrapper).text()).toBe(text);
    expect(active(wrapper).attributes('role')).toBe('status');
  });

  it("hides the active line when core does not report it, as a daemon's core does", async () => {
    const wrapper = mountPanel('xai');
    setStatus('xai', { configured: true, signedIn: true });
    await nextTick();
    expect(active(wrapper).exists()).toBe(false);
  });

  // The expiry is the access token's, which pi refreshes, so it never reads as the end of the sign-in.
  it('shows a sign-in made outside Damocles without the access token expiry', async () => {
    const wrapper = mountPanel('deepseek');
    expect(wrapper.find('[data-testid="provider-sign-in"]').exists()).toBe(false);
    setStatus('deepseek', { signedIn: true, signedInExpiresAt: Date.UTC(2020, 0, 2) });
    await nextTick();
    expect(wrapper.find('[data-testid="provider-sign-in"]').text()).toBe('Sign-in Signed in');
  });

  it('hosts the sign-in field for a sign-in provider, before the key field', async () => {
    const wrapper = mountPanel('xai');
    const field = wrapper.find('[data-testid="provider-sign-in"]');
    expect(field.find('[data-testid="provider-sign-in-start"]').text()).toBe('Sign in with xAI');
    const key = wrapper.find('input[aria-label="API Key"]');
    expect(field.element.contains(key.element)).toBe(false);
    expect(field.element.compareDocumentPosition(key.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    setStatus('xai', { signedIn: true, signedInExpiresAt: Date.UTC(2020, 0, 2) });
    await nextTick();
    expect(field.find('[data-testid="provider-sign-in-signed-in"]').text()).toBe('Signed in');
    expect(field.text()).not.toContain('2020');
    await field.find('[data-testid="provider-sign-out"]').trigger('click');
    expect(bridge.posted).toEqual([{ type: 'providerSignOut', provider: 'xai' }]);
  });

  it.each([
    ['kimi-coding', 'Sign in with Kimi Code', 'Σύνδεση με Kimi Code', 'share the membership quota'],
    ['meta', 'Sign in with Meta', 'Σύνδεση με Meta', 'bill per token'],
  ] as const)('offers %s a key field and a device-code sign-in, in both languages', async (provider, button, greekButton, hint) => {
    const wrapper = mountPanel(provider);
    const field = wrapper.find('[data-testid="provider-sign-in"]');
    expect(field.find('[data-testid="provider-sign-in-start"]').text()).toBe(button);
    expect(field.text()).toContain(hint);
    expect(wrapper.find('input').attributes('aria-label')).toBe('API Key');
    applyLocale('el');
    await nextTick();
    expect(field.find('[data-testid="provider-sign-in-start"]').text()).toBe(greekButton);
    expect(wrapper.find('input').attributes('aria-label')).toBe('Κλειδί API');
  });

  it('hosts no sign-in field for a key-only provider', () => {
    const wrapper = mountPanel('deepseek');
    expect(wrapper.find('[data-testid="provider-sign-in-start"]').exists()).toBe(false);
  });

  it.each([
    ['a saved key alone', { configured: true }],
    ['a sign-in alone', { signedIn: true }],
    ['a sign-in beside an external key', { signedIn: true, external: 'environment' }],
  ] as const)('offers no prefer switch with %s', async (_case, status) => {
    const wrapper = mountPanel('xai');
    setStatus('xai', status);
    await nextTick();
    expect(preferSwitch(wrapper).exists()).toBe(false);
  });

  it('offers a named prefer switch with a saved key and a sign-in, and posts the choice for its provider', async () => {
    const wrapper = mountPanel('xai');
    setStatus('xai', { configured: true, signedIn: true, active: 'signIn' });
    await nextTick();
    const toggle = preferSwitch(wrapper);
    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.attributes('aria-checked')).toBe('false');
    expect(wrapper.find(`#${toggle.attributes('aria-labelledby')}`).text()).toBe('Prefer API key over sign-in');
    expect(wrapper.find(`#${toggle.attributes('aria-describedby')}`).text()).toContain('never replaces the sign-in');

    await toggle.trigger('click');
    expect(bridge.posted).toEqual([{ type: 'setProviderPreferApiKey', provider: 'xai', preferApiKey: true, requestId: expect.any(String) }]);

    setStatus('xai', { configured: true, signedIn: true, preferApiKey: true, active: 'apiKey' });
    await nextTick();
    expect(preferSwitch(wrapper).attributes('aria-checked')).toBe('true');
    expect(active(wrapper).text()).toBe('Active credential: API key');
  });

  it('shows a refused preference change as an alert, only for its own request', async () => {
    const wrapper = mountPanel('xai');
    setStatus('xai', { configured: true, signedIn: true });
    await nextTick();
    await preferSwitch(wrapper).trigger('click');
    const sent = bridge.posted.at(-1) as Extract<WebviewToExtensionMessage, { type: 'setProviderPreferApiKey' }>;
    const ack = (message: ExtensionToWebviewMessage): void => {
      for (const fn of bridge.listeners) fn(message);
    };

    ack({ type: 'setProviderPreferApiKeyAck', provider: 'deepseek', requestId: sent.requestId, ok: false, error: 'other provider' });
    ack({ type: 'setProviderPreferApiKeyAck', provider: 'xai', requestId: 'stale', ok: false, error: 'stale' });
    await nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    ack({ type: 'setProviderPreferApiKeyAck', provider: 'xai', requestId: sent.requestId, ok: false, error: 'refused on a remote host' });
    await nextTick();
    expect(wrapper.find('[role="alert"]').text()).toBe('refused on a remote host');
  });

  it('holds the value it sent until its own ack, then shows what core published', async () => {
    const wrapper = mountPanel('xai');
    setStatus('xai', { configured: true, signedIn: true, active: 'signIn' });
    await nextTick();
    await preferSwitch(wrapper).trigger('click');
    await nextTick();
    expect(preferSwitch(wrapper).attributes('aria-checked')).toBe('true');
    const sent = bridge.posted.at(-1) as Extract<WebviewToExtensionMessage, { type: 'setProviderPreferApiKey' }>;

    for (const fn of bridge.listeners) fn({ type: 'setProviderPreferApiKeyAck', provider: 'xai', requestId: 'stale', ok: false });
    await nextTick();
    expect(preferSwitch(wrapper).attributes('aria-checked')).toBe('true');

    // core refused, so the status it published still says false
    for (const fn of bridge.listeners) fn({ type: 'setProviderPreferApiKeyAck', provider: 'xai', requestId: sent.requestId, ok: false });
    await nextTick();
    expect(preferSwitch(wrapper).attributes('aria-checked')).toBe('false');
    expect(wrapper.find('[role="alert"]').text()).toBe('Failed to change the preference');
  });

  it("is disabled while the provider's own sign-in runs", async () => {
    const wrapper = mountPanel('xai');
    setStatus('xai', { configured: true, signedIn: true, active: 'signIn' });
    useSettingsStore().setProviderSignInState('xai', { phase: 'deviceCode', userCode: 'WXYZ-1234', verificationUri: 'https://accounts.x.ai/device' });
    await nextTick();
    expect(preferSwitch(wrapper).attributes('disabled')).toBeDefined();
    await preferSwitch(wrapper).trigger('click');
    expect(bridge.posted.filter((m) => m.type === 'setProviderPreferApiKey')).toEqual([]);

    useSettingsStore().setProviderSignInState('xai', { phase: 'idle' });
    await nextTick();
    expect(preferSwitch(wrapper).attributes('disabled')).toBeUndefined();
  });

  it('drops its error when the switch hides', async () => {
    const wrapper = mountPanel('xai');
    setStatus('xai', { configured: true, signedIn: true });
    await nextTick();
    await preferSwitch(wrapper).trigger('click');
    const sent = bridge.posted.at(-1) as Extract<WebviewToExtensionMessage, { type: 'setProviderPreferApiKey' }>;
    for (const fn of bridge.listeners) fn({ type: 'setProviderPreferApiKeyAck', provider: 'xai', requestId: sent.requestId, ok: false, error: 'refused' });
    await nextTick();
    expect(wrapper.find('[role="alert"]').text()).toBe('refused');

    setStatus('xai', { configured: false, signedIn: true });
    await nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    setStatus('xai', { configured: true, signedIn: true });
    await nextTick();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('is localized', async () => {
    applyLocale('el');
    const wrapper = mountPanel('xai');
    setStatus('xai', { configured: true, signedIn: true, active: 'signIn' });
    await nextTick();
    expect(active(wrapper).text()).toBe('Ενεργό διαπιστευτήριο: σύνδεση');
    const toggle = preferSwitch(wrapper);
    expect(wrapper.find(`#${toggle.attributes('aria-labelledby')}`).text()).toBe('Προτίμηση κλειδιού API έναντι σύνδεσης');
  });
});
