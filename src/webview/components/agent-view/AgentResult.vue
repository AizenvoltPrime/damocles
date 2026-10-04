<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamAgentStatus } from '@shared/types/team';
import MarkdownRenderer from '../MarkdownRenderer.vue';
import { agentStatusChip } from '@/composables/useTeamFormatting';

/** What an agent handed back (Chat Panel.dc.html `av.hasResult`), tinted by its status so a stopped or failed run never reads as a success. */
const props = defineProps<{
  content: string;
  status: TeamAgentStatus;
  /** Where the result went, shown after the status. */
  destination?: string;
}>();

const { t } = useI18n();
const chip = computed(() => agentStatusChip(props.status));
// The reference captions a completed result with its destination alone.
const caption = computed(() => [props.status === 'completed' ? null : t(chip.value.labelKey), props.destination].filter(Boolean).join(' · '));
</script>

<template>
  <div
    class="rounded-10 border border-[color-mix(in_srgb,var(--tone,currentColor)_30%,var(--d-border))] bg-(--d-card) px-3.5 pt-2.5 pb-3"
    :class="chip.color"
    data-testid="agent-result"
  >
    <div class="mb-1.5 flex items-center gap-1.75 text-xs font-semibold">
      <component
        :is="chip.icon"
        class="size-3.25"
        aria-hidden="true"
      />{{ t('subagentDisplay.result') }}
      <span
        v-if="caption"
        class="font-normal text-(--d-faint)"
      >{{ caption }}</span>
    </div>
    <MarkdownRenderer
      :content="content"
      class="text-13 leading-[1.6]"
    />
  </div>
</template>
