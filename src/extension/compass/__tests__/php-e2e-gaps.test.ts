import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as path from 'path';
import { extractFile } from '../extractors';
import { setGrammarDir } from '../parser-manager';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import { handleQuery } from '../mcp-handlers';
import { findDeadCode } from '../refactor';
import { getSqlEngine, createTestStore } from './sql-test-helper';

const FIXTURES = path.join(__dirname, 'fixtures');
const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

const FILE_CONTEXT = path.join(FIXTURES, 'OrganizationContext.php').replace(/\\/g, '/');
const FILE_CONSUMER = path.join(FIXTURES, 'TenantConsumer.php').replace(/\\/g, '/');
const FILE_TEST = path.join(FIXTURES, 'tests', 'Unit', 'FiwareTenantServiceTest.php').replace(/\\/g, '/');
const FILE_SERVICE = path.join(FIXTURES, 'OrganizationService.php').replace(/\\/g, '/');
const FILE_CONTROLLER = path.join(FIXTURES, 'OrganizationController.php').replace(/\\/g, '/');

let engine: SqlJsStatic;

beforeAll(async () => {
	setGrammarDir(GRAMMARS);
	engine = await getSqlEngine();
});

async function buildGraph(store: GraphStore): Promise<void> {
	for (const file of [FILE_CONTEXT, FILE_CONSUMER, FILE_TEST]) {
		const { nodes, edges } = await extractFile(file, FIXTURES);
		store.storeFileNodesEdges(file, nodes, edges);
	}
	store.resolveExternalEdges();
	store.buildTestedByEdges();
}

describe('PHP head-to-head regression lock (US-006)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('query B: referencers_of OrganizationContext is non-empty (was "none")', async () => {
		store = createTestStore(engine);
		await buildGraph(store);

		const result = handleQuery(store, { pattern: 'referencers_of', target: 'OrganizationContext' });

		expect(result).not.toContain('none');
		expect(result).toContain('resolve');
		expect(result).toContain('TenantConsumer.php');
	});

	it('query C: tests_for FiwareTenantService finds the test (was "none")', async () => {
		store = createTestStore(engine);
		await buildGraph(store);

		const result = handleQuery(store, { pattern: 'tests_for', target: 'FiwareTenantService' });

		expect(result).not.toContain('none');
		expect(result).toContain('testCreateTenant');
		expect(result).toContain('FiwareTenantServiceTest.php');
	});

	it('query C resolves via the CALLS-derived path (constructor call from the test)', async () => {
		store = createTestStore(engine);
		await buildGraph(store);

		const subject = store.getNodesByQualifiedSuffix('FiwareTenantService')
			.find(n => n.kind === 'Class' && n.is_test === 0);
		const testedBy = store.getEdgesByTarget(subject!.qualified_name)
			.filter(e => e.kind === 'TESTED_BY');

		expect(testedBy.map(e => e.source_qualified)).toContain(
			`${FILE_TEST}::FiwareTenantServiceTest::testCreateTenant`,
		);
		const callsDerived = testedBy.find(
			e => e.source_qualified === `${FILE_TEST}::FiwareTenantServiceTest::testCreateTenant`,
		);
		expect(callsDerived!.extra).toBe('{}');
	});
});

describe('PHP DI type-hint dead-code regression (canonical fix proof)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	async function buildDiGraph(): Promise<void> {
		for (const file of [FILE_SERVICE, FILE_CONTROLLER]) {
			const { nodes, edges } = await extractFile(file, FIXTURES);
			store.storeFileNodesEdges(file, nodes, edges);
		}
		store.resolveExternalEdges();
	}

	it('OrganizationService injected only via constructor type hint is NOT flagged dead', async () => {
		store = createTestStore(engine);
		await buildDiGraph();

		const dead = findDeadCode(store, { kind: 'Class' });
		expect(dead.map(d => d.name)).not.toContain('OrganizationService');
	});

	it('referencers_of OrganizationService surfaces the injecting controller constructor', async () => {
		store = createTestStore(engine);
		await buildDiGraph();

		const result = handleQuery(store, { pattern: 'referencers_of', target: 'OrganizationService' });

		expect(result).not.toContain('none');
		expect(result).toContain('OrganizationController.php');
	});
});
