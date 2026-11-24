// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { CharacterFrameView, ShownCharacterMotion, ShownCharacters } from '@shared/themes/characters';
import type { CharacterSelection } from '@shared/themes/schema';
import ProjectAvatar from '../components/ProjectAvatar.vue';
import ProjectRow from '../components/ProjectRow.vue';
import { STATE } from './fakes';
import { createPageCharacters, PAGE_CHARACTERS } from '../characters';
import { shellI18n } from '../i18n';

// A project's avatar (docs/themes.md "Characters"): the shown theme's character in the project's state, named
// "<project> character, <state>" on its wrapper unless the name stands beside it, a strip stepping through d-sprite while it
// may move; else the project's letter, which also stands in for an image that does not load.

const strip = (fps = 4, playable = true): CharacterFrameView => ({ url: 'app://damocles/theme-blob/strip', strip: { frameWidth: 10, frameHeight: 10, frames: 4, fps }, moves: true, playable });
const gif: CharacterFrameView = { url: 'app://damocles/theme-blob/gif', still: 'app://damocles/theme-cache/gif/still.png', moves: true, playable: true };
const shown = (motion: ShownCharacterMotion, running: CharacterFrameView = strip(), selection: CharacterSelection = 'outline'): ShownCharacters => ({
  characters: [{ name: 'Pip', states: { idle: { url: 'app://damocles/theme-blob/idle', moves: false, playable: false }, running } }],
  pins: {},
  motion,
  selection,
});

// the characters the page around the avatars provides
const page = createPageCharacters();
const global = { plugins: [shellI18n], provide: { [PAGE_CHARACTERS as symbol]: page.characters } };

const mounted: VueWrapper[] = [];
function avatar(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(ProjectAvatar, { props: { name: 'api', projectKey: 'local:/work/api', ...props }, global });
  mounted.push(wrapper);
  return wrapper;
}
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  page.set(undefined);
  vi.restoreAllMocks();
});

describe('ProjectAvatar', () => {
  it('shows the project\'s letter while the shown theme has no characters', () => {
    const wrapper = avatar({ state: 'running' });
    expect(wrapper.find('.project-avatar').text()).toBe('A');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('refuses to render on a page that provides no characters', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => mount(ProjectAvatar, { props: { name: 'api' }, global: { plugins: [shellI18n] } })).toThrow('No page provides PAGE_CHARACTERS');
  });

  const character = (wrapper: VueWrapper) => wrapper.find('[data-testid="project-character"]');

  it('names the character "<project> character, <state>" once, on the image role of its wrapper', () => {
    page.set({ shown: shown('always') });
    const running = avatar({ state: 'running' });
    expect(character(running).attributes('role')).toBe('img');
    expect(character(running).attributes('aria-label')).toBe('api character, running');
    expect(running.find('img').attributes('alt')).toBe('');
    expect(character(avatar({ state: 'idle' })).attributes('aria-label')).toBe('api character, idle');
    // a state the character does not draw shows its idle image, still named by the state
    const waiting = avatar({ state: 'waiting' });
    expect(character(waiting).attributes('aria-label')).toBe('api character, waiting');
    expect(waiting.find('img').attributes('src')).toBe('app://damocles/theme-blob/idle');
  });

  it('keeps its name while the pointer swaps an animated image for its still frame: neither image carries it', () => {
    page.set({ shown: shown('hover', gif) });
    const hover = avatar({ state: 'running' });
    expect(character(hover).attributes('aria-label')).toBe('api character, running');
    expect(hover.findAll('img').map((image) => image.attributes('alt'))).toEqual(['', '']);
  });

  it('says nothing where the project\'s name and state stand in text beside it', () => {
    page.set({ shown: shown('always') });
    const decorative = avatar({ state: 'running', decorative: true });
    expect(character(decorative).attributes('role')).toBeUndefined();
    expect(character(decorative).attributes('aria-label')).toBeUndefined();
    expect(character(decorative).attributes('aria-hidden')).toBe('true');
    expect(decorative.find('img').attributes('alt')).toBe('');
  });

  it('shows the project\'s letter for an image that does not load, and the character again once the frame names another file', async () => {
    page.set({ shown: shown('always') });
    const wrapper = avatar({ state: 'idle' });
    await wrapper.find('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.project-avatar').text()).toBe('A');
    expect(wrapper.find('.project-avatar').attributes('aria-hidden')).toBe('true');
    // the same files again are still the ones that failed
    page.set({ shown: shown('active') });
    await nextTick();
    expect(wrapper.find('img').exists()).toBe(false);
    await wrapper.setProps({ state: 'running' });
    expect(wrapper.find('img').attributes('src')).toBe('app://damocles/theme-blob/strip');
  });

  it('falls back to the letter when either image of a hover pair does not load', async () => {
    page.set({ shown: shown('hover', gif) });
    const wrapper = avatar({ state: 'running' });
    await wrapper.findAll('img')[1]!.trigger('error');
    expect(wrapper.find('.project-avatar').text()).toBe('A');
  });

  it('steps a strip through d-sprite: one clipped frame wide, as many steps as frames, at the strip\'s rate', () => {
    page.set({ shown: shown('always') });
    const image = avatar({ state: 'running' }).find('img');
    expect(image.classes()).toContain('d-sprite');
    expect(image.classes()).toContain('project-character-image');
    const style = image.attributes('style') ?? '';
    expect(style).toContain('width: 400%');
    expect(style).toContain('--sprite-frames: 4');
    expect(style).toContain('--sprite-duration: 1s');
    expect(style).not.toContain('transform');
  });

  it('holds the first frame when main says nothing may move (reduce motion, forced colors) and when the flash check blocks it', () => {
    page.set({ shown: shown('still') });
    const held = avatar({ state: 'running' });
    expect(held.find('img').classes()).not.toContain('d-sprite');
    expect(held.find('[data-testid="project-character"]').attributes('data-character-moving')).toBe('false');
    page.set({ shown: shown('always', strip(12, false)) });
    expect(avatar({ state: 'running' }).find('img').classes()).not.toContain('d-sprite');
    // an animated image shows its still frame instead
    page.set({ shown: shown('still', gif) });
    expect(avatar({ state: 'running' }).find('img').attributes('src')).toBe(gif.still);
    page.set({ shown: shown('always', gif) });
    expect(avatar({ state: 'running' }).find('img').attributes('src')).toBe(gif.url);
  });

  it('moves only the selected project\'s character under "Selected project", and only under the pointer under "On hover"', () => {
    page.set({ shown: shown('active') });
    expect(avatar({ state: 'running', active: false }).find('img').classes()).not.toContain('d-sprite');
    expect(avatar({ state: 'running', active: true }).find('img').classes()).toContain('d-sprite');
    page.set({ shown: shown('hover') });
    const hover = avatar({ state: 'running' }).find('img');
    expect(hover.classes()).toContain('d-sprite');
    expect(hover.attributes('data-sprite-hover')).toBe('');
    // an animated image keeps both frames, and the stylesheet shows the moving one only under the pointer
    page.set({ shown: shown('hover', gif) });
    expect(avatar({ state: 'running' }).findAll('img').map((image) => image.attributes('src'))).toEqual([gif.still, gif.url]);
  });

  it('takes the state and the selected project main sent the overlay when its surface names only the key', () => {
    page.set({ shown: shown('active'), states: { 'local:/work/api': 'running' }, selected: 'local:/work/api' });
    const wrapper = avatar({});
    expect(character(wrapper).attributes('aria-label')).toBe('api character, running');
    expect(wrapper.find('img').classes()).toContain('d-sprite');
  });

  it('names its kind, its character and the set\'s selection, and marks itself selected only when asked', () => {
    page.set({ shown: shown('always') });
    const selected = character(avatar({ state: 'idle', selected: true }));
    expect(selected.attributes('data-avatar')).toBe('character');
    expect(selected.attributes('data-character')).toBe('Pip');
    expect(selected.attributes('data-selection')).toBe('outline');
    expect(selected.attributes('data-selected')).toBe('');
    expect(character(avatar({ state: 'idle' })).attributes('data-selected')).toBeUndefined();
    page.set({ shown: shown('always', strip(), 'none') });
    expect(character(avatar({ state: 'idle', selected: true })).attributes('data-selection')).toBe('none');
    page.set(undefined);
    const letter = avatar({ selected: true }).get('.project-avatar');
    expect(letter.attributes('data-avatar')).toBe('letter');
    expect(letter.attributes('data-selected')).toBe('');
  });

  // The stylesheet rings [data-selected] letters around their box and outlines [data-selected][data-selection="outline"]
  // characters along their pixels; a ring class on a character drew a box around a clear sprite.
  it('gives the selected project row\'s character the outline hooks and no box ring, and its letter the ring hook', () => {
    page.set({ shown: shown('always') });
    const row = (selected: boolean) => {
      const wrapper = mount(ProjectRow, { props: { project: STATE.projects[0]!, selected, active: false, grouped: false }, global });
      mounted.push(wrapper);
      return wrapper;
    };
    const sprite = row(true).get('[data-avatar="character"]');
    expect(sprite.attributes('data-selected')).toBe('');
    expect(sprite.attributes('data-selection')).toBe('outline');
    expect(row(false).get('[data-avatar="character"]').attributes('data-selected')).toBeUndefined();
    page.set(undefined);
    const letter = row(true).get('[data-avatar="letter"]');
    expect(letter.attributes('data-selected')).toBe('');
  });
});

