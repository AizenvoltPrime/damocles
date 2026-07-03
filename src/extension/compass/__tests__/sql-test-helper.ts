import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { GraphStore } from '../database';

// One temp dir per test process; removed on exit so a thrown test can't leak DB files (+ -wal/-shm).
const TEST_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-tests-'));
process.once('exit', () => {
	// A store leaked open still holds a Windows file lock, so rmSync can throw EPERM — swallow it in
	// the exit hook (the OS reclaims the temp dir anyway) rather than crash the process on shutdown.
	try {
		fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

export function testDbPath(): string {
	return path.join(TEST_DB_DIR, `${crypto.randomUUID()}.db`);
}

export function createTestStore(): GraphStore {
	return GraphStore.openAt(testDbPath());
}
