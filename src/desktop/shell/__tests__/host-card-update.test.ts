// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { HostUpdate } from '@shared/host-update';
import type { HostCardInfo, HostRun } from '../../preload/overlay-channels';
import HostCard from '../overlay/components/HostCard.vue';
import { hostNotices } from '../overlay/connect-text';
import { shellI18n } from '../i18n';
import el from '../locales/el.json' with { type: 'json' };
import { FakeResizeObserver } from './fakes';

const PROD: HostCardInfo = {
  hostId: 'h1', kind: 'ssh', name: 'prod-1', destinationLabel: 'deploy@prod-1:22', connection: 'connected', signInNeeded: false, recentFolders: [], projectFolders: [],
  notices: [], allowBypass: false, passwordless: false, keyInstalledByDamocles: false, lingerEnabledByDamocles: false, devices: [{ deviceName: 'laptop', self: true }],
};
const UPDATE: HostUpdate = {
  source: 'compatible', phase: 'offer', serverVersion: '3.7.0', targetVersion: '3.9.0', runningAgents: 2, runningTerminals: 2, terminalsSurvive: false, otherDevices: 1, waitingSince: 0,
};
const OUTDATED: HostUpdate = { ...UPDATE, source: 'otherProtocol', phase: 'appOutdated', outdated: 'runs', serverVersion: '3.9.0', targetVersion: '3.7.0' };
const RUNS: HostRun[] = [{ id: 'r1', title: 'build-watch', state: 'running', canOpen: true }, { id: 'r2', title: 'htop', state: 'running', canOpen: false }];
const t = (key: string, values?: Record<string, unknown>, plural?: number): string => (plural === undefined ? shellI18n.global.t(key, values ?? {}) : shellI18n.global.t(key, values ?? {}, plural));

const mounted: VueWrapper[] = [];
function mountCard(host: Partial<HostCardInfo>): VueWrapper {
  const wrapper = mount(HostCard, {
    props: { host: { ...PROD, ...host }, runs: RUNS, checkName: vi.fn(), rename: vi.fn(), setInstallFolder: vi.fn(), browse: vi.fn(), allowBackgroundWork: vi.fn() },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}
const section = (wrapper: VueWrapper) => wrapper.get('[data-testid="host-update"]');
const buttons = (wrapper: VueWrapper): string[] => section(wrapper).findAll('button').map((button) => button.text());
const firstFocus = (): string | undefined => document.querySelector('[data-view-focus]')?.textContent?.trim();

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the host card\'s Update section', () => {
  it('lists what a pending switch waits for and stops, tags the terminals that close, and opens on its first action', async () => {
    const wrapper = mountCard({ update: UPDATE });
    expect(section(wrapper).get('[role="status"]').text()).toBe('Damocles 3.9.0 is ready. This host runs 3.7.0.');
    expect(section(wrapper).findAll('li').map((row) => row.text())).toEqual(['2 agents running', '1 other device connected', '2 terminals close on the switch']);
    expect(buttons(wrapper)).toEqual(['Switch when they finish', 'Switch now']);
    expect(firstFocus()).toBe('Switch when they finish');
    expect(wrapper.findAll('[data-testid="host-run-closes"]').map((tag) => tag.text())).toEqual(['Closes on switch', 'Closes on switch']);
    await section(wrapper).get('[data-testid="host-update-when-idle"]').trigger('click');
    await section(wrapper).get('[data-testid="host-update-now"]').trigger('click');
    expect(wrapper.emitted('updateAction')).toEqual([['switchWhenIdle'], ['switchNow']]);
  });

  it('while waiting keeps Switch now, which takes focus when Switch when they finish goes away', async () => {
    const wrapper = mountCard({ update: UPDATE });
    (section(wrapper).get('[data-testid="host-update-when-idle"]').element as HTMLElement).focus();
    await wrapper.setProps({ host: { ...PROD, update: { ...UPDATE, phase: 'waiting', runningAgents: 1 } } });
    await wrapper.vm.$nextTick();
    expect(section(wrapper).get('[role="status"]').text()).toBe('Switches to Damocles 3.9.0 when it is free.');
    expect(buttons(wrapper)).toEqual(['Switch now']);
    expect(document.activeElement).toBe(section(wrapper).get('[data-testid="host-update-now"]').element);
    expect(firstFocus()).toBe('Switch now');
  });

  it('lists the terminals waiting for files a pending damocles --wait opened, and that they stop waiting in the countdown', () => {
    const waiting: HostUpdate = { ...UPDATE, phase: 'waiting', runningAgents: 1, cliWaits: 1, terminalsSurvive: true, otherDevices: 0 };
    expect(section(mountCard({ update: waiting })).findAll('li').map((row) => [row.attributes('data-blocker'), row.text()])).toEqual([['agents', '1 agent running'], ['cliWaits', '1 terminal waiting for a file'], ['survive', 'Terminals keep running']]);
    const countdown = mountCard({ update: { ...waiting, cliWaits: 2, required: { deadline: Date.now() + 60_000, countdown: true } } });
    expect(section(countdown).findAll('li').map((row) => row.text())).toEqual(['1 agent will stop', '2 terminals will stop waiting for their files', 'Terminals keep running']);
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(section(mountCard({ update: { ...waiting, cliWaits: 2 } })).findAll('li').map((row) => row.text())).toEqual(['Τρέχει 1 agent', '2 τερματικά περιμένουν αρχεία', 'Τα τερματικά συνεχίζουν να τρέχουν']);
  });

  it('hands focus to the card\'s heading when switching takes the action row away, and when the switch ends', async () => {
    const wrapper = mountCard({ update: { ...UPDATE, phase: 'waiting' } });
    const heading = wrapper.get('h2');
    expect(heading.attributes('tabindex')).toBe('-1');
    (section(wrapper).get('[data-testid="host-update-now"]').element as HTMLElement).focus();
    await wrapper.setProps({ host: { ...PROD, update: { ...UPDATE, phase: 'switching' } } });
    await wrapper.vm.$nextTick();
    expect(buttons(wrapper)).toEqual([]);
    expect(document.activeElement).toBe(heading.element);
    (section(wrapper).get('[role="status"]').element as HTMLElement).setAttribute('tabindex', '-1');
    (section(wrapper).get('[role="status"]').element as HTMLElement).focus();
    await wrapper.setProps({ host: PROD });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="host-update"]').exists()).toBe(false);
    expect(document.activeElement).toBe(heading.element);
  });

  it('while switching lists nothing, offers nothing and tags no terminal', () => {
    const wrapper = mountCard({ update: { ...UPDATE, phase: 'switching' } });
    expect(section(wrapper).get('[role="status"]').text()).toBe('Switching to Damocles 3.9.0.');
    expect(section(wrapper).findAll('li')).toHaveLength(0);
    expect(buttons(wrapper)).toEqual([]);
    expect(wrapper.find('[data-testid="host-run-closes"]').exists()).toBe(false);
  });

  it('for an outdated app reads not connected, says why, and hides what it cannot use', () => {
    // main publishes a host whose daemon is of another protocol as not connected
    const wrapper = mountCard({ connection: 'offline', update: OUTDATED });
    expect(wrapper.get('[data-testid="host-card-status"]').text()).toBe('Not connected');
    expect(wrapper.get('[data-testid="host-status-dot"]').attributes()).toMatchObject({ 'data-shape': 'offline', 'data-update': 'appOutdated' });
    expect(section(wrapper).text()).toContain('This host runs Damocles 3.9.0. Update this app to use it.');
    expect(section(wrapper).text()).toContain('This computer runs 3.7.0. Damocles never moves a server back to an older version.');
    expect(buttons(wrapper)).toEqual([]);
    expect(wrapper.find('[data-testid="host-devices"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Running on prod-1');
    expect(wrapper.find('[data-testid="host-card-open-folder"]').exists()).toBe(false);
    expect(firstFocus()).toBe('');
    expect(document.querySelector('[data-view-focus]')).toBe(wrapper.get('[data-testid="host-card-close"]').element);
  });

  it('for a daemon of another protocol, which this app is not attached to, shows the connection main publishes and counts runs in the Update section alone', () => {
    const wrapper = mountCard({ connection: 'offline', update: { ...UPDATE, source: 'otherProtocol' } });
    expect(wrapper.get('[data-testid="host-card-status"]').text()).toBe('Not connected');
    expect(wrapper.get('[data-testid="host-status-dot"]').attributes('data-shape')).toBe('offline');
    expect(wrapper.find('[data-testid="host-card-failure"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Nothing is running.');
    expect(wrapper.text()).not.toContain('Running on prod-1');
    expect(wrapper.find('[data-testid="host-card-connect"]').exists()).toBe(false);
    expect(buttons(wrapper)).toEqual(['Switch when they finish', 'Switch now']);
    // the status row and the dot say what main published, adding no rule of their own
    const failed = mountCard({ connection: 'failed', update: { ...UPDATE, source: 'otherProtocol' } });
    expect(failed.get('[data-testid="host-card-status"]').text()).toBe('Couldn\'t connect');
    expect(failed.get('[data-testid="host-status-dot"]').attributes('data-shape')).toBe('failed');
  });

  it('offers Check for updates to an outdated app while the updater runs, and opens on it', async () => {
    const wrapper = mountCard({ update: OUTDATED, canCheckForUpdates: true });
    expect(buttons(wrapper)).toEqual(['Check for updates']);
    expect(firstFocus()).toBe('Check for updates');
    await section(wrapper).get('[data-testid="host-update-check"]').trigger('click');
    expect(wrapper.emitted('updateAction')).toEqual([['checkForUpdates']]);
  });

  it('shows no Update section without a pending switch', () => {
    expect(mountCard({}).find('[data-testid="host-update"]').exists()).toBe(false);
  });
});

describe('the Update section of a required switch, a drain and a host\'s minimum', () => {
  // a local time, so a short time reads the same in every time zone
  const at = (hour: number, minute: number, second = 0): number => new Date(2026, 0, 15, hour, minute, second).getTime();
  const SURVIVES: HostUpdate = { ...UPDATE, phase: 'waiting', terminalsSurvive: true };
  const rows = (wrapper: VueWrapper): string[] => section(wrapper).findAll('li').map((row) => row.text());
  const lead = (wrapper: VueWrapper): string => section(wrapper).get('[role="status"]').text();
  // what a screen reader reads of the live lead: its text but the aria-hidden parts
  const heardLead = (wrapper: VueWrapper): string => {
    const copy = section(wrapper).get('[role="status"]').element.cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(13, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a required switch its deadline in the warning tone, with Switch now alone and first', () => {
    const wrapper = mountCard({ update: { ...SURVIVES, phase: 'offer', required: { deadline: at(16, 30), countdown: false } } });
    expect(section(wrapper).attributes()).toMatchObject({ 'data-state': 'required', 'data-tone': 'warning' });
    expect(lead(wrapper)).toBe('Must switch to Damocles 3.9.0 by 16:30, in 3 h.');
    expect(section(wrapper).find('.lucide-clock-icon').exists()).toBe(true);
    expect(heardLead(wrapper)).toBe('Must switch to Damocles 3.9.0 by 16:30.');
    expect(rows(wrapper)).toEqual(['2 agents running', '1 other device reconnects after the switch', 'Terminals keep running']);
    expect(buttons(wrapper)).toEqual(['Switch now']);
    expect(firstFocus()).toBe('Switch now');
    expect(section(wrapper).get('[data-testid="host-update-now"]').classes()).toContain('text-(--d-warning-text)');
    expect(wrapper.find('[data-testid="host-run-closes"]').exists()).toBe(false);
  });

  it('counts down in the danger tone, says which agents stop, and ticks with the minutes hidden for a screen reader', async () => {
    const wrapper = mountCard({ update: { ...UPDATE, phase: 'waiting', runningAgents: 1, required: { deadline: at(13, 42, 41), countdown: true } } });
    expect(section(wrapper).attributes()).toMatchObject({ 'data-state': 'countdown', 'data-tone': 'danger' });
    expect(section(wrapper).find('.lucide-timer-icon').exists()).toBe(true);
    expect(lead(wrapper)).toBe('Switches to Damocles 3.9.0 in 12:4113 minutes.');
    expect(section(wrapper).get('[data-testid="countdown-clock"]').attributes('aria-hidden')).toBe('true');
    expect(section(wrapper).get('[data-testid="countdown-spoken"]').attributes('aria-live')).toBe('polite');
    expect(rows(wrapper)).toEqual(['1 agent will stop', '1 other device connected', '2 terminals close on the switch']);
    expect(wrapper.findAll('[data-testid="host-run-closes"]')).toHaveLength(2);
    expect(buttons(wrapper)).toEqual(['Switch now']);
    expect(section(wrapper).get('[data-testid="host-update-now"]').classes()).toContain('text-(--d-danger-text)');
    vi.advanceTimersByTime(2000);
    await wrapper.vm.$nextTick();
    expect(lead(wrapper)).toBe('Switches to Damocles 3.9.0 in 12:3913 minutes.');
  });

  it('gives a deadline on another day its weekday', () => {
    expect(lead(mountCard({ update: { ...SURVIVES, required: { deadline: new Date(2026, 0, 17, 9, 0).getTime(), countdown: false } } }))).toBe('Must switch to Damocles 3.9.0 by Saturday 09:00, in 44 h.');
  });

  it('names the terminals that alone hold a server from before terminals survived a switch, with Switch when they close', () => {
    const offer = mountCard({ update: { ...UPDATE, source: 'otherProtocol', runningAgents: 0, runningTerminals: 3, otherDevices: 0 } });
    expect(lead(offer)).toBe('Damocles 3.9.0 is ready. This host is running 3 terminals on 3.7.0.');
    expect(buttons(offer)).toEqual(['Switch when they close', 'Switch now']);
    expect(lead(mountCard({ update: { ...UPDATE, phase: 'waiting', runningAgents: 0, runningTerminals: 1 } }))).toBe('Switches to Damocles 3.9.0 when 1 terminal closes.');
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(lead(mountCard({ update: { ...UPDATE, source: 'otherProtocol', runningAgents: 0, runningTerminals: 3 } }))).toBe('Το Damocles 3.9.0 είναι έτοιμο. Σε αυτόν τον απομακρυσμένο υπολογιστή τρέχουν 3 τερματικά στο 3.7.0.');
    expect(lead(mountCard({ update: { ...UPDATE, phase: 'waiting', runningAgents: 0, runningTerminals: 3 } }))).toBe('Μεταβαίνει στο Damocles 3.9.0 όταν κλείσουν 3 τερματικά.');
  });

  it('says when the drain ends and that the other devices reconnect then, once no agent runs', () => {
    const agents = mountCard({ update: SURVIVES });
    expect(lead(agents)).toBe('Switches to Damocles 3.9.0 when it is free.');
    expect(rows(agents)).toEqual(['2 agents running', '1 other device reconnects after the switch', 'Terminals keep running']);
    const drain = mountCard({ update: { ...SURVIVES, runningAgents: 0, otherDevices: 2, drainEndsAt: at(14, 5) } });
    expect(lead(drain)).toBe('Switches to Damocles 3.9.0 at 14:05.');
    expect(rows(drain)).toEqual(['2 other devices reconnect at 14:05', 'Terminals keep running']);
    expect(rows(mountCard({ update: { ...SURVIVES, runningAgents: 0, runningTerminals: 0, otherDevices: 1, drainEndsAt: at(14, 5) } }))).toEqual(['1 other device reconnects at 14:05']);
  });

  it('tells an app below the host\'s minimum why, as the outdated card looks', () => {
    const floor: HostUpdate = { ...OUTDATED, outdated: 'floor', runningAgents: 0, runningTerminals: 0, terminalsSurvive: true };
    // main publishes the refused attempt as not connected, with no failure, while the floor shows
    const wrapper = mountCard({ update: floor, connection: 'offline', canCheckForUpdates: true });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="host-card-status"]').text()).toBe('Not connected');
    expect(wrapper.get('[data-testid="host-status-dot"]').attributes()).toMatchObject({ 'data-shape': 'offline', 'data-update': 'appOutdated' });
    expect(section(wrapper).attributes('data-tone')).toBe('warning');
    expect(lead(wrapper)).toBe('This host needs Damocles 3.9.0 or later. Update this app to use it.');
    expect(section(wrapper).get('[data-testid="host-update-sub"]').text()).toBe('This app is 3.7.0. A required update set 3.9.0 as the minimum on prod-1.');
    expect(buttons(wrapper)).toEqual(['Check for updates']);
    expect(wrapper.find('[data-testid="host-devices"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Running on prod-1');
    expect(wrapper.text()).not.toContain('Reconnect');
  });

  it('says each in Greek', () => {
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(lead(mountCard({ update: { ...SURVIVES, required: { deadline: at(14, 30), countdown: false } } }))).toBe('Πρέπει να μεταβεί στο Damocles 3.9.0 έως τις 14:30, σε 1 ώρα.');
    const countdown = mountCard({ update: { ...SURVIVES, runningAgents: 1, required: { deadline: at(13, 42, 41), countdown: true } } });
    expect(lead(countdown)).toBe('Μεταβαίνει στο Damocles 3.9.0 σε 12:4113 λεπτά.');
    expect(rows(countdown)).toEqual(['Θα σταματήσει 1 agent', '1 ακόμη συσκευή επανασυνδέεται μετά τη μετάβαση', 'Τα τερματικά συνεχίζουν να τρέχουν']);
    const drain = mountCard({ update: { ...SURVIVES, runningAgents: 0, otherDevices: 2, drainEndsAt: at(14, 5) } });
    expect(lead(drain)).toBe('Μεταβαίνει στο Damocles 3.9.0 στις 14:05.');
    expect(rows(drain)[0]).toBe('2 ακόμη συσκευές επανασυνδέονται στις 14:05');
    const floor = mountCard({ update: { ...OUTDATED, outdated: 'floor' } });
    expect(lead(floor)).toBe('Αυτός ο απομακρυσμένος υπολογιστής χρειάζεται Damocles 3.9.0 ή νεότερο. Ενημερώστε αυτή την εφαρμογή για να τον χρησιμοποιήσετε.');
    // the host and this computer read as two machines
    const outdated = mountCard({ update: OUTDATED });
    expect(lead(outdated)).toBe('Αυτός ο απομακρυσμένος υπολογιστής τρέχει Damocles 3.9.0. Ενημερώστε αυτή την εφαρμογή για να τον χρησιμοποιήσετε.');
    expect(section(outdated).get('[data-testid="host-update-sub"]').text()).toBe('Αυτός ο υπολογιστής τρέχει 3.7.0. Το Damocles δεν επαναφέρει ποτέ έναν διακομιστή σε παλαιότερη έκδοση.');
    expect(lead(mountCard({ update: { ...UPDATE, runningAgents: 0, runningTerminals: 0 } }))).toBe('Το Damocles 3.9.0 είναι έτοιμο. Αυτός ο απομακρυσμένος υπολογιστής τρέχει 3.7.0.');
    expect(section(floor).get('[data-testid="host-update-sub"]').text()).toBe('Αυτή η εφαρμογή είναι η έκδοση 3.7.0. Μια υποχρεωτική ενημέρωση όρισε την 3.9.0 ως ελάχιστη έκδοση στο prod-1.');
  });
});

describe('the serverInUse notice', () => {
  const inUse = (devices: number) => ({ code: 'serverInUse', params: { version: '3.7.0', devices } });

  it('says which version other devices keep, pluralized in English and Greek', () => {
    expect(hostNotices({ name: 'prod-1', notices: [inUse(1)] }, t, 'en')).toEqual([{ key: 'serverInUse', text: 'This host runs Damocles 3.7.0 because 1 other device uses it.' }]);
    expect(hostNotices({ name: 'prod-1', notices: [inUse(2)] }, t, 'en')[0]!.text).toBe('This host runs Damocles 3.7.0 because 2 other devices use it.');
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(hostNotices({ name: 'prod-1', notices: [inUse(1)] }, t, 'el')[0]!.text).toBe('Αυτός ο απομακρυσμένος υπολογιστής τρέχει Damocles 3.7.0 γιατί τον χρησιμοποιεί 1 ακόμη συσκευή.');
    expect(hostNotices({ name: 'prod-1', notices: [inUse(2)] }, t, 'el')[0]!.text).toBe('Αυτός ο απομακρυσμένος υπολογιστής τρέχει Damocles 3.7.0 γιατί τον χρησιμοποιούν 2 ακόμη συσκευές.');
  });
});
