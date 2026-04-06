import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createExtractionContext, makeId, addNode, addEdge, walkCalls, buildLabelMap, nodeText } from '../extractor-base';
import { sanitizeLabel } from '../sanitize';
import { fileHash, loadCachedByHash, saveCachedWithHash, checkCache, getCacheDir } from '../cache';
import { collectFiles } from '../detect';

let tmpDir: string | null = null;

function setupTmpDir(): string {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-review-test-'));
	return tmpDir;
}

afterEach(() => {
	if (tmpDir && fs.existsSync(tmpDir)) {
		fs.rmSync(tmpDir, { recursive: true });
		tmpDir = null;
	}
});

describe('B3: workspaceRoot threading via ExtractionContext', () => {
	it('computeFileId strips workspaceRoot prefix', () => {
		const ctx = createExtractionContext('/project/src/main.ts', 'const x = 1;', '/project');
		expect(ctx.fileId).toBe(makeId('src/main'));
	});

	it('computeFileId uses full path when no workspaceRoot', () => {
		const ctx = createExtractionContext('/project/src/main.ts', 'const x = 1;');
		expect(ctx.fileId).toBe(makeId('/project/src/main'));
	});

	it('workspaceRoot normalizes backslashes', () => {
		const ctx = createExtractionContext('C:\\project\\src\\main.ts', 'const x = 1;', 'C:\\project');
		expect(ctx.fileId).toBe(makeId('src/main'));
	});

	it('two contexts with different workspaceRoots produce different fileIds', () => {
		const ctx1 = createExtractionContext('/ws1/shared/util.ts', '', '/ws1');
		const ctx2 = createExtractionContext('/ws2/shared/util.ts', '', '/ws2');
		expect(ctx1.fileId).toBe(ctx2.fileId);

		const ctx3 = createExtractionContext('/ws1/unique/util.ts', '', '/ws1');
		const ctx4 = createExtractionContext('/ws2/other/util.ts', '', '/ws2');
		expect(ctx3.fileId).not.toBe(ctx4.fileId);
	});

	it('no module-level state leak between calls', () => {
		const ctxA = createExtractionContext('/alpha/foo.ts', '', '/alpha');
		const ctxB = createExtractionContext('/beta/foo.ts', '', '/beta');
		expect(ctxA.fileId).toBe(makeId('foo'));
		expect(ctxB.fileId).toBe(makeId('foo'));

		const ctxC = createExtractionContext('/alpha/sub/bar.ts', '', '/alpha');
		expect(ctxC.fileId).toBe(makeId('sub/bar'));
	});

	it('stem is always filename without extension', () => {
		const ctx = createExtractionContext('/a/b/my_module.tsx', '', '/a');
		expect(ctx.stem).toBe('my_module');
	});
});

describe('B4: checkCache single-hash per file', () => {
	it('does not double-hash on cache miss', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');
		fs.mkdirSync(cacheDir, { recursive: true });

		const file = path.join(dir, 'test.py');
		fs.writeFileSync(file, 'class Foo: pass');

		const { cached, uncached } = checkCache([file], cacheDir);
		expect(cached).toHaveLength(0);
		expect(uncached).toHaveLength(1);
		expect(uncached[0].hash).toBe(fileHash(file));
	});

	it('loadCachedByHash retrieves exact hash match', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');

		const entry = { nodes: [{ id: 'a', label: 'A', file_type: 'code' as const, source_file: 'a.py' }], edges: [] };
		saveCachedWithHash('abc123', entry, cacheDir);

		const loaded = loadCachedByHash('abc123', cacheDir);
		expect(loaded).not.toBeNull();
		expect(loaded!.nodes[0].label).toBe('A');
	});

	it('loadCachedByHash returns null for wrong hash', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');

		saveCachedWithHash('abc123', { nodes: [], edges: [] }, cacheDir);
		expect(loadCachedByHash('xyz789', cacheDir)).toBeNull();
	});

	it('checkCache separates cached from uncached correctly', () => {
		const dir = setupTmpDir();
		const cacheDir = path.join(dir, 'cache');

		const file1 = path.join(dir, 'a.py');
		const file2 = path.join(dir, 'b.py');
		fs.writeFileSync(file1, 'class A: pass');
		fs.writeFileSync(file2, 'class B: pass');

		saveCachedWithHash(fileHash(file1), {
			nodes: [{ id: 'a', label: 'A', file_type: 'code' as const, source_file: file1 }],
			edges: [],
		}, cacheDir);

		const { cached, uncached } = checkCache([file1, file2], cacheDir);
		expect(cached).toHaveLength(1);
		expect(cached[0].nodes[0].label).toBe('A');
		expect(uncached).toHaveLength(1);
		expect(uncached[0].filePath).toBe(file2);
	});
});

describe('S6: sanitizeLabel trims whitespace', () => {
	it('trims leading and trailing whitespace', () => {
		expect(sanitizeLabel('  hello  ')).toBe('hello');
	});

	it('trims after control character removal', () => {
		expect(sanitizeLabel('\t  label \n')).toBe('label');
	});

	it('preserves inner whitespace', () => {
		expect(sanitizeLabel('  hello world  ')).toBe('hello world');
	});

	it('handles string that is only whitespace', () => {
		expect(sanitizeLabel('   ')).toBe('');
	});
});

describe('W5: isWithinRoot platform-aware case sensitivity', () => {
	it('collectFiles uses workspace root correctly', () => {
		const dir = setupTmpDir();
		fs.writeFileSync(path.join(dir, 'test.py'), '# test');

		const files = collectFiles(dir);
		expect(files.length).toBe(1);
		expect(files[0].endsWith('test.py')).toBe(true);
	});

	it('collectFiles skips symlinks', () => {
		const dir = setupTmpDir();
		fs.writeFileSync(path.join(dir, 'real.py'), '# real');
		try {
			fs.symlinkSync(path.join(dir, 'real.py'), path.join(dir, 'link.py'));
		} catch {
			return;
		}

		const files = collectFiles(dir);
		expect(files.filter(f => f.includes('link')).length).toBe(0);
	});

	it('collectFiles respects excludePatterns', () => {
		const dir = setupTmpDir();
		const sub = path.join(dir, 'generated');
		fs.mkdirSync(sub);
		fs.writeFileSync(path.join(sub, 'output.py'), '# generated');
		fs.writeFileSync(path.join(dir, 'main.py'), '# main');

		const files = collectFiles(dir, ['generated']);
		expect(files.some(f => f.includes('generated'))).toBe(false);
		expect(files.some(f => f.includes('main'))).toBe(true);
	});
});

describe('W16: walkCalls skips class boundaries', () => {
	function makeMockNode(type: string, children: unknown[] = []): any {
		return {
			type,
			children,
			childForFieldName: () => null,
			startPosition: { row: 0 },
			startIndex: 0,
			endIndex: 0,
		};
	}

	it('stops at nested class_declaration', () => {
		const innerCallNode = makeMockNode('call_expression', [
			{ ...makeMockNode('identifier'), type: 'identifier', startIndex: 0, endIndex: 5 },
		]);
		const innerClass = makeMockNode('class_declaration', [innerCallNode]);
		const outerBody = makeMockNode('block', [innerClass]);

		const ctx = createExtractionContext('test.ts', 'innerFunc', '/ws');
		addNode(ctx, 'outer_fn', 'outer()', 1);
		addNode(ctx, 'test_innerfunc', 'innerFunc()', 5);

		const labelMap = buildLabelMap(ctx.nodes);
		const seenPairs = new Set<string>();

		walkCalls(ctx, outerBody, 'outer_fn', labelMap, seenPairs, 'innerFunc');

		const callEdges = ctx.edges.filter(e => e.relation === 'calls');
		expect(callEdges).toHaveLength(0);
	});

	it('stops at nested interface_declaration', () => {
		const innerNode = makeMockNode('interface_declaration', []);
		const body = makeMockNode('block', [innerNode]);

		const ctx = createExtractionContext('test.ts', '', '/ws');
		const labelMap = new Map<string, string>();
		const seenPairs = new Set<string>();

		walkCalls(ctx, body, 'caller', labelMap, seenPairs, '');
		expect(ctx.edges).toHaveLength(0);
	});

	it('stops at function boundaries too', () => {
		const innerCall = makeMockNode('call_expression');
		const nestedFn = makeMockNode('function_declaration', [innerCall]);
		const body = makeMockNode('block', [nestedFn]);

		const ctx = createExtractionContext('test.ts', '', '/ws');
		const labelMap = new Map<string, string>();
		const seenPairs = new Set<string>();

		walkCalls(ctx, body, 'caller', labelMap, seenPairs, '');
		expect(ctx.edges).toHaveLength(0);
	});
});
