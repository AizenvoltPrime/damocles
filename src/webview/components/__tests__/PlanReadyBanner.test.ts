// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PlanReadyBanner from '../PlanReadyBanner.vue';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { TOOL_EXIT_PLAN_MODE } from '@shared/tool-names';
import { i18n } from '@/i18n';

/** The dock's plan banner reads the pending plan from the stores and opens the existing review overlay. */

const PLAN = '# Plan\n\n1. Add the route\n2. Write the tests\n3. Ship it\n';

function mountBanner() {
  return mount(PlanReadyBanner, { global: { plugins: [i18n] } });
}

beforeEach(() => setActivePinia(createPinia()));

describe('PlanReadyBanner', () => {
  it('renders nothing while no plan waits', () => {
    expect(mountBanner().find('[data-testid="plan-ready-banner"]').exists()).toBe(false);
  });

  it('names the plan version and counts its numbered steps', () => {
    useStreamingStore().messages = [
      { id: 'a1', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'p1', name: TOOL_EXIT_PLAN_MODE, input: {}, status: 'denied' }] },
      { id: 'a2', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'p2', name: TOOL_EXIT_PLAN_MODE, input: {}, status: 'awaiting_approval' }] },
    ];
    usePermissionStore().setPendingPlanApproval({ toolUseId: 'p2', planContent: PLAN });

    const banner = mountBanner();

    expect(banner.text()).toContain('Plan ready for review');
    expect(banner.text()).toContain('Version 2 · 3 steps · nothing has been changed yet');
  });

  it('opens the plan review overlay from Review plan', async () => {
    const permissionStore = usePermissionStore();
    permissionStore.setPendingPlanApproval({ toolUseId: 'p1', planContent: PLAN });
    permissionStore.hidePlanOverlay();

    await mountBanner().get('button').trigger('click');

    expect(permissionStore.isPlanOverlayVisible).toBe(true);
  });

  it('speaks Greek in a Greek panel', () => {
    usePermissionStore().setPendingPlanApproval({ toolUseId: 'p1', planContent: PLAN });
    i18n.global.locale.value = 'el';
    try {
      expect(mountBanner().text()).toContain('Έλεγχος σχεδίου');
    } finally {
      i18n.global.locale.value = 'en';
    }
  });
});
