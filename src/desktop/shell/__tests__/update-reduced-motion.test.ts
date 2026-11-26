// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { HostUpdate } from '@shared/host-update';
import { PAGE_HEADING_KEY } from '@/composables/usePageHeading';
import type { ShellHost } from '../../preload/shell-channels';
import ConnectionBanner from '../components/ConnectionBanner.vue';
import HostStatusDot from '../components/HostStatusDot.vue';
import HostUpdateTag from '../components/HostUpdateTag.vue';
import NotifierApp from '../overlay/NotifierApp.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The countdown is information, so it ticks in every motion setting; what moves (a spinner, a pulse, a toast's entrance and
// life bar) is stopped by the one reduced-motion rule every page loads, or is not drawn at all.
const MOTION_CLASSES = ['d-spinning', 'd-pulsing', 'd-flash-once', 'toast-life'];
const LEFT_MS = (12 * 60 + 41) * 1000;
const HOST: ShellHost = { hostId: 'h1', kind: 'ssh', authorityKey: 'ssh-remote+h1', name: 'prod-1', connection: 'connected', signInNeeded: false };

const mounted: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}
// the element, its ancestors and its descendants
const moving = (element: Element): string[] => MOTION_CLASSES.filter((name) => element.closest(`.${name}`) !== null || element.querySelector(`.${name}`) !== null);

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 15, 13, 30));
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion: reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  document.documentElement.setAttribute('data-reduced-motion', '');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.documentElement.removeAttribute('data-reduced-motion');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a countdown under reduced motion', () => {
  it('puts no animation class on the strip, the pip, the tag or the toast, and each countdown text still ticks', async () => {
    const update: HostUpdate = {
      source: 'compatible', phase: 'waiting', serverVersion: '3.7.0', targetVersion: '3.9.0', runningAgents: 1, runningTerminals: 0, terminalsSurvive: true, waitingSince: 0,
      required: { deadline: Date.now() + LEFT_MS, countdown: true },
    };
    const banner = track(mount(ConnectionBanner, { props: { host: { ...HOST, update } }, global: { plugins: [shellI18n], provide: { [PAGE_HEADING_KEY]: () => null } }, attachTo: document.body }));
    const dot = track(mount(HostStatusDot, { props: { connection: 'connecting', update }, attachTo: document.body }));
    const tag = track(mount(HostUpdateTag, { props: { update }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    const api = fakeOverlayApi();
    const notifier = track(mount(NotifierApp, { props: { api }, global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } }, attachTo: document.body }));
    await flushPromises();
    api.toast({ id: 'k1', at: Date.now(), lifeMs: 12_000, remainingMs: 12_000, sticky: true, body: { kind: 'notice', severity: 'error', title: 'prod-1 switches in', message: 'Damocles 3.9.0 is required.', actions: ['Switch now'], host: 'prod-1', countdownTo: update.required!.deadline } });
    await flushPromises();

    const strip = banner.get('[data-testid="host-update-banner"]');
    const pip = dot.get('[data-testid="host-update-pip"]');
    const toast = notifier.get('[data-toast-id="k1"]');
    expect(moving(strip.element)).toEqual([]);
    // the connecting dot keeps its own pulse, which the reduced-motion rule stops; the pip was never inside it
    expect(moving(pip.element)).toEqual([]);
    expect(moving(tag.element)).toEqual([]);
    expect(moving(toast.element)).toEqual([]);

    const clocks = () => [strip.get('[data-testid="countdown-clock"]').text(), toast.get('[data-testid="countdown-clock"]').text(), tag.text()];
    expect(clocks()).toEqual(['12:41', '12:41', '13 min']);
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(clocks()).toEqual(['12:40', '12:40', '13 min']);
    vi.advanceTimersByTime(41_000);
    await nextTick();
    expect(clocks()).toEqual(['11:59', '11:59', '12 min']);
    expect(pip.attributes('data-pip')).toBe('square');
  });

  it('stops every animation and transition the pages could run, under the media query and the app\'s own setting', () => {
    const style = readFileSync(join(__dirname, '..', '..', '..', 'webview', 'style.css'), 'utf8');
    const media = style.slice(style.indexOf('@media (prefers-reduced-motion: reduce)'), style.indexOf('[data-reduced-motion] *,'));
    const setting = style.slice(style.indexOf('[data-reduced-motion] *,'));
    for (const block of [media, setting]) {
      expect(block).toMatch(/\*,\s*\*::before,\s*\*::after|\[data-reduced-motion\] \*,/);
      expect(block).toMatch(/animation-duration:\s*0\.001ms !important/);
      expect(block).toMatch(/animation-iteration-count:\s*1 !important/);
      expect(block).toMatch(/transition-duration:\s*0\.001ms !important/);
    }
  });
});
