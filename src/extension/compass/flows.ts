import type { GraphStore } from './database';
import type { StoredNode, StoredEdge, StoredFlow, FlowInfo, NodeKind } from './types';
import { SECURITY_KEYWORDS } from './types';
import { isTestFile } from './extractors/lang-maps';

export type FlowAdjacency = {
	outBySource: Map<string, StoredEdge[]>;
	inByTarget: Map<string, StoredEdge[]>;
	nodeKindByQn: Map<string, NodeKind>;
};

export function buildFlowAdjacency(store: GraphStore): FlowAdjacency {
	const outBySource = new Map<string, StoredEdge[]>();
	const inByTarget = new Map<string, StoredEdge[]>();
	for (const edge of store.getAllEdges()) {
		const outBucket = outBySource.get(edge.source_qualified);
		if (outBucket) outBucket.push(edge);
		else outBySource.set(edge.source_qualified, [edge]);

		const inBucket = inByTarget.get(edge.target_qualified);
		if (inBucket) inBucket.push(edge);
		else inByTarget.set(edge.target_qualified, [edge]);
	}

	const nodeKindByQn = new Map<string, NodeKind>();
	for (const row of store.getAllNodeQnAndKind()) {
		nodeKindByQn.set(row.qualified_name, row.kind);
	}

	return { outBySource, inByTarget, nodeKindByQn };
}

function callTargetsExcludingFileSources(adjacency: FlowAdjacency): Set<string> {
	const targets = new Set<string>();
	for (const [target, edges] of adjacency.inByTarget) {
		for (const edge of edges) {
			if (edge.kind !== 'CALLS') continue;
			const sourceKind = adjacency.nodeKindByQn.get(edge.source_qualified);
			if (sourceKind === undefined) continue;
			if (sourceKind === 'File') continue;
			targets.add(target);
			break;
		}
	}
	return targets;
}

const FRAMEWORK_DECORATOR_PATTERNS: RegExp[] = [
	/app\.(get|post|put|delete|patch|route|websocket|on_event)/i,
	/router\.(get|post|put|delete|patch|route)/i,
	/blueprint\.(route|before_request|after_request)/i,
	/(before|after)_(request|response)/i,
	/\w+\.route\b/i,
	/click\.(command|group)/i,
	/\w+\.(command|group)\b/i,
	/(field|model)_(serializer|validator)/i,
	/(celery\.)?(task|shared_task|periodic_task)/i,
	/^@?receiver\b/i,
	/api_view/i,
	/^@?action\b/i,
	/pytest\.(fixture|mark)/,
	/(override_settings|modify_settings)/i,
	/(event\.)?listens_for/i,
	/(Get|Post|Put|Delete|Patch|RequestMapping)Mapping/i,
	/^@?(Scheduled|EventListener|Bean|Configuration|RequestMapping)\b/,
	/^@?(Component|Injectable|Controller|Module|Guard|Pipe|Directive|NgModule)\b/,
	/^@?(Subscribe|Mutation|Query|Resolver)\b/,
	/(app|router)\.(get|post|put|delete|patch|use|all)\b/,
	/@(Override|OnLifecycleEvent|Composable)/i,
	/^@?(HiltViewModel|AndroidEntryPoint|Inject)\b/,
	/\w+\.(tool|tool_plain|system_prompt|result_validator)\b/i,
	/^tool\b/,
	/\w+\.(middleware|exception_handler|on_exception)\b/i,
];

const ENTRY_NAME_PATTERNS: RegExp[] = [
	/^main$/,
	/^__main__$/,
	/^test_/,
	/^Test[A-Z]/,
	/^on_/,
	/^handle_/,
	/^activate$/,
	/^setup$/,
	/^handler$/,
	/^handle$/,
	/^lambda_handler$/,
	/^upgrade$/,
	/^downgrade$/,
	/^lifespan$/,
	/^get_db$/,
	/^on(Create|Start|Resume|Pause|Stop|Destroy|Bind|Receive)/,
	/^do(Get|Post|Put|Delete)$/,
	/^do_(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/,
	/^log_message$/,
	/^(middleware|errorHandler)$/,
	/^ng(OnInit|OnChanges|OnDestroy|DoCheck|AfterContentInit|AfterContentChecked|AfterViewInit|AfterViewChecked)$/,
	/^(transform|writeValue|registerOnChange|registerOnTouched|setDisabledState)$/,
	/^(canActivate|canDeactivate|canActivateChild|canLoad|canMatch|resolve)$/,
	/^(componentDidMount|componentDidUpdate|componentWillUnmount|shouldComponentUpdate|render)$/,
];

export function hasFrameworkDecorator(node: StoredNode): boolean {
	let extra: Record<string, unknown>;
	try { extra = JSON.parse(node.extra); } catch { return false; }
	const decorators = extra['decorators'];
	if (!decorators) return false;
	const decList = Array.isArray(decorators) ? decorators : [decorators];
	return decList.some(dec =>
		FRAMEWORK_DECORATOR_PATTERNS.some(pat => pat.test(String(dec))),
	);
}

export function matchesEntryName(node: StoredNode): boolean {
	return ENTRY_NAME_PATTERNS.some(pat => pat.test(node.name));
}

export function detectEntryPoints(
	store: GraphStore,
	options: { includeTests?: boolean } = {},
	adjacency?: FlowAdjacency,
): StoredNode[] {
	const includeTests = options.includeTests ?? false;
	const adj = adjacency ?? buildFlowAdjacency(store);
	const callTargets = callTargetsExcludingFileSources(adj);
	const candidates = store.getNodesByKinds(['Function', 'Test']);
	const entryPoints: StoredNode[] = [];
	const seen = new Set<string>();

	for (const node of candidates) {
		if (!includeTests && (node.is_test === 1 || isTestFile(node.file_path))) continue;

		let isEntry = false;

		if (!callTargets.has(node.qualified_name)) isEntry = true;
		if (hasFrameworkDecorator(node)) isEntry = true;
		if (matchesEntryName(node)) isEntry = true;

		if (isEntry && !seen.has(node.qualified_name)) {
			entryPoints.push(node);
			seen.add(node.qualified_name);
		}
	}

	return entryPoints;
}

interface FlowData {
	name: string;
	entryPointId: number;
	pathIds: number[];
	depth: number;
	nodeCount: number;
	fileCount: number;
	files: string[];
	criticality: number;
}

function traceSingleFlow(
	store: GraphStore,
	ep: StoredNode,
	adjacency: FlowAdjacency,
	maxDepth: number = 15,
): FlowData | null {
	const pathIds: number[] = [ep.id];
	const visited = new Set<string>([ep.qualified_name]);
	const queue: Array<[string, number]> = [[ep.qualified_name, 0]];
	let actualDepth = 0;

	while (queue.length > 0) {
		const [currentQn, depth] = queue.shift()!;
		if (depth > actualDepth) actualDepth = depth;
		if (depth >= maxDepth) continue;

		const edges = adjacency.outBySource.get(currentQn) ?? [];
		for (const edge of edges) {
			if (edge.kind !== 'CALLS') continue;
			if (visited.has(edge.target_qualified)) continue;

			const target = store.getNode(edge.target_qualified);
			if (!target) continue;

			visited.add(edge.target_qualified);
			pathIds.push(target.id);
			queue.push([edge.target_qualified, depth + 1]);
		}
	}

	if (pathIds.length < 2) return null;

	const fileSet = new Set<string>();
	for (const id of pathIds) {
		const n = store.getNodeById(id);
		if (n) fileSet.add(n.file_path);
	}
	const files = [...fileSet];

	const flow: FlowData = {
		name: ep.name,
		entryPointId: ep.id,
		pathIds,
		depth: actualDepth,
		nodeCount: pathIds.length,
		fileCount: files.length,
		files,
		criticality: 0,
	};
	flow.criticality = computeCriticalityWithAdjacency(flow, store, adjacency);
	return flow;
}

export function traceFlows(
	store: GraphStore,
	maxDepth: number = 15,
	options: { includeTests?: boolean } = {},
): FlowData[] {
	const adjacency = buildFlowAdjacency(store);
	const entryPoints = detectEntryPoints(store, options, adjacency);
	const flows: FlowData[] = [];

	for (const ep of entryPoints) {
		const flow = traceSingleFlow(store, ep, adjacency, maxDepth);
		if (flow) flows.push(flow);
	}

	flows.sort((a, b) => b.criticality - a.criticality);
	return flows;
}

export function computeCriticality(flow: FlowData, store: GraphStore): number {
	return computeCriticalityWithAdjacency(flow, store, buildFlowAdjacency(store));
}

function computeCriticalityWithAdjacency(
	flow: FlowData,
	store: GraphStore,
	adjacency: FlowAdjacency,
): number {
	if (flow.pathIds.length === 0) return 0;

	const nodes: StoredNode[] = [];
	for (const id of flow.pathIds) {
		const n = store.getNodeById(id);
		if (n) nodes.push(n);
	}
	if (nodes.length === 0) return 0;

	const fileCount = new Set(nodes.map(n => n.file_path)).size;
	const fileSpread = fileCount > 1 ? Math.min((fileCount - 1) / 4, 1) : 0;

	let externalCount = 0;
	for (const n of nodes) {
		const outgoing = adjacency.outBySource.get(n.qualified_name) ?? [];
		for (const e of outgoing) {
			if (e.kind === 'CALLS' && !store.getNode(e.target_qualified)) {
				externalCount++;
			}
		}
	}
	const externalScore = Math.min(externalCount / 5, 1);

	let securityHits = 0;
	for (const n of nodes) {
		const nameLower = n.name.toLowerCase();
		const qnLower = n.qualified_name.toLowerCase();
		for (const kw of SECURITY_KEYWORDS) {
			if (nameLower.includes(kw) || qnLower.includes(kw)) {
				securityHits++;
				break;
			}
		}
	}
	const securityScore = Math.min(securityHits / Math.max(nodes.length, 1), 1);

	let testedCount = 0;
	for (const n of nodes) {
		const incoming = adjacency.inByTarget.get(n.qualified_name) ?? [];
		if (incoming.some(e => e.kind === 'TESTED_BY')) {
			testedCount++;
		}
	}
	const testGap = 1 - testedCount / Math.max(nodes.length, 1);

	const depthScore = Math.min(flow.depth / 10, 1);

	const criticality = (
		fileSpread * 0.30
		+ externalScore * 0.20
		+ securityScore * 0.25
		+ testGap * 0.15
		+ depthScore * 0.10
	);

	return Math.round(Math.min(Math.max(criticality, 0), 1) * 10000) / 10000;
}

export function storeFlows(store: GraphStore, flows: FlowData[]): number {
	return store.withTransaction(() => {
		store.execRaw('DELETE FROM flow_memberships');
		store.execRaw('DELETE FROM flows');

		let count = 0;
		for (const flow of flows) {
			const pathJson = JSON.stringify(flow.pathIds);
			store.execRaw(
				`INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, criticality, path_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[flow.name, flow.entryPointId, flow.depth, flow.nodeCount, flow.fileCount, flow.criticality, pathJson],
			);

			const row = store.queryRaw(
				'SELECT last_insert_rowid() as id',
			);
			const flowId = (row[0]?.['id'] ?? 0) as number;

			for (let pos = 0; pos < flow.pathIds.length; pos++) {
				store.execRaw(
					'INSERT OR IGNORE INTO flow_memberships (flow_id, node_id, position) VALUES (?, ?, ?)',
					[flowId, flow.pathIds[pos], pos],
				);
			}
			count++;
		}

		return count;
	});
}

function rowToStoredFlow(row: Record<string, unknown>): StoredFlow {
	return {
		id: row['id'] as number,
		name: row['name'] as string,
		entry_point_id: row['entry_point_id'] as number,
		depth: row['depth'] as number,
		node_count: row['node_count'] as number,
		file_count: row['file_count'] as number,
		criticality: row['criticality'] as number,
		path_json: row['path_json'] as string,
		created_at: row['created_at'] as string,
		updated_at: row['updated_at'] as string,
	};
}

export function getFlows(
	store: GraphStore,
	sortBy: string = 'criticality',
	limit: number = 50,
): StoredFlow[] {
	const allowedSort = new Set(['criticality', 'depth', 'node_count', 'file_count', 'name']);
	if (!allowedSort.has(sortBy)) sortBy = 'criticality';

	const order = sortBy === 'name' ? 'ASC' : 'DESC';
	const rows = store.queryRaw(
		`SELECT * FROM flows ORDER BY ${sortBy} ${order} LIMIT ?`,
		limit,
	);
	return rows.map(rowToStoredFlow);
}

export function getFlowById(store: GraphStore, flowId: number): FlowInfo | null {
	const rows = store.queryRaw('SELECT * FROM flows WHERE id = ?', flowId);
	if (rows.length === 0) return null;
	const flow = rowToStoredFlow(rows[0]!);

	const pathIds: number[] = JSON.parse(flow.path_json);
	const nodes: StoredNode[] = [];
	for (const nid of pathIds) {
		const node = store.getNodeById(nid);
		if (node) nodes.push(node);
	}

	return { flow, nodes };
}

export function getAffectedFlows(
	store: GraphStore,
	changedFiles: string[],
): { flows: StoredFlow[]; total: number } {
	if (changedFiles.length === 0) return { flows: [], total: 0 };

	const nodeIds = store.getNodeIdsByFiles(changedFiles);
	if (nodeIds.length === 0) return { flows: [], total: 0 };

	const flowIds = store.getFlowIdsByNodeIds(nodeIds);
	if (flowIds.length === 0) return { flows: [], total: 0 };

	const flows: StoredFlow[] = [];
	for (const fid of flowIds) {
		const info = getFlowById(store, fid);
		if (info) flows.push(info.flow);
	}

	flows.sort((a, b) => b.criticality - a.criticality);
	return { flows, total: flows.length };
}
