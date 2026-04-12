export type CompassIndexState = 'idle' | 'indexing' | 'building' | 'ready' | 'error';

export interface CompassIndexStatus {
	state: CompassIndexState;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	communityCount: number;
	flowCount: number;
	lastIndexedAt: number | null;
	error?: string;
}

export type CompassNodeKind = 'File' | 'Class' | 'Function' | 'Type' | 'Test';
export type CompassEdgeKind = 'CALLS' | 'IMPORTS_FROM' | 'INHERITS' | 'IMPLEMENTS' | 'CONTAINS' | 'TESTED_BY' | 'DEPENDS_ON' | 'REFERENCES';
export type CompassDetailLevel = 'minimal' | 'summary' | 'full';

export interface CompassGraphNode {
	id: number;
	kind: CompassNodeKind;
	name: string;
	qualified_name: string;
	file_path: string;
	line_start: number;
	line_end: number;
	language: string | null;
	community_id: number | null;
}

export interface CompassGraphEdge {
	id: number;
	kind: CompassEdgeKind;
	source_qualified: string;
	target_qualified: string;
	file_path: string;
}

export interface CompassSearchResult {
	node: CompassGraphNode;
	score: number;
}

export interface CompassBlastRadiusResult {
	changed_files: string[];
	changed_nodes: CompassGraphNode[];
	impacted_nodes: CompassGraphNode[];
	impacted_files: string[];
	edges: CompassGraphEdge[];
	total_impacted: number;
	truncated: boolean;
}

export interface CompassFlowInfo {
	id: number;
	name: string;
	entry_point: string;
	depth: number;
	node_count: number;
	file_count: number;
	criticality: number;
}

export interface CompassCommunityInfo {
	id: number;
	name: string;
	size: number;
	cohesion: number;
	dominant_language: string | null;
	description: string | null;
}

export interface CompassArchitectureEdge {
	source_community: number;
	target_community: number;
	edge_count: number;
}

export interface CompassGraphData {
	nodes: CompassGraphNode[];
	edges: CompassGraphEdge[];
	communities: CompassCommunityInfo[];
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
	category: string;
	severity: ValidationSeverity;
	count: number;
	description: string;
	entities: string[];
	truncated: boolean;
}

export interface CompassValidationResult {
	timestamp: number;
	durationMs: number;
	totalIssues: number;
	issues: ValidationIssue[];
	summary: {
		nodeCount: number;
		edgeCount: number;
		fileCount: number;
		communityCount: number;
		edgeToNodeRatio: number;
		workspaceFileCount: number;
		coveragePercent: number;
	};
}
