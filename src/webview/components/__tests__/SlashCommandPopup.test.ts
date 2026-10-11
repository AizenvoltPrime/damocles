// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { SteerTargetInfo } from '@shared/types/subagents';
import SlashCommandPopup from '../SlashCommandPopup.vue';
import { i18n } from '@/i18n';
import { at } from '@/__tests__/helpers';

const MEMBER: SteerTargetInfo = {
  kind: 'team-member',
  id: 'abcdef12-0000-4000-8000-000000000001',
  teamId: 'team-1',
  teamTitle: 'Refactor',
  memberName: 'reviewer',
  role: 'specialist',
  status: 'standby',
};

const SUBAGENT: SteerTargetInfo = {
  kind: 'subagent',
  id: '12345678-0000-4000-8000-000000000002',
  agentType: 'Explore',
  description: 'find the callers',
  status: 'running',
  isBackground: false,
};

const mounted: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

function picker(agents: SteerTargetInfo[]): VueWrapper {
  const wrapper = mount(SlashCommandPopup, {
    props: {
      isOpen: true,
      listId: 'commands',
      commands: [],
      selectedIndex: 0,
      anchorElement: null,
      query: '',
      isLoading: false,
      mode: 'agent',
      agents,
    },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
  mounted.push(wrapper);
  return wrapper;
}

function rows(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[role="option"]').map((row) => row.text().replace(/\s+/g, ' ').trim());
}

describe('the /steer agent picker', () => {
  it('shows a team member with its role badge, team and name, and its status as text', () => {
    const row = at(rows(picker([MEMBER])), 0);

    expect(row).toContain('Specialist');
    expect(row).toContain('Refactor · reviewer');
    // Screen readers and keyboard users get no tooltip, so the status is in the row text itself.
    expect(row).toContain('abcdef12 · standby');
  });

  it('shows a subagent with its type badge and description and no member status', () => {
    const row = at(rows(picker([SUBAGENT])), 0);

    expect(row).toContain('Explorer');
    expect(row).toContain('find the callers');
    expect(row).not.toContain('·');
  });
});

describe('the slash command list', () => {
  it.each(['', 'onerror'])('renders a command name as text, never markup (query %j)', (query) => {
    const name = '<img src=x onerror=alert(1)>';
    const wrapper = mount(SlashCommandPopup, {
      props: {
        isOpen: true,
        listId: 'commands',
        commands: [{ name, description: 'd', filePath: 'f.md', source: 'project' }],
        selectedIndex: 0,
        anchorElement: null,
        query,
        isLoading: false,
        mode: 'command',
        agents: [],
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    mounted.push(wrapper);

    expect(wrapper.find('img').exists()).toBe(false);
    expect(at(rows(wrapper), 0)).toContain(`/${name}`);
    expect(wrapper.findAll('[role="option"] span.font-bold').map((match) => match.text())).toEqual(query ? [query] : []);
  });
});
