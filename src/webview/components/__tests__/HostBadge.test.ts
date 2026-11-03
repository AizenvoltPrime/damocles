// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { canonicalHostColor } from '@shared/host-colors';
import HostBadge from '../HostBadge.vue';

describe('HostBadge', () => {
  it('tints with a palette tone through its class alone', () => {
    const badge = mount(HostBadge, { props: { name: 'prod-1', color: 'danger' } });
    expect(badge.classes()).toContain('d-tone-danger');
    expect(badge.attributes('data-tone')).toBe('danger');
    expect(badge.attributes('style')).toBeUndefined();
  });

  it('tints with a custom color through d-tone-custom and the color\'s channels', () => {
    const badge = mount(HostBadge, { props: { name: 'prod-1', color: canonicalHostColor('#00809a99')! } });
    expect(badge.classes()).toContain('d-tone-custom');
    expect(badge.classes().filter((name) => name.startsWith('d-tone-'))).toEqual(['d-tone-custom']);
    expect(badge.attributes('data-tone')).toBe('custom');
    const style = (badge.element as HTMLElement).style;
    expect(style.getPropertyValue('--host-rgb')).toBe('0 128 154');
    expect(style.getPropertyValue('--host-alpha')).toBe('0.6');
  });

  it('stays muted with no data-tone for a host without a color', () => {
    const badge = mount(HostBadge, { props: { name: 'prod-1' } });
    expect(badge.classes()).toContain('d-tone-muted');
    expect(badge.attributes('data-tone')).toBeUndefined();
  });
});
