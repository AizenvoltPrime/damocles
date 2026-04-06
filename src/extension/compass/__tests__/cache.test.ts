import { describe, it, expect, afterEach } from 'vitest';
import { fileHash, workspaceHash, loadCachedByHash, saveCached, saveCachedWithHash, cachedHashes, clearCache, getCacheDir, checkCache } from '../cache';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;

function setupTmpDir(): string {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-cache-test-'));
	return tmpDir;
}

afterEach(() => {
	if (tmpDir && fs.existsSync(tmpDir)) {
		fs.rmSync(tmpDir, { recursive: true });
	}
});

describe('fileHash', () => {
	it('produces consistent 64-char hex string', () => {
		const dir = setupTmpDir();
		const file = path.join(dir, 'test.txt');
		fs.writeFileSync(file, 'hello world');
		const hash = fileHash(file);
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[a-f0-9]+$/);
		expect(fileHash(file)).toBe(hash);
	});

	it('changes when content changes', () => {
		const dir = setupTmpDir();
		const file = path.join(dir, 'test.txt');
		fs.writeFileSync(file, 'content A');
		const hash1 = fileHash(file);
		fs.writeFileSync(file, 'content B');
		const hash2 = fileHash(file);
		expect(hash1).not.toBe(hash2);
	});
});

describe('workspaceHash', () => {
	it('produces 16-char hex string', () => {
		const hash = workspaceHash('/home/user/project');
		expect(hash).toHaveLength(16);
		expect(hash).toMatch(/^[a-f0-9]+$/);
	});

	it('is deterministic', () => {
		expect(workspaceHash('/a/b')).toBe(workspaceHash('/a/b'));
	});

	it('differs for different paths', () => {
		expect(workspaceHash('/a')).not.toBe(workspaceHash('/b'));
	});
});

describe('cache roundtrip', () => {
	it('saves and loads extraction result', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');
		const file = path.join(dir, 'test.py');
		fs.writeFileSync(file, 'class Foo: pass');

		const result = {
			nodes: [{ id: 'foo', label: 'Foo', file_type: 'code' as const, source_file: file }],
			edges: [],
		};

		saveCached(file, result, cacheDir);
		const hash = fileHash(file);
		const loaded = loadCachedByHash(hash, cacheDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.nodes).toHaveLength(1);
		expect(loaded!.nodes[0].label).toBe('Foo');
	});

	it('returns null on cache miss', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');
		fs.mkdirSync(cacheDir, { recursive: true });
		const file = path.join(dir, 'test.py');
		fs.writeFileSync(file, 'class Foo: pass');
		const hash = fileHash(file);
		expect(loadCachedByHash(hash, cacheDir)).toBeNull();
	});

	it('invalidates on content change', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');
		const file = path.join(dir, 'test.py');
		fs.writeFileSync(file, 'original');
		saveCached(file, { nodes: [], edges: [] }, cacheDir);
		fs.writeFileSync(file, 'modified');
		const newHash = fileHash(file);
		expect(loadCachedByHash(newHash, cacheDir)).toBeNull();
	});

	it('checkCache computes hash only once per file', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');
		fs.mkdirSync(cacheDir, { recursive: true });

		const file1 = path.join(dir, 'a.py');
		const file2 = path.join(dir, 'b.py');
		fs.writeFileSync(file1, 'class A: pass');
		fs.writeFileSync(file2, 'class B: pass');

		const hash1 = fileHash(file1);
		saveCachedWithHash(hash1, { nodes: [{ id: 'a', label: 'A', file_type: 'code' as const, source_file: file1 }], edges: [] }, cacheDir);

		const { cached, uncached } = checkCache([file1, file2], cacheDir);
		expect(cached).toHaveLength(1);
		expect(uncached).toHaveLength(1);
		expect(uncached[0].hash).toBe(fileHash(file2));
	});
});

describe('cachedHashes', () => {
	it('returns set of cached hashes', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, 'abc123.json'), '{}');
		const hashes = cachedHashes(cacheDir);
		expect(hashes.has('abc123')).toBe(true);
	});
});

describe('clearCache', () => {
	it('removes all cache files', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, 'a.json'), '{}');
		fs.writeFileSync(path.join(cacheDir, 'b.json'), '{}');
		clearCache(cacheDir);
		expect(fs.readdirSync(cacheDir).length).toBe(0);
	});
});
