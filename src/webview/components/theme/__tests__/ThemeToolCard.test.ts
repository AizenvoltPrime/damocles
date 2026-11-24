// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import type { ThemeToolDetails } from '@shared/themes/agent';
import ThemeToolCard from '@/components/theme/ThemeToolCard.vue';
import { i18n, loadLocale } from '@/i18n';
import { BUILTIN_THEME, SYSTEM_THEME_ID } from '@shared/themes/builtin';
import { systemTheme } from '@shared/themes/system-theme';
import { miniatureTheme } from '@shared/themes/agent';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { installPreview } from './install-preview';

const posted = vi.hoisted(() => [] as unknown[]);
const listeners = vi.hoisted(() => new Set<(message: unknown) => void>());
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (message: unknown) => void posted.push(message),
    onMessage: (listener: (message: unknown) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  }),
}));

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  useThemePromptStore().$reset();
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
});

function call(overrides: Partial<ToolCall> = {}, details?: Partial<ThemeToolDetails>): ToolCall {
  return {
    id: 'call_1',
    name: 'ThemeSet',
    input: { name: 'Amber Night' },
    status: 'completed',
    ...(details ? { metadata: { tool: 'ThemeSet', ...details } } : {}),
    ...overrides,
  };
}

async function show(toolCall: ToolCall): Promise<VueWrapper> {
  wrapper = mount(ThemeToolCard, { props: { toolCall }, global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const outcome = (w: VueWrapper): string => w.get('[data-testid="theme-tool-outcome"]').text();
const body = (w: VueWrapper): string => w.get('[data-testid="theme-tool-body"]').text();

describe('the ThemeSet tool card', () => {
  it('says it waits on the card below while its prompt is open', async () => {
    useThemePromptStore().setChangePrompt({
      promptId: 'tc-1', toolUseId: 'call_1', action: 'theme', themeName: 'Amber Night', looks: ['dark'], isNew: true, changes: [], contrast: [],
      state: 'waiting', planMode: false, canShowInWindow: true, showInWindow: false, owner: { kind: 'main' },
    });
    const w = await show(call({ status: 'running' }));
    expect(w.text()).toContain(i18n.global.t('toolCall.awaitingApproval'));
    expect(w.get('[data-testid="theme-tool-waiting"]').text()).toBe('Waiting for your answer on the preview card below the chat.');
  });

  it.each([
    [{ outcome: 'applied', themeName: 'Amber Night', looks: ['dark', 'light'] }, 'Applied', 'Applied: Amber Night (dark and light).'],
    [{ outcome: 'kept', themeName: 'Amber Night', applyMode: 'onTheFly' }, 'Kept', 'Kept after the 15-second check.'],
    [{ outcome: 'reverted', themeName: 'Amber Night' }, 'Reverted', 'Reverted.'],
    [{ outcome: 'discarded', themeName: 'Amber Night' }, 'Discarded', 'Discarded. Nothing changed.'],
    [{ outcome: 'changesRequested', themeName: 'Amber Night', note: 'Less orange, keep the panels darker.' }, 'Changes requested', 'Changes requested: “Less orange, keep the panels darker.”'],
    [{ outcome: 'outdated', themeName: 'Amber Night' }, 'Outdated', 'Out of date: Amber Night changed after the agent proposed this.'],
    [{ outcome: 'undone', undone: { kind: 'save', theme: 'Amber Night' } }, 'Undone', 'Undone: saved Amber Night.'],
  ] as const)('shows %o as %s from the result details', async (details, label, lead) => {
    const failed = details.outcome === 'changesRequested' || details.outcome === 'outdated';
    const w = await show(call({ status: failed ? 'failed' : 'completed', ...(failed ? { isError: true, errorMessage: 'refused' } : {}) }, details as Partial<ThemeToolDetails>));
    expect(outcome(w)).toBe(label);
    expect(body(w)).toContain(lead);
    expect(w.get('[data-tool-card]').attributes('data-outcome')).toBe(details.outcome);
    expect(w.text()).not.toContain('refused');
  });

  it('reads changes requested in the warning tone, not as a failure', async () => {
    const w = await show(call({ status: 'failed', isError: true }, { outcome: 'changesRequested', note: 'Darker.' }));
    expect(w.get('[data-testid="theme-tool-outcome"]').classes()).toContain('text-(--d-warning)');
    expect(w.classes().join(' ')).not.toContain('danger');
  });

  it('names the later change that refused an undo', async () => {
    const w = await show(call({ status: 'failed', isError: true, input: { undo: true } }, { laterChange: { change: { kind: 'pick', look: 'dark', theme: 'Bleach', was: 'Amber Night' }, actor: { kind: 'user' }, at: 1 } }));
    expect(body(w)).toBe('Not undone: you picked Bleach for the dark look after it.');
  });

  it('asks for its images only through requestToolResultImages and keeps the ones it gets out of every store', async () => {
    const w = await show(call({ name: 'ThemeRead', input: { preview: true }, imageCount: 1 }, { tool: 'ThemeRead' }));
    expect(posted).toEqual([expect.objectContaining({ type: 'requestToolResultImages', toolUseId: 'call_1', owner: { kind: 'session' } })]);
    const { requestId } = posted[0] as { requestId: string };
    const data = 'iVBORw0KGgoAAAANSUhEUg==';
    for (const listener of [...listeners]) listener({ type: 'toolResultImages', requestId, images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] });
    await flushPromises();

    expect(w.get('[data-testid="tool-result-image"] img').attributes('src')).toMatch(/^blob:/);
    const state = JSON.stringify(getActivePinia()!.state.value);
    expect(state).not.toContain(data);
    expect(state).not.toContain('data:image');
    expect(state).not.toContain('blob:');
  });

  it('keeps an open install card\'s thumbnails out of every store too', async () => {
    const preview = installPreview();
    useThemePromptStore().setInstallPrompt({ promptId: 'ti-1', toolUseId: 'call_1', preview: { ...preview, wallpapers: preview.wallpapers.map((wallpaper) => ({ ...wallpaper, thumb: 'data:image/webp;base64,UklGRg==' })) }, owner: { kind: 'main' } });
    await show(call({ status: 'running', input: { install: { url: 'https://example.com/a.damocles-theme' } } }));
    expect(JSON.stringify(getActivePinia()!.state.value)).not.toContain('data:image');
  });

  it('names an install by its host while it waits, then the installed name and the arrangement opt-in', async () => {
    const input = { install: { url: 'https://raw.githubusercontent.com/nordlys/aurora/main/aurora.damocles-theme' } };
    useThemePromptStore().setInstallPrompt({ promptId: 'ti-1', toolUseId: 'call_1', preview: installPreview(), owner: { kind: 'main' } });
    const waiting = await show(call({ status: 'running', input }));
    expect(waiting.text()).toContain('install, raw.githubusercontent.com');
    expect(waiting.get('[data-testid="theme-tool-waiting"]').text()).toBe('Waiting for your answer on the install card below the chat.');
    waiting.unmount();
    useThemePromptStore().removeInstallPrompt('ti-1');

    const w = await show(call({ input }, { outcome: 'installed', themeName: 'Aurora Borealis 2', useArrangement: true }));
    expect(outcome(w)).toBe('Installed');
    expect(body(w)).toContain('Installed “Aurora Borealis 2”.');
    expect(body(w)).toContain('Its window arrangement applies when you pick it.');
  });

  it('says an install was cancelled', async () => {
    const w = await show(call({ status: 'failed', isError: true, input: { install: { url: 'https://example.com/a.damocles-theme' } } }, { outcome: 'installCancelled' }));
    expect(outcome(w)).toBe('Cancelled');
    expect(body(w)).toContain('Install cancelled.');
    expect(body(w)).not.toContain('arrangement');
  });

  it('says an install expired when its card waited until the staged file was dropped', async () => {
    const w = await show(call({ status: 'failed', isError: true, input: { install: { url: 'https://example.com/a.damocles-theme' } } }, { outcome: 'installExpired' }));
    expect(outcome(w)).toBe('Expired');
    // time ran out and nobody refused: the warning tone, as for a proposal that went out of date
    expect(w.get('[data-testid="theme-tool-outcome"]').classes()).toContain('text-(--d-warning)');
    expect(body(w)).toContain('The install expired.');
    expect(body(w)).toContain('It waited over an hour for an answer, so nothing was installed.');
  });

  it('says a screenshot was sent or denied', async () => {
    const w = await show(call({ name: 'ThemeRead', input: { screenshot: true } }, { tool: 'ThemeRead', screenshot: 'denied' }));
    expect(outcome(w)).toBe('Denied');
    expect(body(w)).toContain('Screenshot denied.');
    expect(body(w)).toContain('No image was sent.');
    expect(body(w)).not.toContain('drawn preview');
  });

  it('says the agent still sees the drawn preview only when the denied call asked for one', async () => {
    const w = await show(call({ name: 'ThemeRead', input: { screenshot: true, preview: 'window' } }, { tool: 'ThemeRead', screenshot: 'denied' }));
    expect(body(w)).toContain('The agent sees the drawn preview only.');
    expect(body(w)).not.toContain('No image was sent.');
  });

  it.each([
    ['forcedColors', 'Windows contrast themes are on, so the window shows Damocles\' own look, not the theme.'],
    ['windowHidden', 'The window was minimized or hidden.'],
    ['covered', 'Another app covered the window. Bring Damocles to the front to take one.'],
    ['timeout', 'The window did not finish drawing the draft in time, so nothing was sent.'],
  ] as const)('says why main took no screenshot (%s), never that nobody answered', async (shotRefused, why) => {
    const w = await show(call({ name: 'ThemeRead', input: { screenshot: true } }, { tool: 'ThemeRead', shotRefused }));
    expect(outcome(w)).toBe('Not taken');
    expect(w.get('[data-testid="theme-tool-outcome"]').classes()).toContain('text-(--d-warning)');
    expect(body(w)).toContain('Screenshot not taken.');
    expect(body(w)).toContain(why);
    expect(body(w)).not.toContain('Nobody answered');
    expect(w.get('[data-tool-card]').attributes('data-outcome')).toBe('notTaken');
  });

  it('draws the screenshot it sent, a draft\'s included, from the result\'s images', async () => {
    const w = await show(call({ id: 'call_shot', name: 'ThemeRead', input: { screenshot: true, draft: 'draft-1' }, imageCount: 1 }, { tool: 'ThemeRead', screenshot: 'sent' }));
    expect(outcome(w)).toBe('Sent');
    expect(w.find('[data-testid="theme-tool-images"]').exists()).toBe(true);
    expect(posted).toEqual([expect.objectContaining({ type: 'requestToolResultImages', toolUseId: 'call_shot' })]);
  });

  it('says a screenshot was not sent when its card ran out or the window let go of the image', async () => {
    const w = await show(call({ name: 'ThemeRead', input: { screenshot: true } }, { tool: 'ThemeRead' }));
    expect(outcome(w)).toBe('Not sent');
    expect(w.get('[data-testid="theme-tool-outcome"]').classes()).toContain('text-(--d-warning)');
    expect(body(w)).toContain('Screenshot not sent.');
    expect(body(w)).toContain('Nobody answered its card in time, or the window no longer held the image.');
    expect(w.get('[data-tool-card]').attributes('data-outcome')).toBe('notSent');
    w.unmount();

    // a ThemeRead that asked for no screenshot, and one that failed, say nothing of one
    const plain = await show(call({ name: 'ThemeRead', input: { preview: true } }, { tool: 'ThemeRead' }));
    expect(plain.find('[data-testid="theme-tool-outcome"]').exists()).toBe(false);
    plain.unmount();
    const failed = await show(call({ name: 'ThemeRead', input: { screenshot: true }, status: 'failed', isError: true, errorMessage: 'no window' }, { tool: 'ThemeRead' }));
    expect(failed.find('[data-testid="theme-tool-outcome"]').exists()).toBe(false);
    expect(failed.text()).toContain('no window');
  });

  it('counts the removed CSS parts the result does not list', async () => {
    const w = await show(call({}, { outcome: 'applied', themeName: 'Amber Night', droppedCss: [{ region: 'transcript', reason: 'property', text: 'display: none' }], droppedCssMore: 41 }));
    expect(w.get('[data-testid="theme-tool-dropped-css"]').text()).toBe("42 parts of the theme's CSS were removed.");
  });
});

describe('the ThemeSet tool card and details it did not write', () => {
  const desktop = (): void => useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
  const metadata = (details: Record<string, unknown>): ToolCall => call({ metadata: { tool: 'ThemeSet', ...details } });

  it('draws the miniature of a result\'s theme in the desktop app only', async () => {
    const theme = miniatureTheme({ ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', name: 'Amber Night' });
    desktop();
    const shown = await show(metadata({ outcome: 'applied', themeName: 'Amber Night', theme }));
    expect(shown.get('[data-testid="theme-miniature"]').attributes('aria-label')).toBe('Amber Night, dark and light looks');
    shown.unmount();

    setActivePinia(createPinia());
    const replayed = await show(metadata({ outcome: 'applied', themeName: 'Amber Night', theme }));
    expect(replayed.find('[data-testid="theme-miniature"]').exists()).toBe(false);
    expect(body(replayed)).toContain('Applied: Amber Night.');
  });

  it('names a project look\'s System colors miniature in the UI\'s language', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    desktop();
    const w = await show(call({ input: { target: 'project', projectLook: { mode: 'full', themeId: SYSTEM_THEME_ID, look: 'auto' } } }, { outcome: 'applied', themeName: 'System colors', theme: miniatureTheme(systemTheme({}))! }));
    expect(w.get('[data-testid="theme-miniature"]').attributes('aria-label')).toBe('Χρώματα συστήματος, σκούρα και ανοιχτή εμφάνιση');
  });

  it('names Aurora in the UI\'s language on its miniature and in an undone pick', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    desktop();
    const aurora = await show(call({ input: { theme: 'damocles-aurora' } }, { outcome: 'applied', themeName: 'Aurora', theme: miniatureTheme({ ...BUILTIN_THEME, id: 'damocles-aurora', name: 'Aurora' })! }));
    expect(aurora.get('[data-testid="theme-miniature"]').attributes('aria-label')).toBe('Σέλας, σκούρα και ανοιχτή εμφάνιση');
    aurora.unmount();
    const undone = await show(metadata({ outcome: 'undone', undone: { kind: 'pick', look: 'dark', theme: 'Aurora', themeId: 'damocles-aurora', was: 'Damocles', wasId: 'damocles' } }));
    expect(body(undone)).toContain('Σέλας');
    expect(body(undone)).not.toContain('Aurora');
  });

  it('shows the plain card for an outcome it does not know', async () => {
    desktop();
    const w = await show(metadata({ outcome: 'teleported', themeName: 'Amber Night' }));
    expect(w.find('[data-testid="theme-tool-outcome"]').exists()).toBe(false);
    expect(w.find('[data-testid="theme-tool-body"]').exists()).toBe(false);
    expect(w.get('[data-tool-card]').attributes('data-outcome')).toBeUndefined();
    expect(w.get('[data-tool-card]').attributes('data-tool-status')).toBe('done');
  });

  it.each([
    ['no looks', { id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', name: 'Broken', schemaVersion: 1 }],
    ['a panel it does not know', { ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', looks: { dark: { ...BUILTIN_THEME.looks.dark, wallpapers: [{ span: { asset: 'a'.repeat(64), panels: ['roof'], fit: 'fill' } }] } } }],
    ['a color that is not one', { ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', looks: { dark: { colors: { ...BUILTIN_THEME.looks.dark!.colors, accent: 'url(https://example.com/a.png)' } } } }],
  ])('draws no miniature, and still its outcome, for a theme with %s', async (_name, theme) => {
    desktop();
    const w = await show(metadata({ outcome: 'applied', themeName: 'Amber Night', theme }));
    expect(w.find('[data-testid="theme-miniature"]').exists()).toBe(false);
    expect(outcome(w)).toBe('Applied');
    expect(body(w)).toContain('Applied: Amber Night.');
  });

  it('names no install host for a URL that has none', async () => {
    useThemePromptStore().setChangePrompt({
      promptId: 'tc-1', toolUseId: 'call_1', action: 'theme', themeName: 'Amber Night', looks: ['dark'], isNew: true, changes: [], contrast: [],
      state: 'waiting', planMode: false, canShowInWindow: true, showInWindow: false, owner: { kind: 'main' },
    });
    const w = await show(call({ status: 'running', input: { name: 'Amber Night', install: { url: 'mailto:someone@example.com' } } }));
    expect(w.text()).not.toContain('install,');
    expect(w.get('[data-testid="theme-tool-waiting"]').text()).toBe('Waiting for your answer on the preview card below the chat.');
  });

  it('words an install and a list in the UI\'s language', async () => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    useThemePromptStore().setInstallPrompt({ promptId: 'ti-1', toolUseId: 'call_1', preview: installPreview(), owner: { kind: 'main' } });
    const waiting = await show(call({ status: 'running', input: { install: { url: 'https://raw.githubusercontent.com/nordlys/aurora/main/aurora.damocles-theme' } } }));
    expect(waiting.text()).toContain('εγκατάσταση, raw.githubusercontent.com');
    waiting.unmount();
    useThemePromptStore().$reset();

    const undone = await show(metadata({ outcome: 'undone', undone: { kind: 'storeRemoved', themes: ['Aurora', 'Bleach', 'Arcade'] } }));
    expect(body(undone)).toContain('Aurora, Bleach και Arcade');
  });
});
