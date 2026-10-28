// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { ShellHost } from '../../preload/shell-channels';
import ConnectionBanner from '../components/ConnectionBanner.vue';
import { shellI18n } from '../i18n';

const HOST: ShellHost = { hostId: 'h1', authorityKey: 'ssh-remote+h1', name: 'prod-1', connection: 'offline', signInNeeded: false };
const mounted: VueWrapper[] = [];
const mountBanner = (host: ShellHost, edge = false): VueWrapper => {
  const wrapper = mount(ConnectionBanner, { props: { host, edge }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
};

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

describe('update banner', () => {
  it('names the old daemon\'s agents and version in place of the offline banner, with both switches', async () => {
    const wrapper = mountBanner({ ...HOST, update: { serverVersion: '3.7.0', runningAgents: 2, phase: 'offer' } });
    expect(wrapper.find('[data-testid="connection-banner"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="host-update-banner-text"]').text()).toBe('prod-1 is running 2 agents on Damocles 3.7.0');
    expect(wrapper.get('[data-testid="connection-banner-announcement"]').text()).toBe('');
    await wrapper.get('[data-testid="host-update-when-idle"]').trigger('click');
    await wrapper.get('[data-testid="host-update-now"]').trigger('click');
    expect(wrapper.emitted('switchWhenIdle')).toEqual([['h1']]);
    expect(wrapper.emitted('switchNow')).toEqual([['h1']]);
  });

  it('uses the singular for one agent, and while waiting for them keeps only Switch now', () => {
    expect(mountBanner({ ...HOST, update: { serverVersion: '3.7.0', runningAgents: 1, phase: 'offer' } }).get('[data-testid="host-update-banner-text"]').text()).toBe('prod-1 is running 1 agent on Damocles 3.7.0');
    const waiting = mountBanner({ ...HOST, update: { serverVersion: '3.7.0', runningAgents: 1, phase: 'waiting' } });
    expect(waiting.get('[data-testid="host-update-banner-text"]').text()).toBe('Waiting for the agents on prod-1 to finish');
    expect(waiting.find('[data-testid="host-update-when-idle"]').exists()).toBe(false);
    expect(waiting.find('[data-testid="host-update-now"]').exists()).toBe(true);
  });

  it('continues across the gutter as an edge in the update tone', () => {
    const edge = mountBanner({ ...HOST, update: { serverVersion: '3.7.0', runningAgents: 2, phase: 'offer' } }, true);
    expect(edge.get('[data-testid="connection-banner-edge"]').attributes('data-state')).toBe('update');
    expect(edge.find('[data-testid="host-update-banner"]').exists()).toBe(false);
  });

  it('has a Greek plural', () => {
    shellI18n.global.locale.value = 'el';
    expect(mountBanner({ ...HOST, update: { serverVersion: '3.7.0', runningAgents: 2, phase: 'offer' } }).get('[data-testid="host-update-banner-text"]').text()).toBe('Στο prod-1 τρέχουν 2 agents στο Damocles 3.7.0');
  });
});
