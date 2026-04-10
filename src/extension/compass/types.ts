export const NodeKind = {
	File: 'File',
	Class: 'Class',
	Function: 'Function',
	Type: 'Type',
	Test: 'Test',
} as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

export const EdgeKind = {
	CALLS: 'CALLS',
	IMPORTS_FROM: 'IMPORTS_FROM',
	INHERITS: 'INHERITS',
	IMPLEMENTS: 'IMPLEMENTS',
	CONTAINS: 'CONTAINS',
	TESTED_BY: 'TESTED_BY',
	DEPENDS_ON: 'DEPENDS_ON',
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

export interface NodeInfo {
	kind: NodeKind;
	name: string;
	file_path: string;
	line_start: number;
	line_end: number;
	language?: string;
	parent_name?: string;
	params?: string;
	return_type?: string;
	modifiers?: string;
	signature?: string;
	is_test?: boolean;
	extra?: Record<string, unknown>;
}

export interface EdgeInfo {
	kind: EdgeKind;
	source: string;
	target: string;
	file_path: string;
	line?: number;
	extra?: Record<string, unknown>;
}

export interface StoredNode {
	id: number;
	kind: NodeKind;
	name: string;
	name_tokens: string;
	qualified_name: string;
	file_path: string;
	line_start: number;
	line_end: number;
	language: string | null;
	parent_name: string | null;
	params: string | null;
	return_type: string | null;
	modifiers: string | null;
	signature: string | null;
	is_test: number;
	file_hash: string | null;
	community_id: number | null;
	extra: string;
	updated_at: number;
}

export interface StoredEdge {
	id: number;
	kind: EdgeKind;
	source_qualified: string;
	target_qualified: string;
	file_path: string;
	line: number;
	extra: string;
	updated_at: number;
}

export interface StoredFlow {
	id: number;
	name: string;
	entry_point_id: number;
	depth: number;
	node_count: number;
	file_count: number;
	criticality: number;
	path_json: string;
	created_at: string;
	updated_at: string;
}

export interface StoredCommunity {
	id: number;
	name: string;
	level: number;
	parent_id: number | null;
	cohesion: number;
	size: number;
	dominant_language: string | null;
	description: string | null;
	created_at: string;
}

export interface GraphStats {
	total_nodes: number;
	total_edges: number;
	nodes_by_kind: Record<string, number>;
	edges_by_kind: Record<string, number>;
	languages: string[];
	files_count: number;
	last_updated: string | null;
}

export interface ImpactResult {
	changed_nodes: StoredNode[];
	impacted_nodes: StoredNode[];
	impacted_files: string[];
	edges: StoredEdge[];
	total_impacted: number;
	truncated: boolean;
}

export interface ChangeRisk {
	node: StoredNode;
	risk_score: number;
	risk_level: 'HIGH' | 'MEDIUM' | 'LOW';
	factors: string[];
	test_coverage: boolean;
}

export interface ChangeAnalysis {
	changed_files: string[];
	changed_ranges: Record<string, Array<[number, number]>>;
	risks: ChangeRisk[];
	test_gaps: StoredNode[];
}

export interface FlowInfo {
	flow: StoredFlow;
	nodes: StoredNode[];
}

export interface CommunityInfo {
	community: StoredCommunity;
	members: StoredNode[];
}

export interface ArchitectureEdge {
	source_community: number;
	target_community: number;
	edge_count: number;
	edge_kinds: string[];
}

export interface ArchitectureOverview {
	communities: StoredCommunity[];
	cross_edges: ArchitectureEdge[];
}

export type DetailLevel = 'minimal' | 'summary' | 'full';

export type IndexState = 'idle' | 'indexing' | 'building' | 'ready' | 'error';

export interface IndexStatus {
	state: IndexState;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	communityCount: number;
	flowCount: number;
	lastIndexedAt: number | null;
	error?: string;
}

export interface CompassConfig {
	excludePatterns: string[];
	maxFiles: number;
	maxNodes: number;
	autoReindex: boolean;
}

export interface ExtractionContext {
	filePath: string;
	stem: string;
	fileQualified: string;
	workspaceRoot: string;
	source: string;
	lineOffset: number;
	nodes: NodeInfo[];
	edges: EdgeInfo[];
	seenQualified: Set<string>;
	functionBodies: Array<{ callerQualified: string; bodyNode: unknown; lineOffset: number }>;
}

export interface ICompassService {
	readonly isEnabled: boolean;
	ensureInitialized(): Promise<void>;
	getStatus(): IndexStatus;
	getGraphTerms(queryTerms: string[]): string[];
	getMcpServerConfig(getSessionId: () => string, workspace: string): unknown;
	onStatusChange(callback: (status: IndexStatus) => void): void;
	triggerReindex(): Promise<void>;
	dispose(): void | Promise<void>;
}

export const CODE_EXTENSIONS: Set<string> = new Set([
	'.py', '.ts', '.js', '.tsx', '.jsx', '.vue',
	'.go', '.rs', '.java',
	'.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
	'.rb', '.swift', '.kt', '.kts', '.cs', '.scala', '.php',
]);

export const SECURITY_KEYWORDS: Set<string> = new Set([
	'auth', 'password', 'token', 'secret', 'crypto',
	'credential', 'session', 'permission', 'encrypt', 'decrypt',
	'hash', 'sign', 'verify', 'certificate', 'oauth',
	'jwt', 'apikey', 'api_key', 'private_key', 'access_token',
]);

export const TEST_PATTERNS: readonly RegExp[] = [
	/^test_/,
	/^Test[A-Z]/,
	/_test$/,
	/\.test\./,
	/\.spec\./,
	/@pytest\.mark/,
	/@Test/,
	/\bdescribe\s*\(/,
	/\bit\s*\(/,
] as const;

export const COMMUNITY_COLORS: readonly string[] = [
	'#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
	'#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
] as const;
