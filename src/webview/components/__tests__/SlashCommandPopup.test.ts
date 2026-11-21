// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { SteerTargetInfo } from '@shared/types/subagents';
import type { AssetWithheld, CustomSlashCommandInfo, RootWithheld, WithheldRootInfo } from '@shared/types/commands';
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

  // The reason is in the option's own text, which is what a screen reader announces for it.
  it('shows each withheld row\'s reason in place of its description, disabling all but the one that asks for trust', () => {
    const row = (name: string, withheld: AssetWithheld): CustomSlashCommandInfo => ({ name, description: 'hidden', filePath: `${name}.md`, source: 'project', withheld });
    const wrapper = mount(SlashCommandPopup, {
      props: {
        isOpen: true,
        listId: 'commands',
        commands: [
          row('gs:', { reason: 'linkOutside' }),
          row('nas', { reason: 'share' }),
          row('gone', { reason: 'broken', target: '/clone/gone.md' }),
          row('bad', { reason: 'invalidFrontmatter', detail: 'bad indentation' }),
          row('skill:x', { reason: 'reservedNamespace' }),
          // a newer host's core may send a reason this webview has no text for
          row('moon', { reason: 'onTheMoon' } as unknown as AssetWithheld),
        ],
        selectedIndex: 0,
        anchorElement: null,
        query: '',
        isLoading: false,
        mode: 'command',
        agents: [],
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    mounted.push(wrapper);

    const options = wrapper.findAll('[role="option"]');
    expect(options.map((option) => [option.find('span.font-mono').text(), option.findAll('span').at(-1)?.text()])).toEqual([
      ['/gs:', 'trust this project to use it'],
      ['/nas', 'links to a network share or WSL path'],
      ['/gone', 'broken link to /clone/gone.md'],
      ['/bad', 'invalid frontmatter: bad indentation'],
      ['/skill:x', 'reserved namespace skill'],
      ['/moon', 'onTheMoon'],
    ]);
    expect(options.map((option) => option.attributes('aria-disabled') ?? null)).toEqual([null, 'true', 'true', 'true', 'true', 'true']);
  });

  it('shows a withheld commands or skills folder as one row naming its folder, its scope and the reason, disabled unless it asks for trust', () => {
    const root = (folder: string, assets: WithheldRootInfo['assets'], source: WithheldRootInfo['source'], withheld: RootWithheld, untrusted?: boolean): WithheldRootInfo =>
      ({ kind: 'withheldRoot', assets, folder, source, filePath: `/home/${folder}/${assets}`, withheld, ...(untrusted ? { untrusted } : {}) });
    const wrapper = mount(SlashCommandPopup, {
      props: {
        isOpen: true,
        listId: 'commands',
        commands: [
          root('.claude', 'commands', 'project', { reason: 'linkOutside' }, true),
          root('.claude', 'skills', 'user', { reason: 'share' }),
          root('.damocles', 'commands', 'user', { reason: 'broken', target: '/dotfiles/commands' }),
          // a newer host's core may send a kind of folder this webview has no text for
          root('.codex', 'agents' as WithheldRootInfo['assets'], 'user', { reason: 'unreachable' }),
        ],
        selectedIndex: 0,
        anchorElement: null,
        query: '',
        isLoading: false,
        mode: 'command',
        agents: [],
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    mounted.push(wrapper);

    const options = wrapper.findAll('[role="option"]');
    expect(options.map((option) => [option.find('[data-row-label]').text(), option.findAll('span').at(-1)?.text()])).toEqual([
      ['.claude commands, project', 'trust this project to use it'],
      ['.claude skills, user', 'links to a network share or WSL path'],
      ['.damocles commands, user', 'broken link to /dotfiles/commands'],
      ['.codex agents, user', 'links to a drive that did not answer'],
    ]);
    expect(options.map((option) => option.attributes('aria-disabled') ?? null)).toEqual([null, 'true', 'true', 'true']);
    expect(rows(wrapper)[0]).toContain('untrusted');
  });

  it('announces the reason of an unavailable row the user tried to pick in a polite live region', async () => {
    const wrapper = mount(SlashCommandPopup, {
      props: {
        isOpen: true,
        listId: 'commands',
        commands: [{ name: 'gone', description: 'hidden', filePath: 'gone.md', source: 'project', withheld: { reason: 'broken', target: '/clone/gone.md' } }],
        selectedIndex: 0,
        anchorElement: null,
        query: '',
        isLoading: false,
        mode: 'command',
        agents: [],
        inactiveReason: null,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    mounted.push(wrapper);
    const region = wrapper.find('[aria-live="polite"]');
    expect(region.exists()).toBe(true);
    expect(region.text()).toBe('');

    await wrapper.setProps({ inactiveReason: { reason: 'broken', target: '/clone/gone.md' } });

    expect(wrapper.find('[aria-live="polite"]').text()).toBe('broken link to /clone/gone.md');
  });
});
