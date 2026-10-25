<script setup lang="ts">
import type { ProjectConnection } from '../../preload/shell-channels';

defineProps<{
  connection: ProjectConnection;
  // the host's name and state, read out for the dot alone
  label: string;
}>();
</script>

<template>
  <!-- An SVG per state, so the state never rests on color alone. -->
  <span
    role="img"
    data-testid="host-status-dot"
    :data-connection="connection"
    :aria-label="label"
    class="inline-flex size-2.5 shrink-0 transition-colors duration-200 ease-out"
    :class="{
      'text-(--d-success)': connection === 'connected',
      'd-pulsing text-(--d-warning)': connection === 'connecting',
      'text-(--d-danger)': connection === 'failed',
      'text-(--d-faint)': connection === 'offline',
    }"
  >
    <Transition name="t-icon">
      <svg
        :key="connection"
        viewBox="0 0 10 10"
        aria-hidden="true"
        class="size-2.5 overflow-visible"
      >
        <circle
          v-if="connection === 'connected'"
          cx="5"
          cy="5"
          r="4"
          fill="currentColor"
        />
        <template v-else-if="connection === 'connecting'">
          <circle
            cx="5"
            cy="5"
            r="3.7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M5 1.3a3.7 3.7 0 0 1 0 7.4z"
            fill="currentColor"
          />
        </template>
        <template v-else-if="connection === 'failed'">
          <circle
            cx="5"
            cy="5"
            r="4.4"
            fill="currentColor"
          />
          <path
            d="M3.3 3.3l3.4 3.4M6.7 3.3 3.3 6.7"
            class="stroke-(--d-card)"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </template>
        <circle
          v-else
          cx="5"
          cy="5"
          r="3.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        />
      </svg>
    </Transition>
  </span>
</template>
