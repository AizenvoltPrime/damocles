#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function workspaceHash(workspacePath) {
	return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
}

function resolveDamoclesDbPath(workspacePath) {
	return path.join(os.homedir(), '.damocles', 'compass', workspaceHash(workspacePath), 'graph.db');
}

function fail(message) {
	console.error(`[compass-rebuild-bench] ${message}`);
	process.exit(1);
}

async function loadSqlEngine() {
	const wasmPath = path.join(process.cwd(), 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
	if (!fs.existsSync(wasmPath)) {
		fail(`sql.js-fts5 wasm not found at ${wasmPath}. Run from the damocles repo root after npm install.`);
	}
	const wasmBinary = fs.readFileSync(wasmPath);
	const initSqlJs = require('sql.js-fts5');
	return await initSqlJs({ wasmBinary });
}

function execAll(db, sql) {
	const result = db.exec(sql);
	if (result.length === 0) return [];
	const { columns, values } = result[0];
	return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function tableExists(db, name) {
	const rows = execAll(
		db,
		`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`,
	);
	return rows.length > 0;
}

function snapshot(db) {
	const nodeCount = execAll(db, 'SELECT COUNT(*) as cnt FROM nodes')[0]?.cnt ?? 0;
	const edgeCount = execAll(db, 'SELECT COUNT(*) as cnt FROM edges')[0]?.cnt ?? 0;
	const communityCount = tableExists(db, 'communities')
		? execAll(db, 'SELECT COUNT(*) as cnt FROM communities')[0]?.cnt ?? 0
		: 0;
	const flowCount = tableExists(db, 'flows')
		? execAll(db, 'SELECT COUNT(*) as cnt FROM flows')[0]?.cnt ?? 0
		: 0;
	const edgesByKind = execAll(
		db,
		'SELECT kind, COUNT(*) as cnt FROM edges GROUP BY kind ORDER BY kind',
	);
	const nodesByKind = execAll(
		db,
		'SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind ORDER BY kind',
	);
	const extractionFormatVersion = execAll(
		db,
		"SELECT value FROM metadata WHERE key = 'extraction_format_version'",
	)[0]?.value ?? '(unset)';
	const schemaVersion = execAll(
		db,
		"SELECT value FROM metadata WHERE key = 'schema_version'",
	)[0]?.value ?? '(unset)';
	return {
		nodeCount,
		edgeCount,
		communityCount,
		flowCount,
		nodesByKind,
		edgesByKind,
		extractionFormatVersion,
		schemaVersion,
	};
}

function printSnapshot(label, snap) {
	console.log(`\n=== ${label} ===`);
	console.log(`schema_version: ${snap.schemaVersion}`);
	console.log(`extraction_format_version: ${snap.extractionFormatVersion}`);
	console.log(`nodes total: ${snap.nodeCount}`);
	console.log(`edges total: ${snap.edgeCount}`);
	console.log(`communities total: ${snap.communityCount}`);
	console.log(`flows total: ${snap.flowCount}`);
	console.log('nodes by kind:');
	for (const r of snap.nodesByKind) console.log(`  ${r.kind}: ${r.cnt}`);
	console.log('edges by kind:');
	for (const r of snap.edgesByKind) console.log(`  ${r.kind}: ${r.cnt}`);
}

async function writeDbAtomically(db, dbPath) {
	const data = db.export();
	const tmpPath = dbPath + '.tmp';
	await fs.promises.writeFile(tmpPath, Buffer.from(data));
	await fs.promises.rename(tmpPath, dbPath);
}

async function main() {
	const workspaceArg = process.argv[2];
	if (!workspaceArg) {
		fail('Usage: node scripts/compass-rebuild-bench.mjs <path-to-repo>');
	}

	const workspacePath = path.resolve(workspaceArg);
	if (!fs.existsSync(workspacePath)) {
		fail(`Workspace path does not exist: ${workspacePath}`);
	}
	if (!fs.statSync(workspacePath).isDirectory()) {
		fail(`Workspace path is not a directory: ${workspacePath}`);
	}

	const dbPath = resolveDamoclesDbPath(workspacePath);

	console.log('compass-rebuild-bench');
	console.log(`  workspace (read-only):  ${workspacePath}`);
	console.log(`  damocles graph DB:      ${dbPath}`);
	console.log('  this script touches ONLY the damocles DB above; the workspace is never written to.');

	if (!fs.existsSync(dbPath)) {
		fail(`No damocles graph DB found for that workspace. Open the workspace in VS Code first to build it.`);
	}

	const engine = await loadSqlEngine();
	const data = fs.readFileSync(dbPath);
	const db = new engine.Database(new Uint8Array(data));

	if (!tableExists(db, 'metadata') || !tableExists(db, 'nodes') || !tableExists(db, 'edges')) {
		db.close();
		fail('DB is missing core tables (metadata/nodes/edges). Refusing to touch it.');
	}

	const before = snapshot(db);
	printSnapshot('BEFORE (current graph)', before);

	db.run("DELETE FROM metadata WHERE key = 'extraction_format_version'");
	await writeDbAtomically(db, dbPath);
	db.close();

	console.log('\n=== ACTION ===');
	console.log("Cleared 'extraction_format_version' metadata key in the damocles DB.");
	console.log('Worker thread is reachable only from the VS Code extension host (it requires the bundled');
	console.log("vscode module via 'logger.ts'), so re-extraction cannot be driven from this CLI script.");
	console.log('Next step:');
	console.log('  1. Open / reopen the workspace in VS Code with the damocles extension active.');
	console.log('  2. The extension detects the missing format version, runs the v1 → v2 migration,');
	console.log('     wipes the graph data tables, and re-extracts from source.');
	console.log('  3. Re-run this script to print the AFTER snapshot.');
}

main().catch(err => {
	console.error(err?.stack ?? err);
	process.exit(1);
});
