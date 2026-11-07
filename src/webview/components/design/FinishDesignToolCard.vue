<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleSlash, Flag, MessageSquare, Send } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import {
  issueCount, parseDesignCheckSummary, parseFinishDesignUnapprovedDetails, type DesignCheckSummary, type FinishDesignDetails, type FinishDesignUnapprovedDetails,
} from '@shared/types/design';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useTKnown } from '@/composables/useTKnown';
import { useDesignStore } from '@/stores/useDesignStore';
import { useUIStore } from '@/stores/useUIStore';
import ToolCardFrame from '../ToolCardFrame.vue';
import ToolErrorStrip from '../ToolErrorStrip.vue';
import ToolBlockedReason from '../ToolBlockedReason.vue';
import DesignCheckReport from './DesignCheckReport.vue';
import DesignJourneyList from './DesignJourneyList.vue';
import { DESIGN_TILE } from './design-tone';

// The design chat's FinishDesign call: the version it stamped, where the result went and what travels with it, why it refused,
// or the user's answer that made no version.
const props = defineProps<{ toolCall: ToolCall }>();
const { t } = useI18n();
const { rt } = useLocalizedText();
const tKnown = useTKnown();
const uiStore = useUIStore();
const designStore = useDesignStore();

const unapproved = computed(() => parseFinishDesignUnapprovedDetails(props.toolCall.metadata));
const UNAPPROVED_KEYS: Record<FinishDesignUnapprovedDetails['approval'], { name: string; note: string }> = {
  changesRequested: { name: 'design.finish.changesRequested', note: 'design.finish.changesRequestedNote' },
  stopped: { name: 'design.finish.stopped', note: 'design.finish.stoppedNote' },
  cancelled: { name: 'design.finish.cancelled', note: 'design.finish.cancelledNote' },
};
// A design chat's prompt belongs to its one running FinishDesign call.
const awaitingApproval = computed(() => props.toolCall.status === 'running' && designStore.approvalPrompts.length > 0);
// The user's answer reads as a refusal of the version, never as the tool failing; a prompt closed unanswered reads as cancelled.
const frameStatus = computed<ToolCall['status']>(() => {
  if (awaitingApproval.value) return 'awaiting_approval';
  if (unapproved.value) return unapproved.value.approval === 'cancelled' ? 'cancelled' : 'denied';
  return props.toolCall.status;
});

const finished = computed(() => {
  const value = props.toolCall.metadata as Partial<FinishDesignDetails> | undefined;
  return props.toolCall.status === 'completed' && typeof value?.version === 'number' && Array.isArray(value.check?.warnings) && Array.isArray(value.journeys)
    ? (value as FinishDesignDetails)
    : undefined;
});
const warnings = computed<DesignCheckSummary | undefined>(() => (finished.value && finished.value.check.warnings.length > 0
  ? { errors: [], warnings: finished.value.check.warnings, attributesChecked: 0, tokensChecked: 0, skillHints: 0, widths: [] }
  : undefined));

const refusal = computed(() => (props.toolCall.status === 'failed' ? parseDesignCheckSummary(props.toolCall.metadata) : undefined));
const refusalErrors = computed(() => (refusal.value ? issueCount(refusal.value.errors) : 0));
// The width checks that could not run are the reason; with none, the check's errors are, which the report lists.
const refusalReason = computed(() => (refusal.value?.widthChecks ? rt(refusal.value.widthChecks.skipped) : undefined));
const showsReport = computed(() => refusal.value !== undefined && (refusalReason.value !== undefined || refusalErrors.value > 0));

const name = computed(() => {
  if (unapproved.value) return t(UNAPPROVED_KEYS[unapproved.value.approval].name);
  if (finished.value) return t(finished.value.reused ? 'design.finish.reused' : 'design.finish.finished', { version: finished.value.version });
  if (refusal.value) return t('design.finish.refused');
  return t('design.tools.finishDesign');
});
const arg = computed(() => (refusalErrors.value > 0 ? t('design.check.errors', { n: refusalErrors.value }, refusalErrors.value) : undefined));
const delivery = computed(() => (finished.value ? tKnown('design.finish.delivery', finished.value.delivery, finished.value.delivery) : ''));
</script>

<template>
  <ToolCardFrame
    :icon="Flag"
    :name="name"
    :arg="arg"
    :status="frameStatus"
    :tile-class="DESIGN_TILE"
    expandable
    :duration-ms="toolCall.durationMs"
    :status-note="!unapproved"
    :abandon-reason="toolCall.abandonReason"
    data-testid="finish-design-card"
    :data-delivery="finished?.delivery"
    :data-approval="unapproved?.approval ?? (awaitingApproval ? 'awaiting' : undefined)"
    @expand="uiStore.expandTool(toolCall.id, 'session')"
  >
    <div
      v-if="unapproved?.approval === 'changesRequested'"
      class="flex flex-col gap-1 border-t border-(--d-border) px-3 py-2 text-xs"
      data-testid="finish-design-unapproved"
    >
      <span class="flex items-center gap-1.5 font-medium text-(--d-design-text)">
        <MessageSquare
          class="size-3 flex-none"
          aria-hidden="true"
        />{{ t('design.finish.yourNote') }}
      </span>
      <q
        class="text-pretty wrap-anywhere whitespace-pre-line text-(--d-text) italic"
        data-testid="finish-design-note"
      >{{ unapproved.feedback }}</q>
      <span class="text-pretty text-(--d-muted)">{{ t(UNAPPROVED_KEYS.changesRequested.note) }}</span>
    </div>
    <p
      v-else-if="unapproved"
      class="flex items-start gap-2 border-t border-(--d-border) px-3 py-2 text-xs text-(--d-muted)"
      data-testid="finish-design-unapproved"
    >
      <CircleSlash
        class="mt-px size-3.25 flex-none text-(--d-faint)"
        aria-hidden="true"
      />
      <span class="text-pretty">{{ t(UNAPPROVED_KEYS[unapproved.approval].note) }}</span>
    </p>
    <template v-else-if="finished">
      <p
        class="flex items-center gap-2 border-t border-(--d-border) px-3 py-2 text-xs"
        :class="finished.delivery === 'no-parent' ? 'text-(--d-muted)' : 'text-(--d-design-text)'"
        data-testid="finish-design-delivery"
      >
        <Send
          class="size-3 flex-none"
          aria-hidden="true"
        />
        {{ delivery }}
      </p>
      <DesignCheckReport
        v-if="warnings"
        :summary="warnings"
        warnings-only
      />
      <div
        v-if="finished.journeys.length > 0"
        class="border-t border-(--d-border) px-3 py-2 text-xs"
      >
        <DesignJourneyList :journeys="finished.journeys" />
      </div>
    </template>
    <template v-else-if="refusal && showsReport">
      <p
        v-if="refusalReason !== undefined"
        class="flex items-start gap-2 border-t border-[color-mix(in_srgb,var(--d-danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2 text-xs text-(--d-danger-text)"
        data-testid="finish-design-refusal"
      >
        <CircleSlash
          class="mt-px size-3.25 flex-none"
          aria-hidden="true"
        />
        <span class="text-pretty">{{ refusalReason }}</span>
      </p>
      <DesignCheckReport
        :summary="refusal"
        refused
      />
    </template>
    <ToolErrorStrip
      v-else-if="toolCall.status === 'failed' && toolCall.errorMessage"
      :message="toolCall.errorMessage"
    />
    <ToolBlockedReason
      v-else-if="toolCall.status === 'blocked' && toolCall.feedback"
      :reason="toolCall.feedback"
    />
    <div
      v-if="toolCall.status === 'running' && !awaitingApproval"
      class="d-sweep-bar h-0.5 bg-(--d-hover) text-(--d-design)"
      aria-hidden="true"
    />
  </ToolCardFrame>
</template>
