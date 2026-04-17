<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { IconCompass } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCompassStore } from '@/stores/useCompassStore';
import { useVSCode } from '@/composables/useVSCode';
import type { CompassGraphNode, CompassGraphEdge, CompassCommunityInfo, CompassNodeKind, CompassEdgeKind } from '@shared/types/compass';

const store = useCompassStore();
const { postMessage } = useVSCode();

const containerRef = ref<HTMLElement | null>(null);
const nodeCountText = ref('');
const loading = ref(false);

interface SimNode extends CompassGraphNode {
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
}

interface SimLink {
	source: SimNode | string;
	target: SimNode | string;
	kind: CompassEdgeKind;
	source_qualified: string;
	target_qualified: string;
}

const NODE_RADIUS: Record<CompassNodeKind, number> = {
	File: 14,
	Class: 12,
	Function: 10,
	Test: 10,
	Type: 10,
};

const FALLBACK_COLORS = [
	'#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
	'#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
];

const EDGE_STYLE: Record<CompassEdgeKind, { color: string; dash: string }> = {
	CALLS: { color: '#a6e3a1', dash: '' },
	IMPORTS_FROM: { color: '#89b4fa', dash: '4,2' },
	INHERITS: { color: '#cba6f7', dash: '' },
	IMPLEMENTS: { color: '#f9e2af', dash: '2,2' },
	TESTED_BY: { color: '#f38ba8', dash: '6,3' },
	CONTAINS: { color: '#585b70', dash: '1,3' },
	DEPENDS_ON: { color: '#fab387', dash: '4,4' },
};

let d3Modules: {
	forceSimulation: typeof import('d3-force').forceSimulation;
	forceLink: typeof import('d3-force').forceLink;
	forceManyBody: typeof import('d3-force').forceManyBody;
	forceCenter: typeof import('d3-force').forceCenter;
	forceCollide: typeof import('d3-force').forceCollide;
	select: typeof import('d3-selection').select;
	zoom: typeof import('d3-zoom').zoom;
	zoomIdentity: typeof import('d3-zoom').zoomIdentity;
	drag: typeof import('d3-drag').drag;
} | null = null;

const simulation = shallowRef<ReturnType<typeof import('d3-force').forceSimulation> | null>(null);
const svgElement = shallowRef<SVGSVGElement | null>(null);
const currentZoomBehavior = shallowRef<ReturnType<typeof import('d3-zoom').zoom> | null>(null);
const currentNodes = shallowRef<SimNode[]>([]);

async function loadD3(): Promise<void> {
	if (d3Modules) return;
	const [force, selection, zoomMod, dragMod] = await Promise.all([
		import('d3-force'),
		import('d3-selection'),
		import('d3-zoom'),
		import('d3-drag'),
	]);
	d3Modules = {
		forceSimulation: force.forceSimulation,
		forceLink: force.forceLink,
		forceManyBody: force.forceManyBody,
		forceCenter: force.forceCenter,
		forceCollide: force.forceCollide,
		select: selection.select,
		zoom: zoomMod.zoom,
		zoomIdentity: zoomMod.zoomIdentity,
		drag: dragMod.drag,
	};
}

function communityColor(communityId: number | null): string {
	if (communityId == null) return '#cdd6f4';
	const communities = store.graphData?.communities ?? [];
	const idx = communities.findIndex(c => c.id === communityId);
	return idx >= 0 ? FALLBACK_COLORS[idx % FALLBACK_COLORS.length]! : FALLBACK_COLORS[communityId % FALLBACK_COLORS.length]!;
}

function buildBlastRadiusSet(): Set<string> {
	if (!store.blastRadius) return new Set();
	const set = new Set<string>();
	for (const n of store.blastRadius.changed_nodes) set.add(n.qualified_name);
	for (const n of store.blastRadius.impacted_nodes) set.add(n.qualified_name);
	return set;
}

function isBlastRadiusTarget(qn: string, brSet: Set<string>): boolean {
	return brSet.has(qn);
}

const changedSet = shallowRef(new Set<string>());
const brSet = shallowRef(new Set<string>());

function rebuildBlastSets(): void {
	brSet.value = buildBlastRadiusSet();
	const changed = new Set<string>();
	if (store.blastRadius) {
		for (const n of store.blastRadius.changed_nodes) changed.add(n.qualified_name);
	}
	changedSet.value = changed;
}

function nodeOpacity(qn: string): number {
	if (!store.hasBlastRadius) return 1;
	return isBlastRadiusTarget(qn, brSet.value) ? 1 : 0.15;
}

function nodeStroke(qn: string): string {
	if (!store.hasBlastRadius) return 'none';
	if (changedSet.value.has(qn)) return '#f38ba8';
	if (brSet.value.has(qn)) return '#fab387';
	return 'none';
}

function cleanupGraph(): void {
	simulation.value?.on('tick', null);
	simulation.value?.stop();
	simulation.value = null;
	if (svgElement.value && d3Modules) {
		d3Modules.select(svgElement.value).on('.zoom', null);
		d3Modules.select(svgElement.value).selectAll('circle').on('.drag', null).on('click', null);
	}
	svgElement.value = null;
	currentZoomBehavior.value = null;
	currentNodes.value = [];
	if (containerRef.value && d3Modules) {
		d3Modules.select(containerRef.value).selectAll('svg').remove();
	}
}

function buildGraph(): void {
	if (!d3Modules || !containerRef.value || !store.graphData) return;

	cleanupGraph();
	rebuildBlastSets();

	const { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, select, zoom, drag } = d3Modules;
	const { nodes: rawNodes, edges: rawEdges } = store.graphData;

	const el = containerRef.value;

	const width = el.clientWidth || 800;
	const height = el.clientHeight || 600;

	const svg = select(el)
		.append('svg')
		.attr('width', '100%')
		.attr('height', '100%')
		.attr('viewBox', `0 0 ${width} ${height}`);

	svgElement.value = svg.node()!;

	const container = svg.append('g');
	const linkGroup = container.append('g');
	const nodeGroup = container.append('g');
	const labelGroup = container.append('g');

	currentZoomBehavior.value = zoom<SVGSVGElement, unknown>()
		.scaleExtent([0.05, 8])
		.on('zoom', (event: { transform: { toString(): string } }) => {
			container.attr('transform', event.transform.toString());
		});
	svg.call(currentZoomBehavior.value);

	const simNodes: SimNode[] = rawNodes.map(n => ({ ...n }));
	currentNodes.value = simNodes;
	const nodeMap = new Map(simNodes.map(n => [n.qualified_name, n]));

	const simLinks: SimLink[] = [];
	for (const e of rawEdges) {
		const src = nodeMap.get(e.source_qualified);
		const tgt = nodeMap.get(e.target_qualified);
		if (src && tgt) {
			simLinks.push({
				source: src,
				target: tgt,
				kind: e.kind,
				source_qualified: e.source_qualified,
				target_qualified: e.target_qualified,
			});
		}
	}

	const linkSel = linkGroup
		.selectAll('line')
		.data(simLinks)
		.join('line')
		.attr('stroke', (d: SimLink) => EDGE_STYLE[d.kind]?.color ?? '#585b70')
		.attr('stroke-width', 1.5)
		.attr('stroke-opacity', 0.4)
		.attr('stroke-dasharray', (d: SimLink) => EDGE_STYLE[d.kind]?.dash ?? '');

	const nodeSel = nodeGroup
		.selectAll('circle')
		.data(simNodes)
		.join('circle')
		.attr('r', (d: SimNode) => NODE_RADIUS[d.kind] ?? 10)
		.attr('fill', (d: SimNode) => communityColor(d.community_id))
		.attr('stroke', (d: SimNode) => nodeStroke(d.qualified_name))
		.attr('stroke-width', 2)
		.attr('opacity', (d: SimNode) => nodeOpacity(d.qualified_name))
		.attr('cursor', 'pointer')
		.on('click', (_event: MouseEvent, d: SimNode) => {
			postMessage({ type: 'compassNavigateToNode', filePath: d.file_path, line: d.line_start });
		})
		.call(
			drag<SVGCircleElement, SimNode>()
				.on('start', (event: { active: boolean }, d: SimNode) => {
					if (!event.active) simulation.value?.alphaTarget(0.3).restart();
					d.fx = d.x;
					d.fy = d.y;
				})
				.on('drag', (event: { x: number; y: number }, d: SimNode) => {
					d.fx = event.x;
					d.fy = event.y;
				})
				.on('end', (event: { active: boolean }, d: SimNode) => {
					if (!event.active) simulation.value?.alphaTarget(0);
					d.fx = null;
					d.fy = null;
				}) as never,
		);

	nodeSel.append('title').text((d: SimNode) => `${d.kind}: ${d.name}\n${d.file_path}:${d.line_start}`);

	const labelSel = labelGroup
		.selectAll('text')
		.data(simNodes)
		.join('text')
		.text((d: SimNode) => d.name)
		.attr('font-size', 9)
		.attr('fill', '#cdd6f4')
		.attr('text-anchor', 'middle')
		.attr('dy', (d: SimNode) => (NODE_RADIUS[d.kind] ?? 10) + 13)
		.attr('pointer-events', 'none')
		.attr('opacity', (d: SimNode) => nodeOpacity(d.qualified_name));

	const updatePositions = () => {
		linkSel
			.attr('x1', (d: SimLink) => (d.source as SimNode).x ?? 0)
			.attr('y1', (d: SimLink) => (d.source as SimNode).y ?? 0)
			.attr('x2', (d: SimLink) => (d.target as SimNode).x ?? 0)
			.attr('y2', (d: SimLink) => (d.target as SimNode).y ?? 0);
		nodeSel.attr('cx', (d: SimNode) => d.x ?? 0).attr('cy', (d: SimNode) => d.y ?? 0);
		labelSel.attr('x', (d: SimNode) => d.x ?? 0).attr('y', (d: SimNode) => d.y ?? 0);
	};

	simulation.value = forceSimulation(simNodes as never[])
		.alphaDecay(0.02)
		.stop()
		.force('link', forceLink(simLinks as never[]).id((d: never) => (d as SimNode).qualified_name).distance(100))
		.force('charge', forceManyBody().strength(-200))
		.force('center', forceCenter(width / 2, height / 2))
		.force('collide', forceCollide().radius((d: never) => ((NODE_RADIUS as Record<string, number>)[(d as SimNode).kind] ?? 10) + 5));

	simulation.value.tick(300);
	updatePositions();
	handleFitToView();

	simulation.value.on('tick', updatePositions).restart();

	nodeCountText.value = `${simNodes.length} nodes, ${simLinks.length} edges`;
}

function requestGraph(): void {
	loading.value = true;
	store.requestGraph();
}

watch(() => store.graphData, () => {
	if (store.graphData) {
		loading.value = false;
		nextTick(buildGraph);
	}
});

watch(() => store.blastRadius, () => {
	if (store.graphData) nextTick(buildGraph);
});

watch(() => store.graphCommunityFilter, () => {
	requestGraph();
});

onMounted(async () => {
	await loadD3();
	if (store.graphData) {
		buildGraph();
	} else if (store.isReady && !store.graphLoading) {
		requestGraph();
	}
});

onUnmounted(() => {
	cleanupGraph();
});

function handleFitToView(): void {
	if (!d3Modules || !svgElement.value || !containerRef.value || !currentZoomBehavior.value || currentNodes.value.length === 0) return;
	const { select, zoomIdentity } = d3Modules;
	const svg = select(svgElement.value);
	const width = containerRef.value.clientWidth;
	const height = containerRef.value.clientHeight;

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const n of currentNodes.value) {
		const r = NODE_RADIUS[n.kind] ?? 10;
		if (n.x != null && n.y != null) {
			if (n.x - r < minX) minX = n.x - r;
			if (n.y - r < minY) minY = n.y - r;
			if (n.x + r > maxX) maxX = n.x + r;
			if (n.y + r > maxY) maxY = n.y + r;
		}
	}
	if (!isFinite(minX)) return;

	const padding = 40;
	const bw = maxX - minX + padding * 2;
	const bh = maxY - minY + padding * 2;
	const scale = Math.min(width / bw, height / bh, 2);
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;

	svg.transition().duration(500).call(
		currentZoomBehavior.value.transform as never,
		zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy),
	);
}
</script>

<template>
	<OverlayShell
		title="Knowledge Graph"
		:subtitle="nodeCountText || undefined"
		:icon="IconCompass"
		icon-class="text-emerald-400"
		@close="store.setActivePanel(null)"
	>
		<template #header-actions>
			<div class="flex items-center gap-1">
				<Select
					:model-value="store.graphCommunityFilter != null ? String(store.graphCommunityFilter) : 'all'"
					@update:model-value="(v) => store.graphCommunityFilter = v === 'all' ? null : Number(v)"
				>
					<SelectTrigger class="h-auto text-[10px] bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 border-0 gap-1 w-auto">
						<SelectValue placeholder="All communities" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All communities</SelectItem>
						<SelectItem
							v-for="c in (store.graphData?.communities ?? [])"
							:key="c.id"
							:value="String(c.id)"
						>
							{{ c.name }} ({{ c.size }})
						</SelectItem>
					</SelectContent>
				</Select>
				<button
					class="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
					@click="handleFitToView"
				>
					Fit
				</button>
				<button
					class="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
					@click="requestGraph"
				>
					Refresh
				</button>
			</div>
		</template>

		<div class="flex flex-col h-full">
			<div
				v-if="store.hasBlastRadius"
				class="px-3 py-1.5 bg-red-500/10 text-red-400 text-[10px] flex items-center justify-between border-b border-border shrink-0"
			>
				<span>Blast radius overlay active — {{ store.blastRadius?.total_impacted ?? 0 }} impacted nodes</span>
				<button
					class="text-[10px] underline cursor-pointer bg-transparent border-0 text-red-400"
					@click="store.dismissBlastRadius()"
				>
					Dismiss
				</button>
			</div>

			<div
				ref="containerRef"
				class="flex-1 relative"
			>
				<div
					v-if="loading || store.graphLoading"
					class="absolute inset-0 flex items-center justify-center bg-background/50"
				>
					<span v-if="store.buildProgress" class="text-xs text-muted-foreground">
						Building {{ store.buildProgress.current }} / {{ store.buildProgress.total }} files…
					</span>
					<span v-else class="text-xs text-muted-foreground">Loading graph…</span>
				</div>
			</div>
		</div>
	</OverlayShell>
</template>
