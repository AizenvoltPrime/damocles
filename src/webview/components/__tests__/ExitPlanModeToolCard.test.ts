// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import { TOOL_EXIT_PLAN_MODE } from '@shared/tool-names';
import ExitPlanModeToolCard from '../ExitPlanModeToolCard.vue';
import PlanReadyBanner from '../PlanReadyBanner.vue';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { i18n } from '@/i18n';

const PLAN = '# Plan\n\n1. Add the route\n2. Write the tests\n3. Ship it\n';

function planCall(id: string, status: ToolCall['status']): ToolCall {
  return { id, name: TOOL_EXIT_PLAN_MODE, input: {}, status };
}

function card(status: ToolCall['status'], id = 'p1'): VueWrapper {
  return mount(ExitPlanModeToolCard, { props: { toolCall: planCall(id, status) }, global: { plugins: [i18n] } });
}

beforeEach(() => setActivePinia(createPinia()));

describe('the plan card status chip', () => {
  it.each<[ToolCall['status'], string]>([
    ['failed', 'Failed'],
    ['unrecorded', 'Outcome not recorded'],
    ['pending', 'Running'],
    ['running', 'Running'],
    ['approved', 'Approved'],
  ])('names a %s plan call for what it is rather than as awaiting review', (status, label) => {
    const chip = card(status).get('[data-testid="plan-card-status"]').text();

    expect(chip).toBe(label);
    expect(chip).not.toBe('Awaiting review');
  });

  it('says awaiting review only for the call that awaits it', () => {
    expect(card('awaiting_approval').get('[data-testid="plan-card-status"]').text()).toBe('Awaiting review');
  });
});

describe('the plan summary', () => {
  beforeEach(() => {
    useStreamingStore().messages = [
      { id: 'a1', role: 'assistant', content: '', timestamp: 1, toolCalls: [planCall('p1', 'denied')] },
      { id: 'a2', role: 'assistant', content: '', timestamp: 2, toolCalls: [planCall('p2', 'awaiting_approval')] },
    ];
    usePermissionStore().setPendingPlanApproval({ toolUseId: 'p2', planContent: PLAN });
  });

  it('numbers the pending plan the same on its card and in the dock banner', () => {
    const banner = mount(PlanReadyBanner, { global: { plugins: [i18n] } });

    expect(card('awaiting_approval', 'p2').text()).toContain('Plan · Version 2 · 3 steps');
    expect(banner.text()).toContain('Version 2 · 3 steps · nothing has been changed yet');
  });

  it('gives an older plan its version without the pending plan\'s step count', () => {
    const text = card('denied', 'p1').text();

    expect(text).toContain('Plan · Version 1');
    expect(text).not.toContain('steps');
  });
});
