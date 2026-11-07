<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleCheck, ExternalLink, Palette, PencilLine } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import type { StartDesignDetails } from '@shared/types/design';
import { Button } from '@/components/ui/button';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDesignStore } from '@/stores/useDesignStore';
import { useUIStore } from '@/stores/useUIStore';
import ToolCardFrame from '../ToolCardFrame.vue';
import ToolErrorStrip from '../ToolErrorStrip.vue';
import ToolBlockedReason from '../ToolBlockedReason.vue';
import { DESIGN_TILE } from './design-tone';

// The parent's StartDesign call: the design chat it opened, and where that design stands (designState's link).
const props = defineProps<{ toolCall: ToolCall }>();
const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const designStore = useDesignStore();
const uiStore = useUIStore();

const details = computed(() => {
  const value = props.toolCall.metadata as Partial<StartDesignDetails> | undefined;
  return props.toolCall.status === 'completed' && typeof value?.designId === 'string' ? (value as StartDesignDetails) : undefined;
});
const opening = computed(() => ['pending', 'running', 'awaiting_approval', 'approved'].includes(props.toolCall.status) || (props.toolCall.status === 'completed' && !details.value));
const failed = computed(() => ['failed', 'denied', 'blocked'].includes(props.toolCall.status));

const name = computed(() => {
  if (details.value) return t(details.value.reopened ? 'design.start.reopened' : 'design.start.opened');
  if (opening.value) return t('design.start.opening');
  if (failed.value) return t('design.start.failed');
  return t('design.tools.startDesign');
});
const arg = computed(() => {
  const input = props.toolCall.input['title'];
  return details.value?.title ?? (typeof input === 'string' ? input : undefined);
});

// Only the parent's current link says where the design stands; a card for a design the chat no longer links shows nothing.
const link = computed(() => (details.value && designStore.link?.designId === details.value.designId ? designStore.link : null));
const state = computed(() => {
  const current = link.value;
  if (!current) return undefined;
  if (current.status === 'finished' && current.version !== null) return { key: 'finished', text: t('design.start.finished', { version: current.version }) };
  if (current.version !== null) return { key: 'edited', text: t('design.header.edited', { version: current.version }) };
  return { key: 'draft', text: t('design.start.draft') };
});

function openDesignChat(): void {
  if (details.value) postMessage({ type: 'openDesignChat', designId: details.value.designId });
}
</script>

<template>
  <ToolCardFrame
    :icon="Palette"
    :name="name"
    :arg="arg"
    :status="toolCall.status"
    :tile-class="DESIGN_TILE"
    expandable
    :duration-ms="toolCall.durationMs"
    status-note
    :abandon-reason="toolCall.abandonReason"
    data-testid="start-design-card"
    :data-status="toolCall.status"
    @expand="uiStore.expandTool(toolCall.id, 'session')"
  >
    <template #trailing>
      <Button
        v-if="details"
        type="button"
        variant="ghost"
        class="d-press d-tone-design -me-1 h-6.5 flex-none gap-1.5 rounded-7 bg-(--tone)/12 px-2.5 text-xs font-semibold hover:bg-(--tone)/20 hover:text-(--d-design-text) focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-0 [&_svg]:size-3"
        data-testid="start-design-open"
        @click.stop="openDesignChat"
      >
        <ExternalLink aria-hidden="true" />{{ t('design.start.open') }}
      </Button>
    </template>
    <Transition
      name="t-swap-box"
      mode="out-in"
    >
      <p
        v-if="state"
        :key="state.key"
        class="flex items-center gap-2 border-t border-(--d-border) px-3 py-1.75 text-xs"
        :class="state.key === 'finished' ? 'text-(--d-success-text)' : 'text-(--d-muted)'"
        data-testid="start-design-status"
        :data-design-status="link?.status"
      >
        <CircleCheck
          v-if="state.key === 'finished'"
          class="size-3 flex-none"
          aria-hidden="true"
        />
        <PencilLine
          v-else
          class="size-3 flex-none text-(--d-design)"
          aria-hidden="true"
        />
        <span>{{ state.text }}</span>
      </p>
    </Transition>
    <ToolErrorStrip
      v-if="toolCall.status === 'failed' && toolCall.errorMessage"
      :message="toolCall.errorMessage"
    />
    <ToolBlockedReason
      v-else-if="toolCall.status === 'blocked' && toolCall.feedback"
      :reason="toolCall.feedback"
    />
    <div
      v-if="opening && toolCall.status !== 'awaiting_approval'"
      class="d-sweep-bar h-0.5 bg-(--d-hover) text-(--d-design)"
      aria-hidden="true"
    />
  </ToolCardFrame>
</template>
