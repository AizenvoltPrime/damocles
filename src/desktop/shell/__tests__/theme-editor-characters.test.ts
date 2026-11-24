// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, type Component } from 'vue';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { characterIndex, type ProjectsFile, type SpriteImport } from '@shared/themes/characters';
import type { AssetMeta, ThemeFile } from '@shared/themes/schema';
import type { DamoclesOverlayApi, ThemeEditorSession, ThemeEditorSpriteResult } from '../../preload/overlay-channels';
import CharactersSection from '../overlay/theme-editor/CharactersSection.vue';
import { createEditorImports } from '../overlay/theme-editor/editor-imports';
import { pinChoices, pinEdits, validPins, type PinChoice } from '../overlay/theme-editor/pins';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The theme editor's Characters section (design S5): the set in each state, each image's flash check and its allowance, adding a
// character from an image, taking another theme's set, and the pins of every project with "Keep in every theme".

globalThis.ResizeObserver ??= FakeResizeObserver as unknown as typeof ResizeObserver;
const ID = '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SHA = (n: number): string => n.toString(16).padStart(64, '0');
const sprite = { kind: 'sprite' as const, mime: 'image/svg+xml', bytes: 100, width: 40, height: 10, frames: 4, durationMs: 1000, license: {} };
const wallpaper: AssetMeta = { kind: 'image', mime: 'image/png', bytes: 1000, width: 1920, height: 1080, license: {} };
const strip = (n: number, fps = 4) => ({ strip: { asset: SHA(n), frameWidth: 10, frameHeight: 10, frames: 4, fps } });
// the running strip steps fast enough to flash, so it moves only once its check passed or the user allowed it. SHA(4) is a
// sprite no character names, and SHA(5) a wallpaper, which is not this section's to drop.
const THEME: ThemeFile = {
  ...BUILTIN_THEME,
  id: ID,
  name: 'Night',
  characters: { name: 'Night', characters: [{ name: 'Pip', states: { idle: strip(1), running: strip(2, 12) } }, { name: 'Mochi', states: { idle: strip(3) } }] },
  assets: { [SHA(1)]: sprite, [SHA(2)]: { ...sprite, durationMs: 333, flash: { flagged: true, atMs: 500 } }, [SHA(3)]: sprite, [SHA(4)]: sprite, [SHA(5)]: wallpaper },
};
const PALS = { themeId: OTHER, name: 'Pals', characters: { name: 'Pals', characters: [{ name: 'Bo', states: { idle: strip(6) } }] }, assets: { [SHA(6)]: sprite } };
const PROJECTS = [{ key: 'local:/work/api', name: 'api', state: 'running' as const }, { key: 'local:/work/web', name: 'web', state: 'idle' as const }];
const session = (pins: ProjectsFile = { version: 1, pins: {} }): ThemeEditorSession => ({
  sessionId: 7, themeId: ID, builtin: false, theme: THEME, kind: 'dark', nextWallpaperShortcut: 'Ctrl+Alt+Shift+.',
  sprites: { [SHA(2)]: { flagged: true, atMs: 500, kind: 'general' } }, projects: PROJECTS, pins, characterSets: [PALS],
});
const IMPORTED: SpriteImport = { sha256: SHA(9), asset: sprite, strip: { frameWidth: 10, frameHeight: 10, frames: 4, fps: 4 } };

interface Harness {
  readonly wrapper: VueWrapper;
  readonly draft: () => ThemeFile;
  // an edit made elsewhere in the editor
  readonly setDraft: (next: ThemeFile) => void;
  // the drafts the section and its imports wrote, the events a replace sent, and the pins it set
  readonly updates: ThemeFile[];
  readonly replaced: ThemeFile[];
  readonly pinned: Array<[string, PinChoice]>;
}
const mounted: VueWrapper[] = [];
// The section as the editor holds it: the editor owns the imports, and each update or replace becomes the draft.
function section(props: { draft?: ThemeFile; pins?: Record<string, PinChoice>; readOnly?: boolean } = {}, api: DamoclesOverlayApi = fakeOverlayApi()): Harness {
  const draft = ref(props.draft ?? THEME);
  const updates: ThemeFile[] = [];
  const replaced: ThemeFile[] = [];
  const pinned: Array<[string, PinChoice]> = [];
  const edit = (next: ThemeFile): void => {
    updates.push(next);
    draft.value = next;
  };
  const imports = createEditorImports({ api, sessionId: () => 7, draft: () => draft.value, edit, t: shellI18n.global.t });
  const Host = defineComponent({
    setup: () => () => h(CharactersSection, {
      api, imports, draft: draft.value, readOnly: props.readOnly ?? false, session: session(), pins: props.pins ?? pinChoices(undefined, ID, PROJECTS.map((p) => p.key)),
      onUpdate: edit,
      onReplace: (next: ThemeFile) => {
        replaced.push(next);
        draft.value = next;
      },
      onPin: (key: string, choice: PinChoice) => void pinned.push([key, choice]),
    }),
  });
  const wrapper = mount(Host, { global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, draft: () => draft.value, setDraft: (next) => void (draft.value = next), updates, replaced, pinned };
}
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.restoreAllMocks();
});

// an import main answers when the test says so
function deferredSprite(api: DamoclesOverlayApi): (result: ThemeEditorSpriteResult) => void {
  let answer!: (result: ThemeEditorSpriteResult) => void;
  vi.mocked(api.themeEditor.importSpriteFile).mockImplementation(() => new Promise((resolve) => {
    answer = resolve;
  }));
  return (result) => answer(result);
}
const button = (wrapper: VueWrapper, name: string) => wrapper.findAll('button').find((candidate) => candidate.attributes('aria-label') === name)!;
const assetKeys = (theme: ThemeFile): string[] => Object.keys(theme.assets ?? {}).sort();
// the set select is the section's first select; SettingSelect is generic, so it is found by hand
async function pickSet(wrapper: VueWrapper, value: string): Promise<void> {
  wrapper.findAllComponents(SettingSelect as Component)[0]!.vm.$emit('update:modelValue', value);
  await flushPromises();
}

describe('the theme editor\'s Characters section', () => {
  it('shows each character in idle, running and waiting, named "<character>, <state>", and a state it lacks as its idle', async () => {
    const { wrapper } = section();
    await flushPromises();
    const table = wrapper.get('[data-testid="character-set-preview"]');
    expect(table.get('caption').text()).toBe('Night characters in each state');
    expect(table.findAll('th').map((cell) => cell.text()).slice(0, 4)).toEqual(['Character', 'Idle', 'Running', 'Waiting']);
    expect(table.findAll('img').map((image) => image.attributes('alt'))).toEqual(['Pip, idle', 'Pip, running', 'Mochi, idle']);
    expect(table.findAll('tbody tr')[1]!.text()).toContain('As idle');
  });

  it('blocks a flashing image until Allow flashing for this file, which only asks main', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.allowFlash).mockResolvedValue({ ok: true, flash: { flagged: true, atMs: 500, kind: 'general', allowed: true } });
    const { wrapper } = section({}, api);
    await flushPromises();
    const blocked = wrapper.get('[data-testid="character-flash-blocked"]');
    expect(blocked.text()).toContain('Blocked: flashes');
    expect(blocked.text()).toContain('Pip, running');
    expect(blocked.text()).toContain('from 0:00.5');
    // the blocked strip holds its first frame
    expect(wrapper.findAll('[data-testid="character-cell-running"] img')[0]!.classes()).not.toContain('d-sprite');
    await wrapper.get('[data-testid="character-allow-flashing"]').trigger('click');
    await flushPromises();
    expect(api.themeEditor.allowFlash).toHaveBeenCalledWith(7, SHA(2));
    expect(wrapper.find('[data-testid="character-flash-blocked"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="character-cell-running"] img')[0]!.classes()).toContain('d-sprite');
  });

  it('stops its moving images when reduce motion turns on while it shows, and moves them again when it turns off', async () => {
    const { wrapper } = section();
    await flushPromises();
    const idle = (): string[] => wrapper.findAll('[data-testid="character-cell-idle"] img')[0]!.classes();
    expect(idle()).toContain('d-sprite');
    document.documentElement.setAttribute('data-reduced-motion', '');
    await flushPromises();
    expect(idle()).not.toContain('d-sprite');
    document.documentElement.removeAttribute('data-reduced-motion');
    await flushPromises();
    expect(idle()).toContain('d-sprite');
  });

  it('adds a character from the image main stores, cut into the frames asked for, and drops a sprite no character names', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importSpriteFile).mockResolvedValue({ ok: true, sprite: IMPORTED, name: 'gloop.svg' });
    const { wrapper, draft } = section({}, api);
    await flushPromises();
    await wrapper.get('[data-testid="character-add"]').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toBe('Name the character first.');
    await wrapper.get('#theme-character-name').setValue('Pip');
    await wrapper.get('[data-testid="character-add"]').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toBe('A character of this set is already named Pip.');
    await wrapper.get('#theme-character-name').setValue('Gloop');
    await wrapper.get('#theme-character-frames').setValue('4');
    await wrapper.get('[data-testid="character-add"]').trigger('click');
    await flushPromises();
    expect(api.themeEditor.importSpriteFile).toHaveBeenCalledWith(7, { frames: 4, fps: 4 });
    expect(draft().characters?.characters.map((character) => character.name)).toEqual(['Pip', 'Mochi', 'Gloop']);
    expect(draft().characters?.characters[2]!.states.idle).toEqual({ strip: { asset: SHA(9), ...IMPORTED.strip } });
    // the unnamed sprite is gone, the wallpaper stays
    expect(assetKeys(draft())).toEqual([SHA(1), SHA(2), SHA(3), SHA(5), SHA(9)].sort());
    expect(wrapper.get<HTMLInputElement>('#theme-character-name').element.value).toBe('');
  });

  it('removes a character with the sprites only it named', async () => {
    const { wrapper, draft } = section();
    await flushPromises();
    await button(wrapper, 'Remove Pip').trigger('click');
    expect(draft().characters?.characters.map((character) => character.name)).toEqual(['Mochi']);
    expect(assetKeys(draft())).toEqual([SHA(3), SHA(5)]);
    // the last character takes the set with it
    await button(wrapper, 'Remove Mochi').trigger('click');
    expect(draft().characters).toBeUndefined();
    expect(assetKeys(draft())).toEqual([SHA(5)]);
  });

  it('marks the selected project\'s character with an outline or nothing, drawn on the set\'s first character, and keeps the choice through other edits', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importSpriteFile).mockResolvedValue({ ok: true, sprite: IMPORTED, name: 'new.svg' });
    const { wrapper, draft } = section({}, api);
    await flushPromises();
    const group = wrapper.get('[data-testid="character-selection"]');
    expect(group.attributes('aria-labelledby')).toBe('theme-character-selection');
    expect(wrapper.get('#theme-character-selection').text()).toBe('Selected project');
    const options = group.findAll('label');
    expect(options.map((option) => option.text())).toEqual(['Outline', 'None']);
    expect(options.map((option) => option.get('.project-character').attributes('data-selection'))).toEqual(['outline', 'none']);
    expect(wrapper.get<HTMLButtonElement>('#theme-character-selection-outline').attributes('data-state')).toBe('checked');

    await wrapper.get('#theme-character-selection-none').trigger('click');
    await flushPromises();
    expect(draft().characters?.selection).toBe('none');
    expect(wrapper.get('#theme-character-selection-none').attributes('data-state')).toBe('checked');
    // a character added afterwards keeps the set's choice
    await wrapper.get('#theme-character-name').setValue('Bun');
    await wrapper.get('[data-testid="character-add"]').trigger('click');
    await flushPromises();
    expect(draft().characters?.characters.map((character) => character.name)).toEqual(['Pip', 'Mochi', 'Bun']);
    expect(draft().characters?.selection).toBe('none');
    // outline is the default, so choosing it writes no field
    await wrapper.get('#theme-character-selection-outline').trigger('click');
    await flushPromises();
    expect(draft().characters).not.toHaveProperty('selection');
  });

  it('offers no selection choice without a set, and none to change while read-only', async () => {
    const { characters: _none, ...bare } = THEME;
    expect(section({ draft: bare }).wrapper.find('[data-testid="character-selection"]').exists()).toBe(false);
    const { wrapper, draft } = section({ readOnly: true });
    await flushPromises();
    await wrapper.get('#theme-character-selection-none').trigger('click');
    await flushPromises();
    expect(draft().characters).not.toHaveProperty('selection');
    // an option that cannot be chosen invites no click
    const classes = (w: typeof wrapper): string[] => w.findAll('[data-testid="character-selection"] label').flatMap((option) => option.classes());
    expect(classes(wrapper)).not.toContain('cursor-pointer');
    expect(classes(wrapper)).not.toContain('hover:bg-(--d-hover)');
    expect(classes(section().wrapper)).toEqual(expect.arrayContaining(['cursor-pointer', 'hover:bg-(--d-hover)']));
  });

  it('gives a state the chosen image and drops the sprite it replaced', async () => {
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.importSpriteFile).mockResolvedValue({ ok: true, sprite: IMPORTED, name: 'run.svg' });
    const { wrapper, draft } = section({}, api);
    await flushPromises();
    await button(wrapper, 'Choose the running image of Pip').trigger('click');
    await flushPromises();
    expect(draft().characters?.characters[0]!.states).toEqual({ idle: strip(1), running: { strip: { asset: SHA(9), ...IMPORTED.strip } } });
    expect(assetKeys(draft())).toEqual([SHA(1), SHA(3), SHA(5), SHA(9)].sort());
  });

  it('puts an image that arrives late on the character it was chosen for, wherever that is by then, and nowhere once it is gone', async () => {
    const api = fakeOverlayApi();
    const answer = deferredSprite(api);
    const { wrapper, draft, setDraft, updates } = section({}, api);
    await flushPromises();
    const only = (name: string): ThemeFile => ({ ...THEME, characters: { ...THEME.characters!, characters: THEME.characters!.characters.filter((character) => character.name === name) } });
    // chosen for Mochi, the second row; while the file dialog is open Pip goes, so Mochi is the first row by then
    await button(wrapper, 'Choose the waiting image of Mochi').trigger('click');
    // the rows' own Remove waits for the import
    expect(button(wrapper, 'Remove Pip').attributes('disabled')).toBeDefined();
    setDraft(only('Mochi'));
    answer({ ok: true, sprite: IMPORTED, name: 'wait.svg' });
    await flushPromises();
    expect(draft().characters?.characters).toEqual([{ name: 'Mochi', states: { idle: strip(3), waiting: { strip: { asset: SHA(9), ...IMPORTED.strip } } } }]);

    // chosen for Mochi, who is gone by the time the image arrives: it goes nowhere, least of all to the row now in its place
    setDraft(THEME);
    await flushPromises();
    await button(wrapper, 'Choose the waiting image of Mochi').trigger('click');
    setDraft(only('Pip'));
    updates.length = 0;
    answer({ ok: true, sprite: IMPORTED, name: 'wait.svg' });
    await flushPromises();
    expect(updates).toEqual([]);
    expect(draft()).toEqual(only('Pip'));
  });

  it('says in its own words that an import main rejected failed, and is ready for the next one', async () => {
    const api = fakeOverlayApi();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.themeEditor.importSpriteFile).mockRejectedValue(new Error("Error invoking remote method 'damocles:theme-editor:import-sprite-file': Error: Rejected"));
    const { wrapper, updates } = section({}, api);
    await flushPromises();
    await wrapper.get('#theme-character-name').setValue('Gloop');
    await wrapper.get('[data-testid="character-add"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Damocles could not do that. Try again.');
    expect(wrapper.get('[data-testid="character-add"]').attributes('disabled')).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it('takes another theme\'s set, or none, as a replacement the editor can undo, with only the new set\'s sprites', async () => {
    const { wrapper, replaced, updates } = section();
    await flushPromises();
    await pickSet(wrapper, `from:${OTHER}`);
    expect(updates).toEqual([]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.characters).toEqual(PALS.characters);
    expect(assetKeys(replaced[0]!)).toEqual([SHA(5), SHA(6)]);
    await pickSet(wrapper, 'none');
    expect(replaced[1]!.characters).toBeUndefined();
    expect(assetKeys(replaced[1]!)).toEqual([SHA(5)]);
    // with no set of its own there is nothing to put back: a set taken now is a plain edit
    await pickSet(wrapper, `from:${OTHER}`);
    expect(replaced).toHaveLength(2);
    expect(updates.at(-1)!.characters).toEqual(PALS.characters);
  });

  it('lists every project with its character and "Keep in every theme", which keeps the character it shows', async () => {
    const { wrapper, pinned } = section();
    await flushPromises();
    const rows = wrapper.get('[data-testid="character-pins"]').findAll('li');
    expect(rows.map((row) => row.text())).toEqual([expect.stringContaining('api'), expect.stringContaining('web')]);
    const automatic = ['Pip', 'Mochi'][characterIndex('local:/work/api', 2)]!;
    expect(rows[0]!.text()).toContain(`Automatic (${automatic})`);
    expect(rows[0]!.get('label').text()).toContain('Keep in every theme');
    await rows[0]!.get('[role="checkbox"]').trigger('click');
    expect(pinned.at(-1)).toEqual(['local:/work/api', { character: null, every: automatic }]);
  });

  it('turns the section\'s choices into the pin changes Save writes, and nothing for a project left as it was', () => {
    const file: ProjectsFile = { version: 1, pins: { a: { byTheme: { [ID]: 'Pip' } } } };
    const before = pinChoices(file, ID, ['a', 'b']);
    expect(before).toEqual({ a: { character: 'Pip', every: null }, b: { character: null, every: null } });
    expect(pinEdits(before, { ...before, a: { character: null, every: 'Mochi' } })).toEqual([{ projectKey: 'a', character: null, everyTheme: 'Mochi' }]);
    expect(pinEdits(before, before)).toEqual([]);
  });

  it('reads a pin of a character the set lacks as automatic, which Save then clears, and leaves the other pins as they are', () => {
    const pins = { a: { character: 'Pip', every: 'Pip' }, b: { character: 'Mochi', every: null } };
    expect(validPins(pins, THEME.characters)).toBe(pins);
    const without = { ...THEME.characters!, characters: THEME.characters!.characters.filter((character) => character.name !== 'Pip') };
    expect(validPins(pins, without)).toEqual({ a: { character: null, every: 'Pip' }, b: { character: 'Mochi', every: null } });
    expect(pinEdits(pins, validPins(pins, without))).toEqual([{ projectKey: 'a', character: null }]);
    expect(validPins(pins, undefined)).toEqual({ a: { character: null, every: 'Pip' }, b: { character: null, every: null } });
  });
});
