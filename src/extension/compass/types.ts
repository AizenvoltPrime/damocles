import type Graph from 'graphology';

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
export type FileType = 'code' | 'document' | 'paper' | 'image';
export type EntityKind = 'file' | 'class' | 'function' | 'method' | 'type' | 'import';

export interface GraphNode {
	id: string;
	label: string;
	file_type: FileType;
	source_file: string;
	source_location?: string;
	kind?: EntityKind;
}

export interface GraphEdge {
	source: string;
	target: string;
	relation: string;
	confidence: Confidence;
	source_file: string;
	source_location?: string;
	weight?: number;
	confidence_score?: number;
}

export interface ExtractionResult {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface GraphNodeAttributes {
	label: string;
	file_type: FileType;
	source_file: string;
	source_location?: string;
	community?: number;
	kind?: EntityKind;
	[key: string]: unknown;
}

export interface GraphEdgeAttributes {
	relation: string;
	confidence: Confidence;
	source_file: string;
	source_location?: string;
	weight?: number;
	confidence_score?: number;
	_src: string;
	_tgt: string;
	[key: string]: unknown;
}

export type CompassGraph = Graph<GraphNodeAttributes, GraphEdgeAttributes>;

export interface CompassConfig {
	excludePatterns: string[];
	maxFiles: number;
	autoReindex: boolean;
}

export type IndexState = 'idle' | 'indexing' | 'ready' | 'error';

export interface IndexStatus {
	state: IndexState;
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	communityCount: number;
	lastIndexedAt: number | null;
	error?: string;
}

export interface CommunityMap {
	[communityId: number]: string[];
}

export interface CohesionScores {
	[communityId: number]: number;
}

export interface GodNode {
	id: string;
	label: string;
	edges: number;
}

export interface SurprisingConnection {
	source: string;
	target: string;
	source_files: [string, string];
	confidence: Confidence;
	relation: string;
	why?: string;
	note?: string;
}

export interface SuggestedQuestion {
	type: 'ambiguous_edge' | 'bridge_node' | 'verify_inferred' | 'isolated_nodes' | 'low_cohesion' | 'no_signal';
	question: string | null;
	why: string;
}

export interface GraphDiff {
	new_nodes: Array<{ id: string; label: string }>;
	removed_nodes: Array<{ id: string; label: string }>;
	new_edges: Array<{ source: string; target: string; relation: string; confidence: string }>;
	removed_edges: Array<{ source: string; target: string; relation: string; confidence: string }>;
	summary: string;
}

export interface AnalysisResult {
	godNodes: GodNode[];
	surprisingConnections: SurprisingConnection[];
	suggestedQuestions: SuggestedQuestion[];
	communities: CommunityMap;
	cohesionScores: CohesionScores;
	communityLabels: Record<number, string>;
}

export interface DetectionResult {
	files: Record<FileType, string[]>;
	total_files: number;
	total_words: number;
	needs_graph: boolean;
	warning: string | null;
	skipped_sensitive: string[];
}

export interface CacheEntry {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface FileGraphContext {
	filePath: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	community?: number;
	relatedFiles: string[];
}

export const VALID_FILE_TYPES: Set<FileType> = new Set<FileType>(['code', 'document', 'paper', 'image']);
export const VALID_CONFIDENCES: Set<Confidence> = new Set<Confidence>(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);

export const REQUIRED_NODE_FIELDS: readonly string[] = ['id', 'label', 'file_type', 'source_file'] as const;
export const REQUIRED_EDGE_FIELDS: readonly string[] = ['source', 'target', 'relation', 'confidence', 'source_file'] as const;

export const CODE_EXTENSIONS: Set<string> = new Set([
	'.py', '.ts', '.js', '.tsx', '.go', '.rs', '.java',
	'.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
	'.rb', '.swift', '.kt', '.kts', '.cs', '.scala', '.php',
]);

export const DOC_EXTENSIONS: Set<string> = new Set(['.md', '.txt', '.rst']);
export const PAPER_EXTENSIONS: Set<string> = new Set(['.pdf']);
export const IMAGE_EXTENSIONS: Set<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export const CODE_STEMS: Set<string> = new Set([
	'py', 'ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'java', 'rb', 'cpp', 'c', 'h', 'hpp', 'cs', 'kt', 'kts', 'scala', 'php',
]);

export function isFileNode(G: CompassGraph, nodeId: string): boolean {
	const label = G.getNodeAttribute(nodeId, 'label') ?? '';
	if (!label) return false;
	const ext = label.split('.').pop() ?? '';
	if (CODE_STEMS.has(ext)) return true;
	if (label.startsWith('.') && label.endsWith('()')) return true;
	if (label.endsWith('()') && G.degree(nodeId) <= 1) return true;
	return false;
}

export function isConceptNode(G: CompassGraph, nodeId: string): boolean {
	const source = G.getNodeAttribute(nodeId, 'source_file') ?? '';
	if (!source) return true;
	const filename = source.split('/').pop() ?? '';
	if (!filename.includes('.')) return true;
	return false;
}

export const COMMUNITY_COLORS: readonly string[] = [
	'#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
	'#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC',
] as const;
