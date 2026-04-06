import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { setGrammarDir } from '../parser-manager';
import { extractFile } from '../extractors/index';
import { labels, relations, findNode } from './extraction-helpers';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const GRAMMAR_DIR = path.join(process.cwd(), 'resources', 'grammars');

beforeAll(() => {
	setGrammarDir(GRAMMAR_DIR);
});

describe('B8: TypeScript-specific AST node extraction', () => {
	let result: Awaited<ReturnType<typeof extractFile>>;

	beforeAll(async () => {
		result = await extractFile(path.join(FIXTURES_DIR, 'sample.ts'), FIXTURES_DIR);
	});

	it('extracts interface declarations', () => {
		const iface = findNode(result, 'HttpOptions');
		expect(iface).toBeDefined();
	});

	it('extracts interface method signatures', () => {
		const sig = findNode(result, '.getHeaders()');
		expect(sig).toBeDefined();
	});

	it('extracts type alias declarations', () => {
		const typeAlias = findNode(result, 'RequestMethod');
		expect(typeAlias).toBeDefined();
	});

	it('extracts enum declarations', () => {
		const enumNode = findNode(result, 'StatusCode');
		expect(enumNode).toBeDefined();
	});

	it('extracts abstract class declarations', () => {
		const abstract = findNode(result, 'BaseClient');
		expect(abstract).toBeDefined();
	});

	it('extracts regular class declarations', () => {
		const cls = findNode(result, 'HttpClient');
		expect(cls).toBeDefined();
	});

	it('extracts class methods', () => {
		expect(findNode(result, '.get()')).toBeDefined();
		expect(findNode(result, '.post()')).toBeDefined();
		expect(findNode(result, '.connect()')).toBeDefined();
	});

	it('extracts standalone functions', () => {
		expect(findNode(result, 'buildHeaders()')).toBeDefined();
	});

	it('extracts import edges', () => {
		expect(relations(result)).toContain('imports');
	});

	it('has contains edges for all TS constructs', () => {
		const containsEdges = result.edges.filter(e => e.relation === 'contains');
		const containedLabels = new Set(containsEdges.map(e => e.target));
		const interfaceNode = findNode(result, 'HttpOptions');
		const enumNode = findNode(result, 'StatusCode');
		const typeNode = findNode(result, 'RequestMethod');
		if (interfaceNode) expect(containedLabels.has(interfaceNode.id)).toBe(true);
		if (enumNode) expect(containedLabels.has(enumNode.id)).toBe(true);
		if (typeNode) expect(containedLabels.has(typeNode.id)).toBe(true);
	});

	it('produces inherits edge for class extends', () => {
		const inheritsEdges = result.edges.filter(e => e.relation === 'inherits');
		expect(inheritsEdges.length).toBeGreaterThan(0);
	});

	it('no dangling edges for TS nodes', () => {
		const nodeIds = new Set(result.nodes.map(n => n.id));
		for (const edge of result.edges) {
			if (edge.relation === 'imports' || edge.relation === 'imports_from') continue;
			expect(nodeIds.has(edge.source)).toBe(true);
		}
	});
});

describe('W10+W11: Ruby require and module extraction', () => {
	let result: Awaited<ReturnType<typeof extractFile>>;

	beforeAll(async () => {
		result = await extractFile(path.join(FIXTURES_DIR, 'sample.rb'), FIXTURES_DIR);
	});

	it('extracts require imports', () => {
		const importEdges = result.edges.filter(e => e.relation === 'imports');
		expect(importEdges.length).toBeGreaterThanOrEqual(2);
		const targets = importEdges.map(e => e.target);
		expect(targets.some(t => t.includes('json'))).toBe(true);
	});

	it('extracts require_relative imports', () => {
		const importEdges = result.edges.filter(e => e.relation === 'imports');
		const targets = importEdges.map(e => e.target);
		expect(targets.some(t => t.includes('helpers'))).toBe(true);
	});

	it('extracts module declarations', () => {
		const mod = findNode(result, 'Networking');
		expect(mod).toBeDefined();
	});

	it('extracts classes within modules', () => {
		const cls = findNode(result, 'ApiClient');
		expect(cls).toBeDefined();
	});

	it('extracts methods within module classes', () => {
		expect(findNode(result, '.get()')).toBeDefined();
		expect(findNode(result, '.post()')).toBeDefined();
	});

	it('extracts standalone functions outside modules', () => {
		expect(findNode(result, 'parse_response()')).toBeDefined();
	});

	it('module contains class edge exists', () => {
		const moduleNode = findNode(result, 'Networking');
		const classNode = findNode(result, 'ApiClient');
		if (moduleNode && classNode) {
			const containsEdge = result.edges.find(e =>
				e.source === moduleNode.id && e.target === classNode.id && e.relation === 'contains'
			);
			expect(containsEdge).toBeDefined();
		}
	});
});

describe('W12: C struct and typedef extraction', () => {
	let result: Awaited<ReturnType<typeof extractFile>>;

	beforeAll(async () => {
		result = await extractFile(path.join(FIXTURES_DIR, 'sample.c'), FIXTURES_DIR);
	});

	it('extracts named struct declarations', () => {
		const structNode = findNode(result, 'Point');
		expect(structNode).toBeDefined();
	});

	it('extracts typedef declarations', () => {
		const typedefNode = findNode(result, 'Person');
		expect(typedefNode).toBeDefined();
	});

	it('extracts typedef alias for named struct', () => {
		const aliasNode = findNode(result, 'PointAlias');
		expect(aliasNode).toBeDefined();
	});

	it('still extracts functions', () => {
		expect(findNode(result, 'validate()')).toBeDefined();
		expect(findNode(result, 'process()')).toBeDefined();
		expect(findNode(result, 'main()')).toBeDefined();
	});

	it('extracts include imports', () => {
		const importEdges = result.edges.filter(e => e.relation === 'imports');
		expect(importEdges.length).toBeGreaterThanOrEqual(3);
	});

	it('struct has contains edge from file', () => {
		const structNode = findNode(result, 'Point');
		if (structNode) {
			const edge = result.edges.find(e => e.target === structNode.id && e.relation === 'contains');
			expect(edge).toBeDefined();
		}
	});
});

describe('W13: PHP interface and trait extraction', () => {
	let result: Awaited<ReturnType<typeof extractFile>>;

	beforeAll(async () => {
		result = await extractFile(path.join(FIXTURES_DIR, 'sample.php'), FIXTURES_DIR);
	});

	it('extracts interface declarations', () => {
		const iface = findNode(result, 'Cacheable');
		expect(iface).toBeDefined();
	});

	it('extracts trait declarations', () => {
		const trait = findNode(result, 'Loggable');
		expect(trait).toBeDefined();
	});

	it('extracts interface methods', () => {
		const getCacheKey = findNode(result, '.getCacheKey()');
		const getTtl = findNode(result, '.getTtl()');
		expect(getCacheKey).toBeDefined();
		expect(getTtl).toBeDefined();
	});

	it('extracts trait methods', () => {
		const logMethod = findNode(result, '.log()');
		expect(logMethod).toBeDefined();
	});

	it('still extracts regular class and methods', () => {
		expect(findNode(result, 'ApiClient')).toBeDefined();
		expect(findNode(result, '.get()')).toBeDefined();
		expect(findNode(result, '.fetch()')).toBeDefined();
	});

	it('still extracts standalone functions', () => {
		expect(findNode(result, 'parseResponse()')).toBeDefined();
	});

	it('still extracts use/import edges', () => {
		const importEdges = result.edges.filter(e => e.relation === 'imports');
		expect(importEdges.length).toBeGreaterThanOrEqual(1);
	});
});

describe('W14: Python uses stem not filename', () => {
	let result: Awaited<ReturnType<typeof extractFile>>;

	beforeAll(async () => {
		result = await extractFile(path.join(FIXTURES_DIR, 'sample.py'), FIXTURES_DIR);
	});

	it('file node label is stem without extension', () => {
		const fileNode = result.nodes[0];
		expect(fileNode).toBeDefined();
		expect(fileNode.label).toBe('sample');
		expect(fileNode.label).not.toContain('.py');
	});
});

describe('W15: Java constructor NID deduplication for overloads', () => {
	let result: Awaited<ReturnType<typeof extractFile>>;

	beforeAll(async () => {
		result = await extractFile(path.join(FIXTURES_DIR, 'sample.java'), FIXTURES_DIR);
	});

	it('extracts multiple constructor overloads as separate nodes', () => {
		const ctorNodes = result.nodes.filter(n =>
			n.label.startsWith('DataProcessor(') && !n.label.includes('.')
		);
		expect(ctorNodes.length).toBeGreaterThanOrEqual(2);
	});

	it('constructor labels include parameter count', () => {
		const ctorLabels = result.nodes
			.filter(n => n.label.startsWith('DataProcessor('))
			.map(n => n.label);
		expect(ctorLabels).toContain('DataProcessor(0)');
		expect(ctorLabels).toContain('DataProcessor(1)');
		expect(ctorLabels).toContain('DataProcessor(2)');
	});

	it('each constructor has a method edge from class', () => {
		const ctorNodes = result.nodes.filter(n => n.label.startsWith('DataProcessor('));
		const methodEdges = result.edges.filter(e => e.relation === 'method');
		for (const ctor of ctorNodes) {
			const edge = methodEdges.find(e => e.target === ctor.id);
			expect(edge).toBeDefined();
		}
	});

	it('still extracts interface declarations', () => {
		expect(findNode(result, 'Processor')).toBeDefined();
	});
});

describe('All 12 extractors produce valid output on fixtures', () => {
	const fixtureFiles = [
		{ name: 'sample.py', minNodes: 2 },
		{ name: 'sample.ts', minNodes: 3 },
		{ name: 'sample.go', minNodes: 3 },
		{ name: 'sample.rs', minNodes: 3 },
		{ name: 'sample.java', minNodes: 3 },
		{ name: 'sample.c', minNodes: 3 },
		{ name: 'sample.cpp', minNodes: 3 },
		{ name: 'sample.rb', minNodes: 3 },
		{ name: 'sample.cs', minNodes: 3 },
		{ name: 'sample.kt', minNodes: 3 },
		{ name: 'sample.scala', minNodes: 3 },
		{ name: 'sample.php', minNodes: 3 },
	];

	for (const { name, minNodes } of fixtureFiles) {
		it(`${name}: produces nodes and edges`, async () => {
			const result = await extractFile(path.join(FIXTURES_DIR, name), FIXTURES_DIR);
			expect(result.nodes.length).toBeGreaterThanOrEqual(minNodes);
			expect(result.edges.length).toBeGreaterThan(0);
		});

		it(`${name}: all nodes have required fields`, async () => {
			const result = await extractFile(path.join(FIXTURES_DIR, name), FIXTURES_DIR);
			for (const node of result.nodes) {
				expect(node.id).toBeTruthy();
				expect(node.label).toBeTruthy();
				expect(node.file_type).toBe('code');
				expect(node.source_file).toBeDefined();
			}
		});

		it(`${name}: no duplicate node IDs`, async () => {
			const result = await extractFile(path.join(FIXTURES_DIR, name), FIXTURES_DIR);
			const ids = result.nodes.map(n => n.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it(`${name}: all non-import edge sources exist as nodes`, async () => {
			const result = await extractFile(path.join(FIXTURES_DIR, name), FIXTURES_DIR);
			const nodeIds = new Set(result.nodes.map(n => n.id));
			for (const edge of result.edges) {
				if (edge.relation === 'imports' || edge.relation === 'imports_from') continue;
				expect(nodeIds.has(edge.source)).toBe(true);
			}
		});

		it(`${name}: has file-level node`, async () => {
			const result = await extractFile(path.join(FIXTURES_DIR, name), FIXTURES_DIR);
			expect(result.nodes.length).toBeGreaterThan(0);
			const fileNode = result.nodes[0];
			expect(fileNode.source_location).toBe('L1');
		});
	}
});
