<script setup lang="ts">
import type { Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { useToolCardStatus } from '@/composables/useToolCardStatus';

/**
 * The reference's tool card (Chat Panel.dc.html m.isTool): a 36px row with the tile, the name, a mono argument,
 * optional meta, the status icon and trailing controls, over the card's own body. An `expandable` card emits
 * `expand` on a click anywhere on it and on Enter or Space on the name, its keyboard target.
 */
const props = withDefaults(defineProps<{
  icon: Component;
  name: string;
  arg?: string | undefined;
  /** The argument's tooltip, such as the full path behind a folder-relative one; defaults to `arg`. */
  argTitle?: string | undefined;
  status: ToolCall['status'];
  expandable?: boolean;
}>(), { arg: undefined, argTitle: undefined, expandable: false });

const emit = defineEmits<{
  (e: 'expand'): void;
}>();

const { t } = useI18n();
const { statusIcon, statusClass, cardClass } = useToolCardStatus(() => props.status);

function handleCardClick(): void {
  if (props.expandable) emit('expand');
}

function handleNameKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  emit('expand');
}
</script>

<template>
  <div
    class="overflow-hidden rounded-11 border bg-(--d-card) text-13 transition-[border-color,opacity] duration-300"
    :class="cardClass"
    data-testid="tool-card-frame"
    @click="handleCardClick"
  >
    <div
      class="flex h-9 w-full min-w-0 items-center gap-2.5 pr-2.5 pl-2"
      :class="expandable && 'cursor-pointer transition-colors hover:bg-(--d-hover)'"
    >
      <span
        class="flex size-5.5 flex-none items-center justify-center rounded-md bg-(--d-accent-soft) text-(--d-accent)"
        aria-hidden="true"
      >
        <component
          :is="icon"
          class="size-3"
        />
      </span>
      <!-- The name, not the card, takes role="button": on the card it would hide the Stop button from assistive tech. -->
      <span
        v-if="expandable"
        role="button"
        tabindex="0"
        aria-haspopup="dialog"
        :aria-label="t('toolCall.expandDetails', { name })"
        class="max-w-[60%] flex-none truncate rounded-sm text-12.5 font-semibold focus-visible:outline-2 focus-visible:outline-(--d-accent)"
        @keydown="handleNameKeydown"
      >{{ name }}</span>
      <span
        v-else
        class="max-w-[60%] flex-none truncate text-12.5 font-semibold"
      >{{ name }}</span>
      <slot name="arg">
        <span
          class="min-w-0 flex-1 truncate font-mono text-11.5 text-(--d-muted)"
          :title="argTitle ?? arg"
        >{{ arg }}</span>
      </slot>
      <slot name="meta" />
      <span
        v-if="status === 'awaiting_approval'"
        class="flex flex-none items-center gap-1.25 rounded-full bg-[color-mix(in_srgb,var(--d-warning)_13%,transparent)] py-px pr-2 pl-1.5 text-11 font-medium text-(--d-warning-text)"
      >
        <span
          class="d-pulsing size-1.5 rounded-full bg-(--d-warning)"
          aria-hidden="true"
        />{{ t('toolCall.awaitingApproval') }}
      </span>
      <component
        :is="statusIcon"
        class="size-3.5 flex-none"
        :class="statusClass"
        aria-hidden="true"
      />
      <slot name="trailing" />
    </div>
    <slot />
  </div>
</template>
