import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import { splitIdentifier, qualifyName } from './schema';
import { runMigrations } from './migrations';
import type { NodeInfo, EdgeInfo, StoredNode, StoredEdge, GraphStats, NodeKind, EdgeKind } from './types';

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

export interface SqlJsStatic {
	Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

interface SqlJsDatabase {
	run(sql: string, params?: unknown[]): SqlJsDatabase;
	exec(sql: string): { columns: string[]; values: unknown[][] }[];
	prepare(sql: string): SqlJsStatement;
	getRowsModified(): number;
	export(): Uint8Array;
	close(): void;
}

interface SqlJsStatement {
	bind(params?: unknown[]): boolean;
	step(): boolean;
	getAsObject(): Record<string, unknown>;
	free(): boolean;
}

interface RunResult {
	changes: number;
}

export interface PreparedStatement {
	run(...params: unknown[]): RunResult;
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

export interface DbWrapper {
	prepare(sql: string): PreparedStatement;
	exec(sql: string): void;
	export(): Uint8Array;
	close(): void;
}

function createWrapper(sqlDb: SqlJsDatabase): DbWrapper {
	return {
		prepare(sql: string): PreparedStatement {
			return {
				run(...params: unknown[]): RunResult {
					sqlDb.run(sql, params);
					return { changes: sqlDb.getRowsModified() };
				},
				get(...params: unknown[]): Record<string, unknown> | undefined {
					const stmt = sqlDb.prepare(sql);
					try {
						if (params.length) stmt.bind(params);
						if (stmt.step()) return stmt.getAsObject();
						return undefined;
					} finally {
						stmt.free();
					}
				},
				all(...params: unknown[]): Record<string, unknown>[] {
					const stmt = sqlDb.prepare(sql);
					try {
						if (params.length) stmt.bind(params);
						const results: Record<string, unknown>[] = [];
						while (stmt.step()) results.push(stmt.getAsObject());
						return results;
					} finally {
						stmt.free();
					}
				},
			};
		},
		exec(sql: string): void {
			sqlDb.exec(sql);
		},
		export(): Uint8Array {
			return sqlDb.export();
		},
		close(): void {
			sqlDb.close();
		},
	};
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

	async open(extensionPath: string): Promise<void> {
		const wasmPath = path.join(extensionPath, 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
		const wasmBinary = await fs.promises.readFile(wasmPath);

		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const initSqlJs = require('sql.js-fts5');
		const SQL: SqlJsStatic = await initSqlJs({ wasmBinary });

		let data: Buffer | undefined;
		try {
			data = await fs.promises.readFile(this._dbPath);
		} catch {
			log(`[Compass] No existing DB at ${this._dbPath}, creating new`);
		}

		this._initFromEngine(SQL, data);
	}

	openFromEngine(engine: SqlJsStatic, data?: Uint8Array): void {
		this._initFromEngine(engine, data);
	}

	private _initFromEngine(engine: SqlJsStatic, data?: ArrayLike<number>): void {
		const sqlDb = data ? new engine.Database(data) : new engine.Database();
		sqlDb.exec('PRAGMA journal_mode = MEMORY');
		sqlDb.exec('PRAGMA foreign_keys = ON');
		this._db = createWrapper(sqlDb);
		runMigrations(this._db);
	}

	upsertNode(node: NodeInfo, fileHash: string = ''): number {
		const now = Date.now() / 1000;
		const filePath = normalizePath(node.file_path);
		const qualified = qualifyName(node.name, filePath, node.parent_name);
		const nameTokens = splitIdentifier(node.name);
		const extra = node.extra ? JSON.stringify(node.extra) : '{}';

		this.db.prepare(`
			INSERT INTO nodes
				(kind, name, name_tokens, qualified_name, file_path, line_start, line_end,
				 language, parent_name, params, return_type, modifiers, signature,
				 is_test, file_hash, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(qualified_name) DO UPDATE SET
				kind=excluded.kind, name=excluded.name, name_tokens=excluded.name_tokens,
				file_path=excluded.file_path, line_start=excluded.line_start,
				line_end=excluded.line_end, language=excluded.language,
				parent_name=excluded.parent_name, params=excluded.params,
				return_type=excluded.return_type, modifiers=excluded.modifiers,
				signature=excluded.signature, is_test=excluded.is_test,
				file_hash=excluded.file_hash, extra=excluded.extra,
				updated_at=excluded.updated_at
		`).run(
			node.kind, node.name, nameTokens, qualified, filePath,
			node.line_start, node.line_end,
			node.language ?? null, node.parent_name ?? null,
			node.params ?? null, node.return_type ?? null,
			node.modifiers ?? null, node.signature ?? null,
			node.is_test ? 1 : 0, fileHash || null,
			extra, now,
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

		const existing = this.db.prepare(`
			SELECT id FROM edges
			WHERE kind = ? AND source_qualified = ? AND target_qualified = ?
				AND file_path = ? AND line = ?
		`).get(edge.kind, edge.source, edge.target, filePath, line) as { id: number } | undefined;

		if (existing) {
			this.db.prepare(
				'UPDATE edges SET extra = ?, updated_at = ? WHERE id = ?',
			).run(extra, now, existing.id);
			return existing.id;
		}

		this.db.prepare(`
			INSERT INTO edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(edge.kind, edge.source, edge.target, filePath, line, extra, now);

		const row = this.db.prepare(
			'SELECT last_insert_rowid() as id',
		).get() as { id: number };
		return row.id;
	}

	removeFileData(filePath: string): void {
		const normalized = normalizePath(filePath);
		const nodeIds = this.db.prepare(
			'SELECT id FROM nodes WHERE file_path = ?',
		).all(normalized) as { id: number }[];
		if (nodeIds.length > 0) {
			const placeholders = nodeIds.map(() => '?').join(',');
			const ids = nodeIds.map(r => r.id);
			this.db.prepare(
				`DELETE FROM flow_memberships WHERE node_id IN (${placeholders})`,
			).run(...ids);
		}
		this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(normalized);
		this.db.prepare('DELETE FROM edges WHERE file_path = ?').run(normalized);
	}

	storeFileNodesEdges(filePath: string, nodes: NodeInfo[], edges: EdgeInfo[], fileHash: string = ''): void {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			this.removeFileData(normalizePath(filePath));
			for (const node of nodes) this.upsertNode(node, fileHash);
			for (const edge of edges) this.upsertEdge(edge);
			this.db.exec('COMMIT');
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

	getEdgesAmong(qualifiedNames: Set<string>): StoredEdge[] {
		if (qualifiedNames.size === 0) return [];
		const list = [...qualifiedNames];
		const BATCH_SIZE = 400;
		if (list.length <= BATCH_SIZE) {
			const placeholders = list.map(() => '?').join(',');
			return this.db.prepare(
				`SELECT * FROM edges WHERE source_qualified IN (${placeholders}) AND target_qualified IN (${placeholders})`,
			).all(...list, ...list).map(rowToStoredEdge);
		}

		const results: StoredEdge[] = [];
		const seen = new Set<number>();
		for (let i = 0; i < list.length; i += BATCH_SIZE) {
			const batch = list.slice(i, i + BATCH_SIZE);
			const placeholders = batch.map(() => '?').join(',');
			const rows = this.db.prepare(
				`SELECT * FROM edges WHERE source_qualified IN (${placeholders}) AND target_qualified IN (${placeholders})`,
			).all(...batch, ...batch).map(rowToStoredEdge);
			for (const edge of rows) {
				if (qualifiedNames.has(edge.source_qualified) && qualifiedNames.has(edge.target_qualified) && !seen.has(edge.id)) {
					seen.add(edge.id);
					results.push(edge);
				}
			}
		}
		return results;
	}

	getAllFiles(): string[] {
		return (this.db.prepare(
			"SELECT DISTINCT file_path FROM nodes WHERE kind = 'File'",
		).all() as { file_path: string }[]).map(r => r.file_path);
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
		const dir = path.dirname(this._dbPath);
		await fs.promises.mkdir(dir, { recursive: true });
		const data = this._db.export();
		const tmpPath = this._dbPath + '.tmp';
		await fs.promises.writeFile(tmpPath, Buffer.from(data));
		await fs.promises.rename(tmpPath, this._dbPath);
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

	getNodeIdsByFiles(filePaths: string[]): number[] {
		if (filePaths.length === 0) return [];
		const normalized = filePaths.map(normalizePath);
		const placeholders = normalized.map(() => '?').join(',');
		const rows = this.db.prepare(
			`SELECT id FROM nodes WHERE file_path IN (${placeholders})`,
		).all(...normalized) as { id: number }[];
		return rows.map(r => r.id);
	}

	getFlowIdsByNodeIds(nodeIds: number[]): number[] {
		if (nodeIds.length === 0) return [];
		const placeholders = nodeIds.map(() => '?').join(',');
		const rows = this.db.prepare(
			`SELECT DISTINCT flow_id FROM flow_memberships WHERE node_id IN (${placeholders})`,
		).all(...nodeIds) as { flow_id: number }[];
		return rows.map(r => r.flow_id);
	}

	countFlowMemberships(nodeId: number): number {
		const row = this.db.prepare(
			'SELECT COUNT(*) as cnt FROM flow_memberships WHERE node_id = ?',
		).get(nodeId) as { cnt: number };
		return row.cnt;
	}

	getNodeCommunityId(nodeId: number): number | null {
		const row = this.db.prepare(
			'SELECT community_id FROM nodes WHERE id = ?',
		).get(nodeId) as { community_id: number | null } | undefined;
		return row?.community_id ?? null;
	}

	getCommunityIdsByQualifiedNames(qualifiedNames: string[]): Map<string, number | null> {
		const result = new Map<string, number | null>();
		if (qualifiedNames.length === 0) return result;
		const placeholders = qualifiedNames.map(() => '?').join(',');
		const rows = this.db.prepare(
			`SELECT qualified_name, community_id FROM nodes WHERE qualified_name IN (${placeholders})`,
		).all(...qualifiedNames) as { qualified_name: string; community_id: number | null }[];
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

	getFilesMatchingSuffix(suffix: string): string[] {
		const normalized = normalizePath(suffix);
		const escaped = normalized.replace(/[%_]/g, ch => `\\${ch}`);
		const rows = this.db.prepare(
			"SELECT DISTINCT file_path FROM nodes WHERE file_path LIKE ? ESCAPE '\\'",
		).all(`%${escaped}`) as { file_path: string }[];
		return rows.map(r => r.file_path);
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

	beginTransaction(): void {
		this.db.exec('BEGIN IMMEDIATE');
	}

	commitTransaction(): void {
		this.db.exec('COMMIT');
	}

	rollbackTransaction(): void {
		this.db.exec('ROLLBACK');
	}
}
