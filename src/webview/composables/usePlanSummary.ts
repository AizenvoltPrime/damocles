import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { TOOL_EXIT_PLAN_MODE } from '@shared/tool-names';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';

/** A plan's "Version n" and "m steps" labels, for the plan card and the dock's plan banner. */
export function usePlanSummary(toolUseId: MaybeRefOrGetter<string | undefined>): ComputedRef<string[]> {
  const { t } = useI18n();
  const { messages } = storeToRefs(useStreamingStore());
  const { pendingPlanApproval } = storeToRefs(usePermissionStore());

  return computed(() => {
    const id = toValue(toolUseId);
    if (id === undefined) return [];
    const parts: string[] = [];
    // Counts only loaded messages: the calls before a compaction never reach the webview.
    const planCallIds = messages.value.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.name === TOOL_EXIT_PLAN_MODE).map((c) => c.id));
    const index = planCallIds.indexOf(id);
    if (index !== -1) parts.push(t('cards.planBanner.version', { n: index + 1 }));
    // Only the plan awaiting review is in memory; an older plan lives in the session's plan file.
    const pending = pendingPlanApproval.value;
    const steps = pending?.toolUseId === id ? (pending.planContent.match(/^\s*\d+\.\s/gm) ?? []).length : 0;
    if (steps > 0) parts.push(t('cards.planBanner.steps', { n: steps }, steps));
    return parts;
  });
}
