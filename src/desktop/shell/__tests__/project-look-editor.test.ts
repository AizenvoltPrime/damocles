// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { ProjectLook } from '@shared/themes/project-looks';
import type { ThemeFile } from '@shared/themes/schema';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import ProjectLookEditor from '../overlay/settings/themes/ProjectLookEditor.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The project look dialog (design S7): the three choices by role and name, the accent derived per look, the wallpaper and
// character touches, a theme of its own, and what Save, Cancel and Escape answer.

globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
const NIGHT_ID = '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const ARCADE_ID = '1b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const WALL = 'f'.repeat(64);
const SPRITE = 'e'.repeat(64);
const IMAGE = { kind: 'image' as const, mime: 'image/png', bytes: 30, width: 1600, height: 1000, license: {} };
const NIGHT: ThemeFile = {
  schemaVersion: 1, id: NIGHT_ID, name: 'Night',
  looks: { dark: { colors: BUILTIN_THEME.looks.dark!.colors, wallpapers: [{ span: { asset: WALL, panels: ['chat'], fit: 'tile' } }] } },
  assets: { [WALL]: IMAGE },
};
const ARCADE: ThemeFile = {
  schemaVersion: 1, id: ARCADE_ID, name: 'Arcade copy', looks: { dark: { colors: BUILTIN_THEME.looks.dark!.colors } },
  characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: SPRITE } } }] },
  assets: { [SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } },
};

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

type Request = Extract<OverlayRequest, { kind: 'projectLook' }>;
function dialog(look?: ProjectLook, api = fakeOverlayApi(), more: Partial<Request> = {}) {
  const answers: OverlayAnswer[] = [];
  const request: Request = {
    kind: 'projectLook', projectKey: '/work/website', projectName: 'website', ...(look ? { look } : {}),
    themes: [{ id: 'damocles', name: 'Damocles', theme: BUILTIN_THEME }, { id: NIGHT_ID, name: 'Night', theme: NIGHT }, { id: ARCADE_ID, name: 'Arcade copy', theme: ARCADE }],
    preferred: { dark: 'damocles', light: 'damocles' },
    shownKind: 'dark',
    ...more,
  };
  const wrapper = mount(ProjectLookEditor, { props: { api, request, onAnswer: (answer: OverlayAnswer) => answers.push(answer) }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, answers, api };
}

const radio = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) => element.id !== '' && document.querySelector(`label[for="${element.id}"]`)?.textContent?.trim() === name)!;
const button = (text: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === text)!;
const caption = (): string => document.querySelector('[data-testid="project-look-caption"]')!.textContent!.trim();
const segment = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) => element.textContent?.trim() === name)!;
const named = (label: string): HTMLElement => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const GONE_ID = '2b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const chosen = { ok: true as const, image: { sha256: WALL, asset: IMAGE, stats: { p10: 0.1, p90: 0.9, mean: 0.5 }, palette: { dark: NIGHT.looks.dark!.colors, light: NIGHT.looks.dark!.colors } }, name: 'harbor.png' };
const accentInput = (): HTMLInputElement => document.getElementById(document.querySelector<HTMLLabelElement>('label[for]:not([for^="project-look-"])')!.htmlFor) as HTMLInputElement;

describe('the project look dialog', () => {
  it('is named for the project, offers the three choices and always shows the order, where the look is stored and the arrangement note', async () => {
    dialog();
    await flushPromises();
    const root = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(root.getAttribute('aria-labelledby')!)!.textContent).toBe('Look for website');
    for (const name of ['Use the current theme', 'Add touches on top of the current theme', 'Use its own theme']) expect(radio(name)).toBeDefined();
    expect(radio('Use the current theme').getAttribute('aria-checked')).toBe('true');
    expect(root.textContent).toContain("Order: this project's own theme, then your schedule");
    expect(root.textContent).toContain("Stored on this computer only; never written to the project's files.");
    expect(root.textContent).toContain('Switching projects never changes your window arrangement.');
    expect(caption()).toBe('Same as every project: Damocles, dark.');
  });

  it('saves an accent touch, shows where the derivation moved its text color, and refuses an accent that is no color', async () => {
    const { answers } = dialog();
    await flushPromises();
    radio('Add touches on top of the current theme').click();
    await flushPromises();
    const input = accentInput();
    input.value = '#ffd60a';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(caption()).toBe('Damocles, dark, with accent.');
    expect(document.querySelector('[data-testid="project-look-accent-status"]')!.textContent).toMatch(/Shown as #[0-9a-f]{6} in the light look, so text in this color stays at 4\.5:1\./);
    // white labels reach only about 4.4:1 on this blue, so the derivation also darkens its fill a little
    input.value = '#0077dd';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    const status = document.querySelector('[data-testid="project-look-accent-status"]')!.textContent!;
    expect(status).toContain('Shown as #0076dc in fills in the dark look, so text on them stays at 4.5:1.');
    expect(status).toContain('Shown as #0076dc in fills in the light look, so text on them stays at 4.5:1.');
    input.value = '#ffd6';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    button('Save').click();
    expect(answers).toEqual([]);
    expect(document.querySelector('[data-testid="project-look-accent-status"]')!.textContent).toContain('Enter a color as # and six hex digits.');
    input.value = '#3A86FF';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    button('Save').click();
    expect(answers).toEqual([{ kind: 'projectLook', look: { mode: 'touches', accent: '#3a86ff' } }]);
  });

  it("takes a wallpaper from another theme and a character set from another theme's characters", async () => {
    const { answers } = dialog({ mode: 'touches', characterSet: ARCADE_ID });
    await flushPromises();
    expect(caption()).toBe('Damocles, dark, with characters.');
    [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) => element.textContent?.trim() === 'From a theme')!.click();
    await flushPromises();
    expect(caption()).toBe('Damocles, dark, with wallpaper and characters.');
    button('Save').click();
    expect(answers).toEqual([{
      kind: 'projectLook',
      look: { mode: 'touches', wallpaper: { span: { asset: WALL, panels: ['chat'], fit: 'tile' } }, assets: { [WALL]: IMAGE }, characterSet: ARCADE_ID },
    }]);
  });

  it('takes a chosen image across every panel with its fit', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.projectLookImage).mockResolvedValue({ ok: true, value: { ok: true, image: { sha256: WALL, asset: IMAGE, stats: { p10: 0.1, p90: 0.9, mean: 0.5 }, palette: { dark: NIGHT.looks.dark!.colors, light: NIGHT.looks.dark!.colors } }, name: 'harbor.png' } } as never);
    const { answers } = dialog({ mode: 'touches', accent: '#3a86ff' }, api);
    await flushPromises();
    [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) => element.textContent?.trim() === 'Image')!.click();
    await flushPromises();
    button('Choose image or video…').click();
    await flushPromises();
    expect(document.querySelector('[data-testid="project-look-image"]')!.textContent).toBe('harbor.png');
    button('Save').click();
    const look = (answers[0] as { look: Extract<ProjectLook, { mode: 'touches' }> }).look;
    expect(look.wallpaper?.span).toEqual({ asset: WALL, panels: ['sidebar', 'chat', 'editor', 'terminal', 'titlebar'], fit: 'fill' });
    expect(look.assets).toEqual({ [WALL]: IMAGE });
  });

  it("saves a theme of its own, whose missing look cannot be picked", async () => {
    const { answers } = dialog({ mode: 'full', themeId: NIGHT_ID, look: 'dark' });
    await flushPromises();
    expect(radio('Use its own theme').getAttribute('aria-checked')).toBe('true');
    expect(caption()).toBe('Night, dark.');
    const looks = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((element) => ['Dark', 'Light', 'Auto'].includes(element.textContent?.trim() ?? ''));
    expect(looks.map((element) => [element.textContent?.trim(), element.disabled])).toEqual([['Dark', false], ['Light', true], ['Auto', false]]);
    looks[2]!.click();
    await flushPromises();
    expect(caption()).toBe('Night, auto: dark now.');
    button('Save').click();
    expect(answers).toEqual([{ kind: 'projectLook', look: { mode: 'full', themeId: NIGHT_ID, look: 'auto' } }]);
  });

  it('answers dismissed for Cancel and for Escape, and Use the current theme saves no look', async () => {
    const cancelled = dialog({ mode: 'touches', accent: '#3a86ff' });
    await flushPromises();
    button('Cancel').click();
    expect(cancelled.answers).toEqual([{ kind: 'dismissed' }]);
    cancelled.wrapper.unmount();
    mounted.splice(mounted.indexOf(cancelled.wrapper), 1);

    const escaped = dialog();
    await flushPromises();
    document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(escaped.answers).toEqual([{ kind: 'dismissed' }]);
    escaped.wrapper.unmount();
    mounted.splice(mounted.indexOf(escaped.wrapper), 1);

    const none = dialog({ mode: 'touches', accent: '#3a86ff' });
    await flushPromises();
    radio('Use the current theme').click();
    await flushPromises();
    button('Save').click();
    expect(none.answers).toEqual([{ kind: 'projectLook', look: null }]);
    expect(none.api.projectLookImage).not.toHaveBeenCalled();
  });

  it('saves no look for touches that set nothing, and takes the accent away with its Clear button', async () => {
    const { answers } = dialog({ mode: 'touches', accent: '#3a86ff' });
    await flushPromises();
    expect(caption()).toBe('Damocles, dark, with accent.');
    button("Use the theme's accent").click();
    await flushPromises();
    expect(accentInput().value).toBe('');
    expect(caption()).toBe('Damocles, dark, no touches yet.');
    button('Save').click();
    expect(answers).toEqual([{ kind: 'projectLook', look: null }]);
  });

  it('never saves a look that does not check as no look: Save stays, says so, and answers once the look is changed', async () => {
    // a theme whose wallpaper names an image its file does not hold
    const TORN: ThemeFile = { ...NIGHT, id: GONE_ID, name: 'Torn', assets: {} };
    const { answers } = dialog({ mode: 'touches', accent: '#3a86ff' }, fakeOverlayApi(), { themes: [{ id: 'damocles', name: 'Damocles', theme: BUILTIN_THEME }, { id: GONE_ID, name: 'Torn', theme: TORN }] });
    await flushPromises();
    segment('From a theme').click();
    await flushPromises();
    expect(byTestId('project-look-invalid')).toBeNull();
    button('Save').click();
    await flushPromises();
    expect(answers).toEqual([]);
    expect(byTestId('project-look-invalid')!.textContent!.trim()).toBe("This look can't be saved as it is. Change it, or choose Cancel.");
    segment('None').click();
    await flushPromises();
    expect(byTestId('project-look-invalid')).toBeNull();
    button('Save').click();
    expect(answers).toEqual([{ kind: 'projectLook', look: { mode: 'touches', accent: '#3a86ff' } }]);
  });

  it('says a theme the look names is missing, by its name while its file still gives one, and shows Damocles\' own look for it', async () => {
    dialog({ mode: 'full', themeId: GONE_ID, look: 'auto' });
    await flushPromises();
    expect(named('Theme').textContent).toContain('Missing theme');
    expect(named('Theme').textContent).not.toContain(GONE_ID);
    expect(byTestId('project-look-theme-missing')!.textContent!.trim()).toBe("This project's theme is missing, so Damocles' own look shows for it until you pick another theme.");
    expect(caption()).toBe('The theme is missing: Damocles, dark shows.');
    expect(named("Damocles' own look, which shows while the theme is missing")).not.toBeNull();
    for (const wrapper of mounted.splice(0)) wrapper.unmount();

    dialog({ mode: 'full', themeId: GONE_ID, look: 'light' }, fakeOverlayApi(), { unusable: [{ id: GONE_ID, name: 'Dusk' }] });
    await flushPromises();
    expect(named('Theme').textContent).toContain('Dusk (missing)');
    expect(byTestId('project-look-theme-missing')!.textContent!.trim()).toBe("Dusk is missing or can't be used, so Damocles' own look shows for this project until you pick another theme.");
    expect(caption()).toBe('Dusk is missing: Damocles, light shows.');
  });

  it('previews Damocles\' own look for a look the theme no longer has', async () => {
    dialog({ mode: 'full', themeId: NIGHT_ID, look: 'light' });
    await flushPromises();
    expect(byTestId('project-look-theme-missing')).toBeNull();
    expect(caption()).toBe('Night has no light look: Damocles, light shows.');
  });

  it('says a character set whose theme is missing is missing, and saves another set in its place', async () => {
    const { answers } = dialog({ mode: 'touches', characterSet: GONE_ID });
    await flushPromises();
    expect(named('Character set').textContent).toContain('Missing character set');
    expect(byTestId('project-look-characters-missing')!.textContent!.trim()).toBe('The theme this character set came from is missing, so the letter avatars show until you pick another set.');
    expect(named('Character set').getAttribute('aria-describedby')).toBeTruthy();
    button('Save').click();
    expect(answers).toEqual([{ kind: 'projectLook', look: { mode: 'touches', characterSet: GONE_ID } }]);
  });

  it('says why an image was not used, says nothing when the choice is cancelled, and keeps the look it had', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.projectLookImage).mockResolvedValueOnce({ ok: true, value: { ok: false, error: 'It flashes too fast.' } });
    const { answers } = dialog({ mode: 'touches', accent: '#3a86ff' }, api);
    await flushPromises();
    segment('Image').click();
    await flushPromises();
    button('Choose image or video…').click();
    await flushPromises();
    expect(document.querySelector('[role="alert"]')!.textContent!.trim()).toBe('The image was not used: It flashes too fast.');
    expect(byTestId('project-look-image')!.textContent).toBe('No image or video chosen');
    // the default answer is a cancelled choice
    button('Choose image or video…').click();
    await flushPromises();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    button('Save').click();
    expect(answers).toEqual([{ kind: 'projectLook', look: { mode: 'touches', accent: '#3a86ff' } }]);
  });

  it('does not save while an image is being read, and saves it once it was', async () => {
    const api = fakeOverlayApi();
    let finish: () => void = () => undefined;
    vi.mocked(api.projectLookImage).mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, value: chosen });
    }));
    const { answers } = dialog({ mode: 'touches', accent: '#3a86ff' }, api);
    await flushPromises();
    segment('Image').click();
    await flushPromises();
    button('Choose image or video…').click();
    await flushPromises();
    expect(button('Reading the file…')).toBeDefined();
    expect(button('Save').getAttribute('aria-disabled')).toBe('true');
    button('Save').click();
    expect(answers).toEqual([]);
    finish();
    await flushPromises();
    expect(button('Save').getAttribute('aria-disabled')).toBeNull();
    button('Save').click();
    expect((answers[0] as { look: Extract<ProjectLook, { mode: 'touches' }> }).look.wallpaper?.span?.asset).toBe(WALL);
  });

  it('offers Fit only for an image that spans the panes, applies the fit chosen, and calls a reopened wallpaper the current wallpaper', async () => {
    const span = { mode: 'touches' as const, wallpaper: { span: { asset: WALL, panels: ['chat' as const], fit: 'tile' as const } }, assets: { [WALL]: IMAGE } };
    const reopened = dialog(span);
    await flushPromises();
    expect(byTestId('project-look-image')!.textContent).toBe('Current wallpaper');
    expect(named('Fit').textContent).toContain('Tile');
    button('Save').click();
    expect(reopened.answers).toEqual([{ kind: 'projectLook', look: span }]);
    for (const wrapper of mounted.splice(0)) wrapper.unmount();

    // a set of per-pane images has no fit to change
    dialog({ mode: 'touches', wallpaper: { panels: { chat: { asset: WALL, fit: 'fill', dim: 0, blur: 0 } } }, assets: { [WALL]: IMAGE } });
    await flushPromises();
    expect(byTestId('project-look-image')!.textContent).toBe('Current wallpaper');
    expect(named('Fit')).toBeNull();
    for (const wrapper of mounted.splice(0)) wrapper.unmount();

    // and none is offered before an image is chosen
    dialog({ mode: 'touches', accent: '#3a86ff' });
    await flushPromises();
    segment('Image').click();
    await flushPromises();
    expect(named('Fit')).toBeNull();
  });

  // a name written right to left would take the punctuation and the words beside it into its own run
  it('isolates a right-to-left project or theme name in the title, the caption and a select, and keeps every text and name free of direction marks', async () => {
    const project = 'אתר 3';
    const night = 'ליל 2';
    dialog({ mode: 'full', themeId: NIGHT_ID, look: 'dark' }, fakeOverlayApi(), {
      projectName: project,
      themes: [{ id: 'damocles', name: 'Damocles', theme: BUILTIN_THEME }, { id: NIGHT_ID, name: night, theme: NIGHT }],
    });
    await flushPromises();
    const runs = (root: Element | null): string[] => [...(root?.querySelectorAll('bdi') ?? [])].map((run) => run.textContent ?? '');

    expect(runs(document.querySelector('[data-testid="project-look"] h2'))).toEqual([project]);
    expect(runs(byTestId('project-look-caption'))).toEqual([night]);
    expect(runs(named('Theme'))).toEqual([night]);
    expect(document.body.textContent).not.toMatch(/[\u2066-\u2069]/);
    for (const element of document.querySelectorAll('[aria-label], [title]')) {
      expect(`${element.getAttribute('aria-label') ?? ''}${element.getAttribute('title') ?? ''}`).not.toMatch(/[\u2066-\u2069]/);
    }
  });

  it('ties each hint to the control it describes', async () => {
    dialog({ mode: 'touches', accent: '#3a86ff' });
    await flushPromises();
    const described = (element: HTMLElement): string => element.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!.textContent!.trim()).join(' ');
    expect(described(named('Wallpaper'))).toBe('Behind the panes, dimmed and blurred by your wallpaper readability settings.');
    expect(described(named('Character set'))).toBe('Pixel characters in place of the letter avatars in the sidebar.');
    radio('Use its own theme').click();
    await flushPromises();
    expect(described(named('Look'))).toBe("Auto follows the computer's light and dark mode.");
  });
});
