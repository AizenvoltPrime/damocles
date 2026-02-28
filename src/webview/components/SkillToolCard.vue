<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import {
  IconSparkles,
  IconCheckCircle,
  IconXCircle,
  IconBan,
  IconMessageSquare,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';

const { t } = useI18n();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const skillName = computed(() => {
  const input = props.toolCall.input;
  return typeof input?.skill === 'string' ? input.skill : 'Unknown skill';
});

const skillDescription = computed(() => {
  const metadata = props.toolCall.metadata;
  return typeof metadata?.skillDescription === 'string' ? metadata.skillDescription : undefined;
});

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
  if (isCompleted.value) return t('skillTool.executed', { name: skillName.value });
  if (isDenied.value) return t('skillTool.denied', { name: skillName.value });
  if (isAbandoned.value) return t('skillTool.skipped', { name: skillName.value });
  return t('skillTool.useSkill', { name: skillName.value });
});
</script>

<template>
  <Card class="text-sm overflow-hidden" :class="cardClass">
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-primary/10 border-b border-border/50 space-y-0">
      <IconSparkles :size="18" class="text-primary shrink-0" />
      <span class="text-foreground font-medium flex-1">{{ headerText }}</span>

      <LoadingSpinner v-if="isPending || isRunning || isAwaitingApproval" :size="16" :class="statusClass" class="shrink-0" />
      <component v-else-if="statusIcon" :is="statusIcon" :size="16" :class="statusClass" class="shrink-0" />
    </CardHeader>

    <CardContent class="p-0">
      <!-- Skill description -->
      <div v-if="skillDescription" class="px-3 py-2 text-xs text-muted-foreground">
        {{ skillDescription }}
      </div>

      <div v-if="isAwaitingApproval" class="px-3 py-2 bg-primary/10" :class="{ 'border-t border-primary/20': !skillDescription }">
        <div class="flex items-center gap-2 text-xs text-primary">
          <span class="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span>{{ t('skillTool.waitingApproval') }}</span>
        </div>
      </div>

      <div v-else-if="isCompleted" class="px-3 py-2 bg-success/10" :class="{ 'border-t border-success/20': !skillDescription }">
        <div class="flex items-center gap-2 text-xs text-success">
          <IconCheckCircle :size="12" />
          <span>{{ t('skillTool.executedSuccess') }}</span>
        </div>
      </div>

      <div v-else-if="isDenied" class="px-3 py-2 bg-error/10" :class="{ 'border-t border-error/20': !skillDescription }">
        <div v-if="toolCall.feedback" class="space-y-1">
          <div class="flex items-center gap-2 text-xs text-error/80">
            <IconMessageSquare :size="12" />
            <span>{{ t('skillTool.feedbackSent') }}</span>
          </div>
          <p class="text-xs text-foreground/80 pl-5 italic">"{{ toolCall.feedback }}"</p>
        </div>
        <div v-else class="flex items-center gap-2 text-xs text-error/80">
          <IconXCircle :size="12" />
          <span>{{ t('skillTool.userDenied') }}</span>
        </div>
      </div>

      <div v-else-if="isAbandoned" class="px-3 py-2 bg-muted/30" :class="{ 'border-t border-border/30': !skillDescription }">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <IconBan :size="12" />
          <span>{{ t('skillTool.requestSkipped') }}</span>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
