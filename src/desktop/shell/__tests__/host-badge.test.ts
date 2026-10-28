// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { PROJECT_CONNECTIONS, type ProjectConnection, type ShellProject } from '../../preload/shell-channels';
import ProjectsSection from '../components/ProjectsSection.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, STATE, fakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

const loopback = (connection: ProjectConnection): ShellProject => ({
  key: 'loopback|c:\\work\\remote',
  name: 'remote',
  fsPath: 'C:\\work\\remote',
  trusted: true,
  authority: { kind: 'loopback', key: 'loopback', name: 'Local daemon' },
  platform: 'win32',
  connection,
  trash: false,
  running: 0,
  waiting: 0,
});

function mountWith(projects: readonly ShellProject[]): VueWrapper {
  const wrapper = mount(ProjectsSection, { props: { api: fakeShellApi(), projects, selectedKey: 'p1', remoteEnabled: false, hosts: [], view: 'flat', groups: STATE.projectGroups, platform: 'win32', collapsed: false, bodySize: 150 }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

describe('host badge', () => {
  it('shows no badge on a local project', () => {
    expect(mountWith(STATE.projects).find('[data-testid="host-badge"]').exists()).toBe(false);
  });

  it('names the host and gives each state its own glyph and words, pulsing only while connecting', () => {
    const glyphs = new Set<string>();
    const words: Record<ProjectConnection, string> = { connecting: 'Connecting', connected: 'Connected', failed: 'Couldn\'t connect', offline: 'Not connected' };
    for (const connection of PROJECT_CONNECTIONS) {
      const wrapper = mountWith([loopback(connection)]);
      const badge = wrapper.get('[data-testid="host-badge"]');
      expect(badge.text()).toBe('Local daemon');
      expect(badge.attributes('title')).toBe(`Local daemon, ${words[connection]}`);
      const dot = badge.get('[role="img"]');
      expect(dot.attributes('aria-label')).toBe(`Local daemon, ${words[connection]}`);
      expect(dot.attributes('data-connection')).toBe(connection);
      expect(dot.classes().includes('d-pulsing')).toBe(connection === 'connecting');
      glyphs.add(dot.get('svg').html());
      wrapper.unmount();
      mounted.splice(mounted.indexOf(wrapper), 1);
    }
    expect(glyphs.size).toBe(PROJECT_CONNECTIONS.length);
  });

  it('titles a remote row with its host and path', () => {
    expect(mountWith([loopback('connected')]).get('[role="option"]').attributes('title')).toBe('Local daemon: C:\\work\\remote');
  });

  it('swaps the glyph in place when the state changes', async () => {
    const wrapper = mountWith([loopback('connecting')]);
    await wrapper.setProps({ projects: [loopback('connected')] });
    const dot = wrapper.get('[data-testid="host-status-dot"]');
    expect(dot.attributes('data-connection')).toBe('connected');
    expect(dot.findAll('svg')).toHaveLength(1);
  });
});
