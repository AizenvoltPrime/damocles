import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as path from 'path';
import { extractFile } from '../extractors';
import { setGrammarDir } from '../parser-manager';
import { GraphStore } from '../database';
import type { SqlJsStatic } from '../database';
import { ComposerPsr4Resolver } from '../composer-resolver';
import { getSqlEngine, createTestStore } from './sql-test-helper';

const FIXTURES = path.join(__dirname, 'fixtures', 'psr4-laravel');
const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

const CAMERA = path.join(FIXTURES, 'app', 'Models', 'Camera.php').replace(/\\/g, '/');
const ORG_CONTEXT = path.join(FIXTURES, 'app', 'Services', 'Organization', 'OrganizationContext.php').replace(/\\/g, '/');
const DEMO_CONSTANTS = path.join(FIXTURES, 'database', 'seeders', 'Demo', 'DemoDataConstants.php').replace(/\\/g, '/');
const CONTROLLER = path.join(FIXTURES, 'app', 'Http', 'Controllers', 'CameraController.php').replace(/\\/g, '/');
const CONTROLLER_FQ = `${CONTROLLER}::CameraController.php`;
const CAMERA_FQ = `${CAMERA}::Camera.php`;
const ORG_CONTEXT_FQ = `${ORG_CONTEXT}::OrganizationContext.php`;
const DEMO_CONSTANTS_FQ = `${DEMO_CONSTANTS}::DemoDataConstants.php`;

let engine: SqlJsStatic;

beforeAll(async () => {
	setGrammarDir(GRAMMARS);
	engine = await getSqlEngine();
});

describe('PHP PSR-4 import resolution', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('resolves App\\Models\\Camera to the Camera.php File node via suffix convention', async () => {
		store = createTestStore(engine);

		const controller = await extractFile(CONTROLLER, FIXTURES);
		const camera = await extractFile(CAMERA, FIXTURES);
		store.storeFileNodesEdges(CONTROLLER, controller.nodes, controller.edges);
		store.storeFileNodesEdges(CAMERA, camera.nodes, camera.edges);

		store.resolveExternalEdges(FIXTURES);

		const imports = store.getEdgesBySource(CONTROLLER_FQ).filter(e => e.kind === 'IMPORTS_FROM');
		const cameraImport = imports.find(e => e.target_qualified === CAMERA_FQ);
		expect(cameraImport, 'IMPORTS_FROM App\\Models\\Camera should resolve to Camera.php File node').toBeDefined();
	});

	it('resolves nested namespace App\\Services\\Organization\\OrganizationContext', async () => {
		store = createTestStore(engine);

		const controller = await extractFile(CONTROLLER, FIXTURES);
		const org = await extractFile(ORG_CONTEXT, FIXTURES);
		store.storeFileNodesEdges(CONTROLLER, controller.nodes, controller.edges);
		store.storeFileNodesEdges(ORG_CONTEXT, org.nodes, org.edges);

		store.resolveExternalEdges(FIXTURES);

		const imports = store.getEdgesBySource(CONTROLLER_FQ).filter(e => e.kind === 'IMPORTS_FROM');
		const orgImport = imports.find(e => e.target_qualified === ORG_CONTEXT_FQ);
		expect(orgImport).toBeDefined();
	});

	it('resolves Database\\Seeders\\Demo\\DemoDataConstants to the seeder File node', async () => {
		store = createTestStore(engine);

		const controller = await extractFile(CONTROLLER, FIXTURES);
		const constants = await extractFile(DEMO_CONSTANTS, FIXTURES);
		store.storeFileNodesEdges(CONTROLLER, controller.nodes, controller.edges);
		store.storeFileNodesEdges(DEMO_CONSTANTS, constants.nodes, constants.edges);

		store.resolveExternalEdges(FIXTURES);

		const imports = store.getEdgesBySource(CONTROLLER_FQ).filter(e => e.kind === 'IMPORTS_FROM');
		const constImport = imports.find(e => e.target_qualified === DEMO_CONSTANTS_FQ);
		expect(constImport).toBeDefined();
	});

	it('leaves Illuminate\\Console\\Command unresolved (known external, not internal)', async () => {
		store = createTestStore(engine);

		const controller = await extractFile(CONTROLLER, FIXTURES);
		store.storeFileNodesEdges(CONTROLLER, controller.nodes, controller.edges);

		store.resolveExternalEdges(FIXTURES);

		const imports = store.getEdgesBySource(CONTROLLER_FQ).filter(e => e.kind === 'IMPORTS_FROM');
		const illuminate = imports.find(e => e.target_qualified === 'Illuminate\\Console\\Command');
		expect(illuminate, 'unresolved external should not be rewritten').toBeDefined();
	});

	it('strips aliasing clause from "use X as Y" imports', async () => {
		store = createTestStore(engine);

		const controller = await extractFile(CONTROLLER, FIXTURES);
		const camera = await extractFile(CAMERA, FIXTURES);
		store.storeFileNodesEdges(CONTROLLER, controller.nodes, controller.edges);
		store.storeFileNodesEdges(CAMERA, camera.nodes, camera.edges);

		store.resolveExternalEdges(FIXTURES);

		const imports = store.getEdgesBySource(CONTROLLER_FQ).filter(e => e.kind === 'IMPORTS_FROM');
		const withAliasText = imports.find(e => e.target_qualified.includes(' as '));
		expect(withAliasText, '"as" fragment should never reach edge target').toBeUndefined();

		const aliasedResolved = imports.filter(e => e.target_qualified === CAMERA_FQ);
		expect(aliasedResolved.length, 'both plain and aliased use should resolve to Camera.php').toBeGreaterThanOrEqual(2);
	});
});

describe('ComposerPsr4Resolver', () => {
	it('resolves App\\Models\\Camera via composer.json autoload.psr-4 mapping', () => {
		const resolver = new ComposerPsr4Resolver(FIXTURES);
		const resolved = resolver.resolveNamespace('App\\Models\\Camera', CONTROLLER);
		expect(resolved).not.toBeNull();
		expect(resolved!.replace(/\\/g, '/').toLowerCase())
			.toBe(CAMERA.toLowerCase());
	});

	it('resolves Database\\Seeders\\Demo\\DemoDataConstants via multi-segment prefix', () => {
		const resolver = new ComposerPsr4Resolver(FIXTURES);
		const resolved = resolver.resolveNamespace('Database\\Seeders\\Demo\\DemoDataConstants', CONTROLLER);
		expect(resolved).not.toBeNull();
		expect(resolved!.replace(/\\/g, '/').toLowerCase())
			.toBe(DEMO_CONSTANTS.toLowerCase());
	});

	it('returns null for a namespace not declared in composer.json', () => {
		const resolver = new ComposerPsr4Resolver(FIXTURES);
		const resolved = resolver.resolveNamespace('Symfony\\Component\\HttpFoundation\\Request', CONTROLLER);
		expect(resolved).toBeNull();
	});

	it('returns null for non-namespaced targets', () => {
		const resolver = new ComposerPsr4Resolver(FIXTURES);
		expect(resolver.resolveNamespace('Camera', CONTROLLER)).toBeNull();
		expect(resolver.resolveNamespace('', CONTROLLER)).toBeNull();
	});

	it('prefers the longest matching prefix when multiple could apply', () => {
		const resolver = new ComposerPsr4Resolver(FIXTURES);
		const resolved = resolver.resolveNamespace('Database\\Seeders\\Demo\\DemoDataConstants', CONTROLLER);
		expect(resolved).not.toBeNull();
		expect(resolved!.replace(/\\/g, '/').toLowerCase()).toContain('/database/seeders/demo/');
	});

	it('caches per-directory lookups', () => {
		const resolver = new ComposerPsr4Resolver(FIXTURES);
		const first = resolver.resolveNamespace('App\\Models\\Camera', CONTROLLER);
		const second = resolver.resolveNamespace('App\\Models\\Camera', CONTROLLER);
		expect(first).toBe(second);
	});
});
