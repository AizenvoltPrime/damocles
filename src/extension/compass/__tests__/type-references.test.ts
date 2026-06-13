import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as path from 'path';
import { extractFile } from '../extractors';
import type { ExtractionResult } from '../extractor-base';
import { setGrammarDir } from '../parser-manager';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import { findDeadCode } from '../refactor';
import { getSqlEngine, createTestStore } from './sql-test-helper';

const FIXTURES = path.join(__dirname, 'fixtures');
const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

const F = (name: string) => path.join(FIXTURES, name).replace(/\\/g, '/');

const FILE_PHP = F('type_hints.php');
const FILE_CS = F('type_hints.cs');
const FILE_TS = F('type_hints.ts');
const FILE_PY = F('type_hints.py');
const FILE_JAVA = F('type_hints.java');
const FILE_GO = F('type_hints.go');
const FILE_RS = F('type_hints.rs');
const FILE_SCALA = F('type_hints.scala');
const FILE_KT = F('type_hints.kt');
const FILE_CPP = F('type_hints.cpp');

let engine: SqlJsStatic;

beforeAll(async () => {
	setGrammarDir(GRAMMARS);
	engine = await getSqlEngine();
});

function refTargets(result: ExtractionResult, sourceSuffix: string): Set<string> {
	return new Set(
		result.edges
			.filter(e => e.kind === 'REFERENCES' && e.source.endsWith(sourceSuffix))
			.map(e => lastSeg(e.target)),
	);
}

function allRefTargets(result: ExtractionResult): Set<string> {
	return new Set(result.edges.filter(e => e.kind === 'REFERENCES').map(e => lastSeg(e.target)));
}

describe('PHP type-position REFERENCES', () => {
	it('emits REFERENCES for constructor promotion type hint (the OrganizationService DI failure case)', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		expect(refTargets(result, '::TenantController::__construct').has('OrganizationService')).toBe(true);
	});

	it('emits REFERENCES for parameter and return type hints', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		const refs = refTargets(result, '::TenantController::resolve');
		expect(refs.has('Repository')).toBe(true);
		expect(refs.has('OrganizationService')).toBe(true);
	});

	it('emits REFERENCES for a property type declaration', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
	});

	it('does NOT emit REFERENCES for primitive types (int/string)', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		const all = allRefTargets(result);
		expect(all.has('int')).toBe(false);
		expect(all.has('string')).toBe(false);
	});
});

describe('C# type-position REFERENCES', () => {
	it('emits REFERENCES for constructor, parameter, return, field, property type hints', async () => {
		const result = await extractFile(FILE_CS, FIXTURES);
		expect(refTargets(result, '::TenantController::TenantController').has('OrganizationService')).toBe(true);
		const resolve = refTargets(result, '::TenantController::Resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
		const classRefs = refTargets(result, '::TenantController');
		expect(classRefs.has('Logger')).toBe(true);
		expect(classRefs.has('Repository')).toBe(true);
	});

	it('emits the generic argument type (Task<Repository> -> Repository)', async () => {
		const result = await extractFile(FILE_CS, FIXTURES);
		expect(refTargets(result, '::TenantController::LoadAsync').has('Repository')).toBe(true);
	});

	it('does NOT survive predefined types (string/int) after resolution', async () => {
		const store = createTestStore(engine);
		try {
			const { nodes, edges } = await extractFile(FILE_CS, FIXTURES);
			store.storeFileNodesEdges(FILE_CS, nodes, edges);
			store.resolveExternalEdges();
			const refs = store.getEdgesByKinds(['REFERENCES']);
			const targets = new Set(refs.map(e => lastSeg(e.target_qualified)));
			expect(targets.has('string')).toBe(false);
			expect(targets.has('int')).toBe(false);
			expect(targets.has('Task')).toBe(false);
		} finally {
			store.close();
		}
	});
});

describe('TypeScript type-position REFERENCES', () => {
	it('emits REFERENCES for constructor promotion, parameter, return, property type annotations', async () => {
		const result = await extractFile(FILE_TS, FIXTURES);
		expect(refTargets(result, '::TenantController::constructor').has('OrganizationService')).toBe(true);
		const resolve = refTargets(result, '::TenantController::resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
	});

	it('emits the generic argument type (Array<Repository> -> Repository)', async () => {
		const result = await extractFile(FILE_TS, FIXTURES);
		expect(refTargets(result, '::TenantController::load').has('Repository')).toBe(true);
	});

	it('does NOT emit REFERENCES for predefined types (number/string)', async () => {
		const result = await extractFile(FILE_TS, FIXTURES);
		const all = allRefTargets(result);
		expect(all.has('number')).toBe(false);
		expect(all.has('string')).toBe(false);
	});
});

describe('Python type-position REFERENCES', () => {
	it('emits REFERENCES for typed parameter and return annotations', async () => {
		const result = await extractFile(FILE_PY, FIXTURES);
		expect(refTargets(result, '::TenantController::__init__').has('OrganizationService')).toBe(true);
		const resolve = refTargets(result, '::TenantController::resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
	});

	it('does NOT survive builtin types (int/str) after resolution', async () => {
		const store = createTestStore(engine);
		try {
			const { nodes, edges } = await extractFile(FILE_PY, FIXTURES);
			store.storeFileNodesEdges(FILE_PY, nodes, edges);
			store.resolveExternalEdges();
			const targets = new Set(store.getEdgesByKinds(['REFERENCES']).map(e => lastSeg(e.target_qualified)));
			expect(targets.has('int')).toBe(false);
			expect(targets.has('str')).toBe(false);
		} finally {
			store.close();
		}
	});
});

describe('Java type-position REFERENCES', () => {
	it('emits REFERENCES for constructor, parameter, return, field type hints', async () => {
		const result = await extractFile(FILE_JAVA, FIXTURES);
		expect(refTargets(result, '::TenantController::TenantController').has('OrganizationService')).toBe(true);
		const resolve = refTargets(result, '::TenantController::resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
	});

	it('emits the generic argument type (List<Repository> -> Repository)', async () => {
		const result = await extractFile(FILE_JAVA, FIXTURES);
		expect(refTargets(result, '::TenantController::load').has('Repository')).toBe(true);
	});

	it('does NOT emit REFERENCES for integral primitive type (int)', async () => {
		const result = await extractFile(FILE_JAVA, FIXTURES);
		expect(allRefTargets(result).has('int')).toBe(false);
	});
});

describe('Go type-position REFERENCES', () => {
	it('emits REFERENCES for parameter, return, and struct field pointer types', async () => {
		const result = await extractFile(FILE_GO, FIXTURES);
		expect(refTargets(result, '::NewController').has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::NewController').has('TenantController')).toBe(true);
		const resolve = refTargets(result, '::TenantController::Resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
	});

	it('does NOT survive predeclared types (string/int) after resolution', async () => {
		const store = createTestStore(engine);
		try {
			const { nodes, edges } = await extractFile(FILE_GO, FIXTURES);
			store.storeFileNodesEdges(FILE_GO, nodes, edges);
			store.resolveExternalEdges();
			const targets = new Set(store.getEdgesByKinds(['REFERENCES']).map(e => lastSeg(e.target_qualified)));
			expect(targets.has('string')).toBe(false);
			expect(targets.has('int')).toBe(false);
		} finally {
			store.close();
		}
	});
});

describe('Rust type-position REFERENCES', () => {
	it('emits REFERENCES for parameter, reference, return, field types', async () => {
		const result = await extractFile(FILE_RS, FIXTURES);
		expect(refTargets(result, '::TenantController::new').has('OrganizationService')).toBe(true);
		const resolve = refTargets(result, '::TenantController::resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
	});

	it('does NOT emit REFERENCES for primitive types (i32)', async () => {
		const result = await extractFile(FILE_RS, FIXTURES);
		expect(allRefTargets(result).has('i32')).toBe(false);
	});
});

describe('Scala type-position REFERENCES', () => {
	it('emits REFERENCES for class-parameter, parameter, return, val type hints', async () => {
		const result = await extractFile(FILE_SCALA, FIXTURES);
		expect(refTargets(result, '::TenantController').has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
		const resolve = refTargets(result, '::TenantController::resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
	});
});

describe('Kotlin type-position REFERENCES', () => {
	it('emits REFERENCES for primary-constructor, parameter, return, property type hints', async () => {
		const result = await extractFile(FILE_KT, FIXTURES);
		expect(refTargets(result, '::TenantController').has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
		const resolve = refTargets(result, '::TenantController::resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
	});
});

describe('C++ type-position REFERENCES', () => {
	it('emits REFERENCES for parameter, return, field types', async () => {
		const result = await extractFile(FILE_CPP, FIXTURES);
		expect(refTargets(result, '::TenantController::TenantController').has('OrganizationService')).toBe(true);
		const resolve = refTargets(result, '::TenantController::resolve');
		expect(resolve.has('Repository')).toBe(true);
		expect(resolve.has('OrganizationService')).toBe(true);
		expect(refTargets(result, '::TenantController').has('Logger')).toBe(true);
	});

	it('does NOT emit REFERENCES for primitive types (int)', async () => {
		const result = await extractFile(FILE_CPP, FIXTURES);
		expect(allRefTargets(result).has('int')).toBe(false);
	});
});

describe('dead-code e2e: DI-injected class is not dead (canonical proof)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('OrganizationService injected only via constructor type hint is NOT flagged dead', async () => {
		store = createTestStore(engine);
		const { nodes, edges } = await extractFile(FILE_PHP, FIXTURES);
		store.storeFileNodesEdges(FILE_PHP, nodes, edges);
		store.resolveExternalEdges();

		const dead = findDeadCode(store, { kind: 'Class' });
		const deadNames = new Set(dead.map(d => d.name));
		expect(deadNames.has('OrganizationService')).toBe(false);
	});
});

function lastSeg(qualified: string): string {
	const colon = qualified.lastIndexOf('::');
	const base = colon >= 0 ? qualified.slice(colon + 2) : qualified;
	const slash = base.lastIndexOf('/');
	return slash >= 0 ? base.slice(slash + 1) : base;
}
