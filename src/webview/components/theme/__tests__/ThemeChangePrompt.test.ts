// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import ThemeChangePrompt from '@/components/theme/ThemeChangePrompt.vue';
import { i18n, loadLocale } from '@/i18n';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { createThemeHandlers } from '@/composables/message-handler/handlers/theme-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { installVisibilityObserver } from '@/__tests__/visibility-observer';
import { CSS_DROP_REASONS } from '@shared/themes/css-types';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

const THEME = { ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', name: 'Amber Night' };

const REQUEST = {
  type: 'requestThemeChange',
  promptId: 'tc-1',
  toolUseId: 'call_1',
  action: 'theme',
  theme: THEME,
  themeName: 'Amber Night',
  looks: ['dark', 'light'],
  isNew: true,
  changes: [{ kind: 'color', look: 'dark', seed: 'accent', hex: '#e0a030' }, { kind: 'radius', value: 0.6 }],
  contrast: [{ look: 'dark', rule: 'text', severity: 'error', fg: '--d-muted', bg: '--d-panel', ratio: 3.94, min: 4.5 }],
  state: 'waiting',
  planMode: false,
  canShowInWindow: true,
  showInWindow: false,
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

// The prompt's messages arrive through the chat page's theme handlers, as core posts them.
function deliver(message: ExtensionToWebviewMessage): void {
  const handlers = createThemeHandlers() as Record<string, (msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void>;
  handlers[message.type]!(message, {} as HandlerContext);
}

async function raised(request: ExtensionToWebviewMessage = REQUEST): Promise<VueWrapper> {
  deliver(request);
  wrapper = mount(ThemeChangePrompt, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

// As in the chat page: the card is mounted before its request arrives.
async function raisedAfterMount(request: ExtensionToWebviewMessage = REQUEST): Promise<VueWrapper> {
  wrapper = mount(ThemeChangePrompt, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  deliver(request);
  await flushPromises();
  return wrapper;
}

const card = (w: VueWrapper) => w.find('[data-testid="theme-change-card"]');
const options = (w: VueWrapper) => w.findAll('[role="option"]').map((option) => option.text().replace(/^\d/, ''));
const listbox = (w: VueWrapper) => w.get('[role="listbox"]');

function press(key: string, target: EventTarget = document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('the theme preview card', () => {
  it('shows the proposal as trusted docked UI with its miniature, changes, contrast and three answers', async () => {
    const w = await raised();

    expect(card(w).attributes('role')).toBe('region');
    expect(card(w).attributes('aria-label')).toBe('Preview a new theme');
    expect(card(w).attributes('data-dock-prompt')).toBeDefined();
    expect(card(w).attributes('data-trusted')).toBeDefined();
    expect(w.get('[data-testid="theme-change-subtitle"]').text()).toBe('Amber Night, dark and light · nothing changes until you choose');
    expect(w.get('[data-testid="theme-miniature"]').attributes('aria-label')).toBe('Amber Night, dark and light looks');
    expect(w.get('[data-testid="theme-change-changes"]').text()).toContain('Accent, dark look: #e0a030');
    expect(w.get('[data-testid="theme-change-changes"]').text()).toContain('Corner radius 0.6');
    expect(w.get('[data-testid="theme-change-contrast"]').text()).toContain('--d-muted on --d-panel is 3.9:1, below 4.5:1');
    expect(listbox(w).attributes('aria-label')).toBe('Answer the theme preview');
    expect(options(w)).toEqual(['Apply', 'Discard', 'Change…']);
    expect(posted).toEqual([]);
  });

  // a name written right to left would take the comma, the numbers and the words beside it into its own run
  it('isolates a right-to-left theme name inside its sentences, and keeps the text free of direction marks', async () => {
    const name = 'ליל 2';
    const w = await raised({ ...REQUEST, themeName: name, theme: { ...THEME, name }, changes: [{ kind: 'name', name }] });
    const subtitle = w.get('[data-testid="theme-change-subtitle"]');
    expect(subtitle.findAll('bdi').map((run) => run.text())).toEqual([name]);
    expect(subtitle.text()).toBe(`${name}, dark and light · nothing changes until you choose`);
    const changes = w.get('[data-testid="theme-change-changes"]');
    expect(changes.findAll('bdi').map((run) => run.text())).toEqual([name]);
    expect(w.text()).not.toMatch(/[\u2066-\u2069]/);
    // an accessible name is read, never laid out, so it carries no mark either
    expect(w.get('[data-testid="theme-miniature"]').attributes('aria-label')).toBe(`${name}, dark and light looks`);
  });

  it('answers Discard and stays, saying so, until core closes the card', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-option-discard"]').trigger('click');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' }]);
    expect(card(w).exists()).toBe(true);
    expect(useThemePromptStore().changePrompts).toHaveLength(1);
    expect(w.get('[data-testid="theme-change-answering"]').text()).toBe('Sending your answer…');
    // nothing else is sent while the answer is out
    await w.get('[data-testid="theme-change-option-apply"]').trigger('click');
    press('3');
    await w.get('[data-testid="theme-change-show"]').trigger('click');
    await flushPromises();
    expect(posted).toHaveLength(1);
    expect(w.find('[data-testid="theme-change-note"]').exists()).toBe(false);

    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    await flushPromises();
    expect(card(w).exists()).toBe(false);
  });

  it('shows a card core turned outdated under a Discard press, with Discard usable again', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-option-discard"]').trigger('click');
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'outdated' });
    await flushPromises();

    expect(w.find('[data-testid="theme-change-answering"]').exists()).toBe(false);
    expect(w.find('[data-testid="theme-change-outdated"]').exists()).toBe(true);
    expect(options(w)).toEqual(['Discard']);
    await w.get('[data-testid="theme-change-option-discard"]').trigger('click');
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' });
  });

  it('answers Apply once, and is locked by the state core sends until core closes the card', async () => {
    const w = await raised();
    const option = w.get('[data-testid="theme-change-option-apply"]');
    await option.trigger('click');
    await option.trigger('click');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'apply' }]);
    expect(w.get('[data-testid="theme-change-applying"]').text()).toBe('Applying…');
    // the card's state is still core's: only its own answer is out
    expect(card(w).attributes('data-state')).toBe('waiting');

    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'applying' });
    await flushPromises();
    expect(card(w).attributes('data-state')).toBe('applying');
    expect(w.get('[data-testid="theme-change-applying"]').text()).toBe('Applying…');
    expect(listbox(w).attributes('aria-disabled')).toBe('true');
    expect(listbox(w).attributes('aria-describedby')).toBe('theme-change-check-reason');
    press('2');
    await w.get('[data-testid="theme-change-option-discard"]').trigger('click');
    await w.get('[data-testid="theme-change-show"]').trigger('click');
    await flushPromises();
    expect(posted).toHaveLength(1);

    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    await flushPromises();
    expect(card(w).exists()).toBe(false);
  });

  it('is locked, Discard included, on a view that gets the card while another view\'s Apply is under way', async () => {
    const w = await raised({ ...REQUEST, state: 'applying' });
    expect(w.get('[data-testid="theme-change-applying"]').text()).toBe('Applying…');
    expect(listbox(w).attributes('aria-disabled')).toBe('true');
    press('1');
    press('2');
    await w.get('[data-testid="theme-change-option-discard"]').trigger('click');
    await flushPromises();
    expect(posted).toEqual([]);

    // the Apply ended and the tool waits again
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'waiting' });
    await flushPromises();
    expect(w.find('[data-testid="theme-change-applying"]').exists()).toBe(false);
    expect(listbox(w).attributes('aria-disabled')).toBeUndefined();
    press('2');
    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' }]);
  });

  it('is free again when core answers an Apply it did not take by posting the card as it stands', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-option-apply"]').trigger('click');
    expect(w.find('[data-testid="theme-change-applying"]').exists()).toBe(true);
    deliver(REQUEST);
    await flushPromises();

    expect(w.findAll('[data-testid="theme-change-card"]')).toHaveLength(1);
    expect(w.find('[data-testid="theme-change-applying"]').exists()).toBe(false);
    await w.get('[data-testid="theme-change-option-apply"]').trigger('click');
    expect(posted).toEqual([
      { type: 'resolveThemeChange', promptId: 'tc-1', choice: 'apply' },
      { type: 'resolveThemeChange', promptId: 'tc-1', choice: 'apply' },
    ]);
  });

  it('turns Outdated with Discard only when Apply finds the theme changed meanwhile', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-option-apply"]').trigger('click');
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'applying' });
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'outdated' });
    await flushPromises();

    expect(w.find('[data-testid="theme-change-applying"]').exists()).toBe(false);
    expect(w.find('[data-testid="theme-change-outdated"]').exists()).toBe(true);
    expect(options(w)).toEqual(['Discard']);
    await w.get('[data-testid="theme-change-option-discard"]').trigger('click');
    await flushPromises();
    expect(posted).toEqual([
      { type: 'resolveThemeChange', promptId: 'tc-1', choice: 'apply' },
      { type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' },
    ]);
    expect(card(w).exists()).toBe(true);
    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    await flushPromises();
    expect(card(w).exists()).toBe(false);
  });

  it('opens a note form on Change…, goes Back to the answers, and sends a trimmed note', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-option-change"]').trigger('click');
    await flushPromises();

    const note = w.get('[data-testid="theme-change-note"]');
    expect(document.activeElement).toBe(note.element);
    expect(w.get('label[for="theme-change-note"]').text()).toBe('What should change?');
    expect(w.get('[data-testid="theme-change-send-note"]').attributes('disabled')).toBeDefined();

    await w.get('[data-testid="theme-change-back"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="theme-change-note-form"]').exists()).toBe(false);
    expect(options(w)).toEqual(['Apply', 'Discard', 'Change…']);
    expect(listbox(w).element.contains(document.activeElement)).toBe(true);
    expect(posted).toEqual([]);

    await w.get('[data-testid="theme-change-option-change"]').trigger('click');
    await flushPromises();
    await w.get('[data-testid="theme-change-note"]').setValue('  Less orange, keep the panels darker.  ');
    await w.get('form').trigger('submit');
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'change', note: 'Less orange, keep the panels darker.' }]);
    // sent once, and the card stays until core closes it
    await w.get('form').trigger('submit');
    expect(posted).toHaveLength(1);
    expect(card(w).exists()).toBe(true);
    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    await flushPromises();
    expect(card(w).exists()).toBe(false);
  });

  it('moves through the answers with the arrows, Home and End, and answers the highlighted one with Enter', async () => {
    const w = await raised();
    const list = listbox(w);
    (list.element as HTMLElement).focus();
    await flushPromises();
    const highlighted = (): string | undefined => w.find('[role="option"][data-highlighted]').attributes('data-testid');

    await list.trigger('keydown', { key: 'End' });
    expect(highlighted()).toBe('theme-change-option-change');
    await list.trigger('keydown', { key: 'Home' });
    expect(highlighted()).toBe('theme-change-option-apply');
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(highlighted()).toBe('theme-change-option-discard');
    await list.trigger('keydown', { key: 'ArrowUp' });
    await list.trigger('keydown', { key: 'ArrowDown' });
    await w.get('[data-testid="theme-change-option-discard"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' }]);
  });

  it('answers from digits: 1 applies, 3 opens the note and never answers, 4 does nothing', async () => {
    const w = await raised();
    press('4');
    press('3');
    await flushPromises();
    expect(posted).toEqual([]);
    expect(w.find('[data-testid="theme-change-note"]').exists()).toBe(true);

    await w.get('[data-testid="theme-change-back"]').trigger('click');
    await flushPromises();
    press('1');
    await flushPromises();
    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'apply' }]);
  });

  it('turns Show in window on through core, shows Stop showing while on, and stops from it', async () => {
    const w = await raised();
    const toggle = w.get('[data-testid="theme-change-show"]');
    expect(toggle.text()).toBe('Show in window');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(w.find('[data-testid="theme-change-stop"]').exists()).toBe(false);

    await toggle.trigger('click');
    expect(posted).toEqual([{ type: 'setThemeShowInWindow', promptId: 'tc-1', on: true }]);
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', showInWindow: true });
    await flushPromises();
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(w.get('[data-testid="theme-change-showing"]').text()).toBe('Showing in the window');

    await w.get('[data-testid="theme-change-stop"]').trigger('click');
    expect(posted.at(-1)).toEqual({ type: 'setThemeShowInWindow', promptId: 'tc-1', on: false });
    expect(document.activeElement).toBe(toggle.element);
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', showInWindow: false });
    await flushPromises();
    expect(w.find('[data-testid="theme-change-stop"]').exists()).toBe(false);
    expect(w.get('[data-testid="theme-change-showing"]').text()).toBe('');
  });

  it('says so, as a status message, when another preview took over the window', async () => {
    const w = await raised({ ...REQUEST, showInWindow: true });
    const status = w.get('[data-testid="theme-change-showing"]');
    expect(status.attributes('role')).toBe('status');
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', showInWindow: false, showNote: 'takenOver' });
    await flushPromises();
    expect(status.text()).toBe('Another preview took over the window.');
    expect(w.get('[data-testid="theme-change-show-row"]').text()).not.toContain('Paints the whole window');

    // a later stop with no note takes the sentence away, as core's stored card does
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', showInWindow: false });
    await flushPromises();
    expect(status.text()).toBe('');
    expect(w.get('[data-testid="theme-change-show-row"]').text()).toContain('Paints the whole window until you stop or answer.');
  });

  it.each([
    ['forcedColors', "Windows contrast themes are on, so the window shows Damocles' own look and cannot show this proposal."],
    ['safeStart', 'This run shows the Damocles theme, so the window cannot show this proposal.'],
  ] as const)('keeps the toggle off and says why when the window cannot show a proposal (%s)', async (showNote, sentence) => {
    const w = await raised();
    await w.get('[data-testid="theme-change-show"]').trigger('click');
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', showInWindow: false, showNote });
    await flushPromises();
    expect(w.get('[data-testid="theme-change-show"]').attributes('aria-pressed')).toBe('false');
    expect(w.get('[data-testid="theme-change-showing"]').text()).toBe(sentence);
    expect(w.find('[data-testid="theme-change-stop"]').exists()).toBe(false);
  });

  it('expands the preview with look picks Both, Dark and Light', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-expand"]').trigger('click');
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Amber Night preview');
    const mini = (): HTMLElement => document.querySelector('[data-testid="theme-change-preview-mini"]') as HTMLElement;
    const pick = (mode: string): HTMLElement => document.querySelector(`[data-testid="theme-change-pick-${mode}"]`) as HTMLElement;
    expect([...document.querySelectorAll('[role="group"] button')].map((button) => button.textContent?.trim())).toEqual(['Both', 'Dark', 'Light']);
    expect(pick('split').getAttribute('aria-pressed')).toBe('true');
    expect(mini().getAttribute('aria-label')).toBe('Amber Night, dark and light looks, large');

    pick('dark').click();
    await flushPromises();
    expect(pick('dark').getAttribute('aria-pressed')).toBe('true');
    expect(pick('split').getAttribute('aria-pressed')).toBe('false');
    expect(mini().getAttribute('aria-label')).toBe('Amber Night, dark look, large');

    pick('light').click();
    await flushPromises();
    expect(mini().getAttribute('aria-label')).toBe('Amber Night, light look, large');

    (document.querySelector('[aria-label="Close preview"]') as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('[data-testid="theme-change-preview-mini"]')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('while the visibility check runs, disables the answers and Show in window and says why, but still expands the preview', async () => {
    const visibility = installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const w = await raised();
    expect(visibility.inits.at(-1)).toMatchObject({ threshold: 1, trackVisibility: true, delay: 100 });
    expect(listbox(w).attributes('aria-disabled')).toBe('true');
    // The reason shows once the check outlasts the card's entrance, in a live region the card holds from the start.
    const reason = w.get('#theme-change-checking');
    expect(reason.attributes('role')).toBe('status');
    expect(reason.text()).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 550));
    await flushPromises();
    expect(reason.text()).toBe('This card must be fully visible before you can answer. Scroll it into view or move what covers it.');
    expect(listbox(w).attributes('aria-disabled')).toBe('true');
    expect(listbox(w).attributes('aria-describedby')).toBe('theme-change-checking');
    expect(w.get('[data-testid="theme-change-show"]').attributes('aria-disabled')).toBe('true');

    press('1');
    await w.get('[data-testid="theme-change-option-apply"]').trigger('click');
    await w.get('[data-testid="theme-change-show"]').trigger('click');
    await flushPromises();
    expect(posted).toEqual([]);

    await w.get('[data-testid="theme-change-expand"]').trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-testid="theme-change-preview-mini"]')).not.toBeNull();

    visibility.report(true);
    await flushPromises();
    expect(reason.text()).toBe('');
    await w.get('[data-testid="theme-change-option-discard"]').trigger('click');
    await flushPromises();
    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' }]);
  });

  it('names the CSS a proposal changes and lists what the sanitizer removed, with each reason worded here', async () => {
    const w = await raised({
      ...REQUEST,
      changes: [{ kind: 'css', region: 'transcript', cleared: false }, { kind: 'css', region: 'titlebar', cleared: true }],
      droppedCss: [
        { region: 'transcript', reason: 'property', text: 'display: none', line: 3 },
        { region: 'transcript', reason: 'url', text: 'background: url(https://example.com/a.png)' },
      ],
    });
    expect(w.get('[data-testid="theme-change-changes"]').text()).toContain('New custom CSS for the transcript');
    expect(w.get('[data-testid="theme-change-changes"]').text()).toContain('Custom CSS removed from the title bar');
    const dropped = w.get('[data-testid="theme-change-dropped"]');
    expect(dropped.find('h3').text()).toBe('Removed from the CSS');
    const parts = dropped.findAll('li');
    expect(parts.map((part) => part.attributes('data-reason'))).toEqual(['property', 'url']);
    expect(parts[0]!.find('code').text()).toBe('display: none');
    expect(parts[0]!.text()).toContain('transcript, line 3: theme CSS may not set this property');
    expect(parts[1]!.text()).toContain('transcript: only still data: images up to 16 KB are allowed; nothing loads from the network');
  });

  it('words every reason the sanitizer can give, in English and Greek', async () => {
    expect(await loadLocale('el')).toBe(true);
    for (const locale of ['en', 'el'] as const) {
      setActivePinia(createPinia());
      i18n.global.locale.value = locale;
      const w = await raised({ ...REQUEST, promptId: `tc-${locale}`, droppedCss: CSS_DROP_REASONS.map((reason) => ({ region: 'sidebar', reason, text: reason })) });
      const parts = w.get('[data-testid="theme-change-dropped"]').findAll('li');
      expect(parts).toHaveLength(CSS_DROP_REASONS.length);
      for (const part of parts) expect(part.text(), `${locale} ${part.attributes('data-reason')}`).not.toMatch(/[{}]|themeAgent/);
      wrapper?.unmount();
      wrapper = null;
    }
    i18n.global.locale.value = 'en';
  });

  it.each([
    ['a request that arrives outdated', () => raisedAfterMount({ ...REQUEST, state: 'outdated' })],
    ['a card mounted over an outdated request', () => raised({ ...REQUEST, state: 'outdated' })],
  ] as const)('offers Discard alone and answers it with Enter, from %s', async (_name, raise) => {
    const w = await raise();
    expect(options(w)).toEqual(['Discard']);
    expect(w.find('[data-testid="theme-change-show-row"]').exists()).toBe(false);
    expect(w.find('[role="option"][data-highlighted]').attributes('data-testid')).toBe('theme-change-option-discard');
    (listbox(w).element as HTMLElement).focus();
    await flushPromises();
    await w.get('[role="option"][data-highlighted]').trigger('keydown', { key: 'Enter' });
    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' }]);
  });

  it('shows one card for a prompt posted twice, in the state of the later post', async () => {
    const w = await raisedAfterMount();
    deliver({ ...REQUEST, state: 'outdated' });
    await flushPromises();
    expect(w.findAll('[data-testid="theme-change-card"]')).toHaveLength(1);
    expect(card(w).attributes('data-state')).toBe('outdated');
    expect(options(w)).toEqual(['Discard']);
  });

  it('turns outdated with Discard only, from an update', async () => {
    const w = await raised();
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'outdated' });
    await flushPromises();

    expect(w.get('[data-testid="theme-change-subtitle"]').text()).toBe('Amber Night, dark and light · out of date');
    expect(w.get('[data-testid="theme-change-outdated"]').text()).toBe('This theme changed after the agent proposed this. Ask again for a fresh preview.');
    expect(options(w)).toEqual(['Discard']);
    expect(w.find('[data-testid="theme-change-show-row"]').exists()).toBe(false);

    press('2');
    await flushPromises();
    expect(posted).toEqual([]);
    press('1');
    await flushPromises();
    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' }]);
  });

  it('on another device of a remote chat, names the computer that changes, shows no image and offers Discard only', async () => {
    const { theme: _theme, ...rest } = REQUEST;
    const w = await raised({ ...rest, canShowInWindow: false, otherDevice: { computer: 'DESKTOP-7Q2' } });

    expect(w.get('[data-testid="theme-change-subtitle"]').text()).toBe('Amber Night, dark and light · on DESKTOP-7Q2');
    expect(w.get('[data-testid="theme-change-computer"]').attributes('data-trusted-mark')).toBeDefined();
    expect(w.get('[data-testid="theme-change-other-device"]').text()).toBe("Applies on DESKTOP-7Q2, the computer this chat's turn runs from. Answer there to apply it; from here you can discard it.");
    expect(w.find('[data-testid="theme-miniature"]').exists()).toBe(false);
    expect(w.get('[data-testid="theme-change-other-placeholder"]').text()).toBe('Preview shows on DESKTOP-7Q2');
    expect(w.find('[data-testid="theme-change-show-row"]').exists()).toBe(false);
    expect(w.get('[data-testid="theme-change-changes"]').text()).toContain('Corner radius 0.6');
    expect(options(w)).toEqual(['Discard']);

    press('2');
    await flushPromises();
    expect(posted).toEqual([]);
    press('1');
    await flushPromises();
    expect(posted).toEqual([{ type: 'resolveThemeChange', promptId: 'tc-1', choice: 'discard' }]);
  });

  it('says when plan mode turned an on-the-fly apply into this card', async () => {
    const w = await raised({ ...REQUEST, planMode: true });
    expect(w.get('[data-testid="theme-change-plan-mode"]').text()).toBe('Plan mode: this change would have applied on the fly, so it waits for your answer here.');
  });

  it('leaves when core closes it, and hands focus on when it held it', async () => {
    const w = await raised();
    (w.get('[role="option"]').element as HTMLElement).focus();
    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    await flushPromises();
    expect(card(w).exists()).toBe(false);
    expect(w.emitted('release-focus')).toHaveLength(1);
    expect(posted).toEqual([]);
  });

  it('speaks Greek in the el locale, numbers included', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const w = await raised();
    expect(card(w).attributes('aria-label')).toBe('Προεπισκόπηση νέου θέματος');
    expect(options(w)).toEqual(['Εφαρμογή', 'Απόρριψη', 'Αλλαγή…']);
    expect(w.get('[data-testid="theme-change-contrast"]').text()).toContain('3,9:1');
    expect(w.get('[data-testid="theme-change-contrast"]').text()).toContain('4,5:1');
    expect(w.get('[data-testid="theme-change-changes"]').text()).toContain('0,6');
  });
});

describe('what the theme preview card says and draws', () => {
  const { theme: _theme, ...NO_THEME } = REQUEST;

  it('names no look for a project look that shows no theme', async () => {
    const w = await raised({ ...NO_THEME, action: 'project', themeName: 'my-project', looks: [], changes: [{ kind: 'projectLook', project: 'my-project', look: 'none' }] });
    expect(w.get('[data-testid="theme-change-subtitle"]').text()).toBe('my-project · nothing changes until you choose');
  });

  it('paints a swatch only from a hex color, as a background color', async () => {
    const w = await raised({
      ...REQUEST,
      changes: [{ kind: 'color', look: 'dark', seed: 'accent', hex: '#e0a030' }, { kind: 'color', look: 'dark', seed: 'panel', hex: 'url(https://example.com/a.png)' }],
    });
    const swatches = w.findAll('[data-testid="theme-change-swatch"]');
    expect(swatches).toHaveLength(1);
    expect(swatches[0]!.attributes('style')).toMatch(/^background-color:\s*(#e0a030|rgb\(224, 160, 48\));?$/);
    expect(w.get('[data-testid="theme-change-changes"]').findAll('li')).toHaveLength(2);
    expect(w.findAll('[style*="url("]')).toHaveLength(0);
  });

  it('gives the changes the full width when the card has no preview column', async () => {
    const schedule = await raised({ ...NO_THEME, action: 'schedule', looks: [], changes: [{ kind: 'schedule', enabled: true, rules: 2 }] });
    expect(schedule.get('[data-testid="theme-change-grid"]').classes().join(' ')).not.toContain('17rem');
    schedule.unmount();
    setActivePinia(createPinia());
    const themed = await raised();
    expect(themed.get('[data-testid="theme-change-grid"]').classes().join(' ')).toContain('grid-cols-[17rem_minmax(0,1fr)]');
  });

  it('says how many more parts the sanitizer removed than it lists', async () => {
    const w = await raised({ ...REQUEST, droppedCss: [{ region: 'transcript', reason: 'property', text: 'display: none', line: 3 }], droppedCssMore: 3 });
    expect(w.get('[data-testid="theme-change-dropped-more"]').text()).toBe('and 3 more');
    w.unmount();
    setActivePinia(createPinia());
    const all = await raised({ ...REQUEST, droppedCss: [{ region: 'transcript', reason: 'property', text: 'display: none', line: 3 }] });
    expect(all.find('[data-testid="theme-change-dropped-more"]').exists()).toBe(false);
  });

  it('on another device with no computer name says it applies elsewhere, and names a computer only after "on"', async () => {
    const unnamed = await raised({ ...NO_THEME, canShowInWindow: false, otherDevice: {} });
    expect(unnamed.get('[data-testid="theme-change-subtitle"]').text()).toBe('Amber Night, dark and light · applies on another computer');
    expect(unnamed.find('[data-testid="theme-change-computer"]').exists()).toBe(false);
    unnamed.unmount();
    setActivePinia(createPinia());

    const outdated = await raised({ ...NO_THEME, canShowInWindow: false, state: 'outdated', otherDevice: { computer: 'DESKTOP-7Q2' } });
    expect(outdated.get('[data-testid="theme-change-subtitle"]').text()).toBe('Amber Night, dark and light · out of date');
    expect(outdated.find('[data-testid="theme-change-computer"]').exists()).toBe(false);
  });

  it('is one bounded element whose details scroll inside it, and which scrolls itself once they have no room left', async () => {
    const w = await raised();
    expect(card(w).classes()).toEqual(expect.arrayContaining(['flex', 'flex-col', 'max-h-[70dvh]', 'min-h-0', 'overflow-x-hidden', 'overflow-y-auto']));
    expect(w.get('[data-testid="theme-change-details"]').classes()).toEqual(expect.arrayContaining(['min-h-0', 'overflow-y-auto']));
  });
});

describe('a theme preview card replaced by the next request', () => {
  // keyed on the Transition's child, a leaving card stayed in the page beside the card of the next request
  it('is one card in the page when the next request arrives while the closed one leaves', async () => {
    wrapper = mount(ThemeChangePrompt, { global: { plugins: [i18n], stubs: { transition: false } }, attachTo: document.body });
    deliver(REQUEST);
    await nextTick();
    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    await nextTick();
    deliver({ ...REQUEST, promptId: 'tc-2' });
    await nextTick();

    expect(document.querySelectorAll('[data-testid="theme-change-card"]')).toHaveLength(1);
  });
});

describe('focus on the theme preview card', () => {
  it('goes to the answers when core turns the card outdated under a focused Apply', async () => {
    const w = await raised();
    (w.get('[data-testid="theme-change-option-apply"]').element as HTMLElement).focus();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('theme-change-option-apply');
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'outdated' });
    await flushPromises();
    expect(listbox(w).element.contains(document.activeElement)).toBe(true);
    expect(w.emitted('release-focus')).toBeUndefined();
  });

  it('goes to the answers when the card turns outdated while its note is being written', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-option-change"]').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(w.get('[data-testid="theme-change-note"]').element);
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'outdated' });
    await flushPromises();
    expect(w.find('[data-testid="theme-change-note-form"]').exists()).toBe(false);
    expect(listbox(w).element.contains(document.activeElement)).toBe(true);
  });

  it('stays in the composer when the card turns outdated while the user types there', async () => {
    const outside = document.createElement('textarea');
    document.body.append(outside);
    await raised();
    outside.focus();
    deliver({ type: 'themeChangeUpdated', promptId: 'tc-1', state: 'outdated' });
    await flushPromises();
    expect(document.activeElement).toBe(outside);
  });

  it('is handed on when core closes the card while its expanded preview holds focus', async () => {
    const w = await raised();
    await w.get('[data-testid="theme-change-expand"]').trigger('click');
    await flushPromises();
    (document.querySelector('[data-testid="theme-change-pick-dark"]') as HTMLElement).focus();
    expect(card(w).element.contains(document.activeElement)).toBe(false);
    deliver({ type: 'themeChangeClosed', promptId: 'tc-1' });
    await flushPromises();
    expect(w.emitted('release-focus')).toHaveLength(1);
  });

  it('says Stop showing is held while the visibility check runs', async () => {
    installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const w = await raised({ ...REQUEST, showInWindow: true });
    const stop = w.get('[data-testid="theme-change-stop"]');
    expect(stop.attributes('aria-disabled')).toBe('true');
    await stop.trigger('click');
    expect(posted).toEqual([]);
  });
});
