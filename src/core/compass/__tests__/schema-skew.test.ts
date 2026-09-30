import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { sqliteContentFingerprint } from '../../../__mocks__/sqlite-content';
import { GraphStore } from '../database';
import { CompassService } from '../index';
import { CURRENT_EXTRACTION_FORMAT_VERSION, CURRENT_SCHEMA_VERSION } from '../migrations';
import { normalizePath, compassIndexPath } from '../util';
import type { WebviewValidationResponse } from '../worker-protocol';

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const walSize = (dbPath: string): number => (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0);
const storedMetadata = (dbPath: string, key: string): string => {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const row = raw.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string };
  raw.close();
  return row.value;
};

const nodesIn = (dbPath: string, file: string): number => {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const row = raw.prepare('SELECT COUNT(*) AS n FROM nodes WHERE file_path = ?').get(normalizePath(file)) as { n: number };
  raw.close();
  return row.n;
};

function stampFromAnotherApp(dbPath: string, key: string, value: number): void {
  const raw = new DatabaseSync(dbPath, { timeout: 5000 });
  raw.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, String(value));
  raw.close();
}

let root: string;
const services: CompassService[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'damocles-compass-skew-'));
  // The real worker bundle runs on a worker thread, resolved through AppPaths as the host resolves it.
  await build({
    entryPoints: [path.resolve(__dirname, '..', 'compass-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(root, 'dist', 'compass-worker.js'),
    logLevel: 'silent',
  });
}, 60_000);

afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * An index holding one file, `a.ts`, stored under its current content hash so a full build keeps it
 * without parsing (the test app root has no grammars).
 */
async function seededWorkspace(name: string): Promise<{ workspace: string; dbPath: string; file: string }> {
  const workspace = path.join(root, name);
  mkdirSync(workspace, { recursive: true });
  const file = path.join(workspace, 'a.ts');
  writeFileSync(file, 'export const a = 1;\n');
  const dbPath = compassIndexPath(workspace);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new GraphStore(dbPath);
  await store.open();
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  store.storeFileNodesEdges(file, [{ kind: 'File', name: 'a.ts', file_path: file, line_start: 1, line_end: 1, language: 'typescript' }], [], hash);
  store.close();
  return { workspace, dbPath, file };
}

function service(workspace: string): { fake: FakePlatform; compass: CompassService } {
  const fake = createFakePlatform({ appRoot: root, settings: { user: { 'damocles.compass.enabled': true } } });
  const compass = new CompassService(workspace, fake);
  services.push(compass);
  return { fake, compass };
}

const readOnlyNotice = (workspace: string) => ({ level: 'warn', message: expect.stringContaining(`the Compass index of ${workspace}`) as string, actions: [] });
const rebuildRefused = { level: 'warn', message: expect.stringContaining('is read only') as string, actions: [] };

describe('Compass index schema skew', () => {
  it('the current version opens normally and indexes without a notice', async () => {
    const { workspace, dbPath } = await seededWorkspace('current');
    const { fake, compass } = service(workspace);
    await compass.ensureInitialized();
    expect(compass.getStatus().state).toBe('ready');
    expect(compass.getStatus().readOnly).toBeUndefined();
    expect(fake.notifications.calls).toEqual([]);
    expect(storedMetadata(dbPath, 'schema_version')).toBe(String(CURRENT_SCHEMA_VERSION));
  }, 30_000);

  it('an index stamped one version ahead opens read only in the worker, writes nothing and notifies the host once', async () => {
    const { workspace, dbPath, file } = await seededWorkspace('ahead');
    stampFromAnotherApp(dbPath, 'schema_version', CURRENT_SCHEMA_VERSION + 1);
    rmSync(file);
    const before = sha(dbPath);
    const content = sqliteContentFingerprint(dbPath);

    const first = service(workspace);
    await first.compass.ensureInitialized();
    expect(first.compass.getStatus()).toMatchObject({ state: 'ready', readOnly: true });
    expect(first.fake.notifications.calls).toEqual([readOnlyNotice(workspace)]);

    // Validation reports the vanished file but leaves its rows in the newer app's index.
    const validation = await first.compass.webviewValidation() as WebviewValidationResponse;
    expect(validation.staleFilesRemoved).toEqual([]);
    expect(validation.staleFilesKept).toEqual([normalizePath(file)]);

    // An explicit Rebuild says why nothing happens, on every click.
    await first.compass.triggerReindex();
    await first.compass.triggerReindex();
    expect(first.fake.notifications.calls).toEqual([readOnlyNotice(workspace), rebuildRefused, rebuildRefused]);

    // A second window on the same folder in this session raises no second notice.
    const second = service(workspace);
    await second.compass.ensureInitialized();
    expect(second.fake.notifications.calls).toEqual([]);

    expect(sqliteContentFingerprint(dbPath)).toBe(content);
    expect(nodesIn(dbPath, file)).toBe(1);
    expect(sha(dbPath)).toBe(before);
    expect(walSize(dbPath)).toBe(0);
    expect(storedMetadata(dbPath, 'schema_version')).toBe(String(CURRENT_SCHEMA_VERSION + 1));
  }, 30_000);

  it('an index whose extraction format is ahead opens read only', async () => {
    const { workspace, dbPath } = await seededWorkspace('format-ahead');
    stampFromAnotherApp(dbPath, 'extraction_format_version', CURRENT_EXTRACTION_FORMAT_VERSION + 1);
    const { fake, compass } = service(workspace);
    await compass.ensureInitialized();
    expect(compass.getStatus()).toMatchObject({ state: 'ready', readOnly: true });
    expect(fake.notifications.calls).toEqual([readOnlyNotice(workspace)]);
    expect(storedMetadata(dbPath, 'extraction_format_version')).toBe(String(CURRENT_EXTRACTION_FORMAT_VERSION + 1));
  }, 30_000);

  it.each([
    ['schema_version', CURRENT_SCHEMA_VERSION + 1],
    ['extraction_format_version', CURRENT_EXTRACTION_FORMAT_VERSION + 1],
  ])('an open index whose %s moves ahead goes read only at the next write and writes nothing', async (key, value) => {
    const { workspace, dbPath, file } = await seededWorkspace(`moved-${key}`);
    const { fake, compass } = service(workspace);
    await compass.ensureInitialized();
    expect(compass.getStatus().readOnly).toBeUndefined();

    stampFromAnotherApp(dbPath, key, value);
    rmSync(file);
    const content = sqliteContentFingerprint(dbPath);

    const validation = await compass.webviewValidation() as WebviewValidationResponse;
    expect(validation.staleFilesRemoved).toEqual([]);
    expect(validation.staleFilesKept).toEqual([normalizePath(file)]);
    expect(compass.getStatus().readOnly).toBe(true);
    await compass.runPostProcess({ communities: true, flows: true, fts: true });
    await compass.triggerReindex();

    expect(fake.notifications.calls).toEqual([readOnlyNotice(workspace), rebuildRefused]);
    expect(sqliteContentFingerprint(dbPath)).toBe(content);
    expect(nodesIn(dbPath, file)).toBe(1);
    expect(storedMetadata(dbPath, key)).toBe(String(value));
  }, 30_000);
});
