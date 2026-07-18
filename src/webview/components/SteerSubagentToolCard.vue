<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  IconPaperPlane,
  IconCheck,
  IconXCircle,
  IconBan,
  IconClock,
  IconInfo,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useSubagentStore } from '@/stores';
import { subagentTypeLabelKey } from '@/utils/subagentTypeLabel';

const { t } = useI18n();
const subagentStore = useSubagentStore();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const input = computed(() => props.toolCall.input as { agent_id?: string; message?: string });

const shortId = computed(() => String(input.value.agent_id ?? '').slice(0, 8));

const storeMatch = computed(() => {
  const agentId = input.value.agent_id;
  if (!agentId) return undefined;
  return Object.values(subagentStore.subagents).find((s) => s.sdkAgentId === agentId);
});

const metadataAgentType = computed(() =>
  typeof props.toolCall.metadata?.agentType === 'string' ? props.toolCall.metadata.agentType : undefined,
);

const metadataDescription = computed(() =>
  typeof props.toolCall.metadata?.description === 'string' ? props.toolCall.metadata.description : undefined,
);

const resolvedAgentType = computed(() => metadataAgentType.value ?? storeMatch.value?.agentType);

const resolvedDescription = computed(
  () => metadataDescription.value ?? storeMatch.value?.description ?? shortId.value,
);

const displayAgentType = computed(() => {
  const type = resolvedAgentType.value;
  if (!type) return null;
  const key = subagentTypeLabelKey(type);
  return key ? t(key) : type;
});

const steerStatus = computed(() =>
  typeof props.toolCall.metadata?.steerStatus === 'string' ? props.toolCall.metadata.steerStatus : undefined,
);

interface StatusView {
  label: string;
  icon: Component;
  colorClass: string;
}

const statusView = computed<StatusView | null>(() => {
  switch (steerStatus.value) {
    case 'steered':
      return { label: t('steerTool.delivered'), icon: IconCheck, colorClass: 'text-success' };
    case 'queued':
      return { label: t('steerTool.queued'), icon: IconClock, colorClass: 'text-primary' };
    case 'finished':
      return { label: t('steerTool.alreadyFinished'), icon: IconInfo, colorClass: 'text-foreground/70' };
    case 'failed':
      return { label: t('steerTool.failed'), icon: IconXCircle, colorClass: 'text-error' };
    case 'not-found':
      return { label: t('steerTool.notFound'), icon: IconBan, colorClass: 'text-error' };
    default:
      return null;
  }
});

// Spin only while the call is genuinely in flight — keying off `result === undefined` left abandoned/
// denied calls (which never produce a result) spinning forever, unlike sibling tool cards.
const isPending = computed(() => props.toolCall.status === 'pending' || props.toolCall.status === 'running');

const formattedDuration = computed(() => {
  const ms = props.toolCall.durationMs;
  if (ms === undefined) return null;
  const elapsed = Math.floor(ms / 1000);
  if (ms < 60000) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});
</script>

<template>
  <Card class="text-sm overflow-hidden border-border">
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-foreground/5 border-b border-border/50 space-y-0">
      <IconPaperPlane :size="18" class="text-primary shrink-0" />
      <span class="text-foreground font-medium truncate flex-1">{{ t('steerTool.title') }}</span>
      <Badge
        v-if="displayAgentType"
        variant="secondary"
        class="bg-primary/30 text-primary border-primary/30 gap-1 shrink-0"
      >
        <span>{{ displayAgentType }}</span>
      </Badge>
    </CardHeader>

    <CardContent class="px-3 py-2 space-y-2">
      <div class="flex items-baseline gap-1.5 text-xs">
        <span class="text-foreground/50 shrink-0">{{ t('steerTool.targetLabel') }}:</span>
        <span class="text-foreground/90 truncate">{{ resolvedDescription }}</span>
        <span class="text-foreground/40 shrink-0 font-mono">{{ shortId }}</span>
      </div>

      <div class="text-xs">
        <span class="text-foreground/50">{{ t('steerTool.messageLabel') }}:</span>
        <p class="text-foreground/90 italic line-clamp-3 mt-0.5">"{{ input.message }}"</p>
      </div>
    </CardContent>

    <div class="px-3 py-2 flex items-center justify-between border-t border-border/50 bg-foreground/5">
      <div class="flex items-center gap-1.5 text-xs leading-none">
        <template v-if="isPending">
          <LoadingSpinner :size="14" class="text-primary" />
        </template>
        <template v-else-if="statusView">
          <component :is="statusView.icon" :size="14" :class="statusView.colorClass" class="shrink-0" />
          <span :class="statusView.colorClass">{{ statusView.label }}</span>
        </template>
        <template v-else>
          <span class="text-foreground/70">{{ toolCall.result }}</span>
        </template>
      </div>

      <div v-if="formattedDuration" class="flex items-center gap-1 text-xs text-foreground/50 shrink-0">
        <IconClock :size="12" />
        <span>{{ formattedDuration }}</span>
      </div>
    </div>
  </Card>
</template>
