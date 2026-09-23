// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import SteerSubagentToolCard from '../SteerSubagentToolCard.vue';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { i18n } from '@/i18n';

const AGENT = '0a1b2c3d-4e5f-4a00-8000-000000000000';

/** A steer call still in flight, so the card has no result metadata and reads the agent from the store. */
function pendingSteer(): VueWrapper {
  const toolCall: ToolCall = { id: 'steer-1', name: 'SteerSubagent', input: { agent_id: AGENT, message: 'focus' }, status: 'running' };
  return mount(SteerSubagentToolCard, { props: { toolCall }, global: { plugins: [i18n] } });
}

function restoreResumeCardWithoutFile(): void {
  useSubagentStore().restoreSubagentFromHistory({
    id: 'tc-r',
    name: 'Agent',
    input: { resume: AGENT },
    sdkAgentId: AGENT,
    agentResumedFrom: AGENT,
    agentStatus: 'interrupted',
  });
}

beforeEach(() => setActivePinia(createPinia()));

describe('the steer card target before the steer result arrives', () => {
  it('names the agent from a card that knows its details, not from a resume card that only knows its id', () => {
    restoreResumeCardWithoutFile();
    useSubagentStore().restoreSubagentFromHistory({
      id: 'tc1',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'dig in', prompt: 'p' },
      sdkAgentId: AGENT,
      agentStatus: 'interrupted',
    });

    const text = pendingSteer().text();

    expect(text).toContain('dig in');
    expect(text).toContain('Explorer');
  });

  it('names the target by its short id when no card knows the agent details', () => {
    restoreResumeCardWithoutFile();

    // Once as the target name and once as the id beside it; an empty name leaves only the id.
    expect(pendingSteer().text().split(AGENT.slice(0, 8))).toHaveLength(3);
  });
});
