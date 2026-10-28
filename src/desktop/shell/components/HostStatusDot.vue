<script setup lang="ts">
import { computed } from 'vue';
import type { HostReconnect } from '@shared/host-connection';
import { useHostConnection } from '@/composables/useHostConnection';
import type { ProjectConnection } from '../../preload/shell-channels';

const props = defineProps<{
  connection: ProjectConnection;
  // the host's name and state, read out for the dot alone
  label: string;
  // the reconnect loop's phase, which the dot shows only once it outlasted the grace
  reconnect?: HostReconnect | undefined;
  // the latest measurement was slow: a warning ring around the connected center
  slow?: boolean | undefined;
}>();

const view = useHostConnection(() => ({ connected: props.connection === 'connected', reconnect: props.reconnect }));

type Shape = ProjectConnection | 'slow';
const shape = computed((): Shape => {
  const connected: Shape = props.slow ? 'slow' : 'connected';
  if (props.reconnect) {
    const shown = view.shown.value;
    // a drop shorter than the grace changes nothing
    if (!shown) return connected;
    return shown.phase === 'failed' ? 'failed' : 'connecting';
  }
  return props.connection === 'connected' ? connected : props.connection;
});
</script>

<template>
  <!-- An SVG per state, so the state never rests on color alone. -->
  <span
    role="img"
    data-testid="host-status-dot"
    :data-connection="connection"
    :data-shape="shape"
    :aria-label="label"
    class="relative inline-flex size-2.5 shrink-0 transition-colors duration-200 ease-out"
    :class="{
      'text-(--d-success)': shape === 'connected' || shape === 'slow',
      'd-pulsing text-(--d-warning)': shape === 'connecting',
      'text-(--d-danger)': shape === 'failed',
      'text-(--d-faint)': shape === 'offline',
    }"
  >
    <!-- Back after it showed it was away: a green glow lights up once. -->
    <span
      v-if="view.kind.value === 'reconnected'"
      aria-hidden="true"
      data-testid="host-status-flash"
      class="d-flash-once pointer-events-none absolute -inset-0.5 rounded-full bg-(--d-success)/40"
    />
    <Transition name="t-icon">
      <svg
        :key="shape"
        viewBox="0 0 10 10"
        aria-hidden="true"
        class="size-2.5 overflow-visible"
      >
        <circle
          v-if="shape === 'connected'"
          cx="5"
          cy="5"
          r="4"
          fill="currentColor"
        />
        <template v-else-if="shape === 'slow'">
          <circle
            cx="5"
            cy="5"
            r="2.5"
            fill="currentColor"
          />
          <circle
            cx="5"
            cy="5"
            r="4.2"
            fill="none"
            class="stroke-(--d-warning)"
            stroke-width="1.5"
          />
        </template>
        <template v-else-if="shape === 'connecting'">
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
        <template v-else-if="shape === 'failed'">
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
