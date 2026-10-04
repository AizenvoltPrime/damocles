<script setup lang="ts">
import type { Component } from 'vue';

/** One meta chip of an agent or team overlay (Chat Panel.dc.html `chipRow`): icon, value, optional unit word. */
withDefaults(defineProps<{
  icon?: Component | undefined;
  /** A vendored provider logo (provider-logos.ts) shown instead of `icon`. */
  logo?: string | undefined;
  value: string | number;
  unit?: string | undefined;
  iconClass?: string | undefined;
  valueClass?: string | undefined;
  mono?: boolean;
  title?: string | undefined;
  /** Renders a button that emits `click`. */
  clickable?: boolean;
}>(), { icon: undefined, logo: undefined, unit: undefined, iconClass: undefined, valueClass: undefined, mono: false, title: undefined, clickable: false });

const emit = defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <component
    :is="clickable ? 'button' : 'span'"
    :type="clickable ? 'button' : undefined"
    class="inline-flex h-6 flex-none items-center gap-1.5 whitespace-nowrap rounded-7 border border-(--d-border) bg-(--d-card) px-2.25 text-11.5 text-(--d-muted)"
    :class="clickable && 'transition-colors hover:border-(--d-border2)'"
    :title="title"
    data-testid="agent-chip"
    @click="clickable && emit('click')"
  >
    <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
    <span
      v-if="logo"
      class="size-3 flex-none [&>svg]:size-full"
      aria-hidden="true"
      v-html="logo"
    />
    <!-- eslint-enable vue/no-v-html -->
    <component
      :is="icon"
      v-else-if="icon"
      class="size-3 flex-none"
      :class="iconClass ?? 'text-(--d-faint)'"
      aria-hidden="true"
    />
    <span :class="[valueClass ?? 'text-(--d-text)', mono && 'font-mono']">{{ value }}</span>
    <!-- A flex container drops this space from layout; it keeps the value and unit two words for assistive tech. -->
    <template v-if="unit">
      {{ ' ' }}<span>{{ unit }}</span>
    </template>
  </component>
</template>
