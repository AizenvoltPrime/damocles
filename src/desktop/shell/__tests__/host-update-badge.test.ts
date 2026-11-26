// @vitest-environment happy-dom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { HostUpdate } from '@shared/host-update';
import { formatClock, formatResetTime } from '@/utils/clock';
import { PROJECT_CONNECTIONS, type ProjectConnection, type ShellHost, type ShellProject } from '../../preload/shell-channels';
import HostStatusDot from '../components/HostStatusDot.vue';
import HostUpdateTag from '../components/HostUpdateTag.vue';
import ProjectGroup from '../components/ProjectGroup.vue';
import ProjectRow from '../components/ProjectRow.vue';
import TitleBar from '../components/TitleBar.vue';
import { hostStateLabel, hostStateTitle } from '../host-label';
import { shellI18n } from '../i18n';
import el from '../locales/el.json' with { type: 'json' };
import { FakeResizeObserver, fakeShellApi, PAGE_PROVIDE, STATE } from './fakes';

const t = (key: string, params?: Record<string, unknown>): string => shellI18n.global.t(key, params ?? {});
// a local time, so a deadline's short time reads the same in every time zone
const at = (hour: number, minute: number, second = 0): number => new Date(2026, 0, 15, hour, minute, second).getTime();
const NOW = at(13, 30);
const clock = {
  now: () => Date.now(),
  time: (time: number) => formatClock(time, shellI18n.global.locale.value),
  deadline: (time: number) => formatResetTime(time, Date.now(), shellI18n.global.locale.value),
};
const UPDATE: HostUpdate = {
  source: 'compatible', phase: 'waiting', serverVersion: '3.7.0', targetVersion: '3.9.0', runningAgents: 2, runningTerminals: 1, terminalsSurvive: false, waitingSince: 0,
};
const REQUIRED: HostUpdate = { ...UPDATE, required: { deadline: at(16, 30), countdown: false } };
const COUNTDOWN: HostUpdate = { ...UPDATE, required: { deadline: at(13, 42, 41), countdown: true } };
const OUTDATED: HostUpdate = { ...UPDATE, source: 'otherProtocol', phase: 'appOutdated', outdated: 'runs', serverVersion: '3.9.0', targetVersion: '3.7.0' };
const FLOOR: HostUpdate = { ...OUTDATED, outdated: 'floor', runningAgents: 0, runningTerminals: 0, terminalsSurvive: true };
const LATENCY = { latencyMs: 38, slow: false, history: [38], measurements: 1 };
const CONNECTED = { name: 'prod-1', connection: 'connected', latency: LATENCY } as const;

const mounted: VueWrapper[] = [];
beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}
const dot = (props: InstanceType<typeof HostStatusDot>['$props']): VueWrapper => track(mount(HostStatusDot, { props }));

const PROJECT: ShellProject = {
  key: 'ssh+h1|/srv/api', name: 'api', fsPath: '/srv/api', trusted: true, authority: { kind: 'ssh', key: 'ssh+h1', hostId: 'h1', name: 'prod-1' }, platform: 'linux', connection: 'connected', trash: false, running: 0, waiting: 0,
};
const host = (update: HostUpdate | undefined, connection: ProjectConnection = 'connected'): ShellHost => ({ hostId: 'h1', kind: 'ssh', authorityKey: 'ssh+h1', name: 'prod-1', connection, signInNeeded: false, latency: LATENCY, ...(update ? { update } : {}) });
const chip = (update: HostUpdate | undefined): VueWrapper => track(mount(TitleBar, {
  props: { api: fakeShellApi(), state: { ...STATE, projects: [...STATE.projects, PROJECT], hosts: [host(update)], selected: { projectKey: PROJECT.key } } },
  global: { provide: PAGE_PROVIDE, plugins: [shellI18n] },
}));
const group = (update: HostUpdate | undefined, connection: ProjectConnection = 'connected'): VueWrapper => track(mount(ProjectGroup, {
  props: { groupKey: 'ssh+h1', name: 'prod-1', connection, host: host(update, connection), collapsed: false, headerId: 'g1', active: false, busy: { count: 0, waiting: false }, renaming: false },
  global: { provide: PAGE_PROVIDE, plugins: [shellI18n] },
}));
const row = (update: HostUpdate | undefined): VueWrapper => track(mount(ProjectRow, {
  props: { project: PROJECT, selected: false, active: false, grouped: false, host: host(update) },
  global: { provide: PAGE_PROVIDE, plugins: [shellI18n] },
}));
const tag = (wrapper: VueWrapper) => wrapper.find('[data-testid="host-update-tag"]');

describe('the host update badge', () => {
  // the pip's shape says the state, so it never rests on color alone, on every connection shape
  it.each([
    [{ ...UPDATE, phase: 'offer' }, 'circle', 'pending'],
    [UPDATE, 'circle', 'pending'],
    [REQUIRED, 'triangle', 'required'],
    [{ ...REQUIRED, phase: 'offer' }, 'triangle', 'required'],
    [COUNTDOWN, 'square', 'countdown'],
    [{ ...UPDATE, phase: 'switching' }, 'ring', 'switching'],
    [{ ...COUNTDOWN, phase: 'switching' }, 'ring', 'switching'],
    [OUTDATED, 'diamond', 'appOutdated'],
    [FLOOR, 'diamond', 'appOutdated'],
  ] as const)('draws %o as a %s on every connection shape', (update, pip, badge) => {
    for (const connection of PROJECT_CONNECTIONS) {
      for (const slow of [false, true]) {
        const wrapper = dot({ connection, slow, update });
        expect(wrapper.get('[data-testid="host-update-pip"]').attributes('data-pip')).toBe(pip);
        expect(wrapper.get('[data-testid="host-status-dot"]').attributes('data-update')).toBe(badge);
      }
    }
  });

  it('draws no pip without a pending switch', () => {
    for (const connection of PROJECT_CONNECTIONS) {
      const wrapper = dot({ connection });
      expect(wrapper.find('[data-testid="host-update-pip"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="host-status-dot"]').attributes('data-update')).toBeUndefined();
    }
  });

  it('never pulses with the connecting shape', () => {
    const wrapper = dot({ connection: 'connecting', update: UPDATE });
    expect(wrapper.get('[data-testid="host-status-dot"]').classes()).toContain('d-pulsing');
    expect(wrapper.get('[data-testid="host-update-pip"]').element.closest('.d-pulsing')).toBeNull();
    expect(dot({ connection: 'connecting', update: COUNTDOWN }).get('[data-testid="host-update-pip"]').element.closest('.d-pulsing')).toBeNull();
  });

  // a mask shows whatever is behind the dot through the cut, on a hovered or selected row and over a wallpaper alike
  it.each([
    ['circle', 'fill-(--d-info-fill)', UPDATE],
    ['triangle', 'fill-(--d-warning-fill)', REQUIRED],
    ['square', 'fill-(--d-danger-fill)', COUNTDOWN],
    ['ring', 'stroke-(--d-info-fill)', { ...UPDATE, phase: 'switching' }],
    ['diamond', 'fill-(--d-warning-fill)', OUTDATED],
  ] as const)('cuts the %s pip, painted %s, out of every connection shape with a mask in the dot\'s own SVG', (pip, paint, update) => {
    for (const connection of PROJECT_CONNECTIONS) {
      const shape = dot({ connection, update }).get('[data-testid="host-status-dot"] svg');
      const mask = shape.get('mask');
      expect(mask.attributes('id')).toBeTruthy();
      expect(shape.get('g[mask]').attributes('mask')).toBe(`url(#${mask.attributes('id')})`);
      expect(mask.get('[data-cut]').attributes()).toMatchObject({ 'data-cut': pip, fill: 'black' });
    }
    const drawn = dot({ connection: 'connected', update }).get('[data-testid="host-update-pip"]');
    expect(drawn.attributes('data-pip')).toBe(pip);
    expect(drawn.findAll('*').some((part) => part.classes().includes(paint))).toBe(true);
    expect(drawn.html()).not.toContain('stroke-(--d-panel');
  });

  it('cuts nothing out of a dot with no pip', () => {
    const shape = dot({ connection: 'connected' }).get('[data-testid="host-status-dot"] svg');
    expect(shape.find('mask').exists()).toBe(false);
    expect(shape.find('g[mask]').exists()).toBe(false);
  });

  it('assumes no color behind the dot on any surface', () => {
    const shell = path.resolve(__dirname, '..');
    const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
      return /\.(vue|ts|css)$/.test(entry.name) ? [full] : [];
    });
    expect(sources(shell).filter((file) => fs.readFileSync(file, 'utf8').includes('--dot-cut'))).toEqual([]);
  });

  it('adds its phrase to the host\'s name, and the card\'s lead to its tooltip', () => {
    expect(hostStateLabel(CONNECTED, t, clock)).toBe('prod-1 · 38 ms');
    expect(hostStateLabel({ ...CONNECTED, update: { ...UPDATE, phase: 'offer' } }, t, clock)).toBe('prod-1 · 38 ms, update pending');
    expect(hostStateLabel({ ...CONNECTED, update: UPDATE }, t, clock)).toBe('prod-1 · 38 ms, update pending');
    expect(hostStateLabel({ ...CONNECTED, update: { ...UPDATE, phase: 'switching' } }, t, clock)).toBe('prod-1 · 38 ms, switching to Damocles 3.9.0');
    expect(hostStateLabel({ name: 'prod-1', connection: 'offline', update: OUTDATED }, t, clock)).toBe('prod-1, Not connected, update this app');
    expect(hostStateTitle({ ...CONNECTED, update: UPDATE }, t, clock)).toBe('prod-1 · 38 ms\nSwitches to Damocles 3.9.0 when it is free.');
    expect(hostStateTitle({ name: 'prod-1', connection: 'offline', update: OUTDATED }, t, clock)).toBe('prod-1, Not connected\nThis host runs Damocles 3.9.0. Update this app to use it.');
    expect(hostStateTitle(CONNECTED, t, clock)).toBe('prod-1 · 38 ms');
  });

  it('names a host whose server was removed in its dot\'s label and tooltip, by whom when another device removed it', () => {
    expect(hostStateLabel({ name: 'prod-1', connection: 'offline', removed: { by: 'Laptop B' } }, t, clock)).toBe('prod-1, Not connected, server removed');
    expect(hostStateTitle({ name: 'prod-1', connection: 'offline', removed: { by: 'Laptop B' } }, t, clock)).toBe('prod-1, Not connected\nThe Damocles server on prod-1 was removed from Laptop B. Connect to install it again.');
    expect(hostStateTitle({ name: 'prod-1', connection: 'offline', removed: {} }, t, clock)).toBe('prod-1, Not connected\nThe Damocles server was removed from prod-1. Connect to install it again.');
  });

  it('names a required switch by its deadline, then by the minutes left rounded up, never less time than is left', () => {
    expect(hostStateLabel({ ...CONNECTED, update: REQUIRED }, t, clock)).toBe('prod-1 · 38 ms, update required by 16:30');
    expect(hostStateTitle({ ...CONNECTED, update: REQUIRED }, t, clock)).toBe('prod-1 · 38 ms\nMust switch to Damocles 3.9.0 by 16:30, in 3 h.');
    expect(hostStateLabel({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 ms, switches in 13 minutes');
    expect(hostStateTitle({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 ms\nSwitches to Damocles 3.9.0 in 13 minutes.');
    vi.setSystemTime(at(13, 41, 30));
    expect(hostStateLabel({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 ms, switches in 2 minutes');
    vi.setSystemTime(at(13, 42));
    expect(hostStateLabel({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 ms, switches in 1 minute');
    vi.setSystemTime(at(13, 42, 41));
    expect(hostStateLabel({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 ms, switches in less than a minute');
    expect(hostStateLabel({ ...CONNECTED, update: { ...COUNTDOWN, phase: 'switching' } }, t, clock)).toBe('prod-1 · 38 ms, switching to Damocles 3.9.0');
  });

  it('names a deadline on another day by its weekday, and one a week or more away by its date', () => {
    const saturday: HostUpdate = { ...UPDATE, required: { deadline: new Date(2026, 0, 17, 9, 0).getTime(), countdown: false } };
    expect(hostStateLabel({ ...CONNECTED, update: saturday }, t, clock)).toBe('prod-1 · 38 ms, update required by Saturday 09:00');
    expect(hostStateTitle({ ...CONNECTED, update: saturday }, t, clock)).toBe('prod-1 · 38 ms\nMust switch to Damocles 3.9.0 by Saturday 09:00, in 44 h.');
    const weekOut: HostUpdate = { ...UPDATE, required: { deadline: new Date(2026, 0, 22, 9, 0).getTime(), countdown: false } };
    expect(hostStateLabel({ ...CONNECTED, update: weekOut }, t, clock)).toBe('prod-1 · 38 ms, update required by Jan 22 09:00');
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(hostStateLabel({ ...CONNECTED, update: saturday }, t, clock)).toBe('prod-1 · 38 χλστ., απαιτείται ενημέρωση έως Σάββατο στις 09:00');
  });

  it('draws and names the connection main publishes, alike on the dot, in its name and in the group\'s option', () => {
    // main publishes a host whose daemon is of another protocol as not connected; the views add no rule of their own
    for (const update of [OUTDATED, { ...UPDATE, source: 'otherProtocol', phase: 'offer' }] as const) {
      for (const [connection, shape, state] of [['offline', 'offline', 'Not connected'], ['failed', 'failed', 'Couldn\'t connect']] as const) {
        const phrase = update === OUTDATED ? 'update this app' : 'update pending';
        expect(dot({ connection, update }).get('[data-testid="host-status-dot"]').attributes('data-shape')).toBe(shape);
        expect(hostStateLabel({ name: 'prod-1', connection, update }, t, clock)).toBe(`prod-1, ${state}, ${phrase}`);
        const header = group(update, connection);
        expect(header.get('[role="option"]').attributes('aria-label')).toContain(`prod-1, ${state}, ${phrase}`);
        expect(header.get('[data-testid="host-status-dot"]').attributes()).toMatchObject({ 'data-shape': shape, 'aria-label': `prod-1, ${state}, ${phrase}` });
      }
    }
  });

  it('keeps the outdated name for an app below the host\'s minimum, and says why in the tooltip', () => {
    expect(hostStateLabel({ name: 'prod-1', connection: 'failed', update: FLOOR }, t, clock)).toBe(hostStateLabel({ name: 'prod-1', connection: 'failed', update: OUTDATED }, t, clock));
    expect(hostStateLabel({ name: 'prod-1', connection: 'offline', update: FLOOR }, t, clock)).toBe('prod-1, Not connected, update this app');
    expect(hostStateTitle({ name: 'prod-1', connection: 'offline', update: FLOOR }, t, clock)).toBe('prod-1, Not connected\nNeeds Damocles 3.9.0 or later. Update this app to use it.');
  });

  it('says each phrase in Greek', () => {
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(hostStateLabel({ ...CONNECTED, update: UPDATE }, t, clock)).toBe('prod-1 · 38 χλστ., εκκρεμεί ενημέρωση');
    expect(hostStateLabel({ ...CONNECTED, update: { ...UPDATE, phase: 'switching' } }, t, clock)).toBe('prod-1 · 38 χλστ., μετάβαση στο Damocles 3.9.0');
    expect(hostStateLabel({ name: 'prod-1', connection: 'offline', update: OUTDATED }, t, clock)).toBe('prod-1, Χωρίς σύνδεση, ενημερώστε αυτή την εφαρμογή');
    expect(hostStateLabel({ ...CONNECTED, update: REQUIRED }, t, clock)).toBe('prod-1 · 38 χλστ., απαιτείται ενημέρωση έως τις 16:30');
    expect(hostStateLabel({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 χλστ., μεταβαίνει σε 13 λεπτά');
    expect(hostStateTitle({ ...CONNECTED, update: REQUIRED }, t, clock)).toBe('prod-1 · 38 χλστ.\nΠρέπει να μεταβεί στο Damocles 3.9.0 έως τις 16:30, σε 3 ώρες.');
    expect(hostStateTitle({ name: 'prod-1', connection: 'offline', update: FLOOR }, t, clock)).toBe('prod-1, Χωρίς σύνδεση\nΧρειάζεται Damocles 3.9.0 ή νεότερο. Ενημερώστε αυτή την εφαρμογή για να το χρησιμοποιήσετε.');
    vi.setSystemTime(at(13, 42));
    expect(hostStateLabel({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 χλστ., μεταβαίνει σε 1 λεπτό');
    vi.setSystemTime(at(13, 42, 41));
    expect(hostStateLabel({ ...CONNECTED, update: COUNTDOWN }, t, clock)).toBe('prod-1 · 38 χλστ., μεταβαίνει σε λιγότερο από ένα λεπτό');
  });
});

describe('the tag beside the host\'s name', () => {
  it.each([['title bar chip', chip], ['sidebar group header', group]] as const)('shows the deadline, then the minutes left, on the %s, hidden from a screen reader', async (_surface, surface) => {
    const required = tag(surface(REQUIRED));
    expect(required.text()).toBe('16:30');
    expect(required.attributes()).toMatchObject({ 'aria-hidden': 'true', 'data-state': 'required' });
    expect(required.classes()).toContain('text-(--d-warning-text)');
    expect(required.find('.lucide-clock-icon').exists()).toBe(true);

    const wrapper = surface(COUNTDOWN);
    const countdown = tag(wrapper);
    expect(countdown.text()).toBe('13 min');
    expect(countdown.attributes()).toMatchObject({ 'aria-hidden': 'true', 'data-state': 'countdown' });
    expect(countdown.classes()).toEqual(expect.arrayContaining(['bg-(--d-danger-fill)/16', 'text-(--d-danger-text)']));
    expect(countdown.find('.lucide-timer-icon').exists()).toBe(true);
    // 12:41 left: the text holds for 41 seconds, then changes once a minute, as the dot's name does
    const texts = [countdown.text()];
    for (let second = 0; second < 12 * 60 + 41; second++) {
      vi.advanceTimersByTime(1000);
      await nextTick();
      if (tag(wrapper).text() !== texts.at(-1)) texts.push(tag(wrapper).text());
    }
    expect(texts).toEqual(['13 min', '12 min', '11 min', '10 min', '9 min', '8 min', '7 min', '6 min', '5 min', '4 min', '3 min', '2 min', '1 min', '< 1 min']);
    expect(wrapper.get('[data-testid="host-status-dot"]').attributes('aria-label')).toBe('prod-1 · 38 ms, switches in less than a minute');

    for (const update of [undefined, UPDATE, { ...UPDATE, phase: 'offer' }, { ...COUNTDOWN, phase: 'switching' }, OUTDATED, FLOOR] as const) expect(tag(surface(update)).exists()).toBe(false);
  });

  it('counts the minutes in Greek', () => {
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(tag(chip(COUNTDOWN)).text()).toBe('13 λεπ.');
    vi.setSystemTime(at(13, 42));
    expect(tag(group(COUNTDOWN)).text()).toBe('1 λεπ.');
    vi.setSystemTime(at(13, 42, 41));
    expect(tag(group(COUNTDOWN)).text()).toBe('< 1 λεπ.');
  });

  it('adds a short weekday to a deadline on another day', () => {
    const saturday: HostUpdate = { ...UPDATE, required: { deadline: new Date(2026, 0, 17, 9, 0).getTime(), countdown: false } };
    expect(tag(chip(saturday)).text()).toBe('Sat 09:00');
    expect(tag(group({ ...saturday, required: { deadline: new Date(2026, 0, 22, 9, 0).getTime(), countdown: false } })).text()).toBe('Jan 22 09:00');
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(tag(chip(saturday)).text()).toBe('Σάβ 09:00');
  });

  it('pops in with the chip motion, and stops ticking once no text shows a deadline', async () => {
    const wrapper = chip(COUNTDOWN);
    expect(wrapper.findComponent(HostUpdateTag).html()).toContain('t-chip');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await wrapper.setProps({ state: { ...STATE, projects: [...STATE.projects, PROJECT], hosts: [host(undefined)], selected: { projectKey: PROJECT.key } } });
    vi.advanceTimersByTime(2000);
    await nextTick();
    vi.advanceTimersByTime(2000);
    expect(tag(wrapper).exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('names the group\'s option with the same phrase', () => {
    expect(group(REQUIRED).get('[role="option"]').attributes('aria-label')).toContain('prod-1, Connected, update required by 16:30');
    expect(group(COUNTDOWN).get('[role="option"]').attributes('aria-label')).toContain('prod-1, Connected, switches in 13 minutes');
  });

  it('never joins a project row\'s host badge, whose dot still carries the pip and the name', () => {
    for (const update of [REQUIRED, COUNTDOWN]) {
      const wrapper = row(update);
      expect(tag(wrapper).exists()).toBe(false);
      expect(wrapper.get('[data-testid="host-update-pip"]').attributes('data-pip')).toBe(update === REQUIRED ? 'triangle' : 'square');
    }
    expect(row(REQUIRED).get('[data-testid="host-status-dot"]').attributes('aria-label')).toBe('prod-1 · 38 ms, update required by 16:30');
  });
});
