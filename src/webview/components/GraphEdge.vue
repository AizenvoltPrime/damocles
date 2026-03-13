<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  edgeType: 'static' | 'conditional';
  label?: string;
  animated: boolean;
  edgeId: string;
}>();

const pathD = computed(() => {
  const dx = props.toX - props.fromX;
  const cpOffset = Math.min(dx * 0.4, 40);
  return `M ${props.fromX} ${props.fromY} C ${props.fromX + cpOffset} ${props.fromY}, ${props.toX - cpOffset} ${props.toY}, ${props.toX} ${props.toY}`;
});

const midX = computed(() => (props.fromX + props.toX) / 2);
const midY = computed(() => (props.fromY + props.toY) / 2);

const markerId = computed(() => `arrowhead-${props.edgeId}`);
</script>

<template>
  <g>
    <!-- Arrowhead marker -->
    <defs>
      <marker
        :id="markerId"
        viewBox="0 0 10 7"
        refX="10"
        refY="3.5"
        markerWidth="8"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <polygon points="0 0, 10 3.5, 0 7" fill="var(--muted-foreground)" opacity="0.5" />
      </marker>
    </defs>

    <!-- Edge path -->
    <path
      :d="pathD"
      fill="none"
      stroke="var(--muted-foreground)"
      stroke-opacity="0.4"
      stroke-width="1.5"
      :stroke-dasharray="edgeType === 'conditional' ? '4 3' : undefined"
      :marker-end="`url(#${markerId})`"
    />

    <!-- Animated dots -->
    <template v-if="animated">
      <circle r="2" fill="var(--primary)" opacity="0.8">
        <animateMotion :dur="`${0.8}s`" repeatCount="indefinite" :path="pathD" />
      </circle>
      <circle r="2" fill="var(--primary)" opacity="0.5">
        <animateMotion :dur="`${0.8}s`" repeatCount="indefinite" :path="pathD" begin="0.4s" />
      </circle>
    </template>

    <!-- Label -->
    <text
      v-if="label"
      :x="midX"
      :y="midY - 8"
      text-anchor="middle"
      fill="var(--muted-foreground)"
      font-size="9"
      opacity="0.7"
    >{{ label }}</text>
  </g>
</template>
