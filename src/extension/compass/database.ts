import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logger';
import { splitIdentifier, qualifyName } from './schema';
import { runMigrations } from './migrations';
import type { NodeInfo, EdgeInfo, StoredNode, StoredEdge, GraphStats, NodeKind, EdgeKind } from './types';
import { isKnownExternal } from './known-externals';
import { createWrapper } from './db-wrapper';
import type { DbWrapper } from './db-wrapper';
import {
	createAliasResolver, getLanguageFamily,
	buildRelativeImportPathCandidates, resolveImportSpecToFiles,
} from './import-resolver';
import type { AliasResolver } from './import-resolver';
import { runValidation as runStoreValidation } from './validation';
import type { ValidationResult } from './validation';
import { normalizePath } from './util';

export type { DbWrapper, PreparedStatement } from './db-wrapper';

const NON_DISTINCTIVE_DIRS = new Set(['.', 'src', 'lib']);

// SQLITE_CORRUPT (11) / SQLITE_NOTADB (26): the file is unreadable and discard-and-rebuild is the fix.
// SQLITE_BUSY (5) / SQLITE_LOCKED (6) and IO faults are transient — often a sibling VS Code window
// holding the shared graph.db — so deleting the file under a live connection would be destructive.
function isCorruptionError(err: unknown): boolean {
	const errcode = (err as { errcode?: number })?.errcode;
	if (typeof errcode === 'number') {
		// Mask off the extended bits so CORRUPT_VTAB (267), CORRUPT_SEQUENCE (523), CORRUPT_INDEX (779)
		// still classify as corruption instead of being treated as transient.
		const primary = errcode & 0xff;
		if (primary === 5 || primary === 6 || primary === 10) return false; // BUSY / LOCKED / IOERR
		if (primary === 11 || primary === 26) return true; // CORRUPT / NOTADB
	}
	const message = err instanceof Error ? err.message : String(err);
	return /malformed|not a database/i.test(message);
}

function computeSearchAux(node: NodeInfo, normalizedFilePath: string): string {
	const parts: string[] = [];
	if (node.parent_name && node.kind !== 'File') {
		parts.push(node.parent_name);
		const split = splitIdentifier(node.parent_name);
		if (split) parts.push(split);
	}
	const segments = normalizedFilePath.split('/').filter(Boolean);
	if (segments.length >= 2) {
		const dir = segments[segments.length - 2]!;
		if (!NON_DISTINCTIVE_DIRS.has(dir.toLowerCase())) parts.push(dir);
	}
	return parts.join(' ').trim();
}

const SQL_PARAM_BATCH_SIZE = 400;

export function runChunked<T, R>(
	items: T[],
	run: (chunk: T[], placeholders: string) => R[] | void,
): R[] {
	const rows: R[] = [];
	for (let i = 0; i < items.length; i += SQL_PARAM_BATCH_SIZE) {
		const chunk = items.slice(i, i + SQL_PARAM_BATCH_SIZE);
		const placeholders = chunk.map(() => '?').join(',');
		const result = run(chunk, placeholders);
		if (result) rows.push(...result);
	}
	return rows;
}

export function rowToStoredNode(row: Record<string, unknown>): StoredNode {
	return {
		id: row['id'] as number,
		kind: row['kind'] as NodeKind,
		name: row['name'] as string,
		name_tokens: row['name_tokens'] as string,
		qualified_name: row['qualified_name'] as string,
		file_path: row['file_path'] as string,
		line_start: row['line_start'] as number,
		line_end: row['line_end'] as number,
		language: (row['language'] as string | null) ?? null,
		parent_name: (row['parent_name'] as string | null) ?? null,
		params: (row['params'] as string | null) ?? null,
		return_type: (row['return_type'] as string | null) ?? null,
		modifiers: (row['modifiers'] as string | null) ?? null,
		signature: (row['signature'] as string | null) ?? null,
		is_test: row['is_test'] as number,
		file_hash: (row['file_hash'] as string | null) ?? null,
		community_id: (row['community_id'] as number | null) ?? null,
		extra: (row['extra'] as string) ?? '{}',
		updated_at: row['updated_at'] as number,
	};
}

export function rowToStoredEdge(row: Record<string, unknown>): StoredEdge {
	return {
		id: row['id'] as number,
		kind: row['kind'] as EdgeKind,
		source_qualified: row['source_qualified'] as string,
		target_qualified: row['target_qualified'] as string,
		file_path: row['file_path'] as string,
		line: row['line'] as number,
		extra: (row['extra'] as string) ?? '{}',
		updated_at: row['updated_at'] as number,
	};
}

function probeWithCache(cache: Map<string, boolean>, key: string, probe: () => boolean): boolean {
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const result = probe();
	cache.set(key, result);
	return result;
}

/** SQLite LOWER() folds ASCII only; prefilter probes are sound solely for ASCII inputs. */
function isAsciiOnly(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) > 127) return false;
	}
	return true;
}

const TEST_NAME_SUFFIX_RE = /(?:[._]tests?|[._]spec|tests?)$/;
const TEST_NAME_PREFIX_RE = /^tests?[._]?/;

/** Returns the lowercased subject name with one test affix stripped, or null when no affix matched. */
function stripTestNameAffix(name: string): string | null {
	const lower = name.toLowerCase();
	const suffixStripped = lower.replace(TEST_NAME_SUFFIX_RE, '');
	if (suffixStripped !== lower) return suffixStripped || null;
	const prefixStripped = lower.replace(TEST_NAME_PREFIX_RE, '');
	if (prefixStripped !== lower) return prefixStripped || null;
	return null;
}

function fileStem(filePath: string): string {
	const base = filePath.slice(filePath.lastIndexOf('/') + 1);
	return base.replace(/\.[^.]*$/, '');
}

export class GraphStore {
	private _db: DbWrapper | null = null;
	private _dbPath: string;

	constructor(dbPath: string) {
		this._dbPath = dbPath;
	}

	get db(): DbWrapper {
		if (!this._db) throw new Error('GraphStore not open');
		return this._db;
	}

	get isOpen(): boolean {
		return this._db !== null;
	}

	get dbPath(): string {
		return this._dbPath;
	}

	// extensionPath kept for the worker call site; node:sqlite needs no wasm.
	async open(_extensionPath?: string): Promise<void> {
		try {
			this._openFileBacked(this._dbPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Only discard on genuine corruption. A transient BUSY/LOCKED (e.g. a sibling window) must
			// surface, not delete the shared file out from under the live connection.
			if (!isCorruptionError(err)) {
				log(`[Compass] Existing DB at ${this._dbPath} failed to open (${message}) — not corruption; surfacing`);
				throw err;
			}
			log(`[Compass] Existing DB at ${this._dbPath} is corrupt (${message}) — discarding and rebuilding fresh`);
			try {
				await this._discardDbFiles();
			} catch (rmErr) {
				// On Windows a sibling window can hold the file (EPERM/EBUSY); rm won't remove it, and
				// reopening would just re-hit the corruption. Surface a clear error instead of silently
				// reopening the same corrupt file.
				const rmMessage = rmErr instanceof Error ? rmErr.message : String(rmErr);
				throw new Error(`Compass DB at ${this._dbPath} is corrupt but could not be discarded (${rmMessage}); another window may be holding it. Close other windows and retry.`);
			}
			this._openFileBacked(this._dbPath);
		}
	}

	static openAt(dbPath: string): GraphStore {
		const store = new GraphStore(dbPath);
		store._openFileBacked(dbPath);
		return store;
	}

	private async _discardDbFiles(): Promise<void> {
		await fs.promises.rm(this._dbPath, { force: true });
		await fs.promises.rm(this._dbPath + '-wal', { force: true });
		await fs.promises.rm(this._dbPath + '-shm', { force: true });
	}

	private _openFileBacked(dbPath: string): void {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const raw = new DatabaseSync(dbPath, { timeout: 5000, enableForeignKeyConstraints: true });
		try {
			raw.exec('PRAGMA journal_mode = WAL');
			raw.exec('PRAGMA synchronous = NORMAL');
			// FK enforcement is already on via the constructor's enableForeignKeyConstraints.
			this._db = createWrapper(raw, dbPath);
			runMigrations(this._db);
		} catch (err) {
			this._db = null;
			try {
				raw.close();
			} catch {
				// release the file lock so a corrupt file can be discarded
			}
			throw err;
		}
	}

	upsertNode(node: NodeInfo, fileHash: string = ''): number {
		const now = Date.now() / 1000;
		const filePath = normalizePath(node.file_path);
		const qualified = qualifyName(node.name, filePath, node.parent_name);
		const nameTokens = splitIdentifier(node.name);
		const extra = node.extra ? JSON.stringify(node.extra) : '{}';
		const searchAux = computeSearchAux(node, filePath);

		this.db.prepare(`
			INSERT INTO nodes
				(kind, name, name_tokens, qualified_name, file_path, line_start, line_end,
				 language, parent_name, params, return_type, modifiers, signature,
				 is_test, file_hash, search_aux, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(qualified_name) DO UPDATE SET
				kind=excluded.kind, name=excluded.name, name_tokens=excluded.name_tokens,
				file_path=excluded.file_path, line_start=excluded.line_start,
				line_end=excluded.line_end, language=excluded.language,
				parent_name=excluded.parent_name, params=excluded.params,
				return_type=excluded.return_type, modifiers=excluded.modifiers,
				signature=excluded.signature, is_test=excluded.is_test,
				file_hash=excluded.file_hash, search_aux=excluded.search_aux,
				extra=excluded.extra, updated_at=excluded.updated_at
		`).run(
			node.kind, node.name, nameTokens, qualified, filePath,
			node.line_start, node.line_end,
			node.language ?? null, node.parent_name ?? null,
			node.params ?? null, node.return_type ?? null,
			node.modifiers ?? null, node.signature ?? null,
			node.is_test ? 1 : 0, fileHash || null,
			searchAux || null, extra, now,
		);

		const row = this.db.prepare(
			'SELECT id FROM nodes WHERE qualified_name = ?',
		).get(qualified) as { id: number };
		return row.id;
	}

	upsertEdge(edge: EdgeInfo): number {
		const now = Date.now() / 1000;
		const extra = edge.extra ? JSON.stringify(edge.extra) : '{}';
		const line = edge.line ?? 0;
		const filePath = normalizePath(edge.file_path);

		this.db.prepare(`
			INSERT INTO edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(kind, source_qualified, target_qualified, file_path, line) DO UPDATE SET
				extra=excluded.extra, updated_at=excluded.updated_at
		`).run(edge.kind, edge.source, edge.target, filePath, line, extra, now);

		const row = this.db.prepare(`
			SELECT id FROM edges
			WHERE kind = ? AND source_qualified = ? AND target_qualified = ?
				AND file_path = ? AND line = ?
		`).get(edge.kind, edge.source, edge.target, filePath, line) as { id: number };
		return row.id;
	}

	removeFileData(filePath: string): void {
		const normalized = normalizePath(filePath);
		const nodeIds = (this.db.prepare(
			'SELECT id FROM nodes WHERE file_path = ?',
		).all(normalized) as { id: number }[]).map(r => r.id);
		runChunked(nodeIds, (chunk, placeholders) => {
			this.db.prepare(
				`DELETE FROM flow_memberships WHERE node_id IN (${placeholders})`,
			).run(...chunk);
		});
		this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(normalized);
		this.db.prepare('DELETE FROM edges WHERE file_path = ?').run(normalized);
	}

	storeFileNodesEdges(filePath: string, nodes: NodeInfo[], edges: EdgeInfo[], fileHash: string = ''): void {
		this._withTransaction(() => {
			this.removeFileData(normalizePath(filePath));
			for (const node of nodes) this.upsertNode(node, fileHash);
			for (const edge of edges) this.upsertEdge(edge);
		});
	}

	private _withTransaction<T>(work: () => T): T {
		const owns = !this.db.inTransaction();
		if (!owns) return work();
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = work();
			this.db.exec('COMMIT');
			return result;
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	getNode(qualifiedName: string): StoredNode | undefined {
		const row = this.db.prepare(
			'SELECT * FROM nodes WHERE qualified_name = ?',
		).get(qualifiedName);
		return row ? rowToStoredNode(row) : undefined;
	}

	getNodesByQualifiedNames(qualifiedNames: string[]): StoredNode[] {
		return runChunked(qualifiedNames, (chunk, placeholders) =>
			this.db.prepare(
				`SELECT * FROM nodes WHERE qualified_name IN (${placeholders})`,
			).all(...chunk),
		).map(rowToStoredNode);
	}

	getNodeById(id: number): StoredNode | undefined {
		const row = this.db.prepare(
			'SELECT * FROM nodes WHERE id = ?',
		).get(id);
		return row ? rowToStoredNode(row) : undefined;
	}

	getNodesByFile(filePath: string): StoredNode[] {
		return this.db.prepare(
			'SELECT * FROM nodes WHERE file_path = ?',
		).all(normalizePath(filePath)).map(rowToStoredNode);
	}

	getNodesByQualifiedSuffix(name: string): StoredNode[] {
		const escaped = name.replace(/[%_]/g, ch => `\\${ch}`);
		return this.db.prepare(
			"SELECT * FROM nodes WHERE qualified_name = ? OR qualified_name LIKE ? ESCAPE '\\'",
		).all(name, `%::${escaped}`).map(rowToStoredNode);
	}

	getFileNodesByStem(name: string): StoredNode[] {
		const escaped = name.replace(/[%_]/g, ch => `\\${ch}`);
		return this.db.prepare(
			"SELECT * FROM nodes WHERE kind = 'File' AND qualified_name LIKE ? ESCAPE '\\'",
		).all(`%::${escaped}.%`).map(rowToStoredNode);
	}

	getNodesByKind(kind: string): StoredNode[] {
		return this.db.prepare(
			'SELECT * FROM nodes WHERE kind = ?',
		).all(kind).map(rowToStoredNode);
	}

	getEdgesBySource(qualifiedName: string): StoredEdge[] {
		return this.db.prepare(
			'SELECT * FROM edges WHERE source_qualified = ?',
		).all(qualifiedName).map(rowToStoredEdge);
	}

	getEdgesByTarget(qualifiedName: string): StoredEdge[] {
		return this.db.prepare(
			'SELECT * FROM edges WHERE target_qualified = ?',
		).all(qualifiedName).map(rowToStoredEdge);
	}

	getEdgesBySources(qualifiedNames: string[]): StoredEdge[] {
		return runChunked(qualifiedNames, (chunk, placeholders) =>
			this.db.prepare(
				`SELECT * FROM edges WHERE source_qualified IN (${placeholders})`,
			).all(...chunk),
		).map(rowToStoredEdge);
	}

	getEdgesByTargets(qualifiedNames: string[]): StoredEdge[] {
		return runChunked(qualifiedNames, (chunk, placeholders) =>
			this.db.prepare(
				`SELECT * FROM edges WHERE target_qualified IN (${placeholders})`,
			).all(...chunk),
		).map(rowToStoredEdge);
	}

	getEdgesByTargetName(name: string, kinds: string[]): StoredEdge[] {
		if (kinds.length === 0) return [];
		const kindPlaceholders = kinds.map(() => '?').join(',');
		const escaped = name.replace(/[%_]/g, ch => `\\${ch}`);
		return this.db.prepare(
			`SELECT * FROM edges WHERE (target_qualified = ? OR target_qualified LIKE ? ESCAPE '\\') AND kind IN (${kindPlaceholders})`,
		).all(name, `%::${escaped}`, ...kinds).map(rowToStoredEdge);
	}

	getEdgesByKinds(kinds: string[]): StoredEdge[] {
		if (kinds.length === 0) return [];
		const placeholders = kinds.map(() => '?').join(',');
		return this.db.prepare(
			`SELECT * FROM edges WHERE kind IN (${placeholders})`,
		).all(...kinds).map(rowToStoredEdge);
	}

	getEdgesAmong(qualifiedNames: Set<string>): StoredEdge[] {
		if (qualifiedNames.size === 0) return [];
		const list = [...qualifiedNames];
		const TEMP_TABLE_THRESHOLD = 250;

		if (list.length >= TEMP_TABLE_THRESHOLD) {
			return this._getEdgesAmongViaTempTable(list);
		}

		const placeholders = list.map(() => '?').join(',');
		return this.db.prepare(
			`SELECT * FROM edges WHERE source_qualified IN (${placeholders}) AND target_qualified IN (${placeholders})`,
		).all(...list, ...list).map(rowToStoredEdge);
	}

	private _getEdgesAmongViaTempTable(list: string[]): StoredEdge[] {
		this.db.exec('CREATE TEMP TABLE IF NOT EXISTS _qn_filter (name TEXT PRIMARY KEY)');
		try {
			this.db.exec('DELETE FROM temp._qn_filter');
			const insert = this.db.prepare('INSERT OR IGNORE INTO temp._qn_filter (name) VALUES (?)');
			for (const name of list) insert.run(name);

			return this.db.prepare(`
				SELECT e.* FROM edges e
					JOIN temp._qn_filter s ON s.name = e.source_qualified
					JOIN temp._qn_filter t ON t.name = e.target_qualified
			`).all().map(rowToStoredEdge);
		} finally {
			this.db.exec('DROP TABLE IF EXISTS temp._qn_filter');
		}
	}

	getAllFiles(): string[] {
		return (this.db.prepare(
			"SELECT DISTINCT file_path FROM nodes WHERE kind = 'File'",
		).all() as { file_path: string }[]).map(r => r.file_path);
	}

	getFileHashIndex(): Map<string, { hash: string | null; nodeCount: number }> {
		const rows = this.db.prepare(
			'SELECT file_path, MAX(file_hash) as hash, COUNT(*) as node_count FROM nodes GROUP BY file_path',
		).all() as { file_path: string; hash: string | null; node_count: number }[];
		const index = new Map<string, { hash: string | null; nodeCount: number }>();
		for (const r of rows) {
			index.set(r.file_path, { hash: r.hash, nodeCount: r.node_count });
		}
		return index;
	}

	getNodeCount(): number {
		return (this.db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number }).cnt;
	}

	getEdgeCount(): number {
		return (this.db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt;
	}

	getStats(): GraphStats {
		const totalNodes = this.getNodeCount();
		const totalEdges = this.getEdgeCount();

		const nodesByKind: Record<string, number> = {};
		for (const r of this.db.prepare('SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind').all() as { kind: string; cnt: number }[]) {
			nodesByKind[r.kind] = r.cnt;
		}

		const edgesByKind: Record<string, number> = {};
		for (const r of this.db.prepare('SELECT kind, COUNT(*) as cnt FROM edges GROUP BY kind').all() as { kind: string; cnt: number }[]) {
			edgesByKind[r.kind] = r.cnt;
		}

		const languages = (this.db.prepare(
			"SELECT DISTINCT language FROM nodes WHERE language IS NOT NULL AND language != ''",
		).all() as { language: string }[]).map(r => r.language);

		const filesCount = (this.db.prepare(
			"SELECT COUNT(*) as cnt FROM nodes WHERE kind = 'File'",
		).get() as { cnt: number }).cnt;

		const lastUpdated = this.getMetadata('last_updated');

		return {
			total_nodes: totalNodes,
			total_edges: totalEdges,
			nodes_by_kind: nodesByKind,
			edges_by_kind: edgesByKind,
			languages,
			files_count: filesCount,
			last_updated: lastUpdated ?? null,
		};
	}

	setMetadata(key: string, value: string): void {
		this.db.prepare(
			'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
		).run(key, value);
	}

	getMetadata(key: string): string | undefined {
		const row = this.db.prepare(
			'SELECT value FROM metadata WHERE key = ?',
		).get(key) as { value: string } | undefined;
		return row?.value;
	}

	async serialize(): Promise<void> {
		if (!this._db) return;
		if (!this._db.isDirty()) {
			log('[Compass] Serialize skipped: no changes since last write');
			return;
		}
		// WAL persists writes continuously; a checkpoint just folds the WAL back into the main file.
		// Only clear dirty when it fully folded — if a concurrent reader blocked it, stay dirty so the
		// next serialize retries the fold instead of leaving the main file stale.
		const folded = this._db.checkpoint();
		if (folded) this._db.clearDirty();
	}

	close(): void {
		if (this._db) {
			this._db.close();
			this._db = null;
		}
	}

	async dispose(): Promise<void> {
		await this.serialize();
		this.close();
	}

	exportData(): Uint8Array {
		return this.db.export();
	}

	getAllEdges(): StoredEdge[] {
		return this.db.prepare('SELECT * FROM edges ORDER BY id').all().map(rowToStoredEdge);
	}

	getAllNodes(): StoredNode[] {
		return this.db.prepare('SELECT * FROM nodes ORDER BY id').all().map(rowToStoredNode);
	}

	getAllNodeQnAndKind(): { qualified_name: string; kind: NodeKind }[] {
		return this.db.prepare('SELECT qualified_name, kind FROM nodes').all() as { qualified_name: string; kind: NodeKind }[];
	}

	getNodesByKinds(kinds: string[]): StoredNode[] {
		if (kinds.length === 0) return [];
		const placeholders = kinds.map(() => '?').join(',');
		return this.db.prepare(
			`SELECT * FROM nodes WHERE kind IN (${placeholders})`,
		).all(...kinds).map(rowToStoredNode);
	}

	getAllCallTargets(): Set<string> {
		const rows = this.db.prepare(
			"SELECT DISTINCT target_qualified FROM edges WHERE kind = 'CALLS'",
		).all() as { target_qualified: string }[];
		return new Set(rows.map(r => r.target_qualified));
	}

	getCallTargetsExcludingFileSources(): Set<string> {
		const rows = this.db.prepare(
			`SELECT DISTINCT e.target_qualified
			 FROM edges e
			 JOIN nodes n ON n.qualified_name = e.source_qualified
			 WHERE e.kind = 'CALLS' AND n.kind <> 'File'`,
		).all() as { target_qualified: string }[];
		return new Set(rows.map(r => r.target_qualified));
	}

	getNodeIdsByFiles(filePaths: string[]): number[] {
		const normalized = filePaths.map(normalizePath);
		const rows = runChunked(normalized, (chunk, placeholders) =>
			this.db.prepare(
				`SELECT id FROM nodes WHERE file_path IN (${placeholders})`,
			).all(...chunk) as { id: number }[],
		);
		return rows.map(r => r.id);
	}

	getFlowIdsByNodeIds(nodeIds: number[]): number[] {
		const rows = runChunked(nodeIds, (chunk, placeholders) =>
			this.db.prepare(
				`SELECT DISTINCT flow_id FROM flow_memberships WHERE node_id IN (${placeholders})`,
			).all(...chunk) as { flow_id: number }[],
		);
		return [...new Set(rows.map(r => r.flow_id))];
	}

	countFlowMemberships(nodeId: number): number {
		const row = this.db.prepare(
			'SELECT COUNT(*) as cnt FROM flow_memberships WHERE node_id = ?',
		).get(nodeId) as { cnt: number };
		return row.cnt;
	}

	getFlowCriticalitiesForNode(nodeId: number): number[] {
		const rows = this.db.prepare(
			'SELECT f.criticality FROM flows f JOIN flow_memberships fm ON fm.flow_id = f.id WHERE fm.node_id = ?',
		).all(nodeId) as { criticality: number }[];
		return rows.map(r => r.criticality);
	}

	getNodeCommunityId(nodeId: number): number | null {
		const row = this.db.prepare(
			'SELECT community_id FROM nodes WHERE id = ?',
		).get(nodeId) as { community_id: number | null } | undefined;
		return row?.community_id ?? null;
	}

	getCommunityIdsByQualifiedNames(qualifiedNames: string[]): Map<string, number | null> {
		const result = new Map<string, number | null>();
		const rows = runChunked(qualifiedNames, (chunk, placeholders) =>
			this.db.prepare(
				`SELECT qualified_name, community_id FROM nodes WHERE qualified_name IN (${placeholders})`,
			).all(...chunk) as { qualified_name: string; community_id: number | null }[],
		);
		for (const r of rows) {
			result.set(r.qualified_name, r.community_id);
		}
		return result;
	}

	getCommunityMemberQns(communityId: number): string[] {
		const rows = this.db.prepare(
			'SELECT qualified_name FROM nodes WHERE community_id = ?',
		).all(communityId) as { qualified_name: string }[];
		return rows.map(r => r.qualified_name);
	}

	resolveGraphFilePaths(paths: string[], workspaceRoot?: string): string[] {
		const results = new Set<string>();
		for (const matches of this.resolveGraphFilePathsGrouped(paths, workspaceRoot).values()) {
			for (const m of matches) results.add(m);
		}
		return [...results];
	}

	resolveGraphFilePathsGrouped(paths: string[], workspaceRoot?: string): Map<string, string[]> {
		const result = new Map<string, string[]>();
		if (paths.length === 0) return result;

		const stored = (this.db.prepare(
			'SELECT DISTINCT file_path FROM nodes',
		).all() as { file_path: string }[]).map(r => r.file_path);

		const isWin = process.platform === 'win32';
		const fold = (s: string): string => (isWin ? s.toLowerCase() : s);

		const storedByFolded = new Map<string, string>();
		for (const s of stored) storedByFolded.set(fold(s), s);

		for (const raw of paths) {
			if (result.has(raw)) continue;
			const matched = new Set<string>();
			const candidates = this._buildPathCandidates(raw, workspaceRoot);

			let exact = false;
			for (const cand of candidates) {
				const hit = storedByFolded.get(fold(cand));
				if (hit) { matched.add(hit); exact = true; }
			}

			if (!exact) {
				for (const cand of candidates) {
					const foldedCand = fold(cand);
					const anchored = '/' + foldedCand;
					for (const s of stored) {
						const foldedStored = fold(s);
						if (foldedStored === foldedCand || foldedStored.endsWith(anchored)) {
							matched.add(s);
						}
					}
				}
			}
			result.set(raw, [...matched]);
		}
		return result;
	}

	private _buildPathCandidates(raw: string, workspaceRoot?: string): string[] {
		const candidates = new Set<string>();
		const norm = normalizePath(raw);
		if (norm) candidates.add(norm);
		if (workspaceRoot) {
			const abs = normalizePath(path.resolve(workspaceRoot, raw));
			if (abs) candidates.add(abs);
			if (path.isAbsolute(raw)) {
				const rel = normalizePath(path.relative(workspaceRoot, raw));
				if (rel && rel !== '..' && !rel.startsWith('../')) candidates.add(rel);
			}
		}
		return [...candidates];
	}

	getCommunityCount(): number {
		return (this.db.prepare('SELECT COUNT(*) as cnt FROM communities').get() as { cnt: number }).cnt;
	}

	getFlowCount(): number {
		return (this.db.prepare('SELECT COUNT(*) as cnt FROM flows').get() as { cnt: number }).cnt;
	}

	searchFts(ftsQuery: string, kind: NodeKind | undefined, limit: number): Array<Record<string, unknown>> {
		const params: unknown[] = [ftsQuery];
		let kindClause = '';
		if (kind) {
			kindClause = 'AND n.kind = ?';
			params.push(kind);
		}
		params.push(limit);
		return this.db.prepare(`
			SELECT n.*, rank AS score
			FROM nodes_fts f
			JOIN nodes n ON n.id = f.rowid
			WHERE nodes_fts MATCH ?
				${kindClause}
			ORDER BY rank
			LIMIT ?
		`).all(...params);
	}

	getNodesLimited(limit: number, communityId?: number | null): StoredNode[] {
		if (communityId != null) {
			return this.db.prepare(
				'SELECT * FROM nodes WHERE community_id = ? ORDER BY id LIMIT ?',
			).all(communityId, limit).map(rowToStoredNode);
		}
		return this.db.prepare(
			'SELECT * FROM nodes ORDER BY id LIMIT ?',
		).all(limit).map(rowToStoredNode);
	}

	execRaw(sql: string, params?: unknown[]): void {
		if (params && params.length > 0) {
			this.db.prepare(sql).run(...params);
		} else {
			this.db.exec(sql);
		}
	}

	queryRaw(sql: string, ...params: unknown[]): Record<string, unknown>[] {
		return this.db.prepare(sql).all(...params);
	}

	runValidation(): ValidationResult {
		return runStoreValidation(this);
	}

	rebuildFtsIndex(): void {
		this._withTransaction(() => {
			this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
		});
	}

	inTransaction(): boolean {
		return this.db.inTransaction();
	}

	resolveExternalEdges(workspaceRoot?: string): number {
		const unresolvedEdges = this.db.prepare(`
			SELECT e.id, e.kind, e.target_qualified, e.file_path FROM edges e
			WHERE e.kind IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON', 'CALLS', 'REFERENCES')
				AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified)
		`).all() as { id: number; kind: string; target_qualified: string; file_path: string }[];

		if (unresolvedEdges.length === 0) return 0;

		const aliasResolver = createAliasResolver(workspaceRoot);
		const actionableEdges = this._dropUnresolvableExternalEdges(unresolvedEdges, aliasResolver);
		if (actionableEdges.length === 0) return 0;

		const allNodes = this.db.prepare(
			"SELECT name, qualified_name, file_path, kind, parent_name FROM nodes WHERE kind != 'File'"
		).all() as { name: string; qualified_name: string; file_path: string; kind: string; parent_name: string | null }[];

		const nodesByName = new Map<string, { qualified_name: string; file_path: string; parent_name: string | null }[]>();
		const classesByFile = new Map<string, { name: string; qualified_name: string }[]>();
		for (const n of allNodes) {
			const lower = n.name.toLowerCase();
			const entry = { qualified_name: n.qualified_name, file_path: n.file_path, parent_name: n.parent_name };
			const list = nodesByName.get(lower);
			if (list) list.push(entry);
			else nodesByName.set(lower, [entry]);

			if (n.kind === 'Class' || n.kind === 'Type') {
				const classEntry = { name: n.name, qualified_name: n.qualified_name };
				const classList = classesByFile.get(n.file_path);
				if (classList) classList.push(classEntry);
				else classesByFile.set(n.file_path, [classEntry]);
			}
		}

		const allFilePaths = this.getAllFiles();
		const fileLowerIndex = allFilePaths.map(f => ({ lower: f.toLowerCase(), original: f }));

		const fileNodes = this.db.prepare(
			"SELECT file_path, qualified_name FROM nodes WHERE kind = 'File'"
		).all() as { file_path: string; qualified_name: string }[];
		const fileQualifiedByPath = new Map<string, string>();
		for (const fn of fileNodes) fileQualifiedByPath.set(fn.file_path, fn.qualified_name);

		const importEdges = this.db.prepare(
			"SELECT file_path, target_qualified FROM edges WHERE kind = 'IMPORTS_FROM'"
		).all() as { file_path: string; target_qualified: string }[];
		const fileImports = new Map<string, Set<string>>();
		for (const ie of importEdges) {
			const resolvedFiles = resolveImportSpecToFiles(ie.target_qualified, ie.file_path, fileLowerIndex, aliasResolver);
			if (resolvedFiles.length === 0) continue;
			let set = fileImports.get(ie.file_path);
			if (!set) { set = new Set(); fileImports.set(ie.file_path, set); }
			for (const f of resolvedFiles) set.add(f);
		}

		return this._withTransaction(() => {
			let resolved = 0;
			const toDelete: number[] = [];
			for (const edge of actionableEdges) {
				const target = edge.target_qualified;
				const isCallOrRef = edge.kind === 'CALLS' || edge.kind === 'REFERENCES';

				if (edge.kind === 'IMPORTS_FROM') {
					const resolvedFiles = resolveImportSpecToFiles(target, edge.file_path, fileLowerIndex, aliasResolver);
					if (resolvedFiles.length === 1) {
						const fileQ = fileQualifiedByPath.get(resolvedFiles[0]!);
						if (fileQ) {
							this.db.prepare(
								'UPDATE OR REPLACE edges SET target_qualified = ? WHERE id = ?',
							).run(fileQ, edge.id);
							resolved++;
						}
					}
					continue;
				}

				if (!isCallOrRef && target.includes('\\')) {
					const parts = target.split('\\');
					const className = parts[parts.length - 1]!;
					const pathSuffix = '/' + parts.join('/').toLowerCase() + '.php';

					let matchedFile: string | null = null;
					for (const f of fileLowerIndex) {
						if (f.lower.endsWith(pathSuffix)) {
							matchedFile = f.original;
							break;
						}
					}

					if (matchedFile) {
						const classes = classesByFile.get(matchedFile) ?? [];
						const matches = classes.filter(c => c.name === className);
						if (matches.length === 1) {
							this.db.prepare(
								'UPDATE OR REPLACE edges SET target_qualified = ? WHERE id = ?',
							).run(matches[0]!.qualified_name, edge.id);
							resolved++;
							continue;
						}
					}
				}

				const shortName = target.replace(/^.*(?:::|\.|[/\\])/, '');
				if (!shortName) {
					if (isCallOrRef) toDelete.push(edge.id);
					continue;
				}

				const candidates = nodesByName.get(shortName.toLowerCase());
				if (!candidates || candidates.length === 0) {
					if (isCallOrRef) toDelete.push(edge.id);
					continue;
				}

				if (isCallOrRef && target.includes('::')) {
					const scopeSegment = target.slice(0, target.lastIndexOf('::'));
					const scope = scopeSegment.slice(scopeSegment.lastIndexOf('\\') + 1).toLowerCase();
					if (scope) {
						const parentMatches = candidates.filter(c => c.parent_name?.toLowerCase() === scope);
						if (parentMatches.length === 1) {
							this.db.prepare(
								'UPDATE OR REPLACE edges SET target_qualified = ? WHERE id = ?',
							).run(parentMatches[0]!.qualified_name, edge.id);
							resolved++;
							continue;
						}
					}
				}

				if (isCallOrRef) {
					const imports = fileImports.get(edge.file_path);
					if (imports && imports.size > 0) {
						const inScope = candidates.filter(c => imports.has(c.file_path));
						if (inScope.length === 1) {
							this.db.prepare(
								'UPDATE OR REPLACE edges SET target_qualified = ? WHERE id = ?',
							).run(inScope[0]!.qualified_name, edge.id);
							resolved++;
							continue;
						}
					}
				}

				if (candidates.length === 1) {
					this.db.prepare(
						'UPDATE OR REPLACE edges SET target_qualified = ? WHERE id = ?',
					).run(candidates[0]!.qualified_name, edge.id);
					resolved++;
					continue;
				}

				const sourceFamily = getLanguageFamily(edge.file_path);
				if (sourceFamily) {
					const sameFamily = candidates.filter(c => getLanguageFamily(c.file_path) === sourceFamily);
					if (sameFamily.length === 1) {
						this.db.prepare(
							'UPDATE OR REPLACE edges SET target_qualified = ? WHERE id = ?',
						).run(sameFamily[0]!.qualified_name, edge.id);
						resolved++;
						continue;
					}
				}

				if (isCallOrRef) toDelete.push(edge.id);
			}

			runChunked(toDelete, (chunk, placeholders) => {
				this.db.prepare(
					`DELETE FROM edges WHERE id IN (${placeholders})`,
				).run(...chunk);
			});

			return resolved;
		});
	}

	/**
	 * Drops unresolved edges whose known-external targets cannot match any resolution path,
	 * so passes where only permanent externals remain skip the full in-memory index build.
	 * CALLS/REFERENCES are exempt (unresolvable ones are deleted, never persisted); every
	 * probe mirrors a resolution path, so a dropped edge is one the resolver would no-op on.
	 */
	private _dropUnresolvableExternalEdges<T extends { kind: string; target_qualified: string; file_path: string }>(
		edges: T[],
		aliasResolver: AliasResolver,
	): T[] {
		const probeCache = new Map<string, boolean>();
		return edges.filter(edge => {
			if (edge.kind === 'CALLS' || edge.kind === 'REFERENCES') return true;
			if (!isAsciiOnly(edge.target_qualified) || !isAsciiOnly(edge.file_path)) return true;
			if (!isKnownExternal(edge.target_qualified)) return true;
			if (edge.kind === 'IMPORTS_FROM') {
				return this._importSpecMayResolve(edge.target_qualified, edge.file_path, aliasResolver, probeCache);
			}
			return this._externalTargetMayMatchNode(edge.target_qualified, probeCache);
		});
	}

	private _importSpecMayResolve(
		spec: string,
		sourceFilePath: string,
		aliasResolver: AliasResolver,
		probeCache: Map<string, boolean>,
	): boolean {
		const trimmed = spec.trim();
		if (!trimmed) return false;
		if (aliasResolver.resolve(trimmed, sourceFilePath) !== null) return true;
		const isRelativeSpec = trimmed.startsWith('./')
			|| trimmed.startsWith('../')
			|| trimmed.startsWith('/')
			|| trimmed.startsWith('.');
		if (!isRelativeSpec) return false;
		return probeWithCache(probeCache, `import:${sourceFilePath}|${trimmed}`, () =>
			this._anyFileMatchingLowerPaths(buildRelativeImportPathCandidates(trimmed, sourceFilePath)));
	}

	private _externalTargetMayMatchNode(target: string, probeCache: Map<string, boolean>): boolean {
		if (target.includes('\\')) {
			const pathSuffix = '/' + target.split('\\').join('/').toLowerCase() + '.php';
			if (probeWithCache(probeCache, `file-suffix:${pathSuffix}`, () => this._anyFileWithPathSuffix(pathSuffix))) {
				return true;
			}
		}
		const shortName = target.replace(/^.*(?:::|\.|[/\\])/, '');
		if (!shortName) return false;
		const lowerName = shortName.toLowerCase();
		return probeWithCache(probeCache, `name:${lowerName}`, () => this._anyNonFileNodeNamed(lowerName));
	}

	private _anyFileMatchingLowerPaths(lowerPaths: string[]): boolean {
		if (lowerPaths.length === 0) return false;
		const placeholders = lowerPaths.map(() => '?').join(',');
		return this.db.prepare(
			`SELECT 1 FROM nodes WHERE kind = 'File' AND LOWER(file_path) IN (${placeholders}) LIMIT 1`,
		).get(...lowerPaths) !== undefined;
	}

	private _anyFileWithPathSuffix(lowerSuffix: string): boolean {
		return this.db.prepare(
			"SELECT 1 FROM nodes WHERE kind = 'File' AND LOWER(file_path) LIKE '%' || ? LIMIT 1",
		).get(lowerSuffix) !== undefined;
	}

	private _anyNonFileNodeNamed(lowerName: string): boolean {
		return this.db.prepare(
			"SELECT 1 FROM nodes WHERE kind != 'File' AND LOWER(name) = ? LIMIT 1",
		).get(lowerName) !== undefined;
	}

	/**
	 * Rederives the full TESTED_BY edge set (source=Test, target=production) from CALLS edges,
	 * then adds a class/file-stem name fallback for DI/mock-heavy tests that never call their
	 * subject directly. Full rebuild rather than delta-scoped: `resolveExternalEdges`
	 * re-resolves CALLS targets graph-wide on every pass, so a moved production symbol can
	 * re-point an unchanged test's edge — without change-data-capture there is no safe
	 * per-file delta. The work is one indexed set-based statement plus a linear name-map pass;
	 * incremental builds gate it on actual graph mutation (a re-extracted or removed file),
	 * so a no-op incremental skips it entirely.
	 */
	buildTestedByEdges(): number {
		return this._withTransaction(() => {
			const now = Date.now() / 1000;
			this.db.exec("DELETE FROM edges WHERE kind = 'TESTED_BY'");
			this.db.prepare(`
				INSERT INTO edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
				SELECT DISTINCT 'TESTED_BY', e.source_qualified, e.target_qualified, src.file_path, 0, '{}', ?
				FROM edges e
				JOIN nodes src ON src.qualified_name = e.source_qualified
				JOIN nodes tgt ON tgt.qualified_name = e.target_qualified
				WHERE e.kind = 'CALLS'
					AND (src.kind = 'Test' OR src.is_test = 1)
					AND tgt.kind IN ('Function', 'Class')
					AND tgt.is_test = 0
			`).run(now);
			this._insertNameDerivedTestedByEdges(now);
			return (this.db.prepare(
				"SELECT COUNT(*) as cnt FROM edges WHERE kind = 'TESTED_BY'",
			).get() as { cnt: number }).cnt;
		});
	}

	/**
	 * Links tests to their subject by stripped test-class name (or file stem when parentless).
	 * Inserts only on an unambiguous production-name match; CALLS-derived rows win conflicts.
	 */
	private _insertNameDerivedTestedByEdges(now: number): void {
		const testNodes = this.db.prepare(
			"SELECT qualified_name, parent_name, file_path FROM nodes WHERE kind = 'Test' OR is_test = 1",
		).all() as { qualified_name: string; parent_name: string | null; file_path: string }[];
		if (testNodes.length === 0) return;

		const productionNodes = this.db.prepare(
			"SELECT name, qualified_name FROM nodes WHERE kind IN ('Class', 'Function', 'Type') AND is_test = 0",
		).all() as { name: string; qualified_name: string }[];

		const productionByLowerName = new Map<string, string[]>();
		for (const p of productionNodes) {
			const lower = p.name.toLowerCase();
			const list = productionByLowerName.get(lower);
			if (list) list.push(p.qualified_name);
			else productionByLowerName.set(lower, [p.qualified_name]);
		}

		const insert = this.db.prepare(`
			INSERT OR IGNORE INTO edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
			VALUES ('TESTED_BY', ?, ?, ?, 0, '{"derived":"name"}', ?)
		`);
		for (const t of testNodes) {
			const subjectKey = stripTestNameAffix(t.parent_name || fileStem(t.file_path));
			if (!subjectKey) continue;
			const candidates = productionByLowerName.get(subjectKey);
			if (!candidates || candidates.length !== 1) continue;
			insert.run(t.qualified_name, candidates[0]!, t.file_path, now);
		}
	}

	withTransaction<T>(work: () => T): T {
		return this._withTransaction(work);
	}
}
