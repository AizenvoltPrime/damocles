// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ToggleSwitch from '../ToggleSwitch.vue';

// palette-contrast.test.ts holds on-accent against faint and accent at 3:1 or more in both desktop palettes.
describe('ToggleSwitch', () => {
  it('draws the knob in on-accent on a faint off track, with the accent track fading in as a layer', () => {
    const wrapper = mount(ToggleSwitch, { props: { checked: false } });
    const track = wrapper.get('[role="switch"]');
    const knob = track.get('span');
    expect(knob.classes()).toContain('bg-(--d-on-accent)');
    expect(track.classes()).toContain('bg-(--d-faint)');
    expect(track.classes()).toContain('before:bg-(--d-accent)');
    expect(track.classes().some((name) => name.startsWith('transition-colors'))).toBe(false);
  });

  it('reports the new state and names itself from its attributes', async () => {
    const wrapper = mount(ToggleSwitch, { props: { checked: false }, attrs: { 'aria-label': 'Prefer key' } });
    const track = wrapper.get('[role="switch"]');
    expect(track.attributes('aria-label')).toBe('Prefer key');
    await track.trigger('click');
    expect(wrapper.emitted('update:checked')).toEqual([[true]]);
  });
});
