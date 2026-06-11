import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import type { GraphStore } from './database';
import { collectFiles } from './detect';
import { extractFile, GrammarLoadError } from './extractors';
import { getChangedFiles } from './git';
import type { CompassConfig } from './types';

const MAX_DEPENDENT_HOPS = 2;
const MAX_DEPENDENT_FILES = 500;

export interface BuildResult {
	filesParsed: number;
	totalNodes: number;
	totalEdges: number;
	errors: Array<{ file: string; error: string }>;
}

export interface IncrementalResult extends BuildResult {
	changedFiles: string[];
	dependentFiles: string[];
}

function fileHash(filePath: string): string {
	const content = fs.readFileSync(filePath);
	return crypto.createHash('sha256').update(content).digest('hex');
}

function singleHopDependents(store: GraphStore, filePath: string): Set<string> {
	const dependents = new Set<string>();

	for (const node of store.getNodesByFile(filePath)) {
		for (const e of store.getEdgesByTarget(node.qualified_name)) {
			if (e.kind === 'CALLS') {
				const sourceNode = store.getNode(e.source_qualified);
				if (sourceNode?.kind === 'File') continue;
				dependents.add(e.file_path);
				continue;
			}
			if (e.kind === 'IMPORTS_FROM' || e.kind === 'INHERITS' || e.kind === 'IMPLEMENTS') {
				dependents.add(e.file_path);
			}
		}
	}

	dependents.delete(filePath);
	return dependents;
}

export function findDependents(
	store: GraphStore,
	filePath: string,
	maxHops: number = MAX_DEPENDENT_HOPS,
): string[] {
	const allDependents = new Set<string>();
	const visited = new Set<string>([filePath]);
	let frontier = new Set<string>([filePath]);

	for (let hop = 0; hop < maxHops; hop++) {
		const nextFrontier = new Set<string>();
		let capped = false;
		for (const fp of frontier) {
			for (const d of singleHopDependents(store, fp)) {
				if (!visited.has(d)) {
					allDependents.add(d);
					nextFrontier.add(d);
				}
				if (allDependents.size >= MAX_DEPENDENT_FILES) { capped = true; break; }
			}
			if (capped) break;
		}
		for (const d of nextFrontier) visited.add(d);
		frontier = nextFrontier;
		if (capped) break;
		if (frontier.size === 0) break;
	}

	return [...allDependents].slice(0, MAX_DEPENDENT_FILES);
}

function recordExtractionError(
	errors: Array<{ file: string; error: string }>,
	failedGrammarLanguages: Set<string>,
	filePath: string,
	err: unknown,
): void {
	const message = err instanceof Error ? err.message : String(err);
	if (err instanceof GrammarLoadError) {
		if (!failedGrammarLanguages.has(err.language)) {
			failedGrammarLanguages.add(err.language);
			log('[Compass] %s — every %s file will be recorded as an error this build', message, err.language);
		}
	} else {
		log('[Compass] Error parsing %s: %s', filePath, message);
	}
	errors.push({ file: filePath, error: message });
}

export async function fullBuild(
	store: GraphStore,
	workspaceRoot: string,
	{ excludePatterns }: CompassConfig,
	onProgress?: (current: number, total: number) => Promise<void>,
): Promise<BuildResult> {
	const files = collectFiles(workspaceRoot, excludePatterns);

	const existingFiles = new Set(store.getAllFiles());
	const currentNormalized = new Set(files.map(f => f.replace(/\\/g, '/')));
	for (const stale of existingFiles) {
		if (!currentNormalized.has(stale)) {
			store.removeFileData(stale);
		}
	}

	const fileHashIndex = store.getFileHashIndex();
	let totalNodes = 0;
	let totalEdges = 0;
	const errors: Array<{ file: string; error: string }> = [];
	const failedGrammarLanguages = new Set<string>();

	const total = files.length;
	const emitEvery = Math.max(25, Math.floor(total / 100));
	let processed = 0;
	if (onProgress) await onProgress(0, total);

	for (const filePath of files) {
		try {
			const hash = fileHash(filePath);
			const existing = fileHashIndex.get(filePath.replace(/\\/g, '/'));
			if (existing && existing.hash === hash) {
				totalNodes += existing.nodeCount;
				continue;
			}

			const result = await extractFile(filePath, workspaceRoot);
			store.storeFileNodesEdges(filePath, result.nodes, result.edges, hash);
			totalNodes += result.nodes.length;
			totalEdges += result.edges.length;
		} catch (err) {
			recordExtractionError(errors, failedGrammarLanguages, filePath, err);
		} finally {
			processed++;
			if (onProgress && (processed % emitEvery === 0 || processed === total)) {
				await onProgress(processed, total);
			}
		}
	}

	const resolved = store.resolveExternalEdges(workspaceRoot);
	if (resolved > 0) log('[Compass] Resolved %d external edge references', resolved);

	store.buildTestedByEdges();

	store.setMetadata('last_updated', new Date().toISOString());
	store.setMetadata('last_build_type', 'full');

	return { filesParsed: files.length, totalNodes, totalEdges, errors };
}

export async function incrementalUpdate(
	store: GraphStore,
	workspaceRoot: string,
	base: string = 'HEAD~1',
	changedFileList?: string[],
	onProgress?: (current: number, total: number) => Promise<void>,
): Promise<IncrementalResult> {
	const changed = changedFileList ?? getChangedFiles(workspaceRoot, base);

	if (changed.length === 0) {
		return {
			filesParsed: 0,
			totalNodes: 0,
			totalEdges: 0,
			errors: [],
			changedFiles: [],
			dependentFiles: [],
		};
	}

	const absChanged = changed.map(f => path.resolve(workspaceRoot, f).replace(/\\/g, '/'));

	const dependentFiles = new Set<string>();
	for (const fp of absChanged) {
		for (const d of findDependents(store, fp)) {
			dependentFiles.add(d);
		}
	}

	const allFiles = new Set([...absChanged, ...dependentFiles]);
	const fileHashIndex = store.getFileHashIndex();
	let totalNodes = 0;
	let totalEdges = 0;
	let mutated = false;
	const errors: Array<{ file: string; error: string }> = [];
	const failedGrammarLanguages = new Set<string>();

	const total = allFiles.size;
	const emitEvery = Math.max(25, Math.floor(total / 100));
	let processed = 0;
	if (onProgress) await onProgress(0, total);

	for (const filePath of allFiles) {
		if (!fs.existsSync(filePath)) {
			store.removeFileData(filePath);
			mutated = true;
			processed++;
			if (onProgress && (processed % emitEvery === 0 || processed === total)) {
				await onProgress(processed, total);
			}
			continue;
		}

		try {
			const hash = fileHash(filePath);
			const existing = fileHashIndex.get(filePath);
			if (existing && existing.hash === hash) {
				continue;
			}

			const result = await extractFile(filePath, workspaceRoot);
			store.storeFileNodesEdges(filePath, result.nodes, result.edges, hash);
			mutated = true;
			totalNodes += result.nodes.length;
			totalEdges += result.edges.length;
		} catch (err) {
			recordExtractionError(errors, failedGrammarLanguages, filePath, err);
		} finally {
			processed++;
			if (onProgress && (processed % emitEvery === 0 || processed === total)) {
				await onProgress(processed, total);
			}
		}
	}

	if (mutated) {
		const resolved = store.resolveExternalEdges(workspaceRoot);
		if (resolved > 0) log('[Compass] Resolved %d external edge references', resolved);
		store.buildTestedByEdges();
		store.setMetadata('last_updated', new Date().toISOString());
		store.setMetadata('last_build_type', 'incremental');
	}

	return {
		filesParsed: allFiles.size,
		totalNodes,
		totalEdges,
		errors,
		changedFiles: absChanged,
		dependentFiles: [...dependentFiles],
	};
}
