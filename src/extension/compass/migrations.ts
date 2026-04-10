import { SCHEMA_SQL } from './schema';
import { log } from '../logger';

export const CURRENT_SCHEMA_VERSION = 1;

export interface MigrationDb {
	exec(sql: string): void;
	prepare(sql: string): {
		get(...params: unknown[]): Record<string, unknown> | undefined;
		run(...params: unknown[]): { changes: number };
	};
}

export function getSchemaVersion(db: MigrationDb): number {
	const tableExists = db.prepare(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
	).get();
	if (!tableExists) return 0;

	const row = db.prepare(
		"SELECT value FROM metadata WHERE key = 'schema_version'",
	).get() as { value: string } | undefined;
	return row ? parseInt(row.value, 10) : 0;
}

export function runMigrations(db: MigrationDb): void {
	const current = getSchemaVersion(db);
	if (current >= CURRENT_SCHEMA_VERSION) return;

	log(`[Compass] Running migrations from v${current} to v${CURRENT_SCHEMA_VERSION}`);

	if (current < 1) {
		db.exec('BEGIN IMMEDIATE');
		try {
			db.exec(SCHEMA_SQL);
			db.prepare(
				"INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
			).run('schema_version', '1');
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
		log('[Compass] Migration v1: base schema created');
	}
}
