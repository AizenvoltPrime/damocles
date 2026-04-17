import { SCHEMA_SQL } from './schema';
import { log } from '../logger';

export const CURRENT_SCHEMA_VERSION = 1;
export const CURRENT_EXTRACTION_FORMAT_VERSION = 1;

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
			).run('schema_version', '1');
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
		log('[Compass] Schema migration v1: base schema created');
	}
}

function runExtractionFormatMigrations(db: MigrationDb): void {
	const current = getExtractionFormatVersion(db);
	if (current >= CURRENT_EXTRACTION_FORMAT_VERSION) return;

	log(`[Compass] Running extraction-format migrations from v${current} to v${CURRENT_EXTRACTION_FORMAT_VERSION}`);

	if (current < 1) {
		db.exec('BEGIN IMMEDIATE');
		try {
			db.exec('DELETE FROM flow_memberships');
			db.exec('DELETE FROM flows');
			db.exec('DELETE FROM edges');
			db.exec('DELETE FROM nodes');
			db.exec('DELETE FROM communities');
			db.prepare(
				'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
			).run('extraction_format_version', '1');
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
		log('[Compass] Extraction-format v1: graph data reset for re-extraction (cross-file CALLS/REFERENCES, anonymous-arrow/IIFE attribution, internal IMPORTS_FROM → File, nested-class parent chain)');
	}
}
