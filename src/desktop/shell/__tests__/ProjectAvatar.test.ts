// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { CharacterFrameView, ShownCharacterMotion, ShownCharacters } from '@shared/themes/characters';
import ProjectAvatar from '../components/ProjectAvatar.vue';
import { setPageCharacters } from '../characters';
import { shellI18n } from '../i18n';

// A project's avatar (docs/themes.md "Characters"): the shown theme's character in the project's state, named
// "<project> character, <state>" on its wrapper unless the name stands beside it, a strip stepping through d-sprite while it
// may move; else the project's letter, which also stands in for an image that does not load.

const strip = (fps = 4, playable = true): CharacterFrameView => ({ url: 'app://damocles/theme-blob/strip', strip: { frameWidth: 10, frameHeight: 10, frames: 4, fps }, moves: true, playable });
const gif: CharacterFrameView = { url: 'app://damocles/theme-blob/gif', still: 'app://damocles/theme-cache/gif/still.png', moves: true, playable: true };
const shown = (motion: ShownCharacterMotion, running: CharacterFrameView = strip()): ShownCharacters => ({
  characters: [{ name: 'Pip', states: { idle: { url: 'app://damocles/theme-blob/idle', moves: false, playable: false }, running } }],
  pins: {},
  motion,
});

const mounted: VueWrapper[] = [];
function avatar(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(ProjectAvatar, { props: { name: 'api', projectKey: 'local:/work/api', ...props }, global: { plugins: [shellI18n] } });
  mounted.push(wrapper);
  return wrapper;
}
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  setPageCharacters(undefined);
});

describe('ProjectAvatar', () => {
  it('shows the project\'s letter while the shown theme has no characters', () => {
    const wrapper = avatar({ state: 'running' });
    expect(wrapper.find('.project-avatar').text()).toBe('A');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  const character = (wrapper: VueWrapper) => wrapper.find('[data-testid="project-character"]');

  it('names the character "<project> character, <state>" once, on the image role of its wrapper', () => {
    setPageCharacters({ shown: shown('always') });
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
    setPageCharacters({ shown: shown('hover', gif) });
    const hover = avatar({ state: 'running' });
    expect(character(hover).attributes('aria-label')).toBe('api character, running');
    expect(hover.findAll('img').map((image) => image.attributes('alt'))).toEqual(['', '']);
  });

  it('says nothing where the project\'s name and state stand in text beside it', () => {
    setPageCharacters({ shown: shown('always') });
    const decorative = avatar({ state: 'running', decorative: true });
    expect(character(decorative).attributes('role')).toBeUndefined();
    expect(character(decorative).attributes('aria-label')).toBeUndefined();
    expect(character(decorative).attributes('aria-hidden')).toBe('true');
    expect(decorative.find('img').attributes('alt')).toBe('');
  });

  it('shows the project\'s letter for an image that does not load, and the character again once the frame names another file', async () => {
    setPageCharacters({ shown: shown('always') });
    const wrapper = avatar({ state: 'idle' });
    await wrapper.find('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.project-avatar').text()).toBe('A');
    expect(wrapper.find('.project-avatar').attributes('aria-hidden')).toBe('true');
    // the same files again are still the ones that failed
    setPageCharacters({ shown: shown('active') });
    await nextTick();
    expect(wrapper.find('img').exists()).toBe(false);
    await wrapper.setProps({ state: 'running' });
    expect(wrapper.find('img').attributes('src')).toBe('app://damocles/theme-blob/strip');
  });

  it('falls back to the letter when either image of a hover pair does not load', async () => {
    setPageCharacters({ shown: shown('hover', gif) });
    const wrapper = avatar({ state: 'running' });
    await wrapper.findAll('img')[1]!.trigger('error');
    expect(wrapper.find('.project-avatar').text()).toBe('A');
  });

  it('steps a strip through d-sprite: one clipped frame wide, as many steps as frames, at the strip\'s rate', () => {
    setPageCharacters({ shown: shown('always') });
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
    setPageCharacters({ shown: shown('still') });
    const held = avatar({ state: 'running' });
    expect(held.find('img').classes()).not.toContain('d-sprite');
    expect(held.find('[data-testid="project-character"]').attributes('data-character-moving')).toBe('false');
    setPageCharacters({ shown: shown('always', strip(12, false)) });
    expect(avatar({ state: 'running' }).find('img').classes()).not.toContain('d-sprite');
    // an animated image shows its still frame instead
    setPageCharacters({ shown: shown('still', gif) });
    expect(avatar({ state: 'running' }).find('img').attributes('src')).toBe(gif.still);
    setPageCharacters({ shown: shown('always', gif) });
    expect(avatar({ state: 'running' }).find('img').attributes('src')).toBe(gif.url);
  });

  it('moves only the selected project\'s character under "Selected project", and only under the pointer under "On hover"', () => {
    setPageCharacters({ shown: shown('active') });
    expect(avatar({ state: 'running', active: false }).find('img').classes()).not.toContain('d-sprite');
    expect(avatar({ state: 'running', active: true }).find('img').classes()).toContain('d-sprite');
    setPageCharacters({ shown: shown('hover') });
    const hover = avatar({ state: 'running' }).find('img');
    expect(hover.classes()).toContain('d-sprite');
    expect(hover.attributes('data-sprite-hover')).toBe('');
    // an animated image keeps both frames, and the stylesheet shows the moving one only under the pointer
    setPageCharacters({ shown: shown('hover', gif) });
    expect(avatar({ state: 'running' }).findAll('img').map((image) => image.attributes('src'))).toEqual([gif.still, gif.url]);
  });

  it('takes the state and the selected project main sent the overlay when its surface names only the key', () => {
    setPageCharacters({ shown: shown('active'), states: { 'local:/work/api': 'running' }, selected: 'local:/work/api' });
    const wrapper = avatar({});
    expect(character(wrapper).attributes('aria-label')).toBe('api character, running');
    expect(wrapper.find('img').classes()).toContain('d-sprite');
  });
});

