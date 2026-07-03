import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GraphStore } from '../database';
import { SCHEMA_SQL } from '../schema';
import {
	getSchemaVersion,
	getExtractionFormatVersion,
	runMigrations,
	CURRENT_SCHEMA_VERSION,
	CURRENT_EXTRACTION_FORMAT_VERSION,
} from '../migrations';
import { createTestStore, testDbPath } from './sql-test-helper';

type RawDb = InstanceType<typeof DatabaseSync>;
type SqlParam = string | number | null;

function run(db: RawDb, sql: string, params: SqlParam[] = []): void {
	db.prepare(sql).run(...params);
}

// Build an old-format DB at a temp file (node:sqlite writes standard SQLite format), then reopen it
// file-backed so runMigrations executes exactly as it would on a real on-disk graph.db.
function buildDbFile(build: (db: RawDb) => void): string {
	const dbPath = testDbPath();
	const db = new DatabaseSync(dbPath);
	build(db);
	db.close();
	return dbPath;
}

interface RawEdgeRow {
	id: number;
	kind: string;
	source: string;
	target: string;
	filePath: string;
	line: number | null;
}

function buildV3Database(edges: RawEdgeRow[]): string {
	return buildDbFile(db => {
		db.exec(SCHEMA_SQL);
		db.exec('DROP INDEX idx_edges_unique');
		run(db,
			'INSERT INTO metadata (key, value) VALUES (?, ?), (?, ?)',
			['schema_version', '3', 'extraction_format_version', String(CURRENT_EXTRACTION_FORMAT_VERSION)],
		);
		for (const e of edges) {
			run(db,
				'INSERT INTO edges (id, kind, source_qualified, target_qualified, file_path, line, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				[e.id, e.kind, e.source, e.target, e.filePath, e.line, '{}', 1000],
			);
		}
	});
}

function openStoreFrom(dbPath: string): GraphStore {
	return GraphStore.openAt(dbPath);
}

function hasUniqueEdgeIndex(store: GraphStore): boolean {
	return store.queryRaw(
		"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_edges_unique'",
	).length === 1;
}

const LEGACY_NODES_FTS_SQL = `
CREATE VIRTUAL TABLE nodes_fts USING fts5(
    name, name_tokens, qualified_name, file_path, signature,
    content=nodes, content_rowid=id,
    tokenize='porter unicode61'
);

CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES (NEW.id, NEW.name, NEW.name_tokens, NEW.qualified_name, NEW.file_path, NEW.signature);
END;

CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES ('delete', OLD.id, OLD.name, OLD.name_tokens, OLD.qualified_name, OLD.file_path, OLD.signature);
END;

CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES ('delete', OLD.id, OLD.name, OLD.name_tokens, OLD.qualified_name, OLD.file_path, OLD.signature);
    INSERT INTO nodes_fts(rowid, name, name_tokens, qualified_name, file_path, signature)
    VALUES (NEW.id, NEW.name, NEW.name_tokens, NEW.qualified_name, NEW.file_path, NEW.signature);
END;
`;

const LEGACY_SCHEMA_SQL = `
CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_tokens TEXT NOT NULL,
    qualified_name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    language TEXT,
    parent_name TEXT,
    params TEXT,
    return_type TEXT,
    modifiers TEXT,
    signature TEXT,
    is_test INTEGER DEFAULT 0,
    file_hash TEXT,
    community_id INTEGER,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);

CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source_qualified TEXT NOT NULL,
    target_qualified TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line INTEGER,
    extra TEXT DEFAULT '{}',
    updated_at REAL NOT NULL
);

CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entry_point_id INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    criticality REAL NOT NULL DEFAULT 0.0,
    path_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE flow_memberships (
    flow_id INTEGER NOT NULL,
    node_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (flow_id, node_id)
);

CREATE TABLE communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER,
    cohesion REAL NOT NULL DEFAULT 0.0,
    size INTEGER NOT NULL DEFAULT 0,
    dominant_language TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

${LEGACY_NODES_FTS_SQL}
CREATE INDEX idx_nodes_file ON nodes(file_path);
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_nodes_qualified ON nodes(qualified_name);
CREATE INDEX idx_nodes_community ON nodes(community_id);
CREATE INDEX idx_edges_source ON edges(source_qualified);
CREATE INDEX idx_edges_target ON edges(target_qualified);
CREATE INDEX idx_edges_kind ON edges(kind);
CREATE INDEX idx_edges_file ON edges(file_path);
`;

const V2_EDGE_INDEXES_SQL = `
CREATE INDEX idx_edges_target_kind ON edges(target_qualified, kind);
CREATE INDEX idx_edges_source_kind ON edges(source_qualified, kind);
CREATE INDEX idx_edges_composite ON edges(kind, source_qualified, target_qualified);
`;

function seedGraphRows(db: RawDb): void {
	const insertNode = 'INSERT INTO nodes (kind, name, name_tokens, qualified_name, file_path, line_start, line_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
	run(db, insertNode, ['File', 'a.ts', 'a ts', 'a.ts::a.ts', 'a.ts', 1, 50, 1000]);
	run(db, insertNode, ['Function', 'alphaHelper', 'alpha helper', 'a.ts::alphaHelper', 'a.ts', 2, 10, 1000]);
	run(db, insertNode, ['Function', 'betaHelper', 'beta helper', 'a.ts::betaHelper', 'a.ts', 12, 20, 1000]);
	const insertEdge = 'INSERT INTO edges (id, kind, source_qualified, target_qualified, file_path, line, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
	run(db, insertEdge, [1, 'CALLS', 'a.ts::alphaHelper', 'a.ts::betaHelper', 'a.ts', 5, 1000]);
	run(db, insertEdge, [2, 'CONTAINS', 'a.ts::a.ts', 'a.ts::alphaHelper', 'a.ts', 2, 1000]);
}

function buildLegacyDatabase(schemaVersion: 1 | 2): string {
	return buildDbFile(db => {
		db.exec(LEGACY_SCHEMA_SQL);
		if (schemaVersion === 2) db.exec(V2_EDGE_INDEXES_SQL);
		run(db,
			'INSERT INTO metadata (key, value) VALUES (?, ?), (?, ?)',
			['schema_version', String(schemaVersion), 'extraction_format_version', String(CURRENT_EXTRACTION_FORMAT_VERSION)],
		);
		seedGraphRows(db);
	});
}

function hasIndex(store: GraphStore, name: string): boolean {
	return store.queryRaw(
		"SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", name,
	).length === 1;
}

function countOf(store: GraphStore, sql: string): number {
	return Number((store.queryRaw(sql)[0] as { cnt: number }).cnt);
}

function hasSearchAuxColumn(store: GraphStore): boolean {
	return countOf(store, "SELECT COUNT(*) as cnt FROM pragma_table_info('nodes') WHERE name = 'search_aux'") === 1;
}

function expectSeededGraphMigrated(store: GraphStore): void {
	expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
	expect(store.queryRaw('SELECT qualified_name FROM nodes ORDER BY id').map(r => r.qualified_name)).toEqual([
		'a.ts::a.ts',
		'a.ts::alphaHelper',
		'a.ts::betaHelper',
	]);
	expect(store.getAllEdges().map(e => ({ id: e.id, kind: e.kind, source: e.source_qualified, target: e.target_qualified }))).toEqual([
		{ id: 1, kind: 'CALLS', source: 'a.ts::alphaHelper', target: 'a.ts::betaHelper' },
		{ id: 2, kind: 'CONTAINS', source: 'a.ts::a.ts', target: 'a.ts::alphaHelper' },
	]);
	expect(hasIndex(store, 'idx_edges_target_kind')).toBe(true);
	expect(hasIndex(store, 'idx_edges_source_kind')).toBe(true);
	expect(hasIndex(store, 'idx_edges_composite')).toBe(true);
	expect(hasUniqueEdgeIndex(store)).toBe(true);
	expect(hasSearchAuxColumn(store)).toBe(true);
	expect(countOf(store, 'SELECT COUNT(*) as cnt FROM nodes_fts_docsize')).toBe(3);
}

describe('schema v4 migration', () => {
	it('dedupes duplicate edges keeping the lowest id and creates the unique index', () => {
		const store = openStoreFrom(buildV3Database([
			{ id: 1, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: 10 },
			{ id: 2, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: 20 },
			{ id: 3, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: 10 },
			{ id: 4, kind: 'IMPORTS_FROM', source: 'a.ts::a.ts', target: 'b.ts::b.ts', filePath: 'a.ts', line: 1 },
			{ id: 5, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: 10 },
		]));

		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(store.getAllEdges().map(e => e.id)).toEqual([1, 2, 4]);
		expect(hasUniqueEdgeIndex(store)).toBe(true);
		store.close();
	});

	it('normalizes NULL line to 0 before deduping', () => {
		const store = openStoreFrom(buildV3Database([
			{ id: 1, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: null },
			{ id: 2, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: 0 },
			{ id: 3, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: null },
		]));

		const edges = store.getAllEdges();
		expect(edges).toHaveLength(1);
		expect(edges[0]!.id).toBe(1);
		expect(edges[0]!.line).toBe(0);
		store.close();
	});

	it('is a no-op when re-run on an already-migrated database', () => {
		const store = openStoreFrom(buildV3Database([
			{ id: 1, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: 10 },
			{ id: 2, kind: 'CALLS', source: 'a.ts::x', target: 'a.ts::y', filePath: 'a.ts', line: 10 },
		]));
		const migratedEdges = store.getAllEdges();

		runMigrations(store.db);

		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(store.getAllEdges()).toEqual(migratedEdges);
		expect(hasUniqueEdgeIndex(store)).toBe(true);
		store.close();
	});

	it('installs the unique index on a fresh database via SCHEMA_SQL', () => {
		const store = createTestStore();

		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(hasUniqueEdgeIndex(store)).toBe(true);
		store.close();
	});
});

describe('fresh install', () => {
	it('stamps the latest schema and extraction-format versions without table resets', () => {
		const store = createTestStore();

		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
		expect(countOf(store, 'SELECT COUNT(*) as cnt FROM nodes')).toBe(0);
		store.close();
	});
});

describe('schema migration chains', () => {
	it('migrates a seeded v1 database to the latest schema preserving nodes and edges', () => {
		const store = openStoreFrom(buildLegacyDatabase(1));

		expectSeededGraphMigrated(store);
		store.close();
	});

	it('migrates a seeded v2 database to the latest schema preserving nodes and edges', () => {
		const store = openStoreFrom(buildLegacyDatabase(2));

		expectSeededGraphMigrated(store);
		store.close();
	});

	it('v3 rebuilds the FTS index with search_aux at row parity with nodes', () => {
		const store = openStoreFrom(buildLegacyDatabase(2));

		const nodeCount = countOf(store, 'SELECT COUNT(*) as cnt FROM nodes');
		expect(nodeCount).toBe(3);
		expect(countOf(store, 'SELECT COUNT(*) as cnt FROM nodes_fts_docsize')).toBe(nodeCount);
		expect(hasSearchAuxColumn(store)).toBe(true);
		expect(store.queryRaw("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'alpha'")).toHaveLength(1);
		store.close();
	});

	it('re-running all migrations on a fully migrated database is byte-identical', () => {
		const store = openStoreFrom(buildLegacyDatabase(1));
		const before = store.exportData();

		runMigrations(store.db);

		const after = store.exportData();
		expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
		store.close();
	});
});

describe('extraction-format reset chain', () => {
	it('wipes graph tables and stamps the latest extraction-format version', () => {
		const dbPath = buildDbFile(db => {
			db.exec(SCHEMA_SQL);
			run(db,
				'INSERT INTO metadata (key, value) VALUES (?, ?), (?, ?)',
				['schema_version', String(CURRENT_SCHEMA_VERSION), 'extraction_format_version', '2'],
			);
			seedGraphRows(db);
			run(db, "INSERT INTO flows (name, entry_point_id, depth, node_count, file_count, path_json) VALUES ('flow', 2, 1, 2, 1, '[]')");
			run(db, 'INSERT INTO flow_memberships (flow_id, node_id, position) VALUES (1, 2, 0)');
			run(db, "INSERT INTO communities (name) VALUES ('core')");
		});

		const store = openStoreFrom(dbPath);

		for (const table of ['nodes', 'edges', 'flows', 'flow_memberships', 'communities']) {
			expect(countOf(store, `SELECT COUNT(*) as cnt FROM ${table}`)).toBe(0);
		}
		expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
		expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
		store.close();
	});
});

describe('existing-format DB compatibility', () => {
	// A DB file produced outside GraphStore (standard SQLite format) must open + be queryable
	// unchanged under the file-backed node:sqlite engine (no migration/reset when already current).
	it('opens a pre-existing current-schema DB file and reads its rows', () => {
		const dbPath = buildDbFile(db => {
			db.exec(SCHEMA_SQL);
			run(db,
				'INSERT INTO metadata (key, value) VALUES (?, ?), (?, ?)',
				['schema_version', String(CURRENT_SCHEMA_VERSION), 'extraction_format_version', String(CURRENT_EXTRACTION_FORMAT_VERSION)],
			);
			seedGraphRows(db);
		});

		const store = openStoreFrom(dbPath);
		try {
			expect(getSchemaVersion(store.db)).toBe(CURRENT_SCHEMA_VERSION);
			expect(getExtractionFormatVersion(store.db)).toBe(CURRENT_EXTRACTION_FORMAT_VERSION);
			expect(countOf(store, 'SELECT COUNT(*) as cnt FROM nodes')).toBe(3);
			expect(store.getAllEdges().map(e => e.id)).toEqual([1, 2]);
			expect(store.queryRaw("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'alpha'")).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
