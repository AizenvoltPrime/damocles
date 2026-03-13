<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import GraphNode from './GraphNode.vue';
import GraphEdge from './GraphEdge.vue';
import GraphStateInspector from './GraphStateInspector.vue';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { formatDuration } from '@/utils/stringUtils';
import type { GraphExecutionSnapshot, GraphNodeState } from '@shared/types/graph';

const { t } = useI18n();
const store = useContextInjectionStore();

const props = defineProps<{
  snapshot: GraphExecutionSnapshot;
  isLive: boolean;
}>();

const LAYOUT = {
  NODE_WIDTH: 120,
  NODE_HEIGHT: 48,
  TERMINAL_RADIUS: 12,
  NODE_GAP: 36,
  PADDING_X: 24,
  SVG_HEIGHT: 120,
} as const;

interface LayoutNode {
  name: string;
  type: 'start' | 'end' | 'node';
  x: number;
  y: number;
  width: number;
  height: number;
}

const layoutNodes = computed<LayoutNode[]>(() => {
  const nodes: LayoutNode[] = [];
  let cursor = LAYOUT.PADDING_X;
  const centerY = LAYOUT.SVG_HEIGHT / 2;

  for (const tNode of props.snapshot.topology.nodes) {
    const isTerminal = tNode.type === 'start' || tNode.type === 'end';
    const w = isTerminal ? LAYOUT.TERMINAL_RADIUS * 2 : LAYOUT.NODE_WIDTH;
    const h = isTerminal ? LAYOUT.TERMINAL_RADIUS * 2 : LAYOUT.NODE_HEIGHT;
    const x = cursor + w / 2;

    nodes.push({ name: tNode.name, type: tNode.type, x, y: centerY, width: w, height: h });
    cursor += w + LAYOUT.NODE_GAP;
  }

  return nodes;
});

const totalWidth = computed(() => {
  const last = layoutNodes.value[layoutNodes.value.length - 1];
  if (!last) return 200;
  return last.x + last.width / 2 + LAYOUT.PADDING_X;
});

const nodeStateMap = computed(() => {
  const map = new Map<string, GraphNodeState>();
  for (const ns of props.snapshot.nodeStates) {
    map.set(ns.name, ns);
  }
  return map;
});

function getNodeStatus(name: string): GraphNodeState['status'] {
  return nodeStateMap.value.get(name)?.status ?? 'pending';
}

function getNodeDuration(name: string): number | undefined {
  return nodeStateMap.value.get(name)?.durationMs;
}

interface LayoutEdge {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  edgeType: 'static' | 'conditional';
  label?: string;
  animated: boolean;
  edgeId: string;
}

const layoutEdges = computed<LayoutEdge[]>(() => {
  const edges: LayoutEdge[] = [];
  const nodeMap = new Map<string, LayoutNode>();
  for (const n of layoutNodes.value) {
    nodeMap.set(n.name, n);
  }

  for (const edge of props.snapshot.topology.edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) continue;

    const fromStatus = getNodeStatus(edge.from);
    const toStatus = getNodeStatus(edge.to);
    const animated = props.isLive && fromStatus === 'completed' && toStatus === 'running';

    edges.push({
      fromX: from.x + from.width / 2,
      fromY: from.y,
      toX: to.x - to.width / 2,
      toY: to.y,
      edgeType: edge.type,
      label: edge.label,
      animated,
      edgeId: `${edge.from}-${edge.to}`,
    });
  }

  return edges;
});

const selectedNodeState = computed<GraphNodeState | null>(() => {
  if (!store.selectedGraphNode) return null;
  return nodeStateMap.value.get(store.selectedGraphNode) ?? null;
});

const graphNodeCount = computed(() =>
  props.graphNodeCount,
);

</script>

<template>
  <div class="space-y-3">
    <!-- Summary badges -->
    <div class="flex items-center gap-1.5 flex-wrap">
      <Badge variant="secondary" class="text-[10px]">
        {{ t('contextInjection.graphNodeCount', { count: graphNodeCount }) }}
      </Badge>
      <Badge variant="secondary" class="text-[10px]">
        {{ formatDuration(snapshot.totalDurationMs) }}
      </Badge>
      <Badge
        v-if="isLive"
        variant="outline"
        class="text-[10px] border-primary/50 text-primary"
      >
        {{ t('contextInjection.graphLive') }}
      </Badge>
      <Badge
        v-else
        variant="outline"
        class="text-[10px] border-emerald-500/50 text-emerald-400"
      >
        {{ t('contextInjection.graphComplete') }}
      </Badge>
    </div>

    <!-- SVG graph -->
    <div class="rounded-xl border border-border bg-muted/40 p-3 overflow-x-auto">
      <svg
        :viewBox="`0 0 ${totalWidth} ${LAYOUT.SVG_HEIGHT}`"
        :width="totalWidth"
        :height="LAYOUT.SVG_HEIGHT"
        preserveAspectRatio="xMidYMid meet"
        class="w-full"
        style="min-width: 300px;"
      >
        <!-- Edges (rendered first, below nodes) -->
        <GraphEdge
          v-for="edge in layoutEdges"
          :key="edge.edgeId"
          v-bind="edge"
        />

        <!-- Nodes -->
        <GraphNode
          v-for="node in layoutNodes"
          :key="node.name"
          :name="node.name"
          :node-type="node.type"
          :status="getNodeStatus(node.name)"
          :duration-ms="getNodeDuration(node.name)"
          :x="node.x"
          :y="node.y"
          :width="node.width"
          :height="node.height"
          :is-selected="store.selectedGraphNode === node.name"
          :is-live="isLive"
          @select="store.selectGraphNode"
        />
      </svg>
    </div>

    <!-- State inspector -->
    <GraphStateInspector :node-state="selectedNodeState" />
  </div>
</template>
