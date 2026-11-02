<script setup lang="ts">
import type { WslDistroInfo } from '../../preload/overlay-channels';

defineProps<{
  state: WslDistroInfo['state'];
  label: string;
}>();
</script>

<template>
  <!-- An SVG per state, so the state never rests on color alone: a disc runs, a ring is stopped, a dashed ring is a state
       wsl.exe named in words Damocles cannot read. -->
  <span
    role="img"
    data-testid="distro-state-dot"
    :data-state="state"
    :aria-label="label"
    class="relative inline-flex size-2.5 shrink-0 transition-colors duration-200 ease-out"
    :class="{
      'text-(--d-success)': state === 'running',
      'text-(--d-faint)': state === 'stopped',
      'text-(--d-faint-text)': state === 'other',
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
        <circle
          v-else-if="state === 'other'"
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
