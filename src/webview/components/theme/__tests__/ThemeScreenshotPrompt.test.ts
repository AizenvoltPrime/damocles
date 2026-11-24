// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import ThemeScreenshotPrompt from '@/components/theme/ThemeScreenshotPrompt.vue';
import { i18n, loadLocale } from '@/i18n';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { createThemeHandlers } from '@/composables/message-handler/handlers/theme-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { installVisibilityObserver } from '@/__tests__/visibility-observer';
import { BUILTIN_THEME } from '@shared/themes/builtin';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

const REQUEST = {
  type: 'requestThemeScreenshot',
  promptId: 'ts-1',
  toolUseId: 'call_2',
  url: `app://damocles/theme-shot/${'3f2a9c01'.repeat(4)}`,
  width: 1280,
  height: 800,
  owner: { kind: 'main' },
} as const satisfies ExtensionToWebviewMessage;

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  i18n.global.locale.value = 'en';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
  vi.unstubAllGlobals();
});

function deliver(message: ExtensionToWebviewMessage): void {
  const handlers = createThemeHandlers() as Record<string, (msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void>;
  handlers[message.type]!(message, {} as HandlerContext);
}

async function raised(request: ExtensionToWebviewMessage = REQUEST): Promise<VueWrapper> {
  deliver(request);
  wrapper = mount(ThemeScreenshotPrompt, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const card = (w: VueWrapper) => w.find('[data-testid="theme-screenshot-card"]');
// each option's label, without its digit and hint
const options = (w: VueWrapper) => w.findAll('[role="option"]').map((option) => option.get('[data-testid="theme-screenshot-option-label"]').text());

function press(key: string): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('the screenshot consent card', () => {
  it('shows the very screenshot main holds, what is sent, and Allow or Deny, before anything is sent', async () => {
    const w = await raised();

    expect(card(w).attributes('aria-label')).toBe('Send a screenshot of the window to the model?');
    expect(card(w).attributes('data-trusted')).toBeDefined();
    expect(card(w).attributes('data-dock-prompt')).toBeDefined();
    const image = w.get('[data-testid="theme-screenshot-image"]');
    expect(image.attributes('src')).toBe(REQUEST.url);
    expect(image.attributes('alt')).toBe('Screenshot of this window, 1280 by 800');
    expect(card(w).text()).toContain('Only this image is sent, once. It may show file names and chat text.');
    expect(w.get('[role="listbox"]').attributes('aria-label')).toBe('Answer the screenshot request');
    expect(options(w)).toEqual(['Allow once', 'Allow for this chat', 'Deny']);
    expect(w.get('[data-testid="theme-screenshot-option-hint"]').text()).toBe('Later screenshots in this chat are sent without asking. A draft may show on the window for a moment while one is taken.');
    expect(posted).toEqual([]);
  });

  it.each([
    ['allow', 0],
    ['allowChat', 1],
    ['deny', 2],
  ] as const)('answers %s from its option and stays, saying so, until core closes the card', async (choice, index) => {
    const w = await raised();
    await w.findAll('[role="option"]')[index]!.trigger('click');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveThemeScreenshot', promptId: 'ts-1', choice }]);
    expect(card(w).exists()).toBe(true);
    expect(useThemePromptStore().screenshotPrompts).toHaveLength(1);
    expect(w.get('#theme-screenshot-status').text()).toBe('Sending your answer…');
    // no answer is sent twice, nor after another answer went out
    expect(w.get('[role="listbox"]').attributes('aria-disabled')).toBe('true');
    await w.get('[data-testid="theme-screenshot-option-allow"]').trigger('click');
    await w.get('[data-testid="theme-screenshot-option-allowChat"]').trigger('click');
    await w.get('[data-testid="theme-screenshot-option-deny"]').trigger('click');
    press('1');
    press('2');
    press('3');
    expect(posted).toHaveLength(1);

    deliver({ type: 'themeScreenshotClosed', promptId: 'ts-1' });
    await flushPromises();
    expect(card(w).exists()).toBe(false);
    expect(useThemePromptStore().screenshotPrompts).toEqual([]);
  });

  it('lets Allow go again once core posts the card again', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-screenshot-option-allow"]').trigger('click');
    deliver(REQUEST);
    await flushPromises();
    expect(w.find('#theme-screenshot-status').exists()).toBe(false);
    await w.get('[data-testid="theme-screenshot-option-allow"]').trigger('click');
    expect(posted).toHaveLength(2);
  });

  it.each([
    ['1', 'allow'],
    ['2', 'allowChat'],
    ['3', 'deny'],
  ] as const)('answers digit %s as %s and ignores a digit past its answers', async (digit, choice) => {
    const w = await raised();
    press('4');
    await flushPromises();
    expect(posted).toEqual([]);

    press(digit);
    await flushPromises();
    expect(posted).toEqual([{ type: 'resolveThemeScreenshot', promptId: 'ts-1', choice }]);
    expect(card(w).exists()).toBe(true);
  });

  it('answers nothing while it is not fully visible: not from a digit, a click or Enter', async () => {
    const visibility = installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const w = await raised();
    const list = w.get('[role="listbox"]');
    expect(list.attributes('aria-disabled')).toBe('true');

    press('1');
    press('2');
    press('3');
    await w.get('[data-testid="theme-screenshot-option-allow"]').trigger('click');
    await w.get('[data-testid="theme-screenshot-option-allowChat"]').trigger('click');
    await w.get('[data-testid="theme-screenshot-option-allow"]').trigger('keydown', { key: 'Enter' });
    // the option's own handler, reached past the card's event hold
    w.findComponent({ name: 'ListboxItem' }).vm.$emit('select', new Event('select'));
    await flushPromises();
    expect(posted).toEqual([]);

    // the reason shows once the check outlasts the card's entrance, and the answers name it
    await new Promise((resolve) => setTimeout(resolve, 550));
    await flushPromises();
    expect(w.get('#theme-screenshot-checking').text()).toBe('This card must be fully visible before you can answer. Scroll it into view or move what covers it.');
    expect(list.attributes('aria-describedby')).toBe('theme-screenshot-checking');

    visibility.report(true);
    await flushPromises();
    expect(list.attributes('aria-disabled')).toBeUndefined();
    expect(list.attributes('aria-describedby')).toBeUndefined();
    press('1');
    expect(posted).toEqual([{ type: 'resolveThemeScreenshot', promptId: 'ts-1', choice: 'allow' }]);
  });

  it('offers Deny alone, and says why, once the image fails to load', async () => {
    const w = await raised();
    (w.get('[data-testid="theme-screenshot-option-allow"]').element as HTMLElement).focus();
    await w.get('[data-testid="theme-screenshot-image"]').trigger('error');
    await flushPromises();
    await nextTick();

    expect(w.find('[data-testid="theme-screenshot-image"]').exists()).toBe(false);
    expect(w.get('[data-testid="theme-screenshot-gone"]').text()).toBe('The window no longer holds this screenshot, so it cannot be sent. Deny it and ask again for a new one.');
    expect(w.get('[data-testid="theme-screenshot-gone"]').attributes('role')).toBe('status');
    expect(options(w)).toEqual(['Deny']);
    expect(w.get('[role="listbox"]').element.contains(document.activeElement)).toBe(true);
    press('2');
    expect(posted).toEqual([]);
    press('1');
    expect(posted).toEqual([{ type: 'resolveThemeScreenshot', promptId: 'ts-1', choice: 'deny' }]);
  });

  it.each([
    'https://example.com/shot.png',
    'app://damocles/theme-shot/3f2a9c',
    `app://damocles/theme-blob/${'3f2a9c01'.repeat(4)}`,
    'data:image/png;base64,iVBORw0KGgo=',
  ])('shows no image and offers Deny alone for a URL that is not a screenshot main holds (%s)', async (url) => {
    const w = await raised({ ...REQUEST, url });
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('[data-testid="theme-screenshot-gone"]').exists()).toBe(true);
    expect(options(w)).toEqual(['Deny']);
    press('1');
    expect(posted).toEqual([{ type: 'resolveThemeScreenshot', promptId: 'ts-1', choice: 'deny' }]);
  });

  it('is one bounded element whose image scrolls inside it, and which scrolls itself once that has no room left', async () => {
    const w = await raised();
    expect(card(w).classes()).toEqual(expect.arrayContaining(['flex', 'flex-col', 'max-h-[70dvh]', 'min-h-0', 'overflow-x-hidden', 'overflow-y-auto']));
    expect(w.get('[aria-label="Screenshot details"]').classes()).toEqual(expect.arrayContaining(['min-h-0', 'overflow-y-auto']));
  });

  it('shows one card for a prompt posted again, and leaves when core closes it', async () => {
    const w = await raised();
    deliver(REQUEST);
    await flushPromises();
    expect(w.findAll('[data-testid="theme-screenshot-card"]')).toHaveLength(1);

    deliver({ type: 'themeScreenshotClosed', promptId: 'ts-1' });
    await flushPromises();
    expect(card(w).exists()).toBe(false);
    expect(posted).toEqual([]);
  });

  it('shows a draft\'s name, isolated, and its miniature and no capture, and offers the three answers', async () => {
    const name = 'Amber \u2069\u2068night';
    const w = await raised({ type: 'requestThemeScreenshot', promptId: 'ts-2', toolUseId: 'call_3', owner: { kind: 'main' }, draft: { name, theme: BUILTIN_THEME } });

    expect(card(w).attributes('aria-label')).toBe('Send the model a screenshot of a draft on the window?');
    expect(card(w).attributes('data-trusted')).toBeDefined();
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('[data-testid="theme-screenshot-gone"]').exists()).toBe(false);
    expect(w.get('[data-testid="theme-screenshot-draft"] [data-testid="theme-miniature"]').attributes('aria-label')).toContain('Amber');
    // the draft's name is the agent's text: one bdi with no isolate marks of its own, inside the card's sentence
    const caption = w.get('[data-testid="theme-screenshot-draft-name"]');
    expect(caption.text()).toBe('Draft Amber night');
    expect(caption.findAll('bdi').map((bdi) => bdi.text())).toEqual(['Amber night']);
    expect(w.get('[data-testid="theme-screenshot-note"]').text()).toContain('the window shows the draft for a moment');
    expect(options(w)).toEqual(['Allow once', 'Allow for this chat', 'Deny']);

    press('2');
    await flushPromises();
    expect(posted).toEqual([{ type: 'resolveThemeScreenshot', promptId: 'ts-2', choice: 'allowChat' }]);
  });

  it('speaks Greek in the el locale', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const w = await raised();
    expect(card(w).attributes('aria-label')).toBe('Αποστολή στιγμιότυπου του παραθύρου στο μοντέλο;');
    expect(options(w)).toEqual(['Να επιτραπεί μία φορά', 'Να επιτρέπεται σε αυτή τη συνομιλία', 'Άρνηση']);
  });
});
