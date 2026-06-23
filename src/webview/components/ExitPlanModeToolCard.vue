<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import {
  IconClipboard,
  IconCheckCircle,
  IconXCircle,
  IconBan,
  IconCheck,
  IconPencil,
  IconMessageSquare,
  IconEye,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useVSCode } from '@/composables/useVSCode';

const { t } = useI18n();
const { postMessage } = useVSCode();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const permissionStore = usePermissionStore();

const approvedPlan = computed(() => permissionStore.getApprovedPlan(props.toolCall.id));
const approvalMode = computed(() => approvedPlan.value?.approvalMode ?? null);

const isPending = computed(() => props.toolCall.status === 'pending');
const isRunning = computed(() => props.toolCall.status === 'running');
const isAwaitingApproval = computed(() => props.toolCall.status === 'awaiting_approval');
const isCompleted = computed(() => props.toolCall.status === 'completed');
const isFailed = computed(() => props.toolCall.status === 'failed');
const isDenied = computed(() => props.toolCall.status === 'denied');
const isAbandoned = computed(() => props.toolCall.status === 'abandoned');

const statusIcon = computed(() => {
  if (isPending.value || isRunning.value || isAwaitingApproval.value) return null;
  if (isCompleted.value) return IconCheckCircle;
  if (isFailed.value || isDenied.value) return IconXCircle;
  if (isAbandoned.value) return IconBan;
  return null;
});

const statusClass = computed(() => {
  if (isRunning.value || isAwaitingApproval.value) return 'text-primary';
  if (isCompleted.value) return 'text-success';
  if (isFailed.value || isDenied.value) return 'text-error';
  if (isAbandoned.value) return 'text-muted-foreground';
  return 'text-muted-foreground';
});

const cardClass = computed(() => {
  if (isAwaitingApproval.value) return 'border-primary/50 bg-primary/5';
  if (isFailed.value || isDenied.value) return 'border-error/50';
  if (isAbandoned.value) return 'border-muted/50 opacity-60';
  if (isCompleted.value) return 'border-success/30';
  return 'border-border';
});

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
  return approvalMode.value === 'acceptEdits' ? IconCheck : IconPencil;
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
  <Card class="text-sm overflow-hidden" :class="[cardClass, isClickable && 'cursor-pointer hover:border-primary/70 transition-colors ring-1 ring-primary/30']" @click="handleCardClick">
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-primary/10 border-b border-border/50 space-y-0">
      <IconClipboard :size="18" class="text-primary shrink-0" />
      <span class="text-foreground font-medium flex-1">{{ headerText }}</span>

      <LoadingSpinner v-if="isPending || isRunning || isAwaitingApproval" :size="16" :class="statusClass" class="shrink-0" />
      <component v-else-if="statusIcon" :is="statusIcon" :size="16" :class="statusClass" class="shrink-0" />
    </CardHeader>

    <CardContent class="p-0">
      <!-- View plan button (when completed) — opens the full on-disk plan in the plan overlay -->
      <div v-if="isCompleted" class="px-3 py-2">
        <button
          type="button"
          class="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer"
          @click="handleViewPlan"
        >
          <IconEye :size="14" />
          <span>{{ t('exitPlanMode.viewPlan') }}</span>
        </button>
      </div>

      <!-- Approval mode indicator (when completed) -->
      <div v-if="isCompleted && approvalModeLabel" class="px-3 py-2 bg-success/10 border-t border-success/20">
        <div class="flex items-center gap-2 text-xs text-success">
          <component :is="approvalModeIcon" :size="12" />
          <span>{{ approvalModeLabel }}</span>
        </div>
      </div>

      <!-- Status messages -->
      <div v-if="isAwaitingApproval" class="px-3 py-2 bg-primary/10 border-t border-primary/20">
        <div class="flex items-center gap-2 text-xs text-primary">
          <span class="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span>{{ isClickable ? t('exitPlanMode.clickToReview') : t('exitPlanMode.waitingApproval') }}</span>
        </div>
      </div>

      <div v-else-if="isDenied" class="px-3 py-2 bg-error/10 border-t border-error/20">
        <div v-if="toolCall.feedback" class="space-y-1">
          <div class="flex items-center gap-2 text-xs text-error/80">
            <IconMessageSquare :size="12" />
            <span>{{ t('exitPlanMode.feedbackSent') }}</span>
          </div>
          <p class="text-xs text-foreground/80 pl-5 italic">"{{ toolCall.feedback }}"</p>
        </div>
        <div v-else class="flex items-center gap-2 text-xs text-error/80">
          <IconXCircle :size="12" />
          <span>{{ t('exitPlanMode.revisionRequested') }}</span>
        </div>
      </div>

      <div v-else-if="isAbandoned" class="px-3 py-2 bg-muted/30 border-t border-border/30">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <IconBan :size="12" />
          <span>{{ t('exitPlanMode.wasExited') }}</span>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
