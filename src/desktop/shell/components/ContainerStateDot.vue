<script lang="ts">
// A container's state as docker last reported it: a saved record's (running, stopped, missing, unknown) or a listed one's
// (running, paused, restarting, other).
export type ContainerDotState = 'running' | 'stopped' | 'missing' | 'unknown' | 'paused' | 'restarting' | 'other';
</script>

<script setup lang="ts">
defineProps<{
  state: ContainerDotState;
  label: string;
}>();
</script>

<template>
  <!-- An SVG per state, so the state never rests on color alone: a disc runs, two bars pause, a half disc restarts, a ring is
       stopped, a crossed ring is gone and a dashed ring is a state Damocles cannot read. -->
  <span
    role="img"
    data-testid="container-state-dot"
    :data-state="state"
    :aria-label="label"
    class="relative inline-flex size-2.5 shrink-0 transition-colors duration-200 ease-out"
    :class="{
      'text-(--d-success)': state === 'running',
      'text-(--d-warning)': state === 'paused' || state === 'restarting',
      'text-(--d-faint)': state === 'stopped',
      'text-(--d-danger)': state === 'missing',
      'text-(--d-faint-text)': state === 'unknown' || state === 'other',
    }"
  >
    <Transition name="t-icon">
      <svg
        :key="state"
        viewBox="0 0 10 10"
        aria-hidden="true"
        class="size-2.5 overflow-visible"
      >
        <circle
          v-if="state === 'running'"
          cx="5"
          cy="5"
          r="4"
          fill="currentColor"
        />
        <path
          v-else-if="state === 'paused'"
          d="M3.4 1.6v6.8M6.6 1.6v6.8"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
        <template v-else-if="state === 'restarting'">
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
        <template v-else-if="state === 'missing'">
          <circle
            cx="5"
            cy="5"
            r="3.6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M3.4 3.4l3.2 3.2M6.6 3.4 3.4 6.6"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </template>
        <circle
          v-else-if="state === 'unknown' || state === 'other'"
          cx="5"
          cy="5"
          r="3.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-dasharray="2 1.6"
        />
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
