<script setup lang="ts">
import { computed } from 'vue';
import { formatDuration } from '@/utils/stringUtils';
import type { GraphNodeStatus } from '@shared/types/graph';

const props = defineProps<{
  name: string;
  nodeType: 'start' | 'end' | 'node';
  status: GraphNodeStatus;
  durationMs?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isSelected: boolean;
  isLive: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', name: string): void;
}>();

const isTerminal = computed(() => props.nodeType === 'start' || props.nodeType === 'end');
const radius = computed(() => isTerminal.value ? props.width / 2 : 0);

const displayName = computed(() => {
  if (props.nodeType === 'start') return 'S';
  if (props.nodeType === 'end') return 'E';
  return props.name;
});

const statusColors = computed(() => {
  switch (props.status) {
    case 'running': return { fill: 'var(--primary)', fillOpacity: 0.1, stroke: 'var(--primary)', strokeOpacity: 0.6, dot: 'var(--primary)' };
    case 'completed': return { fill: 'var(--color-success)', fillOpacity: 0.1, stroke: 'var(--color-success)', strokeOpacity: 0.4, dot: 'var(--color-success)' };
    case 'error': return { fill: 'var(--color-error)', fillOpacity: 0.1, stroke: 'var(--color-error)', strokeOpacity: 0.4, dot: 'var(--color-error)' };
    case 'skipped': return { fill: 'var(--muted)', fillOpacity: 0.4, stroke: 'var(--border)', strokeOpacity: 0.5, dot: 'var(--muted-foreground)' };
    default: return { fill: 'var(--muted)', fillOpacity: 0.8, stroke: 'var(--border)', strokeOpacity: 1, dot: 'var(--muted-foreground)' };
  }
});

const isPulsing = computed(() => props.isLive && props.status === 'running');
</script>

<template>
  <g
    :transform="`translate(${x}, ${y})`"
    class="cursor-pointer"
    @click="emit('select', name)"
  >
    <!-- Terminal nodes (circles) -->
    <template v-if="isTerminal">
      <circle
        :r="radius"
        :fill="statusColors.fill"
        :fill-opacity="statusColors.fillOpacity"
        :stroke="statusColors.stroke"
        :stroke-opacity="statusColors.strokeOpacity"
        stroke-width="1.5"
      />
      <!-- Selection ring -->
      <circle
        v-if="isSelected"
        :r="radius + 3"
        fill="none"
        stroke="var(--primary)"
        stroke-width="2"
        stroke-opacity="0.8"
      />
      <text
        text-anchor="middle"
        dominant-baseline="central"
        fill="var(--foreground)"
        font-size="10"
        font-weight="600"
      >{{ displayName }}</text>
    </template>

    <!-- Regular nodes (rounded rects) -->
    <template v-else>
      <!-- Pulse glow ring for running+live -->
      <rect
        v-if="isPulsing"
        :x="-width / 2 - 4"
        :y="-height / 2 - 4"
        :width="width + 8"
        :height="height + 8"
        rx="12"
        fill="none"
        :stroke="statusColors.stroke"
        stroke-width="2"
        class="animate-graph-pulse"
      />

      <!-- Selection ring -->
      <rect
        v-if="isSelected"
        :x="-width / 2 - 3"
        :y="-height / 2 - 3"
        :width="width + 6"
        :height="height + 6"
        rx="11"
        fill="none"
        stroke="var(--primary)"
        stroke-width="2"
        stroke-opacity="0.8"
      />

      <!-- Main rect -->
      <rect
        :x="-width / 2"
        :y="-height / 2"
        :width="width"
        :height="height"
        rx="8"
        :fill="statusColors.fill"
        :fill-opacity="statusColors.fillOpacity"
        :stroke="statusColors.stroke"
        :stroke-opacity="statusColors.strokeOpacity"
        stroke-width="1.5"
      />

      <!-- Status dot -->
      <circle
        :cx="width / 2 - 8"
        :cy="-height / 2 + 8"
        r="3"
        :fill="statusColors.dot"
      />

      <!-- Node name -->
      <text
        text-anchor="middle"
        :dominant-baseline="durationMs !== undefined ? 'auto' : 'central'"
        :y="durationMs !== undefined ? -2 : 0"
        fill="var(--foreground)"
        font-size="10"
        font-weight="500"
      >{{ displayName }}</text>

      <!-- Duration -->
      <text
        v-if="durationMs !== undefined"
        text-anchor="middle"
        dominant-baseline="hanging"
        y="8"
        fill="var(--muted-foreground)"
        font-size="9"
        opacity="0.7"
      >{{ formatDuration(durationMs) }}</text>
    </template>
  </g>
</template>
