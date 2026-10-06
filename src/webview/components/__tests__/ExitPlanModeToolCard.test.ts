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

function planCall(id: string, status: ToolCall['status'], planVersion?: number): ToolCall {
  return { id, name: TOOL_EXIT_PLAN_MODE, input: {}, status, ...(planVersion !== undefined && { metadata: { planVersion } }) };
}

function card(status: ToolCall['status'], id = 'p1', planVersion?: number): VueWrapper {
  return mount(ExitPlanModeToolCard, { props: { toolCall: planCall(id, status, planVersion) }, global: { plugins: [i18n] } });
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
    // The loaded messages start after a compaction: counting them would call the pending plan Version 1.
    useStreamingStore().messages = [
      { id: 'a2', role: 'assistant', content: '', timestamp: 2, toolCalls: [planCall('p2', 'awaiting_approval', 3)] },
    ];
    usePermissionStore().setPendingPlanApproval({ toolUseId: 'p2', planContent: PLAN, planVersion: 3 });
  });

  it('shows the version core recorded, the same on the card and in the dock banner', () => {
    const banner = mount(PlanReadyBanner, { global: { plugins: [i18n] } });

    expect(card('awaiting_approval', 'p2', 3).text()).toContain('Plan · Version 3 · 3 steps');
    expect(banner.text()).toContain('Version 3 · 3 steps · nothing has been changed yet');
  });

  it('gives an older plan its recorded version without the pending plan\'s step count', () => {
    const text = card('denied', 'p1', 2).text();

    expect(text).toContain('Plan · Version 2');
    expect(text).not.toContain('steps');
  });

  it('shows no version for a call recorded without one, and keeps the pending plan\'s steps', () => {
    usePermissionStore().setPendingPlanApproval({ toolUseId: 'legacy', planContent: PLAN });

    expect(card('denied', 'old').get('[data-testid="plan-card-subtitle"]').text()).toBe('Plan');
    expect(card('awaiting_approval', 'legacy').text()).toContain('Plan · 3 steps');
    expect(mount(PlanReadyBanner, { global: { plugins: [i18n] } }).text()).toContain('3 steps · nothing has been changed yet');
    expect(mount(PlanReadyBanner, { global: { plugins: [i18n] } }).text()).not.toContain('Version');
  });

  it.each([Number.NaN, 0, -2, 1.5])('shows no version for a recorded %s, which core never stamps', (planVersion) => {
    expect(card('denied', 'edited', planVersion).get('[data-testid="plan-card-subtitle"]').text()).toBe('Plan');
  });
});
