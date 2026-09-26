// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { SubagentState } from '@shared/types/subagents';
import SubagentCard from '../SubagentCard.vue';
import { Badge } from '@/components/ui/badge';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { i18n } from '@/i18n';

/**
 * `agentType` is `input.subagent_type` off the Agent tool, so the model picks it. The card indexes an
 * icon table with it and the badge indexes a translation-key table with it, and both tables are plain
 * objects whose inherited members are truthy.
 */

const PROTOTYPE_KEYS = ['toString', 'constructor', 'valueOf', '__proto__'];

function subagent(agentType: string): SubagentState {
  return {
    id: 'sub-1',
    agentType,
    description: 'do the thing',
    prompt: 'go',
    status: 'running',
    startTime: 0,
    messages: [],
    toolCalls: [],
    messagesSealed: false,
  };
}

function card(agentType: string): VueWrapper {
  return mount(SubagentCard, {
    props: { subagent: subagent(agentType) },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
  });
}

function iconPaths(wrapper: VueWrapper): string[] {
  return wrapper.findAll('svg path').map((p) => p.attributes('d') ?? '');
}

beforeEach(() => setActivePinia(createPinia()));

describe('a subagent typed after an Object.prototype member', () => {
  it.each(PROTOTYPE_KEYS)('renders the card for %s instead of throwing', (agentType) => {
    expect(() => card(agentType)).not.toThrow();
  });

  it.each(PROTOTYPE_KEYS)('gives %s the same fallback icon an unknown agent type gets', (agentType) => {
    expect(iconPaths(card(agentType))).toEqual(iconPaths(card('something-invented')));
  });

  it.each(PROTOTYPE_KEYS)('shows %s as its own raw badge text rather than a translation key', (agentType) => {
    const text = card(agentType).text();

    expect(text).toContain(agentType);
    expect(text).not.toContain('subagentTypes.');
  });

  it('keeps a real agent type working, so the gate rejects only inherited members', () => {
    const wrapper = card('code-reviewer');

    expect(wrapper.text()).toContain('Code Reviewer');
    expect(iconPaths(wrapper)).not.toEqual(iconPaths(card('something-invented')));
  });
});

describe('a resume card', () => {
  const AGENT = '0a1b2c3d-4e5f-4a0';

  function resumeCard(over: Partial<SubagentState>): VueWrapper {
    const { agentType: _unset, ...rest } = subagent('Explore');
    return mount(SubagentCard, {
      props: { subagent: { ...rest, ...over } },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    });
  }

  it('shows the Resumed badge once the agent has named itself', () => {
    const text = resumeCard({ agentType: 'Explore', resume: { agentId: AGENT, loaded: true } }).text();

    expect(text).toContain('Resumed');
    expect(text).toContain('do the thing');
  });

  it('shows neither the Resumed badge nor a type badge while it only knows the agent id', () => {
    const wrapper = resumeCard({ resume: { agentId: AGENT, loaded: false } });

    expect(wrapper.text()).toContain('Resuming 0a1b2c3d');
    expect(wrapper.findAllComponents(Badge)).toHaveLength(0);
  });
});

describe('a subagent card’s usage', () => {
  const USAGE = { totalInputTokens: 12, totalOutputTokens: 340, cacheReadTokens: 4800, cacheCreationTokens: 1200, costUsd: 0.37 };

  function mountFromStore(id: string): VueWrapper {
    return mount(SubagentCard, {
      props: { subagent: useSubagentStore().subagents[id]! },
      global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    });
  }

  it('follows each live usage update, after the tools, duration and model', async () => {
    const store = useSubagentStore();
    store.registerAgentTool('sub-1', { subagent_type: 'Explore', description: 'find' });
    store.updateSubagentModel('sub-1', 'haiku');
    const wrapper = mountFromStore('sub-1');
    expect(wrapper.text()).not.toContain('tokens');

    store.updateSubagentUsage('sub-1', USAGE, false);
    await wrapper.setProps({ subagent: store.subagents['sub-1']! });

    const text = wrapper.text();
    expect(text).toContain('6.4K tokens');
    expect(text).toContain('79% cache');
    expect(text).toContain('~$0.37 est.');
    expect(text.indexOf('haiku')).toBeLessThan(text.indexOf('6.4K tokens'));
  });

  it('shows the same figures after a reload as it did live', () => {
    const store = useSubagentStore();
    store.registerAgentTool('sub-1', { subagent_type: 'Explore', description: 'find' });
    store.updateSubagentUsage('sub-1', USAGE, false);
    const live = mountFromStore('sub-1').find('.leading-none').text();

    setActivePinia(createPinia());
    useSubagentStore().restoreSubagentFromHistory({
      id: 'sub-1',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find' },
      agentUsage: USAGE,
      agentDollarBilled: false,
    });
    const restored = mountFromStore('sub-1').find('.leading-none').text();

    expect(restored).toContain('~$0.37 est.');
    expect(restored.replace(/\d+s/, '')).toBe(live.replace(/\d+s/, ''));
  });
});
