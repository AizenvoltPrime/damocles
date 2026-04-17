import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import { splitIdentifier, qualifyName } from './schema';
import { runMigrations } from './migrations';
import type { NodeInfo, EdgeInfo, StoredNode, StoredEdge, GraphStats, NodeKind, EdgeKind } from './types';
import { isKnownExternal } from './known-externals';
import { TsconfigResolver } from './tsconfig-resolver';
import { ViteAliasResolver } from './vite-alias-resolver';
import { ComposerPsr4Resolver } from './composer-resolver';

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

const TEST_FIXTURE_PATH_RE = /\/(?:__tests__|tests?|spec|e2e)\/(?:[^/]+\/)*fixtures?\//i;
const FIXTURES_DIR_RE = /\/__fixtures__\//i;

function isTestFixtureFile(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	return TEST_FIXTURE_PATH_RE.test(normalized) || FIXTURES_DIR_RE.test(normalized);
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

function getLanguageFamily(filePath: string): string | null {
	const dot = filePath.lastIndexOf('.');
	if (dot === -1) return null;
	const ext = filePath.slice(dot + 1).toLowerCase();
	switch (ext) {
		case 'ts': case 'tsx': case 'js': case 'jsx': case 'vue': return 'js';
		case 'php': return 'php';
		case 'py': return 'python';
		case 'go': return 'go';
		case 'rs': return 'rust';
		case 'java': return 'java';
		case 'cs': return 'csharp';
		case 'rb': return 'ruby';
		case 'kt': return 'kotlin';
		case 'scala': return 'scala';
		case 'c': case 'cpp': case 'cc': case 'cxx': case 'h': case 'hpp': return 'c';
		case 'kts': return 'kotlin';
		default: return null;
	}
}

const IMPORT_RESOLVE_EXTENSIONS = [
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue',
	'.py', '.go', '.rs', '.java', '.cs', '.rb', '.kt', '.kts',
	'.scala', '.php', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
];

interface AliasResolver {
	resolve(spec: string, sourceFilePath: string): string | null;
}

function createAliasResolver(workspaceRoot?: string): AliasResolver {
	const tsResolver = new TsconfigResolver(workspaceRoot);
	const viteResolver = new ViteAliasResolver(workspaceRoot);
	const composerResolver = new ComposerPsr4Resolver(workspaceRoot);
	return {
		resolve(spec: string, sourceFilePath: string): string | null {
			return tsResolver.resolveAlias(spec, sourceFilePath)
				?? viteResolver.resolveAlias(spec, sourceFilePath)
				?? composerResolver.resolveNamespace(spec, sourceFilePath);
		},
	};
}

function resolveImportSpecToFiles(
	spec: string,
	sourceFilePath: string,
	fileLowerIndex: Array<{ lower: string; original: string }>,
	aliasResolver?: AliasResolver,
): string[] {
	const trimmed = spec.trim();
	if (!trimmed) return [];

	if (aliasResolver) {
		const resolvedAbs = aliasResolver.resolve(trimmed, sourceFilePath);
		if (resolvedAbs) {
			const lowerResolved = resolvedAbs.replace(/\\/g, '/').toLowerCase();
			for (const f of fileLowerIndex) {
				if (f.lower === lowerResolved) return [f.original];
			}
		}
	}

	const isRelativeSpec = trimmed.startsWith('./')
		|| trimmed.startsWith('../')
		|| trimmed.startsWith('/')
		|| trimmed.startsWith('.');
	if (!isRelativeSpec && isKnownExternal(trimmed)) return [];

	const normalizedSource = sourceFilePath.replace(/\\/g, '/');
	const lastSlash = normalizedSource.lastIndexOf('/');
	const sourceDir = lastSlash >= 0 ? normalizedSource.substring(0, lastSlash) : '';

	const exactLower: string[] = [];
	const suffixes: string[] = [];

	if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/')) {
		const rootAnchored = trimmed.startsWith('/');
		const parts = rootAnchored ? [] : sourceDir.split('/').filter(Boolean);
		const rel = trimmed.split('/').filter(s => s !== '');
		for (const p of rel) {
			if (p === '.') continue;
			if (p === '..') parts.pop();
			else parts.push(p);
		}
		const prefix = rootAnchored ? '/' : '';
		const resolved = (prefix + parts.join('/')).toLowerCase();
		exactLower.push(resolved);
		for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
			exactLower.push(resolved + ext);
			exactLower.push(resolved + '/index' + ext);
		}
	} else if (trimmed.startsWith('.')) {
		const dotMatch = trimmed.match(/^(\.+)(.*)$/);
		if (!dotMatch) return [];
		const dots = dotMatch[1]!;
		const rest = dotMatch[2]!;
		const parts = sourceDir.split('/').filter(Boolean);
		for (let i = 0; i < dots.length - 1; i++) parts.pop();
		if (rest) {
			for (const p of rest.split('.').filter(Boolean)) parts.push(p);
		}
		const resolved = parts.join('/').toLowerCase();
		exactLower.push(resolved);
		for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
			exactLower.push(resolved + ext);
			exactLower.push(resolved + '/index' + ext);
			exactLower.push(resolved + '/__init__' + ext);
		}
	} else {
		const aliasStripped = trimmed.replace(/^@[^/]+\//, '').toLowerCase();
		const normalized = aliasStripped.replace(/[.\\]/g, '/');
		for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
			suffixes.push('/' + normalized + ext);
			suffixes.push('/' + normalized + '/index' + ext);
			suffixes.push('/' + normalized + '/__init__' + ext);
		}
	}

	const matches: string[] = [];
	for (const f of fileLowerIndex) {
		let matched = false;
		for (const e of exactLower) {
			if (f.lower === e) { matches.push(f.original); matched = true; break; }
		}
		if (matched) continue;
		for (const s of suffixes) {
			if (f.lower.endsWith(s)) { matches.push(f.original); break; }
		}
	}
	return matches;
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

	getEdgesByTargetName(name: string, kinds: string[]): StoredEdge[] {
		if (kinds.length === 0) return [];
		const kindPlaceholders = kinds.map(() => '?').join(',');
		const escaped = name.replace(/[%_]/g, ch => `\\${ch}`);
		return this.db.prepare(
			`SELECT * FROM edges WHERE target_qualified LIKE ? ESCAPE '\\' AND kind IN (${kindPlaceholders})`,
		).all(`%${escaped}`, ...kinds).map(rowToStoredEdge);
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
			this.db.exec('DELETE FROM _qn_filter');
			const insert = this.db.prepare('INSERT OR IGNORE INTO _qn_filter (name) VALUES (?)');
			for (const name of list) insert.run(name);

			return this.db.prepare(`
				SELECT e.* FROM edges e
					JOIN _qn_filter s ON s.name = e.source_qualified
					JOIN _qn_filter t ON t.name = e.target_qualified
			`).all().map(rowToStoredEdge);
		} finally {
			this.db.exec('DROP TABLE IF EXISTS _qn_filter');
		}
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

	runValidation(): {
		orphanedByKind: Record<string, { count: number; entities: string[]; truncated: boolean }>;
		totalByKind: Record<string, number>;
		brokenEdges: { count: number; entities: string[]; truncated: boolean };
		knownExternalRefs: { count: number; entities: string[]; truncated: boolean };
		unresolvedInternalRefs: { count: number; entities: string[]; truncated: boolean };
		communityGaps: { count: number; entities: string[]; truncated: boolean };
		ftsRowCount: number;
		nodeCount: number;
		edgeCount: number;
		fileCount: number;
		communityCount: number;
		filePaths: string[];
	} {
		const CAP = 100;

		this.db.exec('BEGIN DEFERRED');
		try { return this._runValidationInner(CAP); } finally { this.db.exec('COMMIT'); }
	}

	private _runValidationInner(CAP: number): ReturnType<GraphStore['runValidation']> {
		const totalByKind: Record<string, number> = {};
		for (const kind of ['Function', 'Class', 'Type', 'File']) {
			totalByKind[kind] = (this.db.prepare('SELECT COUNT(*) as cnt FROM nodes WHERE kind = ?').get(kind) as { cnt: number }).cnt;
		}

		const orphanedByKind: Record<string, { count: number; entities: string[]; truncated: boolean }> = {};
		for (const kind of ['Function', 'Class', 'Type', 'File']) {
			const countRow = this.db.prepare(`
				SELECT COUNT(*) as cnt FROM nodes n
				WHERE n.kind = ?
					AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_qualified = n.qualified_name)
					AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_qualified = n.qualified_name)
			`).get(kind) as { cnt: number };
			const entities = this.db.prepare(`
				SELECT n.qualified_name FROM nodes n
				WHERE n.kind = ?
					AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_qualified = n.qualified_name)
					AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_qualified = n.qualified_name)
				LIMIT ?
			`).all(kind, CAP) as { qualified_name: string }[];
			orphanedByKind[kind] = {
				count: countRow.cnt,
				entities: entities.map(r => r.qualified_name),
				truncated: countRow.cnt > CAP,
			};
		}

		const brokenCount = this.db.prepare(`
			SELECT COUNT(*) as cnt FROM edges e
			WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.source_qualified)
				OR (e.kind NOT IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON')
					AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified))
		`).get() as { cnt: number };
		const brokenEntities = this.db.prepare(`
			SELECT e.kind || ': ' || e.source_qualified || ' -> ' || e.target_qualified as label FROM edges e
			WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.source_qualified)
				OR (e.kind NOT IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON')
					AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified))
			LIMIT ?
		`).all(CAP) as { label: string }[];

		const UNRESOLVED_CAP = 5000;
		const allUnresolved = this.db.prepare(`
			SELECT e.kind || ': ' || e.target_qualified as label, e.target_qualified as target, e.file_path as filePath FROM edges e
			WHERE e.kind IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON')
				AND EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.source_qualified)
				AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified)
			LIMIT ?
		`).all(UNRESOLVED_CAP) as { label: string; target: string; filePath: string }[];
		const knownExternalLabels: string[] = [];
		const unresolvedInternalLabels: string[] = [];
		for (const row of allUnresolved) {
			if (isTestFixtureFile(row.filePath)) continue;
			if (isKnownExternal(row.target)) {
				knownExternalLabels.push(row.label);
			} else {
				unresolvedInternalLabels.push(row.label);
			}
		}

		const communityGapCount = this.db.prepare(
			"SELECT COUNT(*) as cnt FROM nodes WHERE community_id IS NULL AND kind != 'File'"
		).get() as { cnt: number };
		const communityGapEntities = this.db.prepare(
			"SELECT qualified_name FROM nodes WHERE community_id IS NULL AND kind != 'File' LIMIT ?"
		).all(CAP) as { qualified_name: string }[];

		const ftsRow = this.db.prepare('SELECT COUNT(*) as cnt FROM nodes_fts').get() as { cnt: number };
		const nodeCount = this.getNodeCount();
		const edgeCount = this.getEdgeCount();
		const fileCount = (this.db.prepare("SELECT COUNT(*) as cnt FROM nodes WHERE kind = 'File'").get() as { cnt: number }).cnt;
		const communityCount = this.getCommunityCount();
		const filePaths = this.getAllFiles();

		return {
			orphanedByKind,
			totalByKind,
			brokenEdges: {
				count: brokenCount.cnt,
				entities: brokenEntities.map(r => r.label),
				truncated: brokenCount.cnt > CAP,
			},
			knownExternalRefs: {
				count: knownExternalLabels.length,
				entities: knownExternalLabels.slice(0, CAP),
				truncated: knownExternalLabels.length > CAP,
			},
			unresolvedInternalRefs: {
				count: unresolvedInternalLabels.length,
				entities: unresolvedInternalLabels.slice(0, CAP),
				truncated: unresolvedInternalLabels.length > CAP,
			},
			communityGaps: {
				count: communityGapCount.cnt,
				entities: communityGapEntities.map(r => r.qualified_name),
				truncated: communityGapCount.cnt > CAP,
			},
			ftsRowCount: ftsRow.cnt,
			nodeCount,
			edgeCount,
			fileCount,
			communityCount,
			filePaths,
		};
	}

	resolveExternalEdges(workspaceRoot?: string): number {
		const unresolvedEdges = this.db.prepare(`
			SELECT e.id, e.kind, e.target_qualified, e.file_path FROM edges e
			WHERE e.kind IN ('IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON', 'CALLS', 'REFERENCES')
				AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.qualified_name = e.target_qualified)
		`).all() as { id: number; kind: string; target_qualified: string; file_path: string }[];

		if (unresolvedEdges.length === 0) return 0;

		const allNodes = this.db.prepare(
			"SELECT name, qualified_name, file_path, kind FROM nodes WHERE kind != 'File'"
		).all() as { name: string; qualified_name: string; file_path: string; kind: string }[];

		const nodesByName = new Map<string, { qualified_name: string; file_path: string }[]>();
		const classesByFile = new Map<string, { name: string; qualified_name: string }[]>();
		for (const n of allNodes) {
			const lower = n.name.toLowerCase();
			const entry = { qualified_name: n.qualified_name, file_path: n.file_path };
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
		const aliasResolver = createAliasResolver(workspaceRoot);

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

		let resolved = 0;
		const toDelete: number[] = [];
		this.db.exec('BEGIN IMMEDIATE');
		try {
			for (const edge of unresolvedEdges) {
				const target = edge.target_qualified;
				const isCallOrRef = edge.kind === 'CALLS' || edge.kind === 'REFERENCES';

				if (edge.kind === 'IMPORTS_FROM') {
					const resolvedFiles = resolveImportSpecToFiles(target, edge.file_path, fileLowerIndex, aliasResolver);
					if (resolvedFiles.length === 1) {
						const fileQ = fileQualifiedByPath.get(resolvedFiles[0]!);
						if (fileQ) {
							this.db.prepare(
								'UPDATE edges SET target_qualified = ? WHERE id = ?',
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
								'UPDATE edges SET target_qualified = ? WHERE id = ?',
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

				if (isCallOrRef) {
					const imports = fileImports.get(edge.file_path);
					if (imports && imports.size > 0) {
						const inScope = candidates.filter(c => imports.has(c.file_path));
						if (inScope.length === 1) {
							this.db.prepare(
								'UPDATE edges SET target_qualified = ? WHERE id = ?',
							).run(inScope[0]!.qualified_name, edge.id);
							resolved++;
							continue;
						}
					}
				}

				if (candidates.length === 1) {
					this.db.prepare(
						'UPDATE edges SET target_qualified = ? WHERE id = ?',
					).run(candidates[0]!.qualified_name, edge.id);
					resolved++;
					continue;
				}

				const sourceFamily = getLanguageFamily(edge.file_path);
				if (sourceFamily) {
					const sameFamily = candidates.filter(c => getLanguageFamily(c.file_path) === sourceFamily);
					if (sameFamily.length === 1) {
						this.db.prepare(
							'UPDATE edges SET target_qualified = ? WHERE id = ?',
						).run(sameFamily[0]!.qualified_name, edge.id);
						resolved++;
						continue;
					}
				}

				if (isCallOrRef) toDelete.push(edge.id);
			}

			if (toDelete.length > 0) {
				const BATCH = 400;
				for (let i = 0; i < toDelete.length; i += BATCH) {
					const batch = toDelete.slice(i, i + BATCH);
					const placeholders = batch.map(() => '?').join(',');
					this.db.prepare(
						`DELETE FROM edges WHERE id IN (${placeholders})`,
					).run(...batch);
				}
			}

			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
		return resolved;
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
