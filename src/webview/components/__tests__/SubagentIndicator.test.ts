// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import SubagentIndicator from '../SubagentIndicator.vue';
import AgentBadge from '../AgentBadge.vue';
import { i18n } from '@/i18n';
import type { SubagentState } from '@shared/types/subagents';

/**
 * `useSubagentStore` holds subagents in a plain `Record`, and `App.vue` binds that record straight
 * to this component. The prop used to be declared as a `Map`, so `props.subagents.size` read
 * `undefined`, the `v-if` never passed, and the indicator silently never rendered. Nothing threw,
 * so no test caught it. These mount against the record shape the store actually produces.
 */

const mounted: { unmount: () => void }[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

function makeSubagent(over: Partial<SubagentState> = {}): SubagentState {
  return {
    id: 'tool-1',
    agentType: 'general-purpose',
    description: 'Investigate the failing build',
    prompt: 'go',
    status: 'running',
    startTime: Date.now(),
    messages: [],
    toolCalls: [],
    messagesSealed: false,
    ...over,
  };
}

function mountIndicator(subagents: Record<string, SubagentState>) {
  const wrapper = mount(SubagentIndicator, {
    props: { subagents },
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe('SubagentIndicator', () => {
  it('renders nothing when the record is empty', () => {
    const wrapper = mountIndicator({});
    expect(wrapper.findComponent(AgentBadge).exists()).toBe(false);
    expect(wrapper.text()).toBe('');
  });

  it('renders one badge per entry of the store record', () => {
    const wrapper = mountIndicator({
      'tool-1': makeSubagent({ id: 'tool-1' }),
      'tool-2': makeSubagent({ id: 'tool-2', status: 'completed' }),
    });

    expect(wrapper.findAllComponents(AgentBadge)).toHaveLength(2);
  });

  it('labels the row as active while any subagent is still running', () => {
    const wrapper = mountIndicator({ 'tool-1': makeSubagent({ status: 'running' }) });
    expect(wrapper.text()).toContain(i18n.global.t('subagentIndicator.active'));
  });

  it('labels the row as recent once every subagent has finished', () => {
    const wrapper = mountIndicator({ 'tool-1': makeSubagent({ status: 'completed' }) });
    expect(wrapper.text()).toContain(i18n.global.t('subagentIndicator.recent'));
  });

  it('re-emits the subagent id from a badge click', async () => {
    const wrapper = mountIndicator({ 'tool-7': makeSubagent({ id: 'tool-7' }) });

    wrapper.findComponent(AgentBadge).vm.$emit('click', 'tool-7');
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('expand')).toEqual([['tool-7']]);
  });
});
