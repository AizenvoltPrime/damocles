import { SCHEMA_SQL } from './schema';
import { log } from '../logger';

export const CURRENT_SCHEMA_VERSION = 2;
export const CURRENT_EXTRACTION_FORMAT_VERSION = 3;

export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		get(...params: unknown[]): Record<string, unknown> | undefined;
		run(...params: unknown[]): { changes: number };
	};
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
		db.exec('BEGIN IMMEDIATE');
		try {
			db.exec(SCHEMA_SQL);
			db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('schema_version', String(CURRENT_SCHEMA_VERSION));
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
		log(`[Compass] Fresh schema installed at v${CURRENT_SCHEMA_VERSION}`);
		return;
	}

	if (current < 2) {
		db.exec('BEGIN IMMEDIATE');
		try {
			db.exec('CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target_qualified, kind)');
			db.exec('CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source_qualified, kind)');
			db.exec('CREATE INDEX IF NOT EXISTS idx_edges_composite ON edges(kind, source_qualified, target_qualified)');
			db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('schema_version', '2');
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
		log('[Compass] Schema migration v2: compound edge indexes created');
	}
}

function isGraphEmpty(db: MigrationDb): boolean {
	const row = db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number } | undefined;
	return !row || row.cnt === 0;
}

function stampExtractionFormatVersion(db: MigrationDb, version: number): void {
	db.exec('BEGIN IMMEDIATE');
	try {
		db.prepare(
			'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
		).run('extraction_format_version', String(version));
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

function resetGraphTablesAndStampVersion(db: MigrationDb, version: number, logMessage: string): void {
	db.exec('BEGIN IMMEDIATE');
	try {
		db.exec('DELETE FROM flow_memberships');
		db.exec('DELETE FROM flows');
		db.exec('DELETE FROM edges');
		db.exec('DELETE FROM nodes');
		db.exec('DELETE FROM communities');
		db.prepare(
			'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
		).run('extraction_format_version', String(version));
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	log(logMessage);
}

const EXTRACTION_FORMAT_RESET_LOGS: Record<number, string> = {
	1: '[Compass] Extraction-format v1: graph data reset for re-extraction (cross-file CALLS/REFERENCES, anonymous-arrow/IIFE attribution, internal IMPORTS_FROM → File, nested-class parent chain)',
	2: '[Compass] Extraction format v1 → v2: clearing graph for re-extraction (this triggers a full re-index on next session)',
	3: '[Compass] Extraction format v2 → v3: clearing graph so File nodes can be re-tagged with no_callable_entities for accurate orphan classification',
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
