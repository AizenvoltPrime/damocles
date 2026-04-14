import type { CompassConfig, IndexStatus } from './types';

export interface InitRequest {
	type: 'init';
	id: number;
	workspacePath: string;
	extensionPath: string;
	config: CompassConfig;
}

export interface FullBuildRequest {
	type: 'fullBuild';
	id: number;
}

export interface IncrementalUpdateRequest {
	type: 'incrementalUpdate';
	id: number;
	base?: string;
	changedFiles?: string[];
}

export interface PostprocessRequest {
	type: 'postprocess';
	id: number;
	flows?: boolean;
	communities?: boolean;
	fts?: boolean;
}

export interface SerializeRequest {
	type: 'serialize';
	id: number;
}

export interface DisposeRequest {
	type: 'dispose';
	id: number;
}

export interface GetStatusRequest {
	type: 'getStatus';
	id: number;
}

export interface GetGraphTermsRequest {
	type: 'getGraphTerms';
	id: number;
	queryTerms: string[];
}

export interface McpContextRequest {
	type: 'mcp:context';
	id: number;
	input: { task?: string; changed_files?: string[]; base?: string };
}

export interface McpSearchRequest {
	type: 'mcp:search';
	id: number;
	input: { query: string; kind?: string; limit?: number; detail_level?: string };
}

export interface McpQueryRequest {
	type: 'mcp:query';
	id: number;
	input: { pattern: string; target: string; detail_level?: string };
}

export interface McpStatsRequest {
	type: 'mcp:stats';
	id: number;
}

export interface McpBlastRadiusRequest {
	type: 'mcp:blastRadius';
	id: number;
	input: { changed_files: string[]; max_depth?: number; max_results?: number; detail_level?: string };
}

export interface McpDetectChangesRequest {
	type: 'mcp:detectChanges';
	id: number;
	input: { base?: string; changed_files?: string[]; detail_level?: string };
}

export interface McpReviewContextRequest {
	type: 'mcp:reviewContext';
	id: number;
	input: { changed_files: string[]; max_depth?: number; include_source?: boolean; base?: string };
}

export interface McpListFlowsRequest {
	type: 'mcp:listFlows';
	id: number;
	input: { sort_by?: string; limit?: number; detail_level?: string };
}

export interface McpGetFlowRequest {
	type: 'mcp:getFlow';
	id: number;
	input: { flow_id?: number; flow_name?: string; include_source?: boolean };
}

export interface McpListCommunitiesRequest {
	type: 'mcp:listCommunities';
	id: number;
	input: { sort_by?: string; min_size?: number; detail_level?: string };
}

export interface McpGetCommunityRequest {
	type: 'mcp:getCommunity';
	id: number;
	input: { community_id?: number; community_name?: string };
}

export interface McpArchitectureRequest {
	type: 'mcp:architecture';
	id: number;
	input: { detail_level?: string };
}

export interface McpBuildRequest {
	type: 'mcp:build';
	id: number;
	input: { full_rebuild?: boolean; postprocess?: boolean };
}

export interface McpPostprocessRequest {
	type: 'mcp:postprocess';
	id: number;
	input: { flows?: boolean; communities?: boolean; fts?: boolean };
}

export interface WebviewSearchRequest {
	type: 'webview:search';
	id: number;
	query: string;
	kind?: string;
	limit?: number;
}

export interface WebviewGraphRequest {
	type: 'webview:graph';
	id: number;
	maxNodes?: number;
	communityId?: number;
}

export interface WebviewBlastRadiusRequest {
	type: 'webview:blastRadius';
	id: number;
	filePath: string;
	depth?: number;
}

export interface WebviewValidationRequest {
	type: 'webview:validation';
	id: number;
}

export interface TreeFilesRequest {
	type: 'tree:files';
	id: number;
}

export interface TreeNodesByFileRequest {
	type: 'tree:nodesByFile';
	id: number;
	filePath: string;
}

export interface TreeEdgesForSymbolRequest {
	type: 'tree:edgesForSymbol';
	id: number;
	qualifiedName: string;
}

export type WorkerRequest =
	| InitRequest
	| FullBuildRequest
	| IncrementalUpdateRequest
	| PostprocessRequest
	| SerializeRequest
	| DisposeRequest
	| GetStatusRequest
	| GetGraphTermsRequest
	| McpContextRequest
	| McpSearchRequest
	| McpQueryRequest
	| McpStatsRequest
	| McpBlastRadiusRequest
	| McpDetectChangesRequest
	| McpReviewContextRequest
	| McpListFlowsRequest
	| McpGetFlowRequest
	| McpListCommunitiesRequest
	| McpGetCommunityRequest
	| McpArchitectureRequest
	| McpBuildRequest
	| McpPostprocessRequest
	| WebviewSearchRequest
	| WebviewGraphRequest
	| WebviewBlastRadiusRequest
	| WebviewValidationRequest
	| TreeFilesRequest
	| TreeNodesByFileRequest
	| TreeEdgesForSymbolRequest;

export interface WorkerResponseOk {
	type: 'response';
	id: number;
	ok: true;
	data: unknown;
}

export interface WorkerResponseError {
	type: 'response';
	id: number;
	ok: false;
	error: string;
}

export type WorkerResponse = WorkerResponseOk | WorkerResponseError;

export interface WorkerStatusEvent {
	type: 'status';
	status: IndexStatus;
}

export interface WorkerLogEvent {
	type: 'log';
	message: string;
}

export type WorkerEvent = WorkerResponse | WorkerStatusEvent | WorkerLogEvent;

export interface ValidationCategoryResult {
	count: number;
	entities: string[];
	truncated: boolean;
}

export interface WebviewValidationResponse {
	validation: {
		orphanedByKind: Record<string, ValidationCategoryResult>;
		totalByKind: Record<string, number>;
		brokenEdges: ValidationCategoryResult;
		knownExternalRefs: ValidationCategoryResult;
		unresolvedInternalRefs: ValidationCategoryResult;
		communityGaps: ValidationCategoryResult;
		ftsRowCount: number;
		nodeCount: number;
		edgeCount: number;
		fileCount: number;
		communityCount: number;
		filePaths: string[];
	};
	workspaceFileCount: number;
	workspaceFiles: string[];
	staleFilesRemoved: string[];
}

export const TIMEOUTS = {
	init: 300_000,
	fullBuild: 300_000,
	incrementalUpdate: 120_000,
	postprocess: 120_000,
	serialize: 30_000,
	dispose: 30_000,
	query: 30_000,
} as const;
