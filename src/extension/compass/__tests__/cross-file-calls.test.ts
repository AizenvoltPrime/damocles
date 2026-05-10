import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as path from 'path';
import { extractFile } from '../extractors';
import { setGrammarDir } from '../parser-manager';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import { handleQuery } from '../mcp-handlers';
import { getSqlEngine, createTestStore } from './sql-test-helper';

const FIXTURES = path.join(__dirname, 'fixtures');
const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

const FILE_A = path.join(FIXTURES, 'sample_crossfile_a.ts').replace(/\\/g, '/');
const FILE_B = path.join(FIXTURES, 'sample_crossfile_b.ts').replace(/\\/g, '/');
const FILE_BARREL = path.join(FIXTURES, 'sample_crossfile_barrel.ts').replace(/\\/g, '/');
const FILE_VIA_BARREL = path.join(FIXTURES, 'sample_crossfile_via_barrel.ts').replace(/\\/g, '/');
const FILE_IIFE = path.join(FIXTURES, 'sample_crossfile_iife.ts').replace(/\\/g, '/');
const FILE_MODULE_SCOPE = path.join(FIXTURES, 'sample_crossfile_module_scope.ts').replace(/\\/g, '/');
const FILE_MODULE_OVERLAP = path.join(FIXTURES, 'sample_crossfile_module_overlap.ts').replace(/\\/g, '/');
const FILE_PY_MAIN = path.join(FIXTURES, 'sample_python_main.py').replace(/\\/g, '/');
const FILE_PY_CALLBACK = path.join(FIXTURES, 'sample_python_callback.py').replace(/\\/g, '/');

let engine: SqlJsStatic;

beforeAll(async () => {
	setGrammarDir(GRAMMARS);
	engine = await getSqlEngine();
});

describe('cross-file CALLS/REFERENCES extraction', () => {
	it('extractor emits dangling CALLS edge with bare-name target when callee is cross-file', async () => {
		const result = await extractFile(FILE_B, FIXTURES);
		const callsOut = result.edges.filter(e => e.kind === 'CALLS' && e.source.endsWith('::callerFunction'));
		const bareTargets = new Set(callsOut.map(e => e.target));
		expect(bareTargets.has('calleeFunction')).toBe(true);
	});

	it('extractor emits dangling REFERENCES edge with bare-name target when reference is cross-file', async () => {
		const result = await extractFile(FILE_B, FIXTURES);
		const refsOut = result.edges.filter(e => e.kind === 'REFERENCES' && e.source.endsWith('::callerFunction'));
		const bareTargets = new Set(refsOut.map(e => e.target));
		expect(bareTargets.has('CalleeClass')).toBe(true);
	});
});

describe('resolveExternalEdges (cross-file)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('rewrites CALLS target from bare name to qualified name via import-scoped match', async () => {
		store = createTestStore(engine);

		const a = await extractFile(FILE_A, FIXTURES);
		const b = await extractFile(FILE_B, FIXTURES);
		store.storeFileNodesEdges(FILE_A, a.nodes, a.edges);
		store.storeFileNodesEdges(FILE_B, b.nodes, b.edges);

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource(`${FILE_B}::callerFunction`)
			.filter(e => e.kind === 'CALLS');
		const calleeTargets = calls.map(e => e.target_qualified);
		expect(calleeTargets).toContain(`${FILE_A}::calleeFunction`);
	});

	it('rewrites REFERENCES target from bare name to qualified name', async () => {
		store = createTestStore(engine);

		const a = await extractFile(FILE_A, FIXTURES);
		const b = await extractFile(FILE_B, FIXTURES);
		store.storeFileNodesEdges(FILE_A, a.nodes, a.edges);
		store.storeFileNodesEdges(FILE_B, b.nodes, b.edges);

		store.resolveExternalEdges();

		const refs = store.getEdgesBySource(`${FILE_B}::callerFunction`)
			.filter(e => e.kind === 'REFERENCES');
		const refTargets = new Set(refs.map(e => e.target_qualified));
		expect(refTargets.has(`${FILE_A}::CalleeClass`)).toBe(true);
	});

	it('deletes unresolved CALLS edges after resolution completes', async () => {
		store = createTestStore(engine);

		const b = await extractFile(FILE_B, FIXTURES);
		store.storeFileNodesEdges(FILE_B, b.nodes, b.edges);

		store.resolveExternalEdges();

		const danglingCalls = store.getEdgesBySource(`${FILE_B}::callerFunction`)
			.filter(e => e.kind === 'CALLS' && e.target_qualified === 'calleeFunction');
		expect(danglingCalls).toHaveLength(0);
	});

	it('preserves already-resolved CALLS edges (hand-seeded full qualified names)', () => {
		store = createTestStore(engine);

		store.upsertNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'callee', file_path: '/src/a.ts', line_start: 2, line_end: 4 });
		store.upsertNode({ kind: 'File', name: 'b.ts', file_path: '/src/b.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'caller', file_path: '/src/b.ts', line_start: 2, line_end: 4 });
		store.upsertEdge({
			kind: 'CALLS', source: '/src/b.ts::caller', target: '/src/a.ts::callee',
			file_path: '/src/b.ts', line: 3,
		});

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/b.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.target_qualified).toBe('/src/a.ts::callee');
	});

	it('falls back to unambiguous global match when no import-scope candidate exists', () => {
		store = createTestStore(engine);

		store.upsertNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'uniqueThing', file_path: '/src/a.ts', line_start: 2, line_end: 4 });
		store.upsertNode({ kind: 'File', name: 'b.ts', file_path: '/src/b.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'caller', file_path: '/src/b.ts', line_start: 2, line_end: 4 });
		store.upsertEdge({
			kind: 'CALLS', source: '/src/b.ts::caller', target: 'uniqueThing',
			file_path: '/src/b.ts', line: 3,
		});

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/b.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.target_qualified).toBe('/src/a.ts::uniqueThing');
	});

	it('deletes unresolved CALLS when multiple candidates exist and none are in imports', () => {
		store = createTestStore(engine);

		store.upsertNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'handle', file_path: '/src/a.ts', line_start: 2, line_end: 4 });
		store.upsertNode({ kind: 'File', name: 'c.ts', file_path: '/src/c.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'handle', file_path: '/src/c.ts', line_start: 2, line_end: 4 });
		store.upsertNode({ kind: 'File', name: 'b.ts', file_path: '/src/b.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'caller', file_path: '/src/b.ts', line_start: 2, line_end: 4 });
		store.upsertEdge({
			kind: 'CALLS', source: '/src/b.ts::caller', target: 'handle',
			file_path: '/src/b.ts', line: 3,
		});

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/b.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(0);
	});

	it('leaves unresolved IMPORTS_FROM edges intact (no terminal delete for import kinds)', () => {
		store = createTestStore(engine);

		store.upsertNode({ kind: 'File', name: 'b.ts', file_path: '/src/b.ts', line_start: 1, line_end: 10 });
		store.upsertEdge({
			kind: 'IMPORTS_FROM', source: '/src/b.ts::b.ts', target: 'external-module',
			file_path: '/src/b.ts', line: 1,
		});

		store.resolveExternalEdges();

		const imports = store.getEdgesBySource('/src/b.ts::b.ts').filter(e => e.kind === 'IMPORTS_FROM');
		expect(imports).toHaveLength(1);
		expect(imports[0]!.target_qualified).toBe('external-module');
	});

	it('does not hijack bare-module imports to a workspace file with a matching basename', () => {
		store = createTestStore(engine);

		store.upsertNode({ kind: 'File', name: 'shim.ts', file_path: '/src/shim/react.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'File', name: 'consumer.ts', file_path: '/src/app/consumer.ts', line_start: 1, line_end: 10 });
		store.upsertEdge({
			kind: 'IMPORTS_FROM', source: '/src/app/consumer.ts::consumer.ts', target: 'react',
			file_path: '/src/app/consumer.ts', line: 1,
		});

		store.resolveExternalEdges();

		const imports = store.getEdgesBySource('/src/app/consumer.ts::consumer.ts').filter(e => e.kind === 'IMPORTS_FROM');
		expect(imports).toHaveLength(1);
		expect(imports[0]!.target_qualified).toBe('react');
	});

	it('does not hijack Node builtin imports (`fs`) to a workspace file with the same basename', () => {
		store = createTestStore(engine);

		store.upsertNode({ kind: 'File', name: 'fs.ts', file_path: '/src/utils/fs.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'File', name: 'caller.ts', file_path: '/src/app/caller.ts', line_start: 1, line_end: 10 });
		store.upsertEdge({
			kind: 'IMPORTS_FROM', source: '/src/app/caller.ts::caller.ts', target: 'fs',
			file_path: '/src/app/caller.ts', line: 1,
		});

		store.resolveExternalEdges();

		const imports = store.getEdgesBySource('/src/app/caller.ts::caller.ts').filter(e => e.kind === 'IMPORTS_FROM');
		expect(imports).toHaveLength(1);
		expect(imports[0]!.target_qualified).toBe('fs');
	});
});

describe('barrel re-export (locks current behavior)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('global unambiguous fallback resolves the call when only one file defines the symbol', async () => {
		store = createTestStore(engine);

		const a = await extractFile(FILE_A, FIXTURES);
		const barrel = await extractFile(FILE_BARREL, FIXTURES);
		const viaBarrel = await extractFile(FILE_VIA_BARREL, FIXTURES);
		store.storeFileNodesEdges(FILE_A, a.nodes, a.edges);
		store.storeFileNodesEdges(FILE_BARREL, barrel.nodes, barrel.edges);
		store.storeFileNodesEdges(FILE_VIA_BARREL, viaBarrel.nodes, viaBarrel.edges);

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource(`${FILE_VIA_BARREL}::barrelCaller`)
			.filter(e => e.kind === 'CALLS');
		const targets = calls.map(e => e.target_qualified);
		expect(targets).toContain(`${FILE_A}::calleeFunction`);
	});
});

describe('end-to-end compass_query cross-file pipeline', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('callers_of returns cross-file caller after resolveExternalEdges', async () => {
		store = createTestStore(engine);

		const a = await extractFile(FILE_A, FIXTURES);
		const b = await extractFile(FILE_B, FIXTURES);
		store.storeFileNodesEdges(FILE_A, a.nodes, a.edges);
		store.storeFileNodesEdges(FILE_B, b.nodes, b.edges);
		store.resolveExternalEdges();

		const result = handleQuery(store, { pattern: 'callers_of', target: 'calleeFunction' });
		expect(result).toContain('callerFunction');
	});

	it('referencers_of returns cross-file referencer after resolveExternalEdges', async () => {
		store = createTestStore(engine);

		const a = await extractFile(FILE_A, FIXTURES);
		const b = await extractFile(FILE_B, FIXTURES);
		store.storeFileNodesEdges(FILE_A, a.nodes, a.edges);
		store.storeFileNodesEdges(FILE_B, b.nodes, b.edges);
		store.resolveExternalEdges();

		const result = handleQuery(store, { pattern: 'referencers_of', target: 'CalleeClass' });
		expect(result).toContain('callerFunction');
	});
});

describe('anonymous arrow / IIFE call attribution', () => {
	it('extractor attributes CALLS inside an IIFE body to the enclosing extracted method', async () => {
		const result = await extractFile(FILE_IIFE, FIXTURES);
		const callsFromBuild = result.edges.filter(
			e => e.kind === 'CALLS' && e.source.endsWith('::IifeHolder::build'),
		);
		const targets = new Set(callsFromBuild.map(e => e.target));
		expect(targets.has('calleeFunction')).toBe(true);
	});

	it('extractor attributes CALLS inside an anonymous callback (.map) to the enclosing method', async () => {
		const result = await extractFile(FILE_IIFE, FIXTURES);
		const callsFromBuild = result.edges.filter(
			e => e.kind === 'CALLS' && e.source.endsWith('::IifeHolder::build'),
		);
		const callLineCount = callsFromBuild.filter(e => e.target === 'calleeFunction').length;
		expect(callLineCount).toBeGreaterThanOrEqual(1);
	});

	it('extractor attributes REFERENCES inside an array literal under an IIFE return to the enclosing method', async () => {
		const result = await extractFile(FILE_IIFE, FIXTURES);
		const refs = result.edges.filter(
			e => e.kind === 'REFERENCES' && e.source.endsWith('::IifeHolder::build'),
		);
		const refTargets = new Set(refs.map(e => e.target));
		expect(refTargets.has('CalleeClass')).toBe(true);
	});

	it('end-to-end: callers_of resolves cross-file bare-name CALLS emitted from inside an IIFE', async () => {
		let store: GraphStore | null = null;
		try {
			store = createTestStore(engine);
			const a = await extractFile(FILE_A, FIXTURES);
			const iife = await extractFile(FILE_IIFE, FIXTURES);
			store.storeFileNodesEdges(FILE_A, a.nodes, a.edges);
			store.storeFileNodesEdges(FILE_IIFE, iife.nodes, iife.edges);
			store.resolveExternalEdges();

			const result = handleQuery(store, { pattern: 'callers_of', target: 'calleeFunction' });
			expect(result).toContain('build');
			expect(result).toContain('sample_crossfile_iife.ts');
		} finally {
			store?.close();
		}
	});
});

describe('module-scope CALLS extraction (US-A3)', () => {
	it('TypeScript top-level call emits CALLS edge sourced from the file qualified name', async () => {
		const result = await extractFile(FILE_MODULE_SCOPE, FIXTURES);
		const callsFromFile = result.edges.filter(
			e => e.kind === 'CALLS' && e.source === `${FILE_MODULE_SCOPE}::sample_crossfile_module_scope.ts`,
		);
		const targets = new Set(callsFromFile.map(e => e.target));
		expect(targets.has('calleeFunction')).toBe(true);
	});

	it('TypeScript top-level array literal emits REFERENCES edge sourced from the file qualified name', async () => {
		const result = await extractFile(FILE_MODULE_SCOPE, FIXTURES);
		const refsFromFile = result.edges.filter(
			e => e.kind === 'REFERENCES' && e.source === `${FILE_MODULE_SCOPE}::sample_crossfile_module_scope.ts`,
		);
		const targets = new Set(refsFromFile.map(e => e.target));
		expect(targets.has('CalleeClass')).toBe(true);
	});

	it('Python `if __name__ == "__main__": main()` emits CALLS edge from file to main', async () => {
		const result = await extractFile(FILE_PY_MAIN, FIXTURES);
		const callsFromFile = result.edges.filter(
			e => e.kind === 'CALLS' && e.source === `${FILE_PY_MAIN}::sample_python_main.py`,
		);
		const targets = new Set(callsFromFile.map(e => e.target));
		expect(targets.has(`${FILE_PY_MAIN}::main`)).toBe(true);
	});

	it('does not double-emit CALLS edges for calls inside function bodies', async () => {
		const result = await extractFile(FILE_PY_MAIN, FIXTURES);
		const callsFromMain = result.edges.filter(
			e => e.kind === 'CALLS'
				&& e.source === `${FILE_PY_MAIN}::main`
				&& e.target === `${FILE_PY_MAIN}::helper`,
		);
		expect(callsFromMain.length).toBe(1);
	});

	it('TypeScript module-scope walk does not descend into function bodies (US-A3 boundary check)', async () => {
		const fileQn = `${FILE_MODULE_OVERLAP}::sample_crossfile_module_overlap.ts`;
		const mainQn = `${FILE_MODULE_OVERLAP}::main`;

		const result = await extractFile(FILE_MODULE_OVERLAP, FIXTURES);
		const callsToCallee = result.edges.filter(
			e => e.kind === 'CALLS' && e.target === 'calleeFunction',
		);

		const fromFile = callsToCallee.filter(e => e.source === fileQn);
		const fromMain = callsToCallee.filter(e => e.source === mainQn);

		expect(fromFile.length).toBe(1);
		expect(fromMain.length).toBe(1);

		const allSources = new Set(callsToCallee.map(e => e.source));
		expect(allSources.size).toBe(2);
		expect(allSources.has(fileQn)).toBe(true);
		expect(allSources.has(mainQn)).toBe(true);
	});
});

describe('Python argument_list REFERENCES extraction (US-A4)', () => {
	it('Python callback passed via argument_list emits REFERENCES edge from caller', async () => {
		const result = await extractFile(FILE_PY_CALLBACK, FIXTURES);
		const refsFromSchedule = result.edges.filter(
			e => e.kind === 'REFERENCES' && e.source === `${FILE_PY_CALLBACK}::schedule`,
		);
		const targets = new Set(refsFromSchedule.map(e => e.target));
		expect(targets.has(`${FILE_PY_CALLBACK}::handler`)).toBe(true);
	});
});
