<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { Ban, CheckCheck, ChevronRight, ClipboardList, Eye, MessageSquare, Pencil } from 'lucide-vue-next';
import { useToolCardStatus } from '@/composables/useToolCardStatus';
import { recordedPlanVersion, usePlanSummary } from '@/composables/usePlanSummary';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';

const { t } = useI18n();
const { postMessage } = usePlatformBridge();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const permissionStore = usePermissionStore();

const approvedPlan = computed(() => permissionStore.getApprovedPlan(props.toolCall.id));
const approvalMode = computed(() => approvedPlan.value?.approvalMode ?? null);

const isAwaitingApproval = computed(() => props.toolCall.status === 'awaiting_approval');
const isCompleted = computed(() => props.toolCall.status === 'completed');
const isDenied = computed(() => props.toolCall.status === 'denied');
const isAbandoned = computed(() => props.toolCall.status === 'abandoned');

const planSummary = usePlanSummary(() => props.toolCall.id, () => recordedPlanVersion(props.toolCall.metadata));
const subtitle = computed(() => [t('exitPlanMode.plan'), ...planSummary.value].join(' · '));

const { statusIcon, statusMotion, cardClass } = useToolCardStatus(() => props.toolCall.status);

// The reference's plan card rings in accent while it awaits review, where a tool row borders in warning.
const frameClass = computed(() => (isAwaitingApproval.value
  ? 'border-[color-mix(in_srgb,var(--d-accent)_45%,var(--d-border))] shadow-[0_0_0_3px_var(--d-accent-soft)]'
  : cardClass.value));

const SUCCESS_CHIP = 'bg-[color-mix(in_srgb,var(--d-success)_14%,transparent)] text-(--d-success-text)';
const WARNING_CHIP = 'bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] text-(--d-warning-text)';
const NEUTRAL_CHIP = 'bg-(--d-hover) text-(--d-muted)';

const CHIPS: Record<ToolCall['status'], { labelKey: string; class: string }> = {
  awaiting_approval: { labelKey: 'exitPlanMode.chipAwaiting', class: WARNING_CHIP },
  approved: { labelKey: 'exitPlanMode.chipApproved', class: SUCCESS_CHIP },
  completed: { labelKey: 'exitPlanMode.chipApproved', class: SUCCESS_CHIP },
  denied: { labelKey: 'exitPlanMode.chipRevising', class: WARNING_CHIP },
  abandoned: { labelKey: 'exitPlanMode.chipExited', class: NEUTRAL_CHIP },
  cancelled: { labelKey: 'cards.status.stopped', class: NEUTRAL_CHIP },
  failed: { labelKey: 'cards.status.failed', class: NEUTRAL_CHIP },
  unrecorded: { labelKey: 'toolCall.outcomeUnrecorded', class: NEUTRAL_CHIP },
  pending: { labelKey: 'cards.status.running', class: NEUTRAL_CHIP },
  running: { labelKey: 'cards.status.running', class: NEUTRAL_CHIP },
};

const chip = computed(() => CHIPS[props.toolCall.status]);

const headerText = computed(() => {
  if (isCompleted.value) return t('exitPlanMode.approved');
  if (isDenied.value) return t('exitPlanMode.revisionRequested');
  if (isAbandoned.value) return t('exitPlanMode.exited');
  return t('exitPlanMode.readyToCode');
});

const approvalModeLabel = computed(() => {
  if (!approvalMode.value) return null;
  return approvalMode.value === 'acceptEdits' ? t('exitPlanMode.autoAccept') : t('exitPlanMode.manualApproval');
});

const approvalModeIcon = computed(() => {
  if (!approvalMode.value) return null;
  return approvalMode.value === 'acceptEdits' ? CheckCheck : Pencil;
});

const isClickable = computed(() => isAwaitingApproval.value && permissionStore.pendingPlanApproval !== null);

function handleCardClick() {
  if (isClickable.value) {
    permissionStore.showPlanOverlay();
  }
}

function handleViewPlan() {
  postMessage({ type: 'openSessionPlan' });
}
</script>

<template>
  <div
    class="overflow-hidden rounded-xl border bg-(--d-card) transition-[border-color,box-shadow] duration-200"
    :class="[
      frameClass,
      isClickable && 'cursor-pointer hover:border-(--d-border2) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)',
    ]"
    :role="isClickable ? 'button' : undefined"
    :tabindex="isClickable ? 0 : undefined"
    :aria-label="isClickable ? t('cards.plan.review') : undefined"
    data-testid="plan-card"
    @click="handleCardClick"
    @keydown.enter.self="handleCardClick"
    @keydown.space.self.prevent="handleCardClick"
  >
    <div class="flex items-center gap-2.5 px-3 py-2.25">
      <span
        class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)"
        aria-hidden="true"
      >
        <ClipboardList class="size-3.5" />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-px">
        <div class="truncate text-13 font-semibold">
          {{ headerText }}
        </div>
        <div
          class="truncate text-11 text-(--d-faint)"
          data-testid="plan-card-subtitle"
        >
          {{ subtitle }}
        </div>
      </div>
      <span
        class="flex flex-none items-center gap-1.25 rounded-full px-2 py-0.5 text-11 font-medium"
        :class="chip.class"
        data-testid="plan-card-status"
      >
        <component
          :is="statusIcon"
          class="size-2.75"
          :class="statusMotion"
          aria-hidden="true"
        />
        {{ t(chip.labelKey) }}
      </span>
    </div>

    <div
      v-if="isAwaitingApproval"
      class="flex items-center gap-2 border-t border-(--d-border) py-1.75 pr-3 pl-12.5 text-xs text-(--d-accent)"
    >
      <span
        class="d-pulsing size-1.75 flex-none rounded-full bg-(--d-accent)"
        aria-hidden="true"
      />
      <span class="flex-1">{{ isClickable ? t('exitPlanMode.clickToReview') : t('exitPlanMode.waitingApproval') }}</span>
      <span
        v-if="isClickable"
        class="flex items-center gap-1 font-semibold"
        aria-hidden="true"
      >
        {{ t('exitPlanMode.review') }}
        <ChevronRight class="size-3" />
      </span>
    </div>

    <div
      v-else-if="isCompleted"
      class="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-(--d-border) py-1.75 pr-3 pl-12.5 text-xs"
    >
      <span
        v-if="approvalModeLabel"
        class="flex items-center gap-1.5 text-(--d-success)"
      >
        <component
          :is="approvalModeIcon"
          class="size-3"
          aria-hidden="true"
        />{{ approvalModeLabel }}
      </span>
      <span class="flex-1" />
      <button
        type="button"
        class="flex items-center gap-1.25 rounded-md text-(--d-accent) hover:underline focus-visible:outline-2 focus-visible:outline-(--d-accent)"
        @click.stop="handleViewPlan"
      >
        <Eye
          class="size-3"
          aria-hidden="true"
        />{{ t('exitPlanMode.viewPlan') }}
      </button>
    </div>

    <div
      v-else-if="isDenied"
      class="flex flex-col gap-0.75 border-t border-(--d-border) pt-1.75 pr-3 pb-2.25 pl-12.5 text-xs"
    >
      <span class="flex items-center gap-1.5 text-(--d-warning)">
        <MessageSquare
          class="size-3"
          aria-hidden="true"
        />{{ toolCall.feedback ? t('exitPlanMode.feedbackSent') : t('exitPlanMode.revisionRequested') }}
      </span>
      <span
        v-if="toolCall.feedback"
        class="text-pretty text-(--d-muted) italic"
      >“{{ toolCall.feedback }}”</span>
    </div>

    <div
      v-else-if="isAbandoned"
      class="flex items-center gap-1.5 border-t border-(--d-border) py-1.75 pr-3 pl-12.5 text-xs text-(--d-muted)"
    >
      <Ban
        class="size-3"
        aria-hidden="true"
      />{{ t('exitPlanMode.wasExited') }}
    </div>
  </div>
</template>
