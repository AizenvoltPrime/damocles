// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { HostUpdate } from '@shared/host-update';
import type { ShellHost, ShellProject } from '../../preload/shell-channels';
import ConnectionBanner from '../components/ConnectionBanner.vue';
import ChatPlaceholder from '../components/ChatPlaceholder.vue';
import { fakeShellApi } from './fakes';
import { BANNER_TONE } from '@/components/banner-tone';
import { PAGE_HEADING_KEY } from '@/composables/usePageHeading';
import { shellI18n } from '../i18n';
import el from '../locales/el.json' with { type: 'json' };

const HOST: ShellHost = { hostId: 'h1', kind: 'ssh', authorityKey: 'ssh-remote+h1', name: 'prod-1', connection: 'offline', signInNeeded: false };
const UPDATE: HostUpdate = {
  source: 'otherProtocol', phase: 'offer', serverVersion: '3.7.0', targetVersion: '3.9.0', runningAgents: 2, runningTerminals: 0, terminalsSurvive: false, waitingSince: 0,
};
const mounted: VueWrapper[] = [];
const mountBanner = (update: Partial<HostUpdate>, options: { edge?: boolean; canCheckForUpdates?: true } = {}): VueWrapper => {
  const { canCheckForUpdates, ...props } = options;
  const host: ShellHost = { ...HOST, update: { ...UPDATE, ...update } as HostUpdate, ...(canCheckForUpdates ? { canCheckForUpdates } : {}) };
  // the strip alone, outside a page, with no heading to hand focus to
  const wrapper = mount(ConnectionBanner, { props: { host, ...props }, global: { plugins: [shellI18n], provide: { [PAGE_HEADING_KEY]: () => null } }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
};
const text = (wrapper: VueWrapper): string => wrapper.get('[data-testid="host-update-banner"] [role="status"]').text();
// what a screen reader reads of the strip's live text: the visible text but its aria-hidden parts
const heard = (wrapper: VueWrapper): string => {
  const copy = wrapper.get('[data-testid="host-update-banner"] [role="status"]').element.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (copy.textContent ?? '').trim();
};
const buttons = (wrapper: VueWrapper): string[] => wrapper.findAll('[data-testid="host-update-banner"] button').map((button) => button.text());

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
});

describe('update banner', () => {
  it('offers both switches in place of the offline banner, naming the old daemon\'s agents and both versions', async () => {
    const wrapper = mountBanner({});
    expect(wrapper.find('[data-testid="connection-banner"]').exists()).toBe(false);
    expect(text(wrapper)).toBe('prod-1 is running 2 agents on Damocles 3.7.0. Damocles 3.9.0 is ready.');
    expect(wrapper.get('[data-testid="host-update-banner"]').classes()).toEqual(expect.arrayContaining(BANNER_TONE.info.split(' ')));
    expect(wrapper.get('[data-testid="connection-banner-announcement"]').text()).toBe('');
    expect(buttons(wrapper)).toEqual(['Switch when they finish', 'Switch now']);
    await wrapper.get('[data-testid="host-update-when-idle"]').trigger('click');
    await wrapper.get('[data-testid="host-update-now"]').trigger('click');
    expect(wrapper.emitted('switchWhenIdle')).toEqual([['h1']]);
    expect(wrapper.emitted('switchNow')).toEqual([['h1']]);
  });

  it('adds that a legacy daemon\'s terminals close, in one status sentence', () => {
    expect(text(mountBanner({ runningAgents: 1, runningTerminals: 1 }))).toBe('prod-1 is running 1 agent on Damocles 3.7.0. Damocles 3.9.0 is ready. Its terminal closes when it switches.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 1, runningTerminals: 3 }))).toBe('prod-1 switches to Damocles 3.9.0 when 1 agent finishes. Its 3 terminals close when it switches.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, runningTerminals: 1, terminalsSurvive: true }))).toBe('prod-1 switches to Damocles 3.9.0 when it is free.');
  });

  it('while waiting names what it waits for and keeps only Switch now', () => {
    const agents = mountBanner({ phase: 'waiting', otherDevices: 1 });
    expect(text(agents)).toBe('prod-1 switches to Damocles 3.9.0 when 2 agents finish.');
    expect(buttons(agents)).toEqual(['Switch now']);
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, otherDevices: 2 }))).toBe('prod-1 switches to Damocles 3.9.0 when 2 other devices disconnect.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, otherDevices: 1 }))).toBe('prod-1 switches to Damocles 3.9.0 when 1 other device disconnects.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0 }))).toBe('prod-1 switches to Damocles 3.9.0 when it is free.');
  });

  it('names the terminals that alone hold a server from before terminals survived a switch, with Switch when they close', () => {
    const offer = mountBanner({ runningAgents: 0, runningTerminals: 3 });
    expect(text(offer)).toBe('prod-1 is running 3 terminals on Damocles 3.7.0. Damocles 3.9.0 is ready.');
    expect(buttons(offer)).toEqual(['Switch when they close', 'Switch now']);
    expect(text(mountBanner({ runningAgents: 0, runningTerminals: 1 }))).toBe('prod-1 is running 1 terminal on Damocles 3.7.0. Damocles 3.9.0 is ready.');
    const waiting = mountBanner({ source: 'compatible', phase: 'waiting', runningAgents: 0, runningTerminals: 3, otherDevices: 1 });
    expect(text(waiting)).toBe('prod-1 switches to Damocles 3.9.0 when 3 terminals close.');
    expect(buttons(waiting)).toEqual(['Switch now']);
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, runningTerminals: 1 }))).toBe('prod-1 switches to Damocles 3.9.0 when 1 terminal closes.');
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    const greek = mountBanner({ runningAgents: 0, runningTerminals: 3 });
    expect(text(greek)).toBe('Στο prod-1 τρέχουν 3 τερματικά στο Damocles 3.7.0. Το Damocles 3.9.0 είναι έτοιμο.');
    expect(buttons(greek)).toEqual(['Μετάβαση όταν κλείσουν', 'Μετάβαση τώρα']);
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, runningTerminals: 1 }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 όταν κλείσει 1 τερματικό.');
  });

  it('names the terminals waiting for files a pending damocles --wait opened, alone or after the agents', () => {
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, cliWaits: 1, terminalsSurvive: true, otherDevices: 1 }))).toBe('prod-1 switches to Damocles 3.9.0 when you close the file a terminal is waiting for.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, cliWaits: 2, terminalsSurvive: true }))).toBe('prod-1 switches to Damocles 3.9.0 when you close the files 2 terminals are waiting for.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 1, cliWaits: 1, terminalsSurvive: true }))).toBe('prod-1 switches to Damocles 3.9.0 when 1 agent finishes. 1 terminal is waiting for a file.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, cliWaits: 1, terminalsSurvive: true, required: { deadline: 0, countdown: false } }))).toMatch(/^prod-1 must switch to Damocles 3\.9\.0 by .+\. 1 terminal is waiting for a file\.$/);
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 1, cliWaits: 2, terminalsSurvive: true, required: { deadline: 0, countdown: true } }))).toMatch(/1 agent will stop\. 2 terminals will stop waiting for their files\.$/);
  });

  it('names the terminals waiting for files in Greek', () => {
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, cliWaits: 1, terminalsSurvive: true }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 όταν κλείσετε το αρχείο που περιμένει ένα τερματικό.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 2, cliWaits: 3, terminalsSurvive: true }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 όταν ολοκληρωθούν 2 agents. 3 τερματικά περιμένουν αρχεία.');
  });

  it('moves focus to Switch now when Switch when they finish goes away', async () => {
    const wrapper = mountBanner({});
    (wrapper.get('[data-testid="host-update-when-idle"]').element as HTMLElement).focus();
    await wrapper.setProps({ host: { ...HOST, update: { ...UPDATE, phase: 'waiting' } } });
    await wrapper.vm.$nextTick();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="host-update-now"]').element);
  });

  it("hands focus to the placeholder's heading once Switch now goes away as the host switches", async () => {
    const project: ShellProject = { key: 'ssh:h1|/srv/app', name: 'app', fsPath: '/srv/app', trusted: true, authority: { kind: 'ssh', key: 'ssh-remote+h1', hostId: 'h1', name: 'prod-1' }, platform: 'linux', connection: 'connected', trash: false, running: 0, waiting: 0 };
    const wrapper = mount(ChatPlaceholder, { props: { api: fakeShellApi(), project, host: { ...HOST, update: UPDATE } }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    (wrapper.get('[data-testid="host-update-now"]').element as HTMLElement).focus();
    await wrapper.setProps({ host: { ...HOST, update: { ...UPDATE, phase: 'switching' } } });
    await nextTick();
    const heading = wrapper.get('[data-testid="chat-placeholder-title"]');
    expect(heading.element.tagName).toBe('H1');
    expect(heading.attributes('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading.element);
  });

  it('while switching says so with a spinner and no actions', () => {
    const wrapper = mountBanner({ phase: 'switching', runningTerminals: 2 });
    expect(text(wrapper)).toBe('Switching prod-1 to Damocles 3.9.0.');
    expect(buttons(wrapper)).toEqual([]);
    expect(wrapper.get('[data-testid="host-update-icon"]').classes()).toContain('d-spinning');
    expect(wrapper.get('[data-testid="host-update-icon"] svg').classes()).toContain('lucide-loader-circle-icon');
  });

  it('eases its tone and swaps its icon with the motion every page shares', async () => {
    const wrapper = mountBanner({});
    expect(wrapper.get('[data-testid="host-update-banner"]').classes()).toEqual(expect.arrayContaining(['transition-colors', 'duration-200', 'ease-out']));
    expect(wrapper.find('[data-testid="host-update-icon"] .lucide-circle-arrow-up-icon').exists()).toBe(true);
    await wrapper.setProps({ host: { ...HOST, update: { ...UPDATE, phase: 'switching' } } });
    expect(wrapper.find('[data-testid="host-update-icon"] .lucide-loader-circle-icon').exists()).toBe(true);
  });

  it('offers Check for updates in the placeholder as main publishes it on the host, and logs a check that fails', async () => {
    const project: ShellProject = { key: 'ssh:h1|/srv/app', name: 'app', fsPath: '/srv/app', trusted: true, authority: { kind: 'ssh', key: 'ssh-remote+h1', hostId: 'h1', name: 'prod-1' }, platform: 'linux', connection: 'offline', trash: false, running: 0, waiting: 0 };
    const outdated: HostUpdate = { ...UPDATE, phase: 'appOutdated', outdated: 'runs', serverVersion: '3.9.0', targetVersion: '3.7.0' };
    const api = fakeShellApi();
    const failure = new Error('the feed did not answer');
    vi.mocked(api.runUpdateAction).mockRejectedValueOnce(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapper = mount(ChatPlaceholder, { props: { api, project, host: { ...HOST, update: outdated } }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    expect(buttons(wrapper)).toEqual([]);
    await wrapper.setProps({ host: { ...HOST, update: outdated, canCheckForUpdates: true } });
    expect(buttons(wrapper)).toEqual(['Check for updates']);
    expect(api.getUpdate).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="host-update-check"]').trigger('click');
    await nextTick();
    expect(api.runUpdateAction).toHaveBeenCalledWith('check');
    expect(logged).toHaveBeenCalledWith('[update] checking for updates failed', failure);
    logged.mockRestore();
  });

  it('tells an outdated app to update, in the warning tone, with Check for updates only while the updater runs', async () => {
    const outdated = { phase: 'appOutdated', outdated: 'runs', serverVersion: '3.9.0', targetVersion: '3.7.0', runningTerminals: 2 } as const;
    const off = mountBanner(outdated);
    expect(text(off)).toBe('prod-1 runs Damocles 3.9.0. Update this app to use it.');
    expect(off.get('[data-testid="host-update-banner"]').classes()).toEqual(expect.arrayContaining(BANNER_TONE.warning.split(' ')));
    expect(buttons(off)).toEqual([]);
    const on = mountBanner(outdated, { canCheckForUpdates: true });
    expect(buttons(on)).toEqual(['Check for updates']);
    await on.get('[data-testid="host-update-check"]').trigger('click');
    expect(on.emitted('checkForUpdates')).toEqual([[]]);
  });

  it('continues across the gutter as an edge in the strip\'s tone', () => {
    const info = mountBanner({}, { edge: true });
    expect(info.get('[data-testid="connection-banner-edge"]').attributes('data-state')).toBe('update');
    expect(info.get('[data-testid="connection-banner-edge"]').classes()).toEqual(expect.arrayContaining(BANNER_TONE.info.split(' ')));
    expect(info.find('[data-testid="host-update-banner"]').exists()).toBe(false);
    const warning = mountBanner({ phase: 'appOutdated', outdated: 'runs' }, { edge: true });
    expect(warning.get('[data-testid="connection-banner-edge"]').classes()).toEqual(expect.arrayContaining(BANNER_TONE.warning.split(' ')));
  });

  it('has Greek plurals', () => {
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(text(mountBanner({ runningTerminals: 3 }))).toBe('Στο prod-1 τρέχουν 2 agents στο Damocles 3.7.0. Το Damocles 3.9.0 είναι έτοιμο. Τα 3 τερματικά του κλείνουν με τη μετάβαση.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 1, runningTerminals: 1 }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 όταν ολοκληρωθεί 1 agent. Το τερματικό του κλείνει με τη μετάβαση.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, otherDevices: 2 }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 όταν αποσυνδεθούν 2 ακόμη συσκευές.');
    expect(text(mountBanner({ phase: 'appOutdated', outdated: 'runs' }))).toBe('Το prod-1 τρέχει Damocles 3.7.0. Ενημερώστε αυτή την εφαρμογή για να το χρησιμοποιήσετε.');
  });
});

// a local time, so the strip's short time reads the same in every time zone
const at = (hour: number, minute: number, second = 0): number => new Date(2026, 0, 15, hour, minute, second).getTime();
const strip = (wrapper: VueWrapper) => wrapper.get('[data-testid="host-update-banner"]');
const LEGACY = { terminalsSurvive: false, runningTerminals: 3 } as const;

describe('a required update\'s strip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(13, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function wait(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms);
    await nextTick();
  }

  it('says the deadline as a short time and whole hours, then minutes under an hour, in the warning tone with Switch now alone', async () => {
    const wrapper = mountBanner({ required: { deadline: at(16, 30), countdown: false } });
    expect(text(wrapper)).toBe('prod-1 must switch to Damocles 3.9.0 by 16:30, in 3 h. 2 agents are still running.');
    expect(strip(wrapper).attributes()).toMatchObject({ 'data-state': 'required', 'data-tone': 'warning' });
    expect(strip(wrapper).classes()).toEqual(expect.arrayContaining(BANNER_TONE.warning.split(' ')));
    expect(strip(wrapper).find('.lucide-clock-icon').exists()).toBe(true);
    expect(buttons(wrapper)).toEqual(['Switch now']);
    // the live text says the deadline alone, so the strip is not heard again each time the time left changes
    expect(heard(wrapper)).toBe('prod-1 must switch to Damocles 3.9.0 by 16:30. 2 agents are still running.');
    await wait(60 * 60_000);
    expect(text(wrapper)).toBe('prod-1 must switch to Damocles 3.9.0 by 16:30, in 2 h. 2 agents are still running.');
    await wait(76 * 60_000);
    expect(text(wrapper)).toBe('prod-1 must switch to Damocles 3.9.0 by 16:30, in 44 minutes. 2 agents are still running.');
    expect(heard(wrapper)).toBe('prod-1 must switch to Damocles 3.9.0 by 16:30. 2 agents are still running.');
    expect(text(mountBanner({ runningAgents: 1, required: { deadline: at(16, 30), countdown: false } }))).toContain('in 44 minutes. 1 agent is still running.');
    expect(text(mountBanner({ phase: 'waiting', runningAgents: 0, required: { deadline: at(16, 30), countdown: false } }))).toBe('prod-1 must switch to Damocles 3.9.0 by 16:30, in 44 minutes.');
  });

  it('counts down in the danger tone, the clock hidden from a screen reader, which hears the minutes left rounded up, once a minute, in a live region of their own', async () => {
    const wrapper = mountBanner({ runningAgents: 1, required: { deadline: at(13, 45), countdown: true } });
    const clock = wrapper.get('[data-testid="countdown-clock"]');
    const spoken = wrapper.get('[data-testid="countdown-spoken"]');
    expect(strip(wrapper).attributes()).toMatchObject({ 'data-state': 'countdown', 'data-tone': 'danger' });
    expect(strip(wrapper).classes()).toEqual(expect.arrayContaining(BANNER_TONE.danger.split(' ')));
    expect(strip(wrapper).find('.lucide-timer-icon').exists()).toBe(true);
    expect(buttons(wrapper)).toEqual(['Switch now']);
    expect(clock.attributes('aria-hidden')).toBe('true');
    expect(spoken.classes()).toContain('sr-only');
    expect(spoken.attributes('aria-live')).toBe('polite');
    expect(text(wrapper)).toBe('prod-1 switches to Damocles 3.9.0 in 15:0015 minutes. 1 agent will stop.');
    expect(heard(wrapper)).toBe('prod-1 switches to Damocles 3.9.0 in 15 minutes. 1 agent will stop.');
    const minutes: Array<[string, string]> = [[clock.text(), spoken.text()]];
    for (let second = 0; second < 15 * 60 + 5; second++) {
      await wait(1000);
      if (spoken.text() !== minutes.at(-1)![1]) minutes.push([clock.text(), spoken.text()]);
    }
    // never less time than is left: 14:59 is still 15 minutes, 00:01 is 1 minute
    const marks = Array.from({ length: 15 }, (_, index) => 15 - index).map((left): [string, string] => [`${String(left).padStart(2, '0')}:00`, left === 1 ? '1 minute' : `${left} minutes`]);
    expect(minutes).toEqual([...marks, ['00:00', 'less than a minute']]);
    expect(clock.text()).toBe('00:00');
  });

  it('ticks at each whole second of the clock, whenever it mounted', async () => {
    vi.setSystemTime(at(13, 30) + 400);
    const wrapper = mountBanner({ required: { deadline: at(13, 45), countdown: true } });
    const clock = wrapper.get('[data-testid="countdown-clock"]');
    expect(clock.text()).toBe('15:00');
    await wait(600);
    expect(clock.text()).toBe('14:59');
    await wait(1000);
    expect(clock.text()).toBe('14:58');
  });

  it('gives a deadline on another day its weekday', () => {
    expect(text(mountBanner({ required: { deadline: new Date(2026, 0, 17, 9, 0).getTime(), countdown: false } }))).toBe('prod-1 must switch to Damocles 3.9.0 by Saturday 09:00, in 44 h. 2 agents are still running.');
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(text(mountBanner({ required: { deadline: new Date(2026, 0, 17, 9, 0).getTime(), countdown: false } }))).toBe('Το prod-1 πρέπει να μεταβεί στο Damocles 3.9.0 έως Σάββατο στις 09:00, σε 44 ώρες. Τρέχουν ακόμη 2 agents.');
  });

  it('adds a legacy daemon\'s closing terminals from the start, in the phase\'s tone', () => {
    const required = mountBanner({ ...LEGACY, required: { deadline: at(16, 30), countdown: false } });
    expect(text(required)).toBe('prod-1 must switch to Damocles 3.9.0 by 16:30, in 3 h. 2 agents are still running. Its 3 terminals close when it switches.');
    expect(strip(required).attributes('data-tone')).toBe('warning');
    const countdown = mountBanner({ ...LEGACY, required: { deadline: at(13, 42, 41), countdown: true } });
    expect(text(countdown)).toBe('prod-1 switches to Damocles 3.9.0 in 12:4113 minutes. 2 agents will stop. Its 3 terminals close when it switches.');
    expect(strip(countdown).attributes('data-tone')).toBe('danger');
    const offer = mountBanner(LEGACY);
    expect(text(offer)).toContain('Its 3 terminals close when it switches.');
    expect(strip(offer).attributes('data-tone')).toBe('info');
  });

  it('reads as switching once the switch is sent, and continues its tone across the gutter', () => {
    const switching = mountBanner({ phase: 'switching', required: { deadline: at(13, 40), countdown: true } });
    expect(text(switching)).toBe('Switching prod-1 to Damocles 3.9.0.');
    expect(strip(switching).attributes('data-tone')).toBe('info');
    const edge = (update: Partial<HostUpdate>): string[] => mountBanner(update, { edge: true }).get('[data-testid="connection-banner-edge"]').classes();
    expect(edge({ required: { deadline: at(16, 30), countdown: false } })).toEqual(expect.arrayContaining(BANNER_TONE.warning.split(' ')));
    expect(edge({ required: { deadline: at(13, 40), countdown: true } })).toEqual(expect.arrayContaining(BANNER_TONE.danger.split(' ')));
  });

  it('says it in Greek, hours and agents pluralized', () => {
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(text(mountBanner({ required: { deadline: at(16, 30), countdown: false } }))).toBe('Το prod-1 πρέπει να μεταβεί στο Damocles 3.9.0 έως τις 16:30, σε 3 ώρες. Τρέχουν ακόμη 2 agents.');
    expect(text(mountBanner({ runningAgents: 1, required: { deadline: at(14, 30), countdown: false } }))).toBe('Το prod-1 πρέπει να μεταβεί στο Damocles 3.9.0 έως τις 14:30, σε 1 ώρα. Τρέχει ακόμη 1 agent.');
    expect(text(mountBanner({ required: { deadline: at(14, 15), countdown: false } }))).toContain('έως τις 14:15, σε 45 λεπτά.');
    expect(text(mountBanner({ runningAgents: 1, ...LEGACY, required: { deadline: at(13, 42, 41), countdown: true } }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 σε 12:4113 λεπτά. Θα σταματήσει 1 agent. Τα 3 τερματικά του κλείνουν με τη μετάβαση.');
    expect(text(mountBanner({ required: { deadline: at(13, 30, 30), countdown: true } }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 σε 00:301 λεπτό. Θα σταματήσουν 2 agents.');
  });
});

describe('the bounded drain and the security floor on the strip', () => {
  const DRAIN = { source: 'compatible', phase: 'waiting', runningAgents: 0, terminalsSurvive: true, runningTerminals: 2 } as const;
  const FLOOR = { phase: 'appOutdated', outdated: 'floor', serverVersion: '3.9.0', targetVersion: '3.7.0', runningAgents: 0, terminalsSurvive: true } as const;

  it('names agents only while any runs, then the drain\'s end and the devices that reconnect', () => {
    expect(text(mountBanner({ ...DRAIN, runningAgents: 2, otherDevices: 1 }))).toBe('prod-1 switches to Damocles 3.9.0 when 2 agents finish.');
    const drain = mountBanner({ ...DRAIN, otherDevices: 1, drainEndsAt: at(14, 5) });
    expect(text(drain)).toBe('prod-1 switches to Damocles 3.9.0 at 14:05. 1 other device reconnects then.');
    expect(strip(drain).attributes('data-tone')).toBe('info');
    expect(buttons(drain)).toEqual(['Switch now']);
    expect(text(mountBanner({ ...DRAIN, otherDevices: 2, drainEndsAt: at(14, 5) }))).toBe('prod-1 switches to Damocles 3.9.0 at 14:05. 2 other devices reconnect then.');
  });

  it('tells an app below the host\'s minimum to update, as the outdated strip looks', () => {
    const off = mountBanner(FLOOR);
    expect(text(off)).toBe('prod-1 needs Damocles 3.9.0 or later. Update this app to use it.');
    expect(strip(off).attributes()).toMatchObject({ 'data-state': 'appOutdated', 'data-tone': 'warning' });
    expect(strip(off).find('.lucide-arrow-down-to-line-icon').exists()).toBe(true);
    expect(buttons(off)).toEqual([]);
    expect(buttons(mountBanner(FLOOR, { canCheckForUpdates: true }))).toEqual(['Check for updates']);
  });

  it('says both in Greek', () => {
    shellI18n.global.setLocaleMessage('el', el);
    shellI18n.global.locale.value = 'el';
    expect(text(mountBanner({ ...DRAIN, otherDevices: 1, drainEndsAt: at(14, 5) }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 στις 14:05. Τότε επανασυνδέεται 1 ακόμη συσκευή.');
    expect(text(mountBanner({ ...DRAIN, otherDevices: 2, drainEndsAt: at(14, 5) }))).toBe('Το prod-1 μεταβαίνει στο Damocles 3.9.0 στις 14:05. Τότε επανασυνδέονται 2 ακόμη συσκευές.');
    expect(text(mountBanner(FLOOR))).toBe('Το prod-1 χρειάζεται Damocles 3.9.0 ή νεότερο. Ενημερώστε αυτή την εφαρμογή για να το χρησιμοποιήσετε.');
  });
});
