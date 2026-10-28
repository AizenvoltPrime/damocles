// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { OFFLINE_GRACE_MS, RECONNECTED_MS } from '@shared/host-connection';
import type { ShellHost } from '../../preload/shell-channels';
import ConnectionBanner from '../components/ConnectionBanner.vue';
import { shellI18n } from '../i18n';

const mounted: VueWrapper[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

const HOST: ShellHost = { hostId: 'h1', authorityKey: 'ssh+h1', name: 'prod-1', connection: 'connected', signInNeeded: false };
const mountBanner = (host: ShellHost | undefined) => {
  const wrapper = mount(ConnectionBanner, { props: { host }, global: { plugins: [shellI18n] } });
  mounted.push(wrapper);
  return wrapper;
};
const banner = (wrapper: VueWrapper) => wrapper.find('[data-testid="connection-banner"]');
const announced = (wrapper: VueWrapper) => wrapper.get('[data-testid="connection-banner-announcement"]').text();
// classes that keep a sentence on one line or cut it
const SINGLE_LINE = /^(truncate|text-ellipsis|whitespace-nowrap|line-clamp-.+)$/;
// classes that cut, hide or fix the height of an element, so a wrapped line or an action inside it would not show whole
const CLIPPING = /^(truncate|overflow(-[xy])?-(hidden|clip)|h-\d.*|max-h-.+|hidden|invisible|sr-only)$|:(hidden|invisible|sr-only)$/;
const clippingOnPath = (from: Element, to: Element): string[] => {
  const found: string[] = [];
  for (let at: Element | null = from; at; at = at === to ? null : at.parentElement) found.push(...[...at.classList].filter((name) => CLIPPING.test(name)));
  return found;
};
const advance = async (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
  await nextTick();
};

describe('connection banner', () => {
  it('shows nothing for a local project or a connected or connecting host', () => {
    expect(banner(mountBanner(undefined)).exists()).toBe(false);
    expect(banner(mountBanner(HOST)).exists()).toBe(false);
    expect(banner(mountBanner({ ...HOST, connection: 'connecting' })).exists()).toBe(false);
  });

  it('says a host no loop reconnects is offline, with Reconnect and no countdown', async () => {
    for (const connection of ['offline', 'failed'] as const) {
      const wrapper = mountBanner({ ...HOST, connection });
      const shown = wrapper.get('[data-testid="connection-banner"]');
      expect(shown.attributes('data-state')).toBe('offline');
      expect(shown.text()).toBe('prod-1 is offlineReconnect');
      expect(announced(wrapper)).toBe('prod-1 is offline');
      await shown.get('button').trigger('click');
      expect(wrapper.emitted('reconnect')).toEqual([['h1']]);
    }
  });

  it('asks for a sign-in an attempt waits on, ahead of the offline state, and opens it on Sign in', async () => {
    const wrapper = mountBanner({ ...HOST, connection: 'connecting', signInNeeded: true });
    const shown = wrapper.get('[data-testid="connection-banner"]');
    expect(shown.attributes('data-state')).toBe('signIn');
    expect(shown.get('button').text()).toBe('Sign in to prod-1');
    expect(shown.text()).toContain('prod-1 is waiting for you to sign in');
    await shown.get('button').trigger('click');
    expect(wrapper.emitted('signIn')).toEqual([['h1']]);
    expect(wrapper.emitted('reconnect')).toBeUndefined();
  });

  it('shows nothing for a drop shorter than the grace, and no green moment after it', async () => {
    const wrapper = mountBanner({ ...HOST, connection: 'offline', reconnect: { phase: 'waiting', since: Date.now(), retryAt: Date.now() } });
    await advance(OFFLINE_GRACE_MS - 1000);
    expect(banner(wrapper).exists()).toBe(false);
    await wrapper.setProps({ host: HOST });
    await advance(OFFLINE_GRACE_MS);
    expect(banner(wrapper).exists()).toBe(false);
    expect(announced(wrapper)).toBe('');
  });

  it('counts down to the next attempt in tabular numerals once the grace ran out, announcing the state once, not each second', async () => {
    const since = Date.now();
    const wrapper = mountBanner({ ...HOST, connection: 'offline', reconnect: { phase: 'waiting', since, retryAt: since + 7000 } });
    expect(banner(wrapper).exists()).toBe(false);
    await advance(OFFLINE_GRACE_MS);
    const countdown = wrapper.get('[data-testid="connection-banner-countdown"]');
    expect(countdown.classes()).toContain('tabular-nums');
    expect(wrapper.get('[data-testid="connection-banner-text"]').text()).toBe('Reconnecting to prod-1 in 5 s');
    expect(announced(wrapper)).toBe('Reconnecting to prod-1');
    const region = wrapper.get('[data-testid="connection-banner-announcement"]').element;
    const changes: string[] = [];
    const observer = new MutationObserver(() => changes.push(region.textContent ?? ''));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    await advance(1000);
    expect(wrapper.get('[data-testid="connection-banner-countdown"]').text()).toBe('4');
    await advance(3000);
    expect(wrapper.get('[data-testid="connection-banner-countdown"]').text()).toBe('1');
    await wrapper.setProps({ host: { ...HOST, connection: 'offline', reconnect: { phase: 'running', since } } });
    expect(wrapper.get('[data-testid="connection-banner-text"]').text()).toBe('Reconnecting to prod-1…');
    await nextTick();
    observer.disconnect();
    // four countdown ticks and the attempt starting changed nothing the live region says
    expect(changes).toEqual([]);
    await wrapper.get('[data-testid="connection-banner-action"]').trigger('click');
    expect(wrapper.emitted('reconnect')).toEqual([['h1']]);
  });

  it('turns red on a permanent failure with Retry, Show log and Edit host, then shows green for a moment once the host is back', async () => {
    const since = Date.now() - OFFLINE_GRACE_MS;
    const wrapper = mountBanner({ ...HOST, connection: 'failed', reconnect: { phase: 'failed', since, code: 'authFailed' } });
    await nextTick();
    expect(banner(wrapper).attributes('data-state')).toBe('failed');
    expect(wrapper.get('[data-testid="connection-banner-text"]').text()).toBe("Couldn't reconnect to prod-1. Edits and messages are kept on this computer.");
    expect(announced(wrapper)).toBe("Couldn't reconnect to prod-1");
    expect(banner(wrapper).findAll('button').map((button) => button.text())).toEqual(['Retry', 'Show log', 'Edit host']);
    for (const action of ['reconnect', 'showLog', 'editHost'] as const) await wrapper.get(`[data-testid="connection-banner-${action}"]`).trigger('click');
    expect([wrapper.emitted('reconnect'), wrapper.emitted('showLog'), wrapper.emitted('editHost')]).toEqual([[['h1']], [['h1']], [['h1']]]);

    await wrapper.setProps({ host: HOST });
    expect(banner(wrapper).attributes('data-state')).toBe('reconnected');
    expect(banner(wrapper).text()).toBe('Reconnected to prod-1');
    expect(announced(wrapper)).toBe('Reconnected to prod-1');
    await advance(RECONNECTED_MS);
    expect(banner(wrapper).exists()).toBe(false);
  });

  it('shows no green moment when the banner moves from an offline host to another, connected host', async () => {
    const wrapper = mountBanner({ ...HOST, connection: 'offline' });
    expect(banner(wrapper).attributes('data-state')).toBe('offline');
    await wrapper.setProps({ host: { ...HOST, hostId: 'h2', authorityKey: 'ssh+h2', name: 'staging' } });
    expect(banner(wrapper).exists()).toBe(false);
    expect(announced(wrapper)).toBe('');
  });

  it('ends the green moment when the host drops again during it', async () => {
    const since = Date.now() - OFFLINE_GRACE_MS;
    const wrapper = mountBanner({ ...HOST, connection: 'failed', reconnect: { phase: 'failed', since, code: 'authFailed' } });
    await nextTick();
    await wrapper.setProps({ host: HOST });
    expect(banner(wrapper).attributes('data-state')).toBe('reconnected');
    await wrapper.setProps({ host: { ...HOST, reconnect: { phase: 'suspect', since: Date.now() } } });
    expect(banner(wrapper).exists()).toBe(false);
    await advance(OFFLINE_GRACE_MS);
    expect(banner(wrapper).attributes('data-state')).toBe('reconnecting');
  });

  // happy-dom lays nothing out, so these pin the classes Chromium wraps with; the screenshots in the frontend report show the result.
  it('in a narrow banner, wraps the failed sentence onto its own line before any action, and clips or hides no action', async () => {
    const since = Date.now() - OFFLINE_GRACE_MS;
    const wrapper = mountBanner({ ...HOST, name: 'billing-production-eu-west-1', connection: 'failed', reconnect: { phase: 'failed', since, code: 'authFailed' } });
    await nextTick();
    const shown = banner(wrapper);
    const text = wrapper.get('[data-testid="connection-banner-text"]');
    const actions = wrapper.get('[data-testid="connection-banner-actions"]');
    expect(shown.classes()).toContain('@container/banner');
    expect(text.classes()).toContain('@max-[24rem]/banner:basis-full');
    expect(text.classes().filter((name) => SINGLE_LINE.test(name))).toEqual([]);
    expect(text.element.parentElement).toBe(actions.element.parentElement);
    expect(text.element.parentElement!.classList).toContain('flex-wrap');
    expect(actions.classes()).toContain('flex-wrap');
    expect(actions.findAll('button').map((button) => button.text())).toEqual(['Retry', 'Show log', 'Edit host']);
    for (const button of actions.findAll('button')) expect(clippingOnPath(button.element, shown.element)).toEqual([]);
  });

  it('draws only the strip on the gutter edge, with no text and no live region', async () => {
    const wrapper = mount(ConnectionBanner, { props: { host: { ...HOST, connection: 'offline' }, edge: true }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    expect(wrapper.get('[data-testid="connection-banner-edge"]').attributes('aria-hidden')).toBe('true');
    expect(wrapper.find('[data-testid="connection-banner-announcement"]').exists()).toBe(false);
  });
});
