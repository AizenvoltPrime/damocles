// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { SubagentState } from '@shared/types/subagents';
import SubagentCard from '../SubagentCard.vue';
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
