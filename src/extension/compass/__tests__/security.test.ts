import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import type { NodeInfo, EdgeInfo } from '../types';
import { sanitizeFtsQuery, splitIdentifier } from '../schema';
import { searchNodes } from '../search';
import { computeBlastRadius } from '../impact';
import { parseUnifiedDiff } from '../changes';
import { collectFiles } from '../detect';
import { getSqlEngine, createTestStore } from './sql-test-helper';

let engine: SqlJsStatic;

beforeAll(async () => {
	engine = await getSqlEngine();
});

function makeNode(overrides: Partial<NodeInfo> & { name: string; file_path: string }): NodeInfo {
	return { kind: 'Function', line_start: 1, line_end: 10, ...overrides };
}

function makeEdge(overrides: Partial<EdgeInfo> & { source: string; target: string; file_path: string }): EdgeInfo {
	return { kind: 'CALLS', ...overrides };
}

// ============================================================
// FTS5 query sanitization
// ============================================================
describe('sanitizeFtsQuery', () => {
	it('wraps each word in quotes', () => {
		expect(sanitizeFtsQuery('compass service')).toBe('"compass" "service"');
	});

	it('strips FTS5 metacharacters', () => {
		expect(sanitizeFtsQuery('test*(something)')).toBe('"testsomething"');
	});

	it('strips boolean operators', () => {
		expect(sanitizeFtsQuery('foo AND bar OR baz')).toBe('"foo" "bar" "baz"');
	});

	it('handles empty query', () => {
		expect(sanitizeFtsQuery('')).toBe('""');
	});

	it('handles query with only metacharacters', () => {
		expect(sanitizeFtsQuery('***')).toBe('""');
	});

	it('preserves normal search terms', () => {
		expect(sanitizeFtsQuery('CompassService')).toBe('"CompassService"');
	});

	it('strips NEAR operator', () => {
		expect(sanitizeFtsQuery('foo NEAR bar')).toBe('"foo" "bar"');
	});

	it('strips double quotes from input', () => {
		expect(sanitizeFtsQuery('"DROP TABLE"')).toBe('"DROP" "TABLE"');
	});

	it('strips curly braces but preserves colons', () => {
		expect(sanitizeFtsQuery('{column:value}')).toBe('"column:value"');
	});

	it('strips angle brackets', () => {
		expect(sanitizeFtsQuery('<script>alert(1)</script>')).toBe('"scriptalert1/script"');
	});
});

// ============================================================
// Identifier splitting
// ============================================================
describe('splitIdentifier', () => {
	it('splits camelCase', () => {
		expect(splitIdentifier('camelCase')).toBe('camel case');
	});

	it('splits PascalCase', () => {
		expect(splitIdentifier('CompassService')).toBe('compass service');
	});

	it('splits snake_case', () => {
		expect(splitIdentifier('get_node_by_id')).toBe('get node by id');
	});

	it('splits ALL_CAPS_SNAKE', () => {
		expect(splitIdentifier('MAX_IMPACT_DEPTH')).toBe('max impact depth');
	});

	it('handles consecutive uppercase like URL', () => {
		expect(splitIdentifier('parseURLString')).toBe('parse url string');
	});

	it('handles single word', () => {
		expect(splitIdentifier('compass')).toBe('compass');
	});

	it('handles path separators', () => {
		expect(splitIdentifier('src/extension/compass')).toBe('src extension compass');
	});

	it('trims and normalizes whitespace', () => {
		expect(splitIdentifier('  foo__bar  ')).toBe('foo bar');
	});
});

// ============================================================
// SQL injection prevention — all queries use parameterized ?
// ============================================================
describe('SQL injection prevention', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('node name with SQL injection payload is stored and retrieved safely', () => {
		store = createTestStore(engine);
		const maliciousName = "Robert'); DROP TABLE nodes;--";
		const id = store.upsertNode(makeNode({
			name: maliciousName,
			file_path: '/src/evil.ts',
		}));
		expect(id).toBeGreaterThan(0);

		const node = store.getNodeById(id);
		expect(node).toBeDefined();
		expect(node!.name).toBe(maliciousName);

		expect(store.getNodeCount()).toBeGreaterThan(0);
	});

	it('file path with SQL injection payload is stored safely', () => {
		store = createTestStore(engine);
		const maliciousPath = "/src/'); DELETE FROM edges WHERE ('1'='1";
		store.upsertNode(makeNode({
			name: 'safeFunc',
			file_path: maliciousPath,
		}));

		const nodes = store.getNodesByFile(maliciousPath);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]!.file_path).toBe(maliciousPath);
	});

	it('edge with SQL injection in qualified names is stored safely', () => {
		store = createTestStore(engine);
		const maliciousSrc = "evil.ts::'; DROP TABLE edges;--";
		const maliciousTgt = "evil.ts::'; UPDATE nodes SET name='hacked';--";

		store.upsertNode(makeNode({ name: "src_func", file_path: '/src/evil.ts' }));
		store.upsertNode(makeNode({ name: "tgt_func", file_path: '/src/evil.ts' }));

		const id = store.upsertEdge(makeEdge({
			source: maliciousSrc,
			target: maliciousTgt,
			file_path: '/src/evil.ts',
		}));
		expect(id).toBeGreaterThan(0);

		const edges = store.getAllEdges();
		const found = edges.find(e => e.source_qualified === maliciousSrc);
		expect(found).toBeDefined();
		expect(found!.target_qualified).toBe(maliciousTgt);
	});

	it('metadata key/value with injection payload is stored safely', () => {
		store = createTestStore(engine);
		const key = "key'; DROP TABLE metadata;--";
		const value = "val'); DELETE FROM nodes;--";

		store.setMetadata(key, value);
		const retrieved = store.getMetadata(key);
		expect(retrieved).toBe(value);
	});

	it('storeFileNodesEdges with malicious data does not corrupt DB', () => {
		store = createTestStore(engine);
		const evilPath = "/'; DELETE FROM nodes WHERE '1'='1";
		store.storeFileNodesEdges(evilPath, [
			makeNode({ name: "func'; DROP TABLE edges;--", file_path: evilPath }),
		], []);

		expect(store.getNodeCount()).toBeGreaterThan(0);
		expect(store.getEdgeCount()).toBe(0);
	});

	it('queryRaw with parameters prevents injection', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'safe', file_path: '/src/ok.ts' }));

		const rows = store.queryRaw(
			"SELECT * FROM nodes WHERE name = ?",
			"safe' OR '1'='1",
		);
		expect(rows).toHaveLength(0);
	});
});

// ============================================================
// FTS5 search injection prevention
// ============================================================
describe('FTS5 search injection prevention', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('searching with FTS5 metacharacters does not throw', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'normalFunc', file_path: '/src/a.ts' }));
		expect(() => searchNodes(store, 'test*(OR "hack")')).not.toThrow();
	});

	it('searching with boolean operators is sanitized', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'normalFunc', file_path: '/src/a.ts' }));
		expect(() => searchNodes(store, 'foo AND bar NOT baz')).not.toThrow();
	});

	it('node with FTS metacharacters in name is searchable', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			name: 'parse_AND_validate',
			file_path: '/src/a.ts',
		}));
		const results = searchNodes(store, 'parse');
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it('node with special characters in name round-trips through FTS', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			name: '__init__',
			file_path: '/src/module.py',
			language: 'python',
		}));
		const results = searchNodes(store, 'init');
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it('extremely long search query does not crash', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'func', file_path: '/src/a.ts' }));
		const longQuery = 'a'.repeat(1000);
		expect(() => searchNodes(store, longQuery)).not.toThrow();
	});

	it('null byte in search query throws rather than executing', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'func', file_path: '/src/a.ts' }));
		expect(() => searchNodes(store, 'func\x00DROP')).toThrow();
		expect(store.getNodeCount()).toBe(1);
	});
});

// ============================================================
// Blast radius does not accept malicious data
// ============================================================
describe('blast radius with adversarial input', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('non-existent file returns empty result', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'func', file_path: '/src/a.ts' }));
		const result = computeBlastRadius(store, ['/src/nonexistent.ts']);
		expect(result.changed_nodes).toHaveLength(0);
	});

	it('file path with SQL injection attempt returns empty', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: 'func', file_path: '/src/a.ts' }));
		const result = computeBlastRadius(store, ["'; DROP TABLE nodes; --"]);
		expect(result.changed_nodes).toHaveLength(0);
		expect(store.getNodeCount()).toBe(1);
	});
});

// ============================================================
// Git diff parsing — no shell injection
// ============================================================
describe('git diff parsing safety', () => {
	it('parseUnifiedDiff handles well-formed input', () => {
		const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,5 @@ function foo() {
`;
		const ranges = parseUnifiedDiff(diff);
		expect(ranges.get('src/a.ts')).toEqual([[10, 14]]);
	});

	it('parseUnifiedDiff handles malformed diff gracefully', () => {
		const garbage = `not a real diff
just some random text
@@ this is not a hunk @@
+++ this has no proper format`;
		const ranges = parseUnifiedDiff(garbage);
		expect(ranges.size).toBe(0);
	});

	it('parseUnifiedDiff handles empty input', () => {
		const ranges = parseUnifiedDiff('');
		expect(ranges.size).toBe(0);
	});

	it('parseUnifiedDiff extracts single-line change', () => {
		const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -5 +5 @@ function foo() {
`;
		const ranges = parseUnifiedDiff(diff);
		expect(ranges.get('src/a.ts')).toEqual([[5, 5]]);
	});

	it('parseUnifiedDiff handles zero-line addition', () => {
		const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -5,2 +5,0 @@ function foo() {
`;
		const ranges = parseUnifiedDiff(diff);
		expect(ranges.get('src/a.ts')).toEqual([[5, 5]]);
	});
});

// ============================================================
// SAFE_GIT_REF pattern validation
// ============================================================
describe('git ref sanitization', () => {
	const SAFE_GIT_REF = /^[A-Za-z0-9_.~^/@{}\-]+$/;

	it('allows standard refs', () => {
		expect(SAFE_GIT_REF.test('HEAD~1')).toBe(true);
		expect(SAFE_GIT_REF.test('main')).toBe(true);
		expect(SAFE_GIT_REF.test('origin/main')).toBe(true);
		expect(SAFE_GIT_REF.test('v1.0.0')).toBe(true);
		expect(SAFE_GIT_REF.test('HEAD@{1}')).toBe(true);
		expect(SAFE_GIT_REF.test('feature/auth-fix')).toBe(true);
	});

	it('blocks shell injection payloads', () => {
		expect(SAFE_GIT_REF.test('$(whoami)')).toBe(false);
		expect(SAFE_GIT_REF.test('`rm -rf /`')).toBe(false);
		expect(SAFE_GIT_REF.test('HEAD; rm -rf /')).toBe(false);
		expect(SAFE_GIT_REF.test('HEAD && cat /etc/passwd')).toBe(false);
		expect(SAFE_GIT_REF.test('HEAD | tee /tmp/out')).toBe(false);
		expect(SAFE_GIT_REF.test("HEAD' --")).toBe(false);
	});

	it('blocks newlines and control characters', () => {
		expect(SAFE_GIT_REF.test('HEAD\nrm -rf /')).toBe(false);
		expect(SAFE_GIT_REF.test('HEAD\x00')).toBe(false);
		expect(SAFE_GIT_REF.test('')).toBe(false);
	});
});

// ============================================================
// Path traversal prevention in detect.ts
// ============================================================
describe('path traversal prevention', () => {
	it('skips dotfiles', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-sec-'));
		fs.writeFileSync(path.join(tmpDir, '.hidden.ts'), 'const x = 1;');
		fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'const y = 2;');

		const files = collectFiles(tmpDir);
		expect(files.length).toBe(1);
		expect(files[0]).toContain('visible.ts');

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('skips .git directory', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-sec-'));
		const gitDir = path.join(tmpDir, '.git');
		fs.mkdirSync(gitDir);
		fs.writeFileSync(path.join(gitDir, 'config.ts'), 'export const x = 1;');
		fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'const a = 1;');

		const files = collectFiles(tmpDir);
		expect(files.length).toBe(1);
		expect(files[0]).toContain('main.ts');

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('blocks credential-bearing data files but allows source code', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-sec-'));
		fs.writeFileSync(path.join(tmpDir, 'safe.ts'), 'const a = 1;');
		fs.writeFileSync(path.join(tmpDir, 'credential_store.ts'), 'export const store = {};');
		fs.writeFileSync(path.join(tmpDir, 'password_util.ts'), 'export const hash = (s) => s;');
		fs.writeFileSync(path.join(tmpDir, 'credentials.json'), '{"key":"x"}');
		fs.writeFileSync(path.join(tmpDir, 'passwords.txt'), 'raw');
		fs.writeFileSync(path.join(tmpDir, '.env'), 'DB_PASS=x');

		const files = collectFiles(tmpDir);
		const names = files.map(f => path.basename(f)).sort();
		expect(names).toEqual(['credential_store.ts', 'password_util.ts', 'safe.ts']);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('handles non-existent root gracefully', () => {
		const files = collectFiles('/nonexistent/path/12345');
		expect(files).toHaveLength(0);
	});
});

// ============================================================
// ReDoS prevention in exclude patterns
// ============================================================
describe('ReDoS prevention', () => {
	it('overly long exclude pattern is silently ignored', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-redos-'));
		fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'const a = 1;');

		const longPattern = 'a'.repeat(201);
		const files = collectFiles(tmpDir, [longPattern]);
		expect(files.length).toBe(1);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('invalid regex in exclude pattern is silently skipped', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-redos-'));
		fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'const a = 1;');

		const files = collectFiles(tmpDir, ['[invalid regex']);
		expect(files.length).toBe(1);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('valid exclude patterns still work correctly', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-redos-'));
		fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'const a = 1;');
		fs.writeFileSync(path.join(tmpDir, 'generated.ts'), 'const b = 2;');

		const files = collectFiles(tmpDir, ['generated']);
		expect(files.length).toBe(1);
		expect(files[0]).toContain('main.ts');

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

// ============================================================
// Unicode and boundary conditions
// ============================================================
describe('unicode and boundary safety', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('unicode node names are stored and retrieved correctly', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			name: '处理请求',
			file_path: '/src/handler.py',
			language: 'python',
		}));

		const node = store.getNode('/src/handler.py::处理请求');
		expect(node).toBeDefined();
		expect(node!.name).toBe('处理请求');
	});

	it('emoji in node names round-trips safely', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			name: 'handle_🔥_event',
			file_path: '/src/event.ts',
		}));

		const nodes = store.getNodesByFile('/src/event.ts');
		expect(nodes).toHaveLength(1);
		expect(nodes[0]!.name).toBe('handle_🔥_event');
	});

	it('empty string node name is stored', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({ name: '', file_path: '/src/a.ts' }));
		expect(store.getNodeCount()).toBe(1);
	});

	it('extremely long qualified name is stored', () => {
		store = createTestStore(engine);
		const longName = 'a'.repeat(5000);
		store.upsertNode(makeNode({ name: longName, file_path: '/src/a.ts' }));

		const nodes = store.getNodesByFile('/src/a.ts');
		expect(nodes).toHaveLength(1);
		expect(nodes[0]!.name).toBe(longName);
	});

	it('backslash in file paths is handled', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			name: 'func',
			file_path: 'C:\\Users\\dev\\src\\a.ts',
		}));

		const nodes = store.getNodesByFile('C:\\Users\\dev\\src\\a.ts');
		expect(nodes).toHaveLength(1);
	});

	it('resolveGraphFilePaths normalizes backslashes against stored paths', () => {
		store = createTestStore(engine);
		store.upsertNode(makeNode({
			kind: 'File',
			name: 'a.ts',
			file_path: 'C:\\Users\\dev\\src\\a.ts',
		}));

		const matches = store.resolveGraphFilePaths(['src/a.ts']);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toBe('C:/Users/dev/src/a.ts');
	});
});
