<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { IconCompass } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import CompassHelpDialog from './CompassHelpDialog.vue';
import CompassEdgeFilterPopover from './CompassEdgeFilterPopover.vue';
import { useCompassStore } from '@/stores/useCompassStore';
import { useVSCode } from '@/composables/useVSCode';
import { EDGE_STYLE, NODE_EQUIVALENT_RADIUS, nodePathGenerator } from '@/composables/compass/useGraphSymbols';
import type { Selection as D3Selection } from 'd3-selection';
import type { CompassGraphNode, CompassEdgeKind } from '@shared/types/compass';

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

/**
 * Curated community palette — kept as raw hex so colours are theme-stable
 * across VS Code light/dark themes. Each node receives a 1.5px outline
 * matching var(--background) so swatches separate against any background.
 *
 * Sampled WCAG contrast ratios vs VS Code Default Dark+ background (#1e1e1e):
 *   #4E79A7 (blue)   ≈ 3.7:1
 *   #F28E2B (orange) ≈ 7.1:1
 *   #E15759 (red)    ≈ 4.7:1
 *   #59A14F (green)  ≈ 5.0:1
 * All entries clear the 3:1 non-text minimum on dark themes; on light
 * themes the var(--background) outline supplies the separating edge.
 */
const FALLBACK_COLORS = [
	'#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
	'#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
];

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
const linkSel = shallowRef<D3Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
const focusedNodeQn = ref<string | null>(null);

type ArrowDirection = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
const DIRECTION_EPSILON = 1e-3;

function navigateToNode(node: SimNode): void {
	postMessage({ type: 'compassNavigateToNode', filePath: node.file_path, line: node.line_start });
}

function nodePathElementFor(qn: string): SVGPathElement | null {
	if (!svgElement.value) return null;
	return svgElement.value.querySelector<SVGPathElement>(`path.node-shape[data-qn="${CSS.escape(qn)}"]`);
}

function focusNodeByQn(qn: string): void {
	const el = nodePathElementFor(qn);
	if (el) {
		focusedNodeQn.value = qn;
		el.focus();
	}
}

function firstNodeQnInTabOrder(): string | null {
	if (currentNodes.value.length === 0) return null;
	const sorted = [...currentNodes.value].sort((a, b) => a.qualified_name.localeCompare(b.qualified_name));
	return sorted[0]?.qualified_name ?? null;
}

function findNearestInDirection(origin: SimNode, direction: ArrowDirection): SimNode | null {
	const ox = origin.x ?? 0;
	const oy = origin.y ?? 0;
	let best: SimNode | null = null;
	let bestDistSq = Infinity;

	for (const candidate of currentNodes.value) {
		if (candidate.qualified_name === origin.qualified_name) continue;
		const cx = candidate.x ?? 0;
		const cy = candidate.y ?? 0;
		const dx = cx - ox;
		const dy = cy - oy;
		const adx = Math.abs(dx);
		const ady = Math.abs(dy);

		const matches = (() => {
			if (direction === 'ArrowRight') return dx > DIRECTION_EPSILON && adx > ady;
			if (direction === 'ArrowLeft') return dx < -DIRECTION_EPSILON && adx > ady;
			if (direction === 'ArrowDown') return dy > DIRECTION_EPSILON && ady > adx;
			return dy < -DIRECTION_EPSILON && ady > adx;
		})();
		if (!matches) continue;

		const distSq = dx * dx + dy * dy;
		if (distSq < bestDistSq) {
			bestDistSq = distSq;
			best = candidate;
		}
	}
	return best;
}

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
	if (communityId == null) return 'var(--foreground)';
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
	if (!store.hasBlastRadius) return 'var(--background)';
	if (changedSet.value.has(qn)) return 'var(--color-error)';
	if (brSet.value.has(qn)) return 'var(--color-warning)';
	return 'var(--background)';
}

function nodeStrokeWidth(qn: string): number {
	if (!store.hasBlastRadius) return 1.5;
	if (changedSet.value.has(qn) || brSet.value.has(qn)) return 2;
	return 1.5;
}

function cleanupGraph(): void {
	simulation.value?.on('tick', null);
	simulation.value?.stop();
	simulation.value = null;
	if (svgElement.value && d3Modules) {
		d3Modules.select(svgElement.value).on('.zoom', null);
		d3Modules.select(svgElement.value).selectAll('path.node-shape').on('.drag', null).on('click', null).on('focus', null);
		svgElement.value.removeEventListener('focusin', handleSvgFocusIn);
		svgElement.value.removeEventListener('keydown', handleSvgKeyDown, true);
	}
	svgElement.value = null;
	currentZoomBehavior.value = null;
	currentNodes.value = [];
	linkSel.value = null;
	focusedNodeQn.value = null;
	if (containerRef.value && d3Modules) {
		d3Modules.select(containerRef.value).selectAll('svg').remove();
	}
}

function handleSvgFocusIn(event: FocusEvent): void {
	if (event.target !== svgElement.value) return;
	const related = event.relatedTarget;
	if (related instanceof Node && svgElement.value?.contains(related)) {
		svgElement.value.blur();
		return;
	}
	const firstQn = firstNodeQnInTabOrder();
	if (firstQn) focusNodeByQn(firstQn);
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function handleSvgKeyDown(event: KeyboardEvent): void {
	if (isEditableTarget(event.target)) return;

	if (event.key === '?') {
		event.preventDefault();
		event.stopPropagation();
		store.setHelpOpen(true);
		return;
	}

	const lowerKey = event.key.toLowerCase();

	if (lowerKey === 'f') {
		event.preventDefault();
		event.stopPropagation();
		handleFitToView();
		return;
	}

	if (lowerKey === 'r') {
		event.preventDefault();
		event.stopPropagation();
		if (!store.graphLoading) requestGraph();
		return;
	}

	const active = document.activeElement;
	if (!(active instanceof SVGPathElement) || !active.classList.contains('node-shape')) return;
	const qn = active.getAttribute('data-qn');
	if (!qn) return;
	const node = currentNodes.value.find(n => n.qualified_name === qn);
	if (!node) return;

	if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
		event.preventDefault();
		event.stopPropagation();
		const target = findNearestInDirection(node, event.key);
		if (target) focusNodeByQn(target.qualified_name);
		return;
	}

	if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
		event.preventDefault();
		event.stopPropagation();
		navigateToNode(node);
		return;
	}

	if (event.key === 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		focusedNodeQn.value = null;
		active.blur();
		containerRef.value?.focus();
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
		.attr('viewBox', `0 0 ${width} ${height}`)
		.attr('tabindex', 0);

	svgElement.value = svg.node()!;
	svgElement.value.addEventListener('focusin', handleSvgFocusIn);
	svgElement.value.addEventListener('keydown', handleSvgKeyDown, true);

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

	linkSel.value = linkGroup
		.selectAll<SVGLineElement, SimLink>('line')
		.data(simLinks)
		.join('line')
		.attr('stroke', (d: SimLink) => EDGE_STYLE[d.kind]?.stroke ?? 'color-mix(in srgb, var(--muted-foreground) 40%, transparent)')
		.attr('stroke-width', 1.5)
		.attr('stroke-opacity', (d: SimLink) => EDGE_STYLE[d.kind]?.opacity ?? 0.6)
		.attr('stroke-dasharray', (d: SimLink) => EDGE_STYLE[d.kind]?.dash ?? '')
		.attr('display', (d: SimLink) => store.visibleEdgeKinds.has(d.kind) ? null : 'none');

	const nodeSel = nodeGroup
		.selectAll<SVGPathElement, SimNode>('path.node-shape')
		.data(simNodes)
		.join('path')
		.attr('class', 'node-shape')
		.attr('d', (d: SimNode) => nodePathGenerator(d.kind))
		.attr('fill', (d: SimNode) => communityColor(d.community_id))
		.attr('stroke', (d: SimNode) => nodeStroke(d.qualified_name))
		.attr('stroke-width', (d: SimNode) => nodeStrokeWidth(d.qualified_name))
		.attr('opacity', (d: SimNode) => nodeOpacity(d.qualified_name))
		.attr('cursor', 'pointer')
		.attr('tabindex', -1)
		.attr('data-qn', (d: SimNode) => d.qualified_name)
		.on('click', (_event: MouseEvent, d: SimNode) => navigateToNode(d))
		.on('focus', (_event: FocusEvent, d: SimNode) => {
			focusedNodeQn.value = d.qualified_name;
		})
		.call(
			drag<SVGPathElement, SimNode>()
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

	nodeSel.append('title').text((d: SimNode) => `${d.kind}: ${d.name} at ${d.file_path}:${d.line_start}`);

	const labelOffset = NODE_EQUIVALENT_RADIUS + 13;
	const labelSel = labelGroup
		.selectAll('text')
		.data(simNodes)
		.join('text')
		.text((d: SimNode) => d.name)
		.attr('font-size', 9)
		.attr('fill', 'var(--foreground)')
		.attr('text-anchor', 'middle')
		.attr('dy', labelOffset)
		.attr('pointer-events', 'none')
		.attr('opacity', (d: SimNode) => nodeOpacity(d.qualified_name));

	const updatePositions = () => {
		linkSel.value
			?.attr('x1', (d: SimLink) => (d.source as SimNode).x ?? 0)
			.attr('y1', (d: SimLink) => (d.source as SimNode).y ?? 0)
			.attr('x2', (d: SimLink) => (d.target as SimNode).x ?? 0)
			.attr('y2', (d: SimLink) => (d.target as SimNode).y ?? 0);
		nodeSel.attr('transform', (d: SimNode) => `translate(${d.x ?? 0},${d.y ?? 0})`);
		labelSel.attr('x', (d: SimNode) => d.x ?? 0).attr('y', (d: SimNode) => d.y ?? 0);
	};

	simulation.value = forceSimulation(simNodes as never[])
		.alphaDecay(0.02)
		.stop()
		.force('link', forceLink(simLinks as never[]).id((d: never) => (d as SimNode).qualified_name).distance(100))
		.force('charge', forceManyBody().strength(-200))
		.force('center', forceCenter(width / 2, height / 2))
		.force('collide', forceCollide().radius(NODE_EQUIVALENT_RADIUS + 5));

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

watch(() => Array.from(store.visibleEdgeKinds).sort().join('|'), () => {
	if (!linkSel.value) return;
	linkSel.value.attr('display', (d: SimLink) => store.visibleEdgeKinds.has(d.kind) ? null : 'none');
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

function prefersReducedMotion(): boolean {
	return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function handleFitToView(): void {
	if (!d3Modules || !svgElement.value || !containerRef.value || !currentZoomBehavior.value || currentNodes.value.length === 0) return;
	const { select, zoomIdentity } = d3Modules;
	const svg = select(svgElement.value);
	const width = containerRef.value.clientWidth;
	const height = containerRef.value.clientHeight;

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const r = NODE_EQUIVALENT_RADIUS;
	for (const n of currentNodes.value) {
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

	const targetTransform = zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-cx, -cy);

	if (prefersReducedMotion()) {
		svg.call(currentZoomBehavior.value.transform as never, targetTransform);
		return;
	}

	svg.transition().duration(500).call(currentZoomBehavior.value.transform as never, targetTransform);
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
				<CompassEdgeFilterPopover />
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
				tabindex="-1"
				class="flex-1 relative outline-none"
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
		<CompassHelpDialog />
	</OverlayShell>
</template>
