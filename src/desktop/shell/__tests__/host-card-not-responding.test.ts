// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { HostCardInfo, HostRun, NameCheck } from '../../preload/overlay-channels';
import HostCard from '../overlay/components/HostCard.vue';
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
  kind: 'ssh',
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

const RUNS: HostRun[] = [
  { id: 'term-1', title: 'bash', state: 'running', canOpen: false, notResponding: true },
  { id: 'term-2', title: 'zsh', state: 'background', canOpen: false },
];

function mountCard(runs: readonly HostRun[]): VueWrapper {
  const wrapper = mount(HostCard, {
    props: {
      host: PROD,
      runs,
      checkName: vi.fn(async (name: string): Promise<NameCheck> => ({ ok: true, name })),
      rename: vi.fn(async (name: string): Promise<NameCheck> => ({ ok: true, name })),
      setInstallFolder: vi.fn(async () => ({ ok: true as const })),
      browse: vi.fn(async () => undefined),
      allowBackgroundWork: vi.fn(async () => ({ result: 'enabled' as const })),
    },
    global,
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

describe('host card rows of a terminal host that does not answer', () => {
  it('says not responding on its rows only, keeps Kill there, and offers End terminal host', async () => {
    const wrapper = mountCard(RUNS);
    const rows = wrapper.findAll('[data-testid="host-run"]');
    expect(rows.map((row) => row.attributes('data-state'))).toEqual(['notResponding', 'background']);
    expect(rows[0]!.get('[data-testid="host-run-state"]').text()).toBe('Not responding');
    expect(rows[1]!.get('[data-testid="host-run-state"]').text()).toBe('in the background');
    expect(rows[0]!.get('[data-testid="host-run-kill"]').attributes('aria-label')).toBe('Kill bash');
    const notice = wrapper.get('[data-testid="host-terminal-host-not-responding"]');
    expect(notice.text()).toContain('A terminal host on prod-1 is not responding. Its terminals take no input until it answers.');
    const end = notice.get('[data-testid="host-end-terminal-host"]');
    expect(end.text()).toBe('End terminal host');
    await end.trigger('click');
    expect(wrapper.emitted('endTerminalHost')).toEqual([[]]);
  });

  it('keeps the focus on End terminal host while main asks, then hands it to the card\'s heading once the notice goes', async () => {
    const wrapper = mountCard(RUNS);
    const end = wrapper.get('[data-testid="host-end-terminal-host"]');
    (end.element as HTMLElement).focus();
    await end.trigger('click');
    await wrapper.setProps({ endingTerminalHost: true });
    expect(end.attributes()).toMatchObject({ 'aria-disabled': 'true', 'aria-busy': 'true' });
    expect(end.attributes('disabled')).toBeUndefined();
    expect(document.activeElement).toBe(end.element);
    await end.trigger('click');
    expect(wrapper.emitted('endTerminalHost')).toEqual([[]]);
    await wrapper.setProps({ endingTerminalHost: false, runs: [RUNS[1]!] });
    expect(wrapper.find('[data-testid="host-terminal-host-not-responding"]').exists()).toBe(false);
    const heading = wrapper.get('h2');
    expect(heading.attributes('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading.element);
  });

  it('offers nothing while every terminal host answers', () => {
    const wrapper = mountCard([RUNS[1]!]);
    expect(wrapper.get('[data-testid="host-run"]').attributes('data-state')).toBe('background');
    expect(wrapper.find('[data-testid="host-terminal-host-not-responding"]').exists()).toBe(false);
  });

  it('reads in Greek', () => {
    shellI18n.global.locale.value = 'el';
    const wrapper = mountCard(RUNS);
    expect(wrapper.get('[data-testid="host-run-state"]').text()).toBe('Δεν αποκρίνεται');
    expect(wrapper.get('[data-testid="host-terminal-host-not-responding"]').text()).toContain('Μια υπηρεσία τερματικών στο prod-1 δεν αποκρίνεται. Τα τερματικά της δεν δέχονται είσοδο μέχρι να αποκριθεί.');
    expect(wrapper.get('[data-testid="host-end-terminal-host"]').text()).toBe('Τερματισμός υπηρεσίας τερματικών');
  });
});
