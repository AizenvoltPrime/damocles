// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ChatMessage } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import type { TeamAgent, TeamState } from '@shared/types/team';
import type { EffortBadgeLevel } from '@shared/effort-badge';
import type { VirtualItem } from '@/composables/useVirtualizedMessages';
import EffortBadge from '../EffortBadge.vue';
import ThinkingIndicator from '../ThinkingIndicator.vue';
import VirtualItemWrapper from '../VirtualItemWrapper.vue';
import SubagentCard from '../SubagentCard.vue';
import SubagentOverlay from '../SubagentOverlay.vue';
import TeamAgentCard from '../TeamAgentCard.vue';
import TeamAgentOverlay from '../TeamAgentOverlay.vue';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { i18n } from '@/i18n';

vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: () => {}, onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const SubtitleShell = defineComponent({ template: '<div><div class="subtitle"><slot name="subtitle" /></div><slot /></div>' });
const PassThrough = defineComponent({ template: '<div><slot /></div>' });

/** Every rendered badge's accessible name, in document order. */
const badgeNames = (wrapper: VueWrapper): Array<string | undefined> =>
  wrapper.findAll('[data-testid="effort-badge"]').map((b) => b.attributes('aria-label'));

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  i18n.global.locale.value = 'en';
});

describe('EffortBadge', () => {
  it('shows the level and names itself "Effort: <level>"', () => {
    const wrapper = mount(EffortBadge, { props: { effort: 'high' }, global: { plugins: [i18n] } });
    expect(wrapper.text()).toBe('High');
    expect(badgeNames(wrapper)).toEqual(['Effort: High']);
    expect(wrapper.attributes('role')).toBe('note');
  });

  it('labels xhigh and minimal with their own names, and translates them', () => {
    expect(mount(EffortBadge, { props: { effort: 'xhigh' }, global: { plugins: [i18n] } }).text()).toBe('Extra High');
    expect(mount(EffortBadge, { props: { effort: 'minimal' }, global: { plugins: [i18n] } }).text()).toBe('Minimal');
    i18n.global.locale.value = 'el';
    const greek = mount(EffortBadge, { props: { effort: 'high' }, global: { plugins: [i18n] } });
    expect(greek.text()).toBe('Υψηλό');
    expect(badgeNames(greek)).toEqual(['Επίπεδο συλλογισμού: Υψηλό']);
  });
});

describe('the reply effort badge', () => {
  const message: ChatMessage = { id: 'a1', role: 'assistant', content: 'answer', thinking: 'pondering', thinkingDuration: 3, timestamp: 1 };
  const item = (type: VirtualItem['type'], effort?: EffortBadgeLevel): VirtualItem => ({
    id: `${type}-a1`, type, message, originalMessageIndex: 0, sourceMessageId: 'a1', spacingLevel: 1, text: 'answer',
    ...(effort ? { effort } : {}),
  });
  const row = (virtualItem: VirtualItem): VueWrapper => mount(VirtualItemWrapper, {
    props: { item: virtualItem, top: 0, isNew: false, canRewind: false, promptIndex: 0 },
    global: { plugins: [i18n], stubs: { MessageContent: true, MarkdownRenderer: true } },
  });

  it('renders in the thinking header, beside its trigger rather than inside it', () => {
    const wrapper = row(item('thinking-block', 'high'));
    expect(badgeNames(wrapper)).toEqual(['Effort: High']);
    expect(wrapper.find('button [data-testid="effort-badge"]').exists()).toBe(false);
  });

  it('renders before the text of a reply with no thinking block', () => {
    const wrapper = row(item('text-block', 'medium'));
    expect(badgeNames(wrapper)).toEqual(['Effort: Medium']);
    const html = wrapper.html();
    expect(html.indexOf('effort-badge')).toBeLessThan(html.indexOf('message-content-stub'));
  });

  it('renders nothing on a row the placement did not pick', () => {
    expect(badgeNames(row(item('text-block')))).toEqual([]);
    expect(badgeNames(mount(ThinkingIndicator, { props: { thinking: 'x', duration: 1 }, global: { plugins: [i18n], stubs: { MarkdownRenderer: true } } }))).toEqual([]);
  });
});

describe('the subagent effort badge', () => {
  const subagent = (over: Partial<SubagentState> = {}): SubagentState => ({
    id: 'sub-1', agentType: 'Explore', description: 'look', prompt: 'p', status: 'running', startTime: 0,
    messages: [], toolCalls: [], messagesSealed: false, model: 'Haiku 4.5', ...over,
  });
  const card = (state: SubagentState) => mount(SubagentCard, { props: { subagent: state }, global: { plugins: [i18n], stubs: { MarkdownRenderer: true } } });
  const overlay = (state: SubagentState) => {
    useSubagentStore().subagents = { [state.id]: state };
    return mount(SubagentOverlay, {
      props: { subagent: state },
      global: { plugins: [i18n], stubs: { OverlayShell: SubtitleShell, MarkdownRenderer: true, ThinkingIndicator: true, LoadingSpinner: true, ToolCallCard: true } },
    });
  };

  it('shows the run effort beside the model on the card and in the overlay header', () => {
    const state = subagent({ effort: 'medium' });
    const onCard = card(state);
    expect(badgeNames(onCard)).toEqual(['Effort: Medium']);
    expect(onCard.text()).toContain('Haiku 4.5');
    expect(badgeNames(overlay(state))).toEqual(['Effort: Medium']);
  });

  it('shows no badge for a run with no published effort', () => {
    expect(badgeNames(card(subagent()))).toEqual([]);
    expect(badgeNames(overlay(subagent()))).toEqual([]);
  });
});

describe('the team agent effort badge', () => {
  const agent = (over: Partial<TeamAgent> = {}): TeamAgent => ({
    agentId: 'agent-1', name: 'lead', role: 'lead', specialization: 'lead it', model: 'Opus 5', profileId: null, attempt: 0,
    status: 'running', activeMs: 0, runningSince: 1, toolCount: 2, lastToolName: null, totalInputTokens: 0, totalOutputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, dollarBilled: true, effort: null, progressSummary: null, result: null,
    logFilePath: null, ...over,
  });
  const seed = (member: TeamAgent): void => {
    const team: TeamState = {
      teamId: 'team-1', toolUseId: 'toolu_1', title: 'Team', status: 'running', phase: 'working', agents: [member],
      messages: [], scratchpad: [], result: null, startTime: 1, endTime: null, totalToolCount: 2, runs: [],
    };
    const store = useTeamStore();
    store.restoreTeamFromHistory(team);
    store.openOverlay('team-1');
    store.openAgentOverlay(member.agentId);
  };
  const card = (member: TeamAgent) => mount(TeamAgentCard, { props: { agent: member, index: 0 }, global: { plugins: [i18n] } });
  const overlay = () => mount(TeamAgentOverlay, {
    global: { plugins: [i18n], stubs: { OverlayShell: SubtitleShell, ScrollArea: PassThrough, Button: true, MarkdownRenderer: true, LoadingSpinner: true, ToolCallCard: true } },
  });

  it.each([
    ['lead', 'high', 'Effort: High'],
    ['specialist', 'medium', 'Effort: Medium'],
  ] as const)('shows the %s effort beside its model on the card and in the overlay header', (role, effort, name) => {
    const member = agent({ role, effort });
    seed(member);
    const onCard = card(member);
    expect(badgeNames(onCard)).toEqual([name]);
    expect(onCard.text()).toContain('Opus 5');
    const header = overlay().get('.subtitle');
    expect(badgeNames(header as unknown as VueWrapper)).toEqual([name]);
    expect(header.text()).toMatch(new RegExp(`${role} \\| Opus 5`));
  });

  it('shows no badge, and keeps the subtitle separator, for an agent with no effort', () => {
    const member = agent();
    seed(member);
    expect(badgeNames(card(member))).toEqual([]);
    const header = overlay().get('.subtitle');
    expect(header.find('[data-testid="effort-badge"]').exists()).toBe(false);
    expect(header.text()).toMatch(/lead \| Opus 5 \| 2 tools/);
  });
});
