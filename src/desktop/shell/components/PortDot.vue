<script setup lang="ts">
import type { PortDotShape } from './ports-section';

defineProps<{
  shape: PortDotShape;
  label: string;
}>();
</script>

<template>
  <!-- An SVG per state, so the state never rests on color alone. -->
  <span
    role="img"
    data-testid="port-dot"
    :data-shape="shape"
    :aria-label="label"
    :title="label"
    class="relative inline-flex size-2.5 shrink-0 transition-colors duration-200 ease-out"
    :class="{
      'text-(--d-success)': shape === 'live',
      'text-(--d-muted)': shape === 'idle',
      'text-(--d-faint)': shape === 'detected' || shape === 'ignored',
      'text-(--d-danger)': shape === 'error',
      'text-(--d-info)': shape === 'direct',
    }"
  >
    <!-- Live connections: a ring breathes out from the disc's edge (r 4 of 5, hence the 10% inset). -->
    <span
      v-if="shape === 'live'"
      aria-hidden="true"
      class="absolute inset-[10%]"
    >
      <span class="d-ring block size-full rounded-full [--ring-scale:2.6]" />
    </span>
    <Transition name="t-icon">
      <svg
        :key="shape"
        viewBox="0 0 10 10"
        aria-hidden="true"
        class="relative size-2.5 overflow-visible"
      >
        <circle
          v-if="shape === 'live'"
          cx="5"
          cy="5"
          r="4"
          fill="currentColor"
        />
        <template v-else-if="shape === 'idle'">
          <circle
            cx="5"
            cy="5"
            r="3.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <circle
            cx="5"
            cy="5"
            r="1.4"
            fill="currentColor"
          />
        </template>
        <rect
          v-else-if="shape === 'direct'"
          x="1.3"
          y="1.3"
          width="7.4"
          height="7.4"
          rx="1.8"
          fill="currentColor"
        />
        <circle
          v-else-if="shape === 'detected'"
          cx="5"
          cy="5"
          r="3.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-dasharray="2 1.6"
        />
        <template v-else-if="shape === 'ignored'">
          <circle
            cx="5"
            cy="5"
            r="3.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            d="M2.5 7.5 7.5 2.5"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </template>
        <template v-else>
          <path
            d="M5 .8 9.4 8.8H.6z"
            fill="currentColor"
            stroke-linejoin="round"
          />
          <path
            d="M5 3.9v2"
            class="stroke-(--d-on-danger)"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </template>
      </svg>
    </Transition>
  </span>
</template>
