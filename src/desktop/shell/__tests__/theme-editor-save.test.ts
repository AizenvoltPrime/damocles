// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { Component } from 'vue';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { Arrangement, AssetMeta, ThemeFile } from '@shared/themes/schema';
import type { WallpaperImport } from '@shared/themes/wallpapers';
import type { ThemeEditorImageResult, ThemeEditorResult, ThemeEditorSave, ThemeEditorSession } from '../../preload/overlay-channels';
import ThemeEditor from '../overlay/theme-editor/ThemeEditor.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The theme editor as a whole: what Save sends and what its answer may change, Cancel and a move to another theme with
// unsaved edits, the window arrangement, what a session keeps across its section tabs, and what main tells it of the
// window's preview and of the theme's file.

const ID = '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SHA = (n: number): string => n.toString(16).padStart(64, '0');
const DARK = BUILTIN_THEME.looks.dark!.colors;
const THEME: ThemeFile = { schemaVersion: 1, id: ID, name: 'Dusk', author: 'me', description: 'A dusk', looks: { dark: { colors: { ...DARK } } } };
const LAYOUT: Arrangement = { sidebarWidth: 320 };
const WINDOW: Arrangement = { sidebarWidth: 240 };
const image: AssetMeta = { kind: 'image', mime: 'image/png', bytes: 2 * 1024 * 1024, width: 1920, height: 1080, license: {} };
const IMPORTED: WallpaperImport = { sha256: SHA(8), asset: image, stats: { p10: 0.05, p90: 0.3, mean: 0.15 }, palette: { dark: DARK, light: BUILTIN_THEME.looks.light!.colors } };
const sprite: AssetMeta = { kind: 'sprite', mime: 'image/svg+xml', bytes: 100, width: 40, height: 10, frames: 4, durationMs: 1000, license: {} };
const strip = (n: number) => ({ strip: { asset: SHA(n), frameWidth: 10, frameHeight: 10, frames: 4, fps: 4 } });
const PROJECT = 'local:/work/api';
const WITH_SET: ThemeFile = { ...THEME, characters: { name: 'Night', characters: [{ name: 'Pip', states: { idle: strip(1) } }, { name: 'Mochi', states: { idle: strip(2) } }] }, assets: { [SHA(1)]: sprite, [SHA(2)]: sprite } };
const PALS = { themeId: OTHER, name: 'Pals', characters: { name: 'Pals', characters: [{ name: 'Bo', states: { idle: strip(3) } }] }, assets: { [SHA(3)]: sprite } };

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  shellI18n.global.locale.value = 'en';
});

const session = (theme: ThemeFile, extra: Partial<ThemeEditorSession> = {}): ThemeEditorSession => ({ sessionId: 1, themeId: theme.id, builtin: false, theme, kind: 'dark', nextWallpaperShortcut: 'Ctrl+Alt+Shift+.', ...extra });

async function editor(start: ThemeEditorSession = session(THEME)) {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const api = fakeOverlayApi();
  vi.mocked(api.themeEditor.getSession).mockResolvedValue(start);
  const wrapper = mount(ThemeEditor, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  const edits = vi.mocked(api.themeEditor);
  // an answer of main's the test gives when it says so
  const deferred = <T>(call: { mockImplementationOnce(run: () => Promise<T>): unknown }): (result: T | Error) => void => {
    let settle!: (result: T | Error) => void;
    call.mockImplementationOnce(() => new Promise<T>((resolve, reject) => {
      settle = (result) => (result instanceof Error ? reject(result) : resolve(result));
    }));
    return (result) => settle(result);
  };
  const tab = async (name: string): Promise<void> => {
    await wrapper.findAll('[role="tab"]').find((candidate) => candidate.text() === name)!.trigger('mousedown', { button: 0 });
    await flushPromises();
  };
  const button = (name: string) => wrapper.findAll('button').find((candidate) => (candidate.attributes('aria-label') ?? candidate.text()) === name);
  const press = async (name: string): Promise<void> => {
    await button(name)!.trigger('click');
    await flushPromises();
  };
  const save = async (): Promise<void> => {
    await wrapper.get('[data-testid="theme-editor-save"]').trigger('click');
    await flushPromises();
  };
  const sent = (): ThemeEditorSave => vi.mocked(edits.save).mock.calls.at(-1)![0];
  const subtitle = (): string => wrapper.get('header p').text();
  const hex = (seed: string) => wrapper.get<HTMLInputElement>(`#theme-hex-${seed}`);
  const failure = (): string | undefined => (wrapper.find('[data-testid="theme-editor-failure"]').exists() ? wrapper.get('[data-testid="theme-editor-failure"]').text() : undefined);
  const preview = (): string => wrapper.get('[data-testid="theme-editor-preview"]').text();
  const load = (next: ThemeEditorSession): void => vi.mocked(edits.onSession).mock.calls[0]![0](next);
  return { wrapper, api, edits, deferred, tab, button, press, save, sent, subtitle, hex, failure, preview, load };
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a name written right to left', () => {
  // it would take the numbers, the punctuation and the words beside it into its own run
  it('is isolated in the header, in the sentences that hold it and in its field, with no direction mark in the text', async () => {
    const name = 'ליל 2';
    const e = await editor(session({ ...THEME, name }, { fromName: name }));
    const runs = (selector: string): string[] => e.wrapper.get(selector).findAll('bdi').map((run) => run.text());
    expect(runs('[data-testid="theme-editor-name"]')).toEqual([name]);
    expect(runs('header p')).toEqual([name]);
    expect(e.subtitle()).toBe(`Copy of ${name}`);
    await e.hex('accent').setValue('#123456');
    expect(runs('[data-testid="theme-editor-preview"]')).toEqual([name]);
    expect(e.wrapper.text()).not.toMatch(/[\u2066-\u2069]/);
    await e.tab('Details');
    expect(e.wrapper.get('#theme-editor-name').attributes('dir')).toBe('auto');
  });
});

describe('Save', () => {
  it('sends the draft whole and marks as saved exactly what it sent, whatever is edited before its answer comes', async () => {
    const e = await editor();
    await e.hex('accent').setValue('#123456');
    expect(e.subtitle()).toBe('Created · not saved yet');
    const answer = e.deferred<ThemeEditorResult>(vi.mocked(e.edits.save));
    await e.save();
    expect(e.sent().theme.looks.dark!.colors.accent).toBe('#123456');
    expect(e.sent()).not.toHaveProperty('includeArrangement');
    // a second Save while the first is out sends nothing
    await e.save();
    expect(e.edits.save).toHaveBeenCalledTimes(1);

    await e.hex('text').setValue('#fefefe');
    answer({ ok: true });
    await flushPromises();
    // the edit made meanwhile is still in the draft, and still unsaved
    expect(e.hex('text').element.value).toBe('#fefefe');
    expect(e.subtitle()).toBe('Created · not saved yet');
    // put back by hand, the draft equals what the save stored
    await e.hex('text').setValue(DARK.text);
    expect(e.subtitle()).toBe('Created');
  });

  it('takes the CSS core kept into a draft whose CSS was not edited meanwhile, and leaves a newer CSS edit alone', async () => {
    const css = { transcript: 'p { color: #000000; }\n.bubble { display: none; }\n' };
    const kept = { transcript: 'p { color: #000000; }\n' };
    const dropped = [{ region: 'transcript' as const, reason: 'property' as const, text: 'display: none', line: 2 }];
    const e = await editor(session({ ...THEME, css }));
    await e.hex('accent').setValue('#123456');
    e.edits.save.mockResolvedValueOnce({ ok: true, css: { kept, dropped, droppedMore: 0 } });
    await e.save();
    expect(e.subtitle()).toBe('Created · saved just now');
    await e.tab('CSS');
    expect(e.wrapper.get<HTMLTextAreaElement>('[data-testid="theme-editor-css-source-transcript"]').element.value).toBe(kept.transcript);
    // core's list shows though the kept CSS loses nothing more, and it is still there after another tab was shown
    expect(e.wrapper.get('[data-testid="theme-editor-css-removed"]').text()).toContain('display: none');
    await e.tab('Colors');
    await e.tab('CSS');
    expect(e.wrapper.get('[data-testid="theme-editor-css-removed"]').text()).toContain('display: none');
    // an edit of the CSS ends it: the list is the live one again
    await e.wrapper.get('[data-testid="theme-editor-css-source-transcript"]').setValue('p { color: #111111; }\n');
    expect(e.wrapper.get('[data-testid="theme-editor-css-removed"]').text()).toBe('Nothing in Transcript is removed.');

    const answer = e.deferred<ThemeEditorResult>(vi.mocked(e.edits.save));
    await e.save();
    await e.wrapper.get('[data-testid="theme-editor-css-source-transcript"]').setValue('p { color: #222222; }\n');
    answer({ ok: true, css: { kept: { transcript: 'p { color: #111111; }\n' }, dropped, droppedMore: 0 } });
    await flushPromises();
    expect(e.wrapper.get<HTMLTextAreaElement>('[data-testid="theme-editor-css-source-transcript"]').element.value).toBe('p { color: #222222; }\n');
    // the saved list is about CSS the draft no longer holds
    expect(e.wrapper.get('[data-testid="theme-editor-css-removed"]').text()).toBe('Nothing in Transcript is removed.');
    expect(e.subtitle()).toBe('Created · not saved yet');
  });

  it('drops the answer of a save whose session ended before it came', async () => {
    const e = await editor();
    await e.hex('accent').setValue('#123456');
    const answer = e.deferred<ThemeEditorResult>(vi.mocked(e.edits.save));
    await e.save();
    const next: ThemeFile = { ...THEME, id: OTHER, name: 'Dawn' };
    e.load(session(next, { sessionId: 2 }));
    await flushPromises();
    answer({ ok: false, error: 'late' });
    await flushPromises();
    expect(e.wrapper.get('[data-testid="theme-editor-name"]').text()).toBe('Dawn');
    expect(e.failure()).toBeUndefined();
    expect(e.subtitle()).toBe('Created');
    // the new session saves at once: the old save holds nothing of it back
    await e.hex('accent').setValue('#654321');
    await e.save();
    expect(e.sent()).toMatchObject({ sessionId: 2, theme: { id: OTHER } });
  });

  it('shows core\'s refusal as core worded it, its own words for a call that failed, and is ready to save again', async () => {
    const e = await editor();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await e.hex('accent').setValue('#123456');
    e.edits.save.mockResolvedValueOnce({ ok: false, error: 'The theme Dusk was not saved: the font file of Fixture Sans is missing. Add the font again.' });
    await e.save();
    expect(e.failure()).toBe('The theme Dusk was not saved: the font file of Fixture Sans is missing. Add the font again.');
    e.edits.save.mockRejectedValueOnce(new Error("Error invoking remote method 'damocles:theme-editor:save': Error: Rejected"));
    await e.save();
    expect(e.failure()).toBe('Damocles could not do that. Try again.');
    e.edits.save.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
    await e.save();
    expect(e.failure()).toBe('The theme was not saved: part of it is not valid.');
    // the next edit ends the message
    await e.hex('accent').setValue('#234567');
    expect(e.failure()).toBeUndefined();
    await e.save();
    expect(e.edits.save).toHaveBeenCalledTimes(4);
    expect(e.subtitle()).toBe('Created · saved just now');
  });

  it('counts a detail cleared and typed again as unchanged, whatever order the draft\'s keys end in', async () => {
    const e = await editor();
    await e.tab('Details');
    await e.wrapper.get('#theme-editor-author').setValue('');
    expect(e.subtitle()).toBe('Created · not saved yet');
    await e.wrapper.get('#theme-editor-author').setValue('me');
    expect(e.subtitle()).toBe('Created');
  });
});

describe('a draft that is no valid theme', () => {
  it('names the field, says the window previews nothing of it, sends no preview, and Save goes to the field', async () => {
    const e = await editor();
    await wait(120);
    vi.mocked(e.edits.preview).mockClear();
    await e.tab('Details');
    await e.wrapper.get('#theme-editor-license').setValue('MIT License');
    expect(e.wrapper.get('#theme-editor-save-reason').text()).toBe('Fix 1 error: License is not an SPDX id');
    expect(e.wrapper.get('#theme-editor-license').attributes('aria-invalid')).toBe('true');
    expect(e.wrapper.get('#theme-editor-license-error').text()).toBe('License is not an SPDX id');
    expect(e.preview()).toBe('Not previewing: fix the error first.');
    await wait(120);
    expect(e.edits.preview).not.toHaveBeenCalled();

    await e.tab('Colors');
    await e.save();
    await wait(50);
    expect(e.edits.save).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('theme-editor-license');

    await e.wrapper.get('#theme-editor-license').setValue('MIT');
    expect(e.wrapper.find('#theme-editor-save-reason').exists()).toBe(false);
    expect(e.preview()).toBe('Previewing your edits · Dusk, dark look');
    await wait(120);
    expect(vi.mocked(e.edits.preview).mock.calls.at(-1)![0].theme).toMatchObject({ license: 'MIT' });
  });

  it('describes the name field by its error only while it has one, and caps every detail at the schema\'s length', async () => {
    const e = await editor();
    await e.tab('Details');
    const name = e.wrapper.get('#theme-editor-name');
    expect(name.attributes('aria-describedby')).toBeUndefined();
    expect(name.attributes('maxlength')).toBe('64');
    expect(e.wrapper.get('#theme-editor-author').attributes('maxlength')).toBe('200');
    expect(e.wrapper.get('#theme-editor-description').attributes('maxlength')).toBe('1000');
    expect(e.wrapper.get('#theme-editor-license').attributes('maxlength')).toBe('64');
    await name.setValue('  ');
    expect(name.attributes('aria-describedby')).toBe('theme-editor-name-error');
    expect(e.wrapper.get('#theme-editor-save-reason').text()).toBe('Fix 1 error: Name is empty');
  });
});

describe('Cancel', () => {
  it('closes at once with nothing to lose, and asks before it discards unsaved edits', async () => {
    const e = await editor();
    await e.wrapper.get('[data-testid="theme-editor-cancel"]').trigger('click');
    expect(e.edits.close).toHaveBeenCalledTimes(1);
    expect(e.wrapper.find('[data-testid="theme-editor-discard"]').exists()).toBe(false);

    await e.hex('accent').setValue('#123456');
    await flushPromises();
    expect(e.edits.setDirty).toHaveBeenLastCalledWith(1, true);
    await e.wrapper.get('[data-testid="theme-editor-cancel"]').trigger('click');
    await flushPromises();
    const question = e.wrapper.get('[data-testid="theme-editor-discard"]');
    expect(question.text()).toContain('Discard unsaved edits?');
    expect(e.edits.close).toHaveBeenCalledTimes(1);
    // focus lands on the answer that loses nothing
    expect(document.activeElement?.textContent?.trim()).toBe('Keep editing');
    await e.press('Keep editing');
    expect(e.wrapper.find('[data-testid="theme-editor-discard"]').exists()).toBe(false);
    expect(e.edits.close).toHaveBeenCalledTimes(1);

    await e.wrapper.get('[data-testid="theme-editor-cancel"]').trigger('click');
    await e.press('Discard');
    expect(e.edits.close).toHaveBeenCalledTimes(2);
  });

  it('asks the same when main wants the dock for another theme, answers main either way, and lets a save answer for it', async () => {
    const e = await editor();
    const asked = vi.mocked(e.edits.onMoveAsked).mock.calls[0]![0];
    await e.hex('accent').setValue('#123456');
    asked();
    await flushPromises();
    expect(e.wrapper.get('[data-testid="theme-editor-discard"]').text()).toContain('Discard unsaved edits?');
    await e.press('Keep editing');
    expect(e.edits.answerMove).toHaveBeenLastCalledWith(1, false);
    asked();
    await flushPromises();
    await e.press('Discard');
    expect(e.edits.answerMove).toHaveBeenLastCalledWith(1, true);
    expect(e.edits.close).not.toHaveBeenCalled();

    // saved while the question stands: nothing is left to discard, so the move goes ahead
    asked();
    await flushPromises();
    await e.save();
    expect(e.edits.setDirty).toHaveBeenLastCalledWith(1, false);
    expect(e.edits.answerMove).toHaveBeenCalledTimes(3);
    expect(e.edits.answerMove).toHaveBeenLastCalledWith(1, true);
    expect(e.wrapper.find('[data-testid="theme-editor-discard"]').exists()).toBe(false);
  });
});

describe('Duplicate to edit', () => {
  it('asks main once however often it is pressed while the copy is made, and says when the call fails', async () => {
    const e = await editor(session({ ...BUILTIN_THEME }, { builtin: true, themeId: BUILTIN_THEME.id }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answer = e.deferred<ThemeEditorResult>(vi.mocked(e.edits.duplicate));
    await e.press('Duplicate to edit');
    await e.press('Duplicate to edit');
    expect(e.edits.duplicate).toHaveBeenCalledTimes(1);
    expect(e.button('Duplicate to edit')!.attributes('aria-disabled')).toBe('true');
    answer(new Error('Rejected'));
    await flushPromises();
    expect(e.failure()).toBe('Damocles could not do that. Try again.');
    expect(e.button('Duplicate to edit')!.attributes('aria-disabled')).toBeUndefined();
    e.edits.duplicate.mockResolvedValueOnce({ ok: false, error: 'The copy was made, but the theme editor could not open it.' });
    await e.press('Duplicate to edit');
    expect(e.failure()).toBe('The copy was made, but the theme editor could not open it.');
    // a built-in theme's Close asks nothing
    await e.press('Close');
    expect(e.edits.close).toHaveBeenCalledTimes(1);
  });
});

describe('the window arrangement', () => {
  const state = (wrapper: VueWrapper): string => wrapper.get('[data-testid="theme-editor-arrangement-state"]').text();
  const toggle = (wrapper: VueWrapper) => wrapper.get('#theme-editor-arrangement');

  it('keeps the arrangement the theme was saved with through a save of something else, and replaces it only on Capture', async () => {
    const e = await editor(session({ ...THEME, layout: LAYOUT }));
    e.edits.captureArrangement.mockResolvedValue({ ok: true, arrangement: WINDOW });
    await e.tab('Arrangement');
    expect(toggle(e.wrapper).attributes('aria-checked')).toBe('true');
    expect(state(e.wrapper)).toBe('Saved with this theme');
    expect(e.wrapper.text()).toContain('20.0 rem wide');

    await e.tab('Colors');
    await e.hex('accent').setValue('#123456');
    await e.save();
    expect(e.sent().theme.layout).toEqual(LAYOUT);
    expect(e.edits.captureArrangement).not.toHaveBeenCalled();

    await e.tab('Arrangement');
    await e.press('Capture the current window arrangement');
    expect(e.edits.captureArrangement).toHaveBeenCalledWith(1);
    expect(state(e.wrapper)).toBe('Captured from the window, saved with your next Save');
    expect(e.wrapper.text()).toContain('15.0 rem wide');
    expect(e.subtitle()).toBe('Created · not saved yet');
    await e.save();
    expect(e.sent().theme.layout).toEqual(WINDOW);
    expect(state(e.wrapper)).toBe('Saved with this theme');
  });

  it('saves none while its switch is off, puts the theme\'s own back when it is turned on again, and captures one for a theme that has none', async () => {
    const e = await editor(session({ ...THEME, layout: LAYOUT }));
    e.edits.captureArrangement.mockResolvedValue({ ok: true, arrangement: WINDOW });
    await e.tab('Arrangement');
    await toggle(e.wrapper).trigger('click');
    await flushPromises();
    expect(state(e.wrapper)).toBe('No window arrangement is saved with this theme');
    await e.save();
    expect(e.sent().theme).not.toHaveProperty('layout');
    e.load(session({ ...THEME, layout: LAYOUT }, { sessionId: 2 }));
    await flushPromises();
    await e.tab('Arrangement');
    await toggle(e.wrapper).trigger('click');
    await toggle(e.wrapper).trigger('click');
    await flushPromises();
    expect(state(e.wrapper)).toBe('Saved with this theme');
    expect(e.edits.captureArrangement).not.toHaveBeenCalled();

    e.load(session(THEME, { sessionId: 3 }));
    await flushPromises();
    await e.tab('Arrangement');
    expect(toggle(e.wrapper).attributes('aria-checked')).toBe('false');
    await toggle(e.wrapper).trigger('click');
    await flushPromises();
    expect(e.edits.captureArrangement).toHaveBeenCalledWith(3);
    expect(state(e.wrapper)).toBe('Captured from the window, saved with your next Save');
  });
});

describe('what a session keeps across its section tabs', () => {
  it('keeps what an import told of its image after another tab was shown', async () => {
    const e = await editor();
    e.edits.importImageFile.mockResolvedValue({ ok: true, image: IMPORTED, name: 'dunes.png' });
    await e.tab('Wallpapers');
    await e.wrapper.get('[role="radiogroup"][aria-label="Wallpaper"]').findAll('[role="radio"]').find((radio) => radio.text() === 'One image per panel')!.trigger('click');
    await e.wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await flushPromises();
    expect(e.wrapper.text()).toContain('dunes.png');
    const readability = e.wrapper.get('[data-testid="wallpaper-readability"]').text();

    await e.tab('Colors');
    await e.tab('Wallpapers');
    expect(e.wrapper.text()).toContain('dunes.png');
    expect(e.wrapper.get('[data-testid="wallpaper-readability"]').text()).toBe(readability);
    expect(e.button('Palette from wallpaper')).toBeDefined();
  });

  it('places an image that arrives after its tab was left, and shows a failure of one when the tab is shown again', async () => {
    const e = await editor();
    await e.tab('Wallpapers');
    await e.wrapper.get('[role="radiogroup"][aria-label="Wallpaper"]').findAll('[role="radio"]').find((radio) => radio.text() === 'One image per panel')!.trigger('click');
    const answer = e.deferred<ThemeEditorImageResult>(vi.mocked(e.edits.importImageFile));
    await e.wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await e.tab('Colors');
    answer({ ok: true, image: IMPORTED, name: 'dunes.png' });
    await flushPromises();
    await e.save();
    expect(e.sent().theme.looks.dark!.wallpapers).toEqual([{ panels: { chat: { asset: SHA(8), fit: 'fill', dim: 0.55, blur: 4 } } }]);
    expect(e.sent().theme.assets).toEqual({ [SHA(8)]: image });

    await e.tab('Wallpapers');
    const refused = e.deferred<ThemeEditorImageResult>(vi.mocked(e.edits.importImageFile));
    await e.wrapper.get('[data-testid="wallpaper-choose"]').trigger('click');
    await e.tab('Colors');
    refused({ ok: false, error: 'This image is larger than 20 MB.' });
    await flushPromises();
    await e.tab('Wallpapers');
    expect(e.wrapper.get('[data-testid="theme-editor-wallpapers"] [role="alert"]').text()).toBe('This image is larger than 20 MB.');
    expect(e.wrapper.get('[data-testid="wallpaper-choose"]').attributes('disabled')).toBeUndefined();
  });
});

describe('the character set', () => {
  const pins = { version: 1 as const, pins: { [PROJECT]: { byTheme: { [ID]: 'Pip' } } } };
  const start = (): ThemeEditorSession => session(WITH_SET, { projects: [{ key: PROJECT, name: 'api', state: 'idle' }], pins, characterSets: [PALS], sprites: {} });
  const pick = async (wrapper: VueWrapper, value: string): Promise<void> => {
    wrapper.findAllComponents(SettingSelect as Component)[0]!.vm.$emit('update:modelValue', value);
    await flushPromises();
  };
  const replaced = (wrapper: VueWrapper): string => wrapper.get('[data-testid="character-set-replaced"]').text();

  it('clears a project\'s pin of a character the set no longer has, as core would drop it', async () => {
    const e = await editor(start());
    await e.tab('Characters');
    await e.press('Remove Pip');
    // the row reads as automatic, never as a name the list does not offer
    expect(e.wrapper.get('[data-testid="character-pins"]').text()).toContain('Automatic (Mochi)');
    await e.save();
    expect(e.sent().pins).toEqual([{ projectKey: PROJECT, character: null }]);
    // saved: nothing of the pin is left to send
    await e.tab('Colors');
    await e.hex('accent').setValue('#123456');
    await e.save();
    expect(e.sent()).not.toHaveProperty('pins');
  });

  it('keeps the set a pick of another one replaced, and puts it back with its images on Undo, until the set is edited again', async () => {
    const e = await editor(start());
    await e.tab('Characters');
    expect(replaced(e.wrapper)).toBe('');
    await pick(e.wrapper, `from:${OTHER}`);
    expect(replaced(e.wrapper)).toBe('Replaced the Night characters. Undo');
    // another part of the theme changes: Undo is still there after it, and after another tab was shown
    await e.tab('Colors');
    await e.hex('accent').setValue('#123456');
    await e.tab('Characters');
    await e.press('Undo');
    expect(replaced(e.wrapper)).toBe('The Night characters are back.');
    await e.save();
    expect(e.sent().theme.characters).toEqual(WITH_SET.characters);
    expect(Object.keys(e.sent().theme.assets!).sort()).toEqual([SHA(1), SHA(2)]);
    // the pin that names a character of the set came back with it: nothing of it is sent
    expect(e.sent()).not.toHaveProperty('pins');

    await pick(e.wrapper, `from:${OTHER}`);
    await e.save();
    expect(e.sent().theme.characters).toEqual(PALS.characters);
    expect(Object.keys(e.sent().theme.assets!)).toEqual([SHA(3)]);
    expect(e.sent().pins).toEqual([{ projectKey: PROJECT, character: null }]);
    // a save is no edit of the set: the replaced one can still be put back
    expect(replaced(e.wrapper)).toBe('Replaced the Night characters. Undo');

    await pick(e.wrapper, 'none');
    expect(replaced(e.wrapper)).toBe('Removed the Pals characters. Undo');
    // a character is removed from the set that Undo put back: that set is no longer the one that was replaced
    await e.press('Undo');
    await e.press('Remove Bo');
    expect(replaced(e.wrapper)).toBe('');
  });
});

describe('what main tells the editor', () => {
  it('says why the window paints no preview, and previews again when it can', async () => {
    const e = await editor();
    await wait(120);
    const refused = vi.mocked(e.edits.onPreviewRefused).mock.calls[0]![0];
    refused('forcedColors');
    await flushPromises();
    expect(e.preview()).toBe("Not previewing: Windows contrast themes are on, so the window shows Damocles' own look.");
    refused('safeStart');
    await flushPromises();
    expect(e.preview()).toBe('Not previewing: this run shows the Damocles theme.');
    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(e.preview()).toBe('Χωρίς προεπισκόπηση: αυτή η εκτέλεση εμφανίζει το θέμα Damocles.');
    shellI18n.global.locale.value = 'en';
    vi.mocked(e.edits.preview).mockClear();
    refused(null);
    await flushPromises();
    expect(e.preview()).toBe('Previewing your edits · Dusk, dark look');
    await wait(120);
    expect(e.edits.preview).toHaveBeenCalledTimes(1);
  });

  it('says that the theme changed outside the editor, on main\'s word or on a refused save, and reloads it when asked', async () => {
    const e = await editor();
    expect(e.wrapper.find('[data-testid="theme-editor-outside"]').exists()).toBe(false);
    await e.hex('accent').setValue('#123456');
    e.edits.save.mockResolvedValueOnce({ ok: false, reason: 'changed' });
    await e.save();
    const banner = e.wrapper.get('[data-testid="theme-editor-outside"]');
    expect(banner.text()).toContain('This theme was changed outside the editor, so Save writes nothing.');
    expect(e.subtitle()).toBe('Created · not saved yet');
    await e.press('Discard my edits and reload');
    expect(e.edits.reload).toHaveBeenCalledWith(1);

    e.load(session({ ...THEME, name: 'Renamed' }, { sessionId: 2 }));
    await flushPromises();
    expect(e.wrapper.find('[data-testid="theme-editor-outside"]').exists()).toBe(false);
    const outside = vi.mocked(e.edits.onOutside).mock.calls[0]![0];
    outside('changed');
    await flushPromises();
    expect(e.button('Reload')).toBeDefined();
    outside('gone');
    await flushPromises();
    expect(e.wrapper.get('[data-testid="theme-editor-outside"]').text()).toBe('This theme was deleted, or its file can no longer be read, so it cannot be saved.');
  });
});
