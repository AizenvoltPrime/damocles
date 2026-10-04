<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { Ban, CircleCheck, CircleX, Clock, Info, Send } from 'lucide-vue-next';
import ToolCardFrame from './ToolCardFrame.vue';
import ToolCardNote from './ToolCardNote.vue';
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
  return agentId ? subagentStore.cardWithDetails(agentId) : undefined;
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
      return { label: t('steerTool.delivered'), icon: CircleCheck, colorClass: 'text-(--d-success)' };
    case 'queued':
      return { label: t('steerTool.queued'), icon: Clock, colorClass: 'text-(--d-accent)' };
    case 'finished':
      return { label: t('steerTool.alreadyFinished'), icon: Info, colorClass: 'text-(--d-muted)' };
    case 'failed':
      return { label: t('steerTool.failed'), icon: CircleX, colorClass: 'text-(--d-danger)' };
    case 'not-found':
      return { label: t('steerTool.notFound'), icon: Ban, colorClass: 'text-(--d-danger)' };
    default:
      return null;
  }
});

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
  <ToolCardFrame
    :icon="Send"
    :name="t('steerTool.title')"
    :arg="resolvedDescription"
    :status="toolCall.status"
    data-testid="steer-tool-card"
  >
    <template #meta>
      <span
        v-if="displayAgentType"
        class="flex-none rounded-5 bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] px-1.5 py-px text-10.5 font-semibold text-(--d-info-text)"
      >{{ displayAgentType }}</span>
      <span class="flex-none font-mono text-10.5 text-(--d-faint)">{{ shortId }}</span>
      <span
        v-if="formattedDuration"
        class="flex-none font-mono text-10.5 text-(--d-faint)"
      >{{ formattedDuration }}</span>
    </template>
    <div class="flex justify-end border-t border-(--d-border) px-3 py-2">
      <div class="max-w-[85%] rounded-[0.875rem_0.875rem_0.3125rem_0.875rem] border border-[color-mix(in_srgb,var(--d-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--d-warning)_7%,transparent)] px-3 pt-2 pb-2.25">
        <div class="mb-0.5 flex items-center gap-1.5 text-11 font-semibold text-(--d-warning-text)">
          <Send
            class="size-2.75"
            aria-hidden="true"
          />{{ t('steerTool.messageLabel') }}
        </div>
        <p class="line-clamp-3 text-12.5 whitespace-pre-wrap text-pretty">
          {{ input.message }}
        </p>
      </div>
    </div>
    <ToolCardNote
      v-if="statusView"
      :tone="statusView.colorClass"
      :icon="statusView.icon"
      :text="statusView.label"
    />
    <p
      v-else-if="toolCall.result && toolCall.status !== 'pending' && toolCall.status !== 'running'"
      class="border-t border-(--d-border) px-3 py-2 text-xs text-(--d-muted)"
    >
      {{ toolCall.result }}
    </p>
  </ToolCardFrame>
</template>
