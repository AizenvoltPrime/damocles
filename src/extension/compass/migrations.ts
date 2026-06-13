import { SCHEMA_SQL, NODES_FTS_SQL } from './schema';
import { log } from '../logger';

export const CURRENT_SCHEMA_VERSION = 4;
export const CURRENT_EXTRACTION_FORMAT_VERSION = 6;

export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		get(...params: unknown[]): Record<string, unknown> | undefined;
		run(...params: unknown[]): { changes: number };
	};
}

function inTransactionBlock(db: MigrationDb, work: () => void): void {
	db.exec('BEGIN IMMEDIATE');
	try {
		work();
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

function hasMetadataTable(db: MigrationDb): boolean {
	const row = db.prepare(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
	).get();
	return !!row;
}

function readVersion(db: MigrationDb, key: string): number {
	const row = db.prepare(
		'SELECT value FROM metadata WHERE key = ?',
	).get(key) as { value: string } | undefined;
	return row ? parseInt(row.value, 10) : 0;
}

export function getSchemaVersion(db: MigrationDb): number {
	if (!hasMetadataTable(db)) return 0;
	return readVersion(db, 'schema_version');
}

export function getExtractionFormatVersion(db: MigrationDb): number {
	if (!hasMetadataTable(db)) return 0;
	const explicit = readVersion(db, 'extraction_format_version');
	if (explicit > 0) return explicit;
	const legacySchema = readVersion(db, 'schema_version');
	return legacySchema >= 2 ? 1 : 0;
}

export function runMigrations(db: MigrationDb): void {
	runSchemaMigrations(db);
	runExtractionFormatMigrations(db);
}

function runSchemaMigrations(db: MigrationDb): void {
	const current = getSchemaVersion(db);
	if (current >= CURRENT_SCHEMA_VERSION) return;

	log(`[Compass] Running schema migrations from v${current} to v${CURRENT_SCHEMA_VERSION}`);

	if (current < 1) {
		inTransactionBlock(db, () => {
			db.exec(SCHEMA_SQL);
			db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('schema_version', String(CURRENT_SCHEMA_VERSION));
		});
		log(`[Compass] Fresh schema installed at v${CURRENT_SCHEMA_VERSION}`);
		return;
	}

	if (current < 2) {
		inTransactionBlock(db, () => {
			db.exec('CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target_qualified, kind)');
			db.exec('CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source_qualified, kind)');
			db.exec('CREATE INDEX IF NOT EXISTS idx_edges_composite ON edges(kind, source_qualified, target_qualified)');
			db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('schema_version', '2');
		});
		log('[Compass] Schema migration v2: compound edge indexes created');
	}

	if (current < 3) {
		inTransactionBlock(db, () => {
			const colRow = db.prepare(
				"SELECT COUNT(*) as cnt FROM pragma_table_info('nodes') WHERE name = 'search_aux'",
			).get() as { cnt: number } | undefined;
			if (!colRow || colRow.cnt === 0) {
				db.exec('ALTER TABLE nodes ADD COLUMN search_aux TEXT');
			}
			db.exec('DROP TRIGGER IF EXISTS nodes_fts_ai');
			db.exec('DROP TRIGGER IF EXISTS nodes_fts_ad');
			db.exec('DROP TRIGGER IF EXISTS nodes_fts_au');
			db.exec('DROP TABLE IF EXISTS nodes_fts');
			db.exec(NODES_FTS_SQL);
			// Repopulate the recreated external-content index from existing rows; triggers
			// only fire on future writes, and hash-skipped files are never re-upserted.
			db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
			db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('schema_version', '3');
		});
		log('[Compass] Schema migration v3: search_aux column added and FTS index rebuilt with enriched columns');
	}

	if (current < 4) {
		inTransactionBlock(db, () => {
			db.exec('UPDATE edges SET line = 0 WHERE line IS NULL');
			db.exec(`
				DELETE FROM edges WHERE id NOT IN (
					SELECT MIN(id) FROM edges
					GROUP BY kind, source_qualified, target_qualified, file_path, line
				)
			`);
			db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(kind, source_qualified, target_qualified, file_path, line)');
			db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('schema_version', '4');
		});
		log('[Compass] Schema migration v4: duplicate edges removed and unique edge index created');
	}
}

function isGraphEmpty(db: MigrationDb): boolean {
	const row = db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number } | undefined;
	return !row || row.cnt === 0;
}

function stampExtractionFormatVersion(db: MigrationDb, version: number): void {
	inTransactionBlock(db, () => {
		db.prepare(
			'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
		).run('extraction_format_version', String(version));
	});
}

function resetGraphTablesAndStampVersion(db: MigrationDb, version: number, logMessage: string): void {
	inTransactionBlock(db, () => {
		db.exec('DELETE FROM flow_memberships');
		db.exec('DELETE FROM flows');
		db.exec('DELETE FROM edges');
		db.exec('DELETE FROM nodes');
		db.exec('DELETE FROM communities');
		db.prepare(
			'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
		).run('extraction_format_version', String(version));
	});
	log(logMessage);
}

const EXTRACTION_FORMAT_RESET_LOGS: Record<number, string> = {
	1: '[Compass] Extraction-format v1: graph data reset for re-extraction (cross-file CALLS/REFERENCES, anonymous-arrow/IIFE attribution, internal IMPORTS_FROM → File, nested-class parent chain)',
	2: '[Compass] Extraction format v1 → v2: clearing graph for re-extraction (this triggers a full re-index on next session)',
	3: '[Compass] Extraction format v2 → v3: clearing graph so File nodes can be re-tagged with no_callable_entities for accurate orphan classification',
	4: '[Compass] Extraction format v3 → v4: clearing graph for re-extraction (Rust #[test] attributes classified, derived TESTED_BY edges, enriched FTS search_aux index)',
	5: '[Compass] Extraction format v4 → v5: clearing graph for re-extraction (constructor/scoped-call CALLS, receiver REFERENCES across all languages, annotation/camelCase test classification, scoped-target + name-fallback TESTED_BY)',
	6: '[Compass] Extraction format v5 → v6: clearing graph for re-extraction (type-position REFERENCES from param/constructor-promotion/property/return type hints and generic args across all typed languages)',
};

function runExtractionFormatMigrations(db: MigrationDb): void {
	const current = getExtractionFormatVersion(db);
	if (current >= CURRENT_EXTRACTION_FORMAT_VERSION) return;

	log(`[Compass] Running extraction-format migrations from v${current} to v${CURRENT_EXTRACTION_FORMAT_VERSION}`);

	if (isGraphEmpty(db)) {
		stampExtractionFormatVersion(db, CURRENT_EXTRACTION_FORMAT_VERSION);
		log(`[Compass] Fresh database — extraction format stamped at v${CURRENT_EXTRACTION_FORMAT_VERSION} without table resets`);
		return;
	}

	for (let target = current + 1; target <= CURRENT_EXTRACTION_FORMAT_VERSION; target++) {
		const message = EXTRACTION_FORMAT_RESET_LOGS[target] ?? `[Compass] Extraction format v${target - 1} → v${target}: clearing graph for re-extraction`;
		resetGraphTablesAndStampVersion(db, target, message);
	}
}
