import * as fs from 'fs';
import * as path from 'path';
import type { SqlJsStatic } from '../database';
import { GraphStore } from '../database';

let _engine: SqlJsStatic | null = null;

export async function getSqlEngine(): Promise<SqlJsStatic> {
	if (_engine) return _engine;
	const wasmPath = path.join(process.cwd(), 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
	const wasmBinary = fs.readFileSync(wasmPath);
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const initSqlJs = require('sql.js-fts5');
	_engine = await initSqlJs({ wasmBinary }) as SqlJsStatic;
	return _engine;
}

export function createTestStore(engine: SqlJsStatic): GraphStore {
	const store = new GraphStore('/tmp/compass-test.db');
	store.openFromEngine(engine);
	return store;
}
