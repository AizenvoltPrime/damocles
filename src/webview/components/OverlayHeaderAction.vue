<script setup lang="ts">
import type { Component } from 'vue';
import { LoaderCircle } from 'lucide-vue-next';

const props = withDefaults(defineProps<{
  /** The visible label, and the accessible name and tooltip when the label is hidden. */
  label: string;
  icon: Component;
  primary?: boolean;
  /** Shows only the icon at every width; the label still names the button. */
  iconOnly?: boolean;
  /** Swaps the icon for a turning loader and marks the button busy. */
  busy?: boolean;
  disabled?: boolean;
  /** A longer tooltip than the label. */
  title?: string | undefined;
}>(), { primary: false, iconOnly: false, busy: false, disabled: false, title: undefined });

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void;
}>();
</script>

<template>
  <button
    type="button"
    class="d-press flex h-7.5 flex-none items-center gap-1.5 whitespace-nowrap rounded-9 border text-xs font-medium disabled:opacity-50"
    :class="[
      iconOnly ? 'w-7.5 justify-center px-0' : 'px-2.75 @max-[34.9375rem]/overlay:w-7.5 @max-[34.9375rem]/overlay:justify-center @max-[34.9375rem]/overlay:px-0',
      primary
        ? 'border-(--d-accent) bg-(--d-accent) text-(--d-on-accent) enabled:hover:brightness-[1.08]'
        : 'border-(--d-border2) bg-transparent text-(--d-text) enabled:hover:bg-(--d-hover)',
    ]"
    :aria-label="iconOnly ? label : undefined"
    :aria-busy="busy || undefined"
    :title="props.title ?? label"
    :disabled="disabled"
    @click="emit('click', $event)"
  >
    <LoaderCircle
      v-if="busy"
      class="size-3.25 d-spinning flex-none"
      aria-hidden="true"
    />
    <component
      :is="icon"
      v-else
      class="size-3.25 flex-none"
      aria-hidden="true"
    />
    <span
      v-if="!iconOnly"
      class="@max-[34.9375rem]/overlay:sr-only"
    >{{ label }}</span>
  </button>
</template>
