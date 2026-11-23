// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import ThemeInstallPrompt from '@/components/theme/ThemeInstallPrompt.vue';
import ThemeInstallCard from '@/components/theme/ThemeInstallCard.vue';
import { focusDockPrompt } from '@/composables/useDockPrompt';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { i18n, loadLocale } from '@/i18n';
import { SYSTEM_THEME_ID } from '@shared/themes/builtin';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { createThemeHandlers } from '@/composables/message-handler/handlers/theme-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { installVisibilityObserver } from '@/__tests__/visibility-observer';
import { CLASH, installPreview } from './install-preview';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

const request = (preview = installPreview()): ExtensionToWebviewMessage => ({ type: 'requestThemeInstall', promptId: 'ti-1', toolUseId: 'call_1', preview, owner: { kind: 'main' } });

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  i18n.global.locale.value = 'en';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  // the thumbnails are the page's, not the store's: a closed prompt lets go of them
  useThemePromptStore().$reset();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

// The prompt's messages arrive through the chat page's theme handlers, as core posts them.
function deliver(message: ExtensionToWebviewMessage): void {
  const handlers = createThemeHandlers() as Record<string, (msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void>;
  handlers[message.type]!(message, {} as HandlerContext);
}

async function raised(message = request()): Promise<VueWrapper> {
  deliver(message);
  wrapper = mount(ThemeInstallPrompt, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const card = (w: VueWrapper) => w.get('[data-testid="theme-install-card"]');
const button = (w: VueWrapper, testId: string) => w.get(`[data-testid="theme-install-${testId}"]`);
const radio = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) => element.id === name)!;
const press = (key: string): void => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('the theme install card', () => {
  it('shows what the theme holds as trusted docked UI, with the source host apart', async () => {
    const w = await raised();
    expect(card(w).attributes('role')).toBe('region');
    expect(card(w).attributes('aria-label')).toBe('Install “Aurora Borealis”?');
    expect(card(w).attributes('data-dock-prompt')).toBeDefined();
    expect(card(w).attributes('data-trusted')).toBeDefined();
    expect(w.get('[data-testid="theme-install-source"]').text()).toBe('From a damocles:// link on raw.githubusercontent.com');
    expect(w.get('[data-testid="theme-install-host"]').text()).toBe('raw.githubusercontent.com');
    expect(w.get('[data-testid="theme-miniature"]').attributes('aria-label')).toBe('Aurora Borealis, dark and light looks');
    expect(w.get('[data-testid="theme-install-fonts"]').text()).toContain('Iosevka, code (OFL-1.1, bundled)');
    expect(w.get('[data-testid="theme-install-css"]').text()).toBe('Present in 2 regions: transcript and sidebar. Cards like this one and Settings never get it.');
    expect(w.text()).toContain('Pixel set, 6 characters');
    const [still, moving] = w.findAll('[data-testid="theme-install-wallpaper"]').map((row) => row.text());
    expect(still).toContain('Still image, WebP, 3840 × 2160, 2.3 MB');
    expect(still).toContain('Light look: sidebar');
    expect(moving).toContain('Moving, WebM, 38 s, 17.2 MB');
    expect(moving).toContain('Dark look: one image across chat and sidebar');
    expect(moving).toContain('No flashing found.');
    expect(button(w, 'go').text()).toBe('Install');
  });

  it('names a converted format in a file source line and says how it converts; a Damocles theme file gets no note', async () => {
    const base16 = await raised(request(installPreview({ format: 'base16', source: { kind: 'file', fileName: 'gruvbox-dark.yaml' } })));
    expect(base16.get('[data-testid="theme-install-source"]').text()).toBe('A base16 or base24 scheme, from the file gruvbox-dark.yaml');
    expect(base16.get('[data-testid="theme-install-conversion"]').text()).toMatch(/^A base16 or base24 scheme becomes a Damocles theme: base00, base01 and base05/);
    base16.unmount();
    useThemePromptStore().$reset();
    for (const [format, fileName, source, note] of [
      ['vscode', 'dark.json', 'A VS Code theme, from the file dark.json', /^A VS Code theme becomes a Damocles theme/],
      ['kde', 'kdeglobals', 'A KDE color scheme, from the file kdeglobals', /^A KDE color scheme becomes a Damocles theme/],
      ['qt', 'graphite.conf', 'A qt5ct or qt6ct palette, from the file graphite.conf', /Qt has no success, warning or danger color, so those come from Damocles' own look/],
      ['gtk', 'gtk.css', 'GTK colors, from the file gtk.css', /comes from libadwaita, GTK's own look/],
    ] as const) {
      const card = await raised(request(installPreview({ format, source: { kind: 'file', fileName } })));
      expect(card.get('[data-testid="theme-install-source"]').text()).toBe(source);
      expect(card.get('[data-testid="theme-install-conversion"]').text()).toMatch(note);
      card.unmount();
      useThemePromptStore().$reset();
    }
    const damocles = await raised(request(installPreview({ source: { kind: 'file', fileName: 'aurora.damocles-theme' } })));
    expect(damocles.get('[data-testid="theme-install-source"]').text()).toBe('From the file aurora.damocles-theme');
    expect(damocles.find('[data-testid="theme-install-conversion"]').exists()).toBe(false);
  });

  it('words a format or source kind this build does not know as a plain file, with no conversion note', async () => {
    const unknown = { format: 'tmtheme', source: { kind: 'file', fileName: 'night.tmTheme' } } as unknown as Parameters<typeof installPreview>[0];
    const card = await raised(request(installPreview(unknown)));
    expect(card.get('[data-testid="theme-install-source"]').text()).toBe('From the file night.tmTheme');
    expect(card.find('[data-testid="theme-install-conversion"]').exists()).toBe(false);
    card.unmount();
    useThemePromptStore().$reset();
    const relayed = { source: { kind: 'mirror', host: 'example.com' } } as unknown as Parameters<typeof installPreview>[0];
    const other = await raised(request(installPreview(relayed)));
    expect(other.get('[data-testid="theme-install-source"]').text()).toBe('From the file example.com');
  });

  it('installs without a clash with the arrangement off by default, and holds Install, not Cancel, until core closes it', async () => {
    const w = await raised();
    const toggle = w.get('[data-testid="theme-install-arrangement"]');
    expect(toggle.attributes('role')).toBe('checkbox');
    expect(toggle.attributes('aria-checked')).toBe('false');
    expect(w.text()).toContain('Off: your arrangement stays as it is.');

    expect(w.get('#theme-install-busy').text()).toBe('');
    await button(w, 'go').trigger('click');
    await button(w, 'go').trigger('click');
    press('1');
    expect(posted).toEqual([{ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'install', useArrangement: false }]);
    expect(button(w, 'go').attributes('aria-disabled')).toBe('true');
    expect(button(w, 'go').attributes('aria-describedby')).toBe('theme-install-busy');
    expect(w.get('#theme-install-busy').attributes('role')).toBe('status');
    expect(w.get('#theme-install-busy').text()).toBe('Installing…');
    // a flash check's progress is no answer: Install stays held
    deliver({ type: 'themeInstallProgress', promptId: 'ti-1', sha256: installPreview().wallpapers[1]!.sha256, fraction: 0.3 });
    await flushPromises();
    expect(button(w, 'go').attributes('aria-disabled')).toBe('true');

    // core takes Cancel at any time
    expect(button(w, 'cancel').attributes('aria-disabled')).toBeUndefined();
    press('2');
    expect(posted.at(-1)).toEqual({ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'cancel' });
    expect(w.find('[data-testid="theme-install-card"]').exists()).toBe(true);

    deliver({ type: 'themeInstallClosed', promptId: 'ti-1' });
    await flushPromises();
    expect(w.find('[data-testid="theme-install-card"]').exists()).toBe(false);
  });

  it('says where the arrangement puts the panes, and sends the opt-in once it is checked', async () => {
    const base = installPreview();
    const grid = { slots: { main: 'chat', side: 'editor', bottom: 'terminal' }, visible: { editor: true, terminal: true }, sideWidth: 480, bottomHeight: 240 } as const;
    const w = await raised(request({ ...base, theme: { ...base.theme, layout: { grid } } }));
    expect(w.text()).toContain('Present: editor on the right and terminal below.');
    await w.get('[data-testid="theme-install-arrangement"]').trigger('click');
    expect(w.text()).toContain('On: the arrangement applies when you pick this theme.');
    press('1');
    expect(posted).toEqual([{ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'install', useArrangement: true }]);
  });

  it('cancels and stays until core closes it', async () => {
    const w = await raised();
    await button(w, 'cancel').trigger('click');
    await flushPromises();
    expect(posted).toEqual([{ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'cancel' }]);
    expect(useThemePromptStore().installPrompts).toHaveLength(1);
    expect(w.find('[data-testid="theme-install-card"]').exists()).toBe(true);

    deliver({ type: 'themeInstallClosed', promptId: 'ti-1' });
    await flushPromises();
    expect(w.find('[data-testid="theme-install-card"]').exists()).toBe(false);
  });

  it('frees Install when a clash arrives under the press, and when core posts the card again', async () => {
    const w = await raised();
    await button(w, 'go').trigger('click');
    expect(button(w, 'go').attributes('aria-disabled')).toBe('true');
    deliver({ type: 'themeInstallUpdated', promptId: 'ti-1', preview: installPreview({ clash: CLASH }) });
    await flushPromises();
    expect(button(w, 'go').attributes('aria-disabled')).toBeUndefined();
    expect(w.get('#theme-install-busy').text()).toBe('');
    expect(button(w, 'go').text()).toBe('Install as “Aurora Borealis 2”');

    await button(w, 'go').trigger('click');
    expect(posted.at(-1)).toEqual({ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'install', onClash: 'keepBoth', useArrangement: false });
    expect(button(w, 'go').attributes('aria-disabled')).toBe('true');
    deliver(request(installPreview({ clash: CLASH })));
    await flushPromises();
    expect(w.findAll('[data-testid="theme-install-card"]')).toHaveLength(1);
    expect(button(w, 'go').attributes('aria-disabled')).toBeUndefined();
  });

  it('on a name clash keeps both by default and names the outcome on Install', async () => {
    const w = await raised(request(installPreview({ clash: CLASH })));
    expect(w.get('[data-testid="theme-install-clash"]').text()).toContain('A theme named Aurora Borealis is installed.');
    expect(radio('theme-install-keep').getAttribute('aria-checked')).toBe('true');
    expect(button(w, 'go').text()).toBe('Install as “Aurora Borealis 2”');
    await button(w, 'go').trigger('click');
    expect(posted).toEqual([{ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'install', onClash: 'keepBoth', useArrangement: false }]);
  });

  it('on a name clash answers Replace once Replace is picked', async () => {
    const w = await raised(request(installPreview({ clash: CLASH })));
    radio('theme-install-replace').click();
    await flushPromises();
    expect(button(w, 'go').text()).toBe('Replace and install');
    await button(w, 'go').trigger('click');
    expect(posted).toEqual([{ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'install', onClash: 'replace', useArrangement: false }]);
  });

  it.each([
    [SYSTEM_THEME_ID, 'System colors', 'Χρώματα συστήματος'],
    ['damocles-aurora', 'Aurora', 'Σέλας'],
  ])('names a clash with the built-in %s in the UI\'s language', async (themeId, name, greek) => {
    expect(await loadLocale('el')).toBe(true);
    i18n.global.locale.value = 'el';
    const w = await raised(request(installPreview({ clash: { ...CLASH, themeId, name, replaceable: false } })));
    expect(w.get('[data-testid="theme-install-clash"]').text()).toContain(`Υπάρχει ήδη εγκατεστημένο θέμα με όνομα ${greek}.`);
  });

  it('offers only Keep both when the installed theme is a built-in', async () => {
    const w = await raised(request(installPreview({ clash: { ...CLASH, replaceable: false } })));
    expect(radio('theme-install-replace').hasAttribute('disabled') || radio('theme-install-replace').getAttribute('data-disabled') !== null).toBe(true);
    expect(w.get('[data-testid="theme-install-clash"]').text()).toContain('A built-in theme is never replaced.');
  });

  it("shows a flash check's progress while it runs, then a flagged wallpaper blocked with the seizure warning and Allow flashing for this file", async () => {
    const preview = installPreview();
    const sha = preview.wallpapers[1]!.sha256;
    const flagged = { ...preview.wallpapers[1]!, flash: 'flagged' as const, atMs: 2500, thumb: 'data:image/webp;base64,UklGRg==' };
    const w = await raised(request({ ...preview, wallpapers: [preview.wallpapers[0]!, { ...preview.wallpapers[1]!, flash: 'pending' }] }));
    expect(w.find('[data-testid="theme-install-flash-pending"]').text()).toBe('Checking every frame for flashing…');
    expect(button(w, 'go').attributes('aria-disabled')).toBeUndefined();
    deliver({ type: 'themeInstallProgress', promptId: 'ti-1', sha256: sha, fraction: 0.42 });
    await flushPromises();
    const progress = w.get('[data-testid="theme-install-flash-progress"]');
    expect(progress.attributes('role')).toBe('status');
    expect(progress.text()).toContain('Checking every frame for flashing… 42%');
    expect(progress.get('[role="progressbar"]').attributes('aria-label')).toBe('Flash check progress');

    deliver({ type: 'themeInstallUpdated', promptId: 'ti-1', preview: { ...preview, wallpapers: [preview.wallpapers[0]!, flagged] } });
    await flushPromises();
    const blocked = w.get('[data-testid="theme-install-flash-blocked"]');
    expect(blocked.attributes('aria-label')).toBe('Blocked: flashes');
    expect(blocked.text()).toContain('It flashes more than three times a second from 2.5 s, so it arrives blocked and the window shows its still frame.');
    expect(blocked.text()).toContain('Seizure warning: flashing images can trigger seizures');
    const row = w.findAll('[data-testid="theme-install-wallpaper"]')[1]!;
    expect(row.attributes('data-flash')).toBe('flagged');
    // the thumbnail is drawn from the page's image cache, and the store never holds it
    expect(row.get('img').attributes('src')).toMatch(/^blob:/);
    expect(JSON.stringify(getActivePinia()!.state.value)).not.toContain('data:image');

    await button(w, 'allow-flash').trigger('click');
    expect(posted).toEqual([{ type: 'allowThemeInstallFlash', promptId: 'ti-1', installId: preview.installId, sha256: sha }]);
    // core answers with the preview again, the file allowed on this computer
    deliver({ type: 'themeInstallUpdated', promptId: 'ti-1', preview: { ...preview, wallpapers: [preview.wallpapers[0]!, { ...flagged, allowed: true }] } });
    await flushPromises();
    expect(w.find('[data-testid="theme-install-flash-blocked"]').exists()).toBe(false);
    expect(w.get('[data-testid="theme-install-flash-allowed"]').text()).toBe('Flashing is allowed for this file on this computer. Reduce motion still pauses it.');
  });

  it('holds Allow flashing for this file while the visibility check runs', async () => {
    const visibility = installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const preview = installPreview();
    const w = await raised(request({ ...preview, wallpapers: [preview.wallpapers[0]!, { ...preview.wallpapers[1]!, flash: 'flagged', atMs: 2500 }] }));
    expect(button(w, 'allow-flash').attributes('aria-disabled')).toBe('true');
    await button(w, 'allow-flash').trigger('click');
    expect(posted).toEqual([]);
    visibility.report(true);
    await flushPromises();
    await button(w, 'allow-flash').trigger('click');
    expect(posted).toEqual([{ type: 'allowThemeInstallFlash', promptId: 'ti-1', installId: preview.installId, sha256: preview.wallpapers[1]!.sha256 }]);
  });

  it('on another device of a remote chat names the computer it installs on, offers Cancel alone, and no Allow', async () => {
    const preview = installPreview({ clash: CLASH });
    const message = request({ ...preview, wallpapers: [preview.wallpapers[0]!, { ...preview.wallpapers[1]!, flash: 'flagged', atMs: 2500 }] });
    const w = await raised({ ...message, otherDevice: { computer: 'DESKTOP-7Q2' } } as ExtensionToWebviewMessage);
    expect(w.get('[data-testid="theme-install-other-device"]').text()).toContain('It installs on DESKTOP-7Q2, not on this computer.');
    expect(w.find('[data-testid="theme-install-go"]').exists()).toBe(false);
    expect(radio('theme-install-keep').hasAttribute('disabled') || radio('theme-install-keep').getAttribute('data-disabled') !== null).toBe(true);
    expect(radio('theme-install-replace').hasAttribute('disabled') || radio('theme-install-replace').getAttribute('data-disabled') !== null).toBe(true);
    const toggle = w.get('[data-testid="theme-install-arrangement"]');
    expect(toggle.attributes('disabled') !== undefined || toggle.attributes('data-disabled') !== undefined).toBe(true);
    await toggle.trigger('click');
    expect(toggle.attributes('aria-checked')).toBe('false');
    expect(w.find('[data-testid="theme-install-allow-flash"]').exists()).toBe(false);
    expect(w.get('[data-testid="theme-install-flash-blocked"]').text()).toContain('Only the computer it installs on can allow flashing for this file.');
    press('1');
    expect(posted).toEqual([{ type: 'resolveThemeInstall', promptId: 'ti-1', choice: 'cancel' }]);
  });

  it('holds its buttons while the visibility check runs', async () => {
    const visibility = installVisibilityObserver(false);
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    const w = await raised();
    expect(button(w, 'go').attributes('aria-disabled')).toBe('true');
    await button(w, 'go').trigger('click');
    expect(posted).toEqual([]);
    visibility.report(true);
    await flushPromises();
    await button(w, 'go').trigger('click');
    expect(posted).toHaveLength(1);
  });

  it('marks the ThemeSet call as waiting on it', async () => {
    await raised();
    expect(useThemePromptStore().awaitedBy('call_1')).toBe(true);
  });
});

describe('what the theme install card draws', () => {
  const THUMB = 'data:image/webp;base64,UklGRg==';
  // the theme's dark look puts the moving wallpaper under the chat
  function walled(thumb?: string) {
    const preview = installPreview();
    const moving = preview.wallpapers[1]!;
    const dark = { ...preview.theme.looks.dark!, wallpapers: [{ panels: { chat: { asset: moving.sha256, fit: 'fill' as const, dim: 0.4, blur: 0 } } }] };
    return {
      ...preview,
      theme: { ...preview.theme, looks: { ...preview.theme.looks, dark } },
      wallpapers: [preview.wallpapers[0]!, { ...moving, flash: 'flagged' as const, allowed: true as const, ...(thumb !== undefined ? { thumb } : {}) }],
    };
  }
  const miniImages = (w: VueWrapper): string[] => w.get('[data-testid="theme-miniature"]').findAll('image').map((image) => image.attributes('href') ?? '');

  it('draws the miniature\'s wallpaper from the thumbnail the page holds', async () => {
    const w = await raised(request(walled(THUMB)));
    expect(miniImages(w)).toHaveLength(1);
    expect(miniImages(w)[0]).toMatch(/^blob:/);
    expect(w.findAll('[data-testid="theme-install-wallpaper"]')[1]!.get('img').attributes('src')).toBe(miniImages(w)[0]);
  });

  it('on another device, which holds no thumbnail, draws a plain miniature and a placeholder, and names the computer that allowed flashing', async () => {
    const w = await raised({ ...request(walled()), otherDevice: { computer: 'DESKTOP-7Q2' } } as ExtensionToWebviewMessage);
    expect(miniImages(w)).toEqual([]);
    expect(w.get('[data-testid="theme-miniature"]').html()).not.toContain('theme-cache');
    expect(w.findAll('[data-testid="theme-install-wallpaper"]')[1]!.find('img').exists()).toBe(false);
    expect(w.get('[data-testid="theme-install-flash-allowed"]').text()).toBe('Flashing is allowed for this file on DESKTOP-7Q2. Reduce motion still pauses it.');
    w.unmount();
    setActivePinia(createPinia());

    const unnamed = await raised({ ...request(walled()), otherDevice: {} } as ExtensionToWebviewMessage);
    expect(unnamed.get('[data-testid="theme-install-flash-allowed"]').text()).toBe('Flashing is allowed for this file on the computer it installs on. Reduce motion still pauses it.');
  });

  it('draws no thumbnail from a URL that is not a WebP data URL', async () => {
    const w = await raised(request(walled('https://example.com/thumb.webp')));
    expect(w.findAll('[data-testid="theme-install-wallpaper"]')[1]!.find('img').exists()).toBe(false);
    expect(miniImages(w)).toEqual([]);
    expect(w.html()).not.toContain('example.com');
  });

  it('paints a swatch only from a hex color, as a background color', async () => {
    const preview = installPreview();
    const dark = { ...preview.theme.looks.dark!, colors: { ...preview.theme.looks.dark!.colors, accent: 'url(https://example.com/a.png)' } };
    const w = await raised(request({ ...preview, theme: { ...preview.theme, looks: { dark } } }));
    const swatches = w.findAll('[data-testid="theme-install-swatch"]');
    expect(swatches).toHaveLength(3);
    // a look whose seeds are not all colors is not drawn
    expect(w.get('[data-testid="theme-miniature"]').findAll('g')).toHaveLength(0);
    for (const swatch of swatches) expect(swatch.attributes('style')).toMatch(/^background-color:/);
    expect(w.findAll('[style*="url("]')).toHaveLength(0);
  });

  it('says how many more parts of the CSS are removed than it lists, once for the whole theme', async () => {
    const preview = installPreview();
    const css = [{ region: 'transcript' as const, bytes: 400, dropped: [{ region: 'transcript' as const, reason: 'property' as const, text: 'display: none', line: 3 }] }, preview.css[1]!];
    const w = await raised(request({ ...preview, css, cssDroppedMore: 12 }));
    expect(w.findAll('[data-testid="theme-install-dropped-more"]').map((more) => more.text())).toEqual(['and 12 more']);
  });

  it('is one bounded element whose details scroll inside it, and which scrolls itself once they have no room left', async () => {
    const w = await raised();
    expect(card(w).classes()).toEqual(expect.arrayContaining(['flex', 'flex-col', 'max-h-[70dvh]', 'min-h-0', 'overflow-x-hidden', 'overflow-y-auto']));
    expect(w.get('[data-testid="theme-install-details"]').classes()).toEqual(expect.arrayContaining(['min-h-0', 'overflow-y-auto']));
  });
});

describe('the theme install card\'s first focus and its Settings dialog form', () => {
  it('takes a notification\'s Review on Cancel, not on a control that changes the install', async () => {
    const w = await raised(request(installPreview({ clash: CLASH })));
    focusDockPrompt(card(w).element as HTMLElement);
    expect(document.activeElement).toBe(button(w, 'cancel').element);
  });

  it('as the Settings dialog draws the preview\'s own thumbnails and holds Cancel too while the install commits', async () => {
    const preview = installPreview();
    const thumb = 'data:image/webp;base64,UklGRg==';
    const shown = { ...preview, wallpapers: [{ ...preview.wallpapers[0]!, thumb }, { ...preview.wallpapers[1]!, thumb: 'https://example.com/thumb.webp' }] };
    const answers: unknown[] = [];
    const Host = defineComponent({
      render: () => h(Dialog, { open: true }, () => h(DialogContent, null, () => h(ThemeInstallCard, { preview: shown, variant: 'dialog', gated: false, busy: true, onAnswer: (answer: unknown) => void answers.push(answer) }))),
    });
    wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
    await flushPromises();
    const shownCard = document.querySelector<HTMLElement>('[data-testid="theme-install-card"]')!;
    const rows = [...shownCard.querySelectorAll('[data-testid="theme-install-wallpaper"]')];
    expect(rows[0]!.querySelector('img')?.getAttribute('src')).toBe(thumb);
    expect(rows[1]!.querySelector('img')).toBeNull();
    const cancel = shownCard.querySelector<HTMLElement>('[data-testid="theme-install-cancel"]')!;
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    cancel.click();
    shownCard.querySelector<HTMLElement>('[data-testid="theme-install-go"]')!.click();
    expect(answers).toEqual([]);
    expect(shownCard.classList.contains('max-h-[70dvh]')).toBe(false);
  });
});
