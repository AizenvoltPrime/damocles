<script setup lang="ts">
import { computed, useId } from 'vue';
import type { HostReconnect } from '@shared/host-connection';
import type { HostUpdate } from '@shared/host-update';
import { useHostConnection } from '@/composables/useHostConnection';
import type { ProjectConnection } from '../../preload/shell-channels';
import { updateBadge, type UpdateBadge } from '../host-label';

const props = defineProps<{
  connection: ProjectConnection;
  // the host's name and state, read out for the dot alone; without one the dot is decorative, beside text that says it
  label?: string | undefined;
  // the reconnect loop's phase, which the dot shows only once it outlasted the grace
  reconnect?: HostReconnect | undefined;
  // the latest measurement was slow: a warning ring around the connected center
  slow?: boolean | undefined;
  // a pending switch, which a pip on the dot's corner shows, cut out of the dot
  update?: HostUpdate | undefined;
}>();

const view = useHostConnection(() => ({ connected: props.connection === 'connected', reconnect: props.reconnect }));
const maskId = useId();

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

// One shape per badge state, so the state never rests on color alone.
type Pip = 'circle' | 'triangle' | 'square' | 'ring' | 'diamond';
const PIPS: Readonly<Record<UpdateBadge, Pip>> = { pending: 'circle', required: 'triangle', countdown: 'square', switching: 'ring', appOutdated: 'diamond' };
// Each pip's outline in the dot's viewBox, which the pip fills (the ring strokes inside it) and the dot's mask cuts out.
const OUTLINES: Readonly<Record<Pip, { readonly tag: 'circle' | 'path' | 'rect'; readonly attrs: Readonly<Record<string, string>> }>> = {
  circle: { tag: 'circle', attrs: { cx: '8.9', cy: '1.1', r: '2.3' } },
  ring: { tag: 'circle', attrs: { cx: '8.9', cy: '1.1', r: '2.4' } },
  triangle: { tag: 'path', attrs: { d: 'M8.9-1.7 11.8 3.2H6Z' } },
  square: { tag: 'rect', attrs: { x: '6.8', y: '-1', width: '4.2', height: '4.2', rx: '.6' } },
  diamond: { tag: 'path', attrs: { d: 'M8.9-1.7 11.9 1.3 8.9 4.3 5.9 1.3Z' } },
};
const FILLS: Readonly<Record<Exclude<Pip, 'ring'>, string>> = { circle: 'fill-(--d-info-fill)', triangle: 'fill-(--d-warning-fill)', square: 'fill-(--d-danger-fill)', diamond: 'fill-(--d-warning-fill)' };
const badge = computed(() => updateBadge(props.update));
const pip = computed(() => (badge.value === undefined ? undefined : PIPS[badge.value]));
</script>

<template>
  <!-- The pip sits outside the dot's own span, so it never takes the connecting shape's pulse. -->
  <span class="relative inline-flex size-2.5 shrink-0">
    <!-- An SVG per state, so the state never rests on color alone. -->
    <span
      :role="label === undefined ? undefined : 'img'"
      data-testid="host-status-dot"
      :data-connection="connection"
      :data-shape="shape"
      :data-update="badge"
      :aria-label="label"
      :aria-hidden="label === undefined ? 'true' : undefined"
      class="relative inline-flex size-2.5 shrink-0 transition-colors duration-200 ease-out"
      :class="{ 'd-pulsing': shape === 'connecting', 'text-(--d-faint)': shape === 'offline' }"
    >
      <!-- Back after it showed it was away: a green glow lights up once. -->
      <span
        v-if="view.kind.value === 'reconnected'"
        aria-hidden="true"
        data-testid="host-status-flash"
        class="d-flash-once pointer-events-none absolute -inset-0.5 rounded-full bg-(--d-success-fill)/40"
      />
      <Transition name="t-icon">
        <svg
          :key="shape"
          viewBox="0 0 10 10"
          aria-hidden="true"
          class="size-2.5 overflow-visible"
        >
          <!-- The pip's outline cut out of the dot with a margin, so whatever is behind the dot shows around the pip. The shape in
               its id keeps it apart from the leaving shape's mask while both are in the DOM. -->
          <mask
            v-if="pip"
            :id="`${maskId}-${shape}`"
            maskUnits="userSpaceOnUse"
            x="-1"
            y="-1"
            width="12"
            height="12"
          >
            <rect
              x="-1"
              y="-1"
              width="12"
              height="12"
              fill="white"
            />
            <component
              :is="OUTLINES[pip].tag"
              v-bind="OUTLINES[pip].attrs"
              :data-cut="pip"
              fill="black"
              stroke="black"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </mask>
          <g :mask="pip ? `url(#${maskId}-${shape})` : undefined">
            <circle
              v-if="shape === 'connected'"
              cx="5"
              cy="5"
              r="4"
              class="fill-(--d-success-fill)"
            />
            <template v-else-if="shape === 'slow'">
              <circle
                cx="5"
                cy="5"
                r="2.5"
                class="fill-(--d-success-fill)"
              />
              <circle
                cx="5"
                cy="5"
                r="4.2"
                fill="none"
                class="stroke-(--d-warning-fill)"
                stroke-width="1.5"
              />
            </template>
            <template v-else-if="shape === 'connecting'">
              <circle
                cx="5"
                cy="5"
                r="3.7"
                fill="none"
                class="stroke-(--d-warning-fill)"
                stroke-width="1.5"
              />
              <path
                d="M5 1.3a3.7 3.7 0 0 1 0 7.4z"
                class="fill-(--d-warning-fill)"
              />
            </template>
            <template v-else-if="shape === 'failed'">
              <circle
                cx="5"
                cy="5"
                r="4.4"
                class="fill-(--d-danger-fill)"
              />
              <path
                d="M3.3 3.3l3.4 3.4M6.7 3.3 3.3 6.7"
                class="stroke-(--d-on-danger)"
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
          </g>
        </svg>
      </Transition>
    </span>
    <Transition name="t-icon">
      <svg
        v-if="pip"
        :key="pip"
        viewBox="0 0 10 10"
        aria-hidden="true"
        data-testid="host-update-pip"
        :data-pip="pip"
        class="pointer-events-none absolute inset-0 size-2.5 overflow-visible"
      >
        <!-- its outer edge, 1.75 + 1.3 / 2, is the ring's outline -->
        <circle
          v-if="pip === 'ring'"
          cx="8.9"
          cy="1.1"
          r="1.75"
          fill="none"
          stroke-width="1.3"
          class="stroke-(--d-info-fill)"
        />
        <component
          :is="OUTLINES[pip].tag"
          v-else
          v-bind="OUTLINES[pip].attrs"
          :class="FILLS[pip]"
        />
      </svg>
    </Transition>
  </span>
</template>
