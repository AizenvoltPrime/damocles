// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ContainerStateDot, { type ContainerDotState } from '../components/ContainerStateDot.vue';
import DistroStateDot from '../components/DistroStateDot.vue';
import PortDot from '../components/PortDot.vue';
import type { PortDotShape } from '../components/ports-section';

// A tone's shape takes the tone's fill token on the shape itself. Drawn from currentColor under a tone's text class it
// takes the text token, which a theme may set apart from the fill (docs/invariants.md "Design tokens").

const TONE_TEXT = /^text-\(--d-(?:success|warning|danger|info|accent|design)(?:-text)?\)$/;
const root = (wrapper: VueWrapper) => wrapper.get('[role="img"]');
const toneText = (wrapper: VueWrapper): string[] => root(wrapper).classes().filter((name) => TONE_TEXT.test(name));
const fills = (wrapper: VueWrapper): string[] => wrapper.findAll('svg *').flatMap((shape) => shape.classes().filter((name) => /^(?:fill|stroke)-\(--d-/.test(name)));

describe('the state dots', () => {
  it.each<[PortDotShape, string[]]>([
    ['live', ['fill-(--d-success-fill)']],
    ['direct', ['fill-(--d-info-fill)']],
    ['error', ['fill-(--d-danger-fill)', 'stroke-(--d-on-danger)']],
  ])('draws a %s port from its fill token, never from the text color', (shape, expected) => {
    const dot = mount(PortDot, { props: { shape, label: 'Port' } });
    expect(toneText(dot)).toEqual([]);
    expect(dot.html()).not.toContain('currentColor');
    expect(fills(dot)).toEqual(expected);
  });

  it('colors a live port\'s ring through --tone', () => {
    expect(mount(PortDot, { props: { shape: 'live', label: 'Port' } }).get('.d-ring').classes()).toContain('[--tone:var(--d-success-fill)]');
  });

  it.each<[PortDotShape, string]>([['idle', 'text-(--d-muted)'], ['detected', 'text-(--d-faint)'], ['ignored', 'text-(--d-faint)']])('keeps a %s port, which has no tone, on the text color', (shape, text) => {
    const dot = mount(PortDot, { props: { shape, label: 'Port' } });
    expect(root(dot).classes()).toContain(text);
    expect(dot.html()).toContain('currentColor');
  });

  it('draws a running distro from the success fill, and a stopped one from the text color', () => {
    const running = mount(DistroStateDot, { props: { state: 'running', label: 'Running' } });
    expect(toneText(running)).toEqual([]);
    expect(running.html()).not.toContain('currentColor');
    expect(fills(running)).toEqual(['fill-(--d-success-fill)']);
    const stopped = mount(DistroStateDot, { props: { state: 'stopped', label: 'Stopped' } });
    expect(root(stopped).classes()).toContain('text-(--d-faint)');
    expect(stopped.get('circle').attributes('stroke')).toBe('currentColor');
  });

  it.each<[ContainerDotState, string[]]>([
    ['running', ['fill-(--d-success-fill)']],
    ['paused', ['stroke-(--d-warning-fill)']],
    ['restarting', ['stroke-(--d-warning-fill)', 'fill-(--d-warning-fill)']],
    ['missing', ['stroke-(--d-danger-fill)', 'stroke-(--d-danger-fill)']],
  ])('draws a %s container from its fill token, never from the text color', (state, expected) => {
    const dot = mount(ContainerStateDot, { props: { state, label: 'State' } });
    expect(toneText(dot)).toEqual([]);
    expect(dot.html()).not.toContain('currentColor');
    expect(fills(dot)).toEqual(expected);
  });

  it.each<ContainerDotState>(['stopped', 'unknown', 'other'])('keeps a %s container, which has no tone, on the text color', (state) => {
    const dot = mount(ContainerStateDot, { props: { state, label: 'State' } });
    expect(root(dot).classes().some((name) => name.startsWith('text-(--d-faint'))).toBe(true);
    expect(dot.get('circle').attributes('stroke')).toBe('currentColor');
  });
});
