// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ConnectStepEvent, HostCardInfo, LingerResult, NameCheck } from '../../preload/overlay-channels';
import HostCard from '../overlay/components/HostCard.vue';
import StepTimeline from '../overlay/components/StepTimeline.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver } from './fakes';

const mounted: VueWrapper[] = [];
const global = { plugins: [shellI18n] };

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const PROD: HostCardInfo = {
  hostId: 'h1',
  name: 'prod-1',
  destinationLabel: 'deploy@prod-1',
  connection: 'connected',
  signInNeeded: false,
  recentFolders: [],
  projectFolders: [],
  notices: [],
  allowBypass: false,
  passwordless: false,
  keyInstalledByDamocles: false,
  lingerEnabledByDamocles: false,
};

function mountCard(host: HostCardInfo, allow: () => Promise<LingerResult | undefined> = vi.fn(async () => ({ result: 'enabled' as const }))): VueWrapper {
  const wrapper = mount(HostCard, {
    props: {
      host,
      runs: [],
      checkName: vi.fn(async (name: string): Promise<NameCheck> => ({ ok: true, name })),
      rename: vi.fn(async (name: string): Promise<NameCheck> => ({ ok: true, name })),
      setInstallFolder: vi.fn(async () => ({ ok: true as const })),
      browse: vi.fn(async () => undefined),
      allowBackgroundWork: allow,
    },
    global,
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

describe('host card devices', () => {
  it('counts the other attached devices and names each, this one marked', () => {
    const wrapper = mountCard({ ...PROD, devices: [{ deviceName: 'ALEXIOS-PC', self: true }, { deviceName: 'ALEXIOS-PC', self: false }, { deviceName: 'ALEXIOS-PC', self: false }] });
    expect(wrapper.get('[data-testid="host-other-devices"]').text()).toBe('2 other devices are connected to prod-1');
    expect(wrapper.findAll('[data-testid="host-device"]').map((row) => row.text())).toEqual(['ALEXIOS-PC(this device)', 'ALEXIOS-PC', 'ALEXIOS-PC']);
    // the same name on every device: one person, so no advice
    expect(wrapper.find('[data-testid="host-account-advice"]').exists()).toBe(false);
  });

  it('uses the singular for one other device and advises one account per person when the names differ', () => {
    const wrapper = mountCard({ ...PROD, devices: [{ deviceName: 'ALEXIOS-PC', self: true }, { deviceName: 'MacBook Air', self: false }] });
    expect(wrapper.get('[data-testid="host-other-devices"]').text()).toBe('1 other device is connected to prod-1');
    expect(wrapper.get('[data-testid="host-account-advice"]').text()).toBe('People who share a server account share its chats, files and tokens. Give each person their own account on prod-1.');
  });

  it('says nothing about other devices while this is the only one', () => {
    const wrapper = mountCard({ ...PROD, devices: [{ deviceName: 'ALEXIOS-PC', self: true }] });
    expect(wrapper.find('[data-testid="host-other-devices"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="host-account-advice"]').exists()).toBe(false);
  });
});

describe('Allow background work', () => {
  const lingerHost: HostCardInfo = { ...PROD, notices: [{ code: 'noLinger', params: { user: 'deploy' } }] };
  const allowButton = (wrapper: VueWrapper) => wrapper.get('[data-testid="allow-background-work-button"]');

  it('offers the action under the no-linger notice and says when it worked', async () => {
    const allow = vi.fn(async (): Promise<LingerResult> => ({ result: 'enabled' }));
    const wrapper = mountCard(lingerHost, allow);
    await allowButton(wrapper).trigger('click');
    await flushPromises();
    expect(allow).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="allow-background-work"]').text()).toBe('Background work is allowed on prod-1.');
  });

  it('shows the admin command with the user the daemon named when polkit refuses', async () => {
    const wrapper = mountCard(lingerHost, vi.fn(async (): Promise<LingerResult> => ({ result: 'refused', user: 'svc-deploy' })));
    await allowButton(wrapper).trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="linger-command"]').text()).toBe('sudo loginctl enable-linger svc-deploy');
    expect(wrapper.find('[data-testid="allow-background-work-button"]').exists()).toBe(false);
  });

  it('quotes a domain user name in the admin command so a shell reads it as one word', async () => {
    for (const [user, word] of [['CORP\\ada', "'CORP\\ada'"], ['ada@corp.example.com', 'ada@corp.example.com'], ["o'neil smith", "'o'\\''neil smith'"]] as const) {
      const wrapper = mountCard(lingerHost, vi.fn(async (): Promise<LingerResult> => ({ result: 'refused', user })));
      await allowButton(wrapper).trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-testid="linger-command"]').text(), user).toBe(`sudo loginctl enable-linger ${word}`);
    }
  });

  it('says so when the host already allowed background work', async () => {
    const wrapper = mountCard(lingerHost, vi.fn(async (): Promise<LingerResult> => ({ result: 'alreadyEnabled' })));
    await allowButton(wrapper).trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="allow-background-work"]').text()).toBe('Background work was already allowed on prod-1.');
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      expect(shellI18n.global.te('remote.linger.alreadyEnabled'), locale).toBe(true);
    }
    shellI18n.global.locale.value = 'en';
  });

  it('says it failed and keeps the action when the daemon failed or the call rejected', async () => {
    const wrapper = mountCard(lingerHost, vi.fn(async (): Promise<LingerResult> => ({ result: 'failed', code: 'spawn' })));
    await allowButton(wrapper).trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Background work could not be allowed on prod-1. Show log has the details.');
    expect(wrapper.find('[data-testid="allow-background-work-button"]').exists()).toBe(true);
    const rejected = mountCard(lingerHost, vi.fn(async () => Promise.reject(new Error('gone'))));
    await allowButton(rejected).trigger('click');
    await flushPromises();
    expect(rejected.find('[role="alert"]').exists()).toBe(true);
  });

  it('is not offered while the host is not connected', () => {
    const wrapper = mountCard({ ...lingerHost, connection: 'offline' });
    expect(wrapper.find('[data-testid="allow-background-work"]').exists()).toBe(false);
  });
});

describe('connect timeline devices', () => {
  const connected: ConnectStepEvent = { attemptId: 'a1', hostId: 'h1', step: 'connected', visited: ['connecting', 'authenticating', 'checking', 'starting'], notices: [] };
  const mountTimeline = (event: ConnectStepEvent, otherDevices: number): VueWrapper => {
    const wrapper = mount(StepTimeline, { props: { event, hostName: 'prod-1', otherDevices, setInstallFolder: vi.fn(async () => ({ ok: true as const })) }, global, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
  };

  it('names the other devices once connected', () => {
    expect(mountTimeline(connected, 2).get('[data-testid="timeline-other-devices"]').text()).toBe('2 other devices are connected to prod-1');
    expect(mountTimeline(connected, 0).find('[data-testid="timeline-other-devices"]').exists()).toBe(false);
    expect(mountTimeline({ ...connected, step: 'starting' }, 2).find('[data-testid="timeline-other-devices"]').exists()).toBe(false);
  });

  it('has a Greek plural for both counts', () => {
    shellI18n.global.locale.value = 'el';
    expect(mountTimeline(connected, 1).get('[data-testid="timeline-other-devices"]').text()).toBe('1 ακόμη συσκευή είναι συνδεδεμένη στο prod-1');
    expect(mountTimeline(connected, 3).get('[data-testid="timeline-other-devices"]').text()).toBe('3 ακόμη συσκευές είναι συνδεδεμένες στο prod-1');
  });
});
