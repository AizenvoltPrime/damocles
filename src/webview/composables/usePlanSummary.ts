import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { PLAN_VERSION_DETAIL_KEY } from '@shared/types/session';
import { usePermissionStore } from '@/stores/usePermissionStore';

/** The plan version core recorded with an `ExitPlanMode` call; undefined for a call recorded without one. */
export function recordedPlanVersion(metadata: Record<string, unknown> | undefined): number | undefined {
  const version = metadata?.[PLAN_VERSION_DETAIL_KEY];
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : undefined;
}

/**
 * A plan's "Version n" and "m steps" labels, for the plan card and the dock's plan banner. `version` is the
 * number core stamped on the call, never a count of the loaded messages, so a compaction or a paged history
 * cannot renumber a plan; a call without one shows no version.
 */
export function usePlanSummary(toolUseId: MaybeRefOrGetter<string | undefined>, version: MaybeRefOrGetter<number | undefined>): ComputedRef<string[]> {
  const { t } = useI18n();
  const { pendingPlanApproval } = storeToRefs(usePermissionStore());

  return computed(() => {
    const id = toValue(toolUseId);
    if (id === undefined) return [];
    const parts: string[] = [];
    const n = toValue(version);
    if (n !== undefined) parts.push(t('cards.planBanner.version', { n }));
    // Only the plan awaiting review is in memory; an older plan lives in the session's plan file.
    const pending = pendingPlanApproval.value;
    const steps = pending?.toolUseId === id ? (pending.planContent.match(/^\s*\d+\.\s/gm) ?? []).length : 0;
    if (steps > 0) parts.push(t('cards.planBanner.steps', { n: steps }, steps));
    return parts;
  });
}
