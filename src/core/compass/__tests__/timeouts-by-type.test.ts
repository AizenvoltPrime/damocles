import { describe, it, expect } from 'vitest';
import { TIMEOUTS, TIMEOUTS_BY_TYPE } from '../worker-protocol';
import type { WorkerRequest } from '../worker-protocol';

const HEAVY_TYPES: Array<WorkerRequest['type']> = [
	'init',
	'fullBuild',
	'incrementalUpdate',
	'postprocess',
	'dispose',
	'mcp:build',
];

const EXPECTED_LIGHT_TYPES: Array<WorkerRequest['type']> = [
	'getStatus',
	'getGraphTerms',
	'serialize',
	'mcp:context',
	'mcp:search',
	'mcp:query',
	'mcp:stats',
	'mcp:blastRadius',
	'mcp:reviewContext',
	'webview:search',
	'webview:graph',
	'webview:blastRadius',
	'webview:validation',
	'tree:files',
	'tree:nodesByFile',
	'tree:edgesForSymbol',
];

describe('TIMEOUTS_BY_TYPE', () => {
	it('every entry maps to a value from TIMEOUTS (no orphan numbers)', () => {
		const timeoutValues = new Set<number>(Object.values(TIMEOUTS));
		for (const [type, value] of Object.entries(TIMEOUTS_BY_TYPE)) {
			expect(timeoutValues, `entry ${type} must use a TIMEOUTS value`).toContain(value);
		}
	});

	it('every known light message type has an entry', () => {
		for (const type of EXPECTED_LIGHT_TYPES) {
			expect(
				TIMEOUTS_BY_TYPE[type],
				`light type '${type}' must be in TIMEOUTS_BY_TYPE — adding a new webview/tree/mcp read without wiring its timeout will fall back to TIMEOUTS.query silently`,
			).toBeDefined();
		}
	});

	it('heavy types are not present (they override via explicit timeoutMs at call sites)', () => {
		for (const type of HEAVY_TYPES) {
			expect(
				TIMEOUTS_BY_TYPE[type],
				`heavy type '${type}' must NOT be in TIMEOUTS_BY_TYPE — heavy ops carry their own timeout via call-site argument`,
			).toBeUndefined();
		}
	});

	it('webview budgets match the plan — validation is the longest, graph/blastRadius are medium', () => {
		expect(TIMEOUTS_BY_TYPE['webview:validation']).toBe(TIMEOUTS.webviewValidation);
		expect(TIMEOUTS_BY_TYPE['webview:graph']).toBe(TIMEOUTS.webviewGraph);
		expect(TIMEOUTS_BY_TYPE['webview:blastRadius']).toBe(TIMEOUTS.webviewBlastRadius);
		expect(TIMEOUTS_BY_TYPE['webview:search']).toBe(TIMEOUTS.webviewSearch);
		expect(TIMEOUTS.webviewValidation).toBeGreaterThan(TIMEOUTS.webviewGraph);
		expect(TIMEOUTS.webviewGraph).toBeGreaterThanOrEqual(TIMEOUTS.webviewSearch);
	});

	it('mcp:* reads share the mcpRead budget', () => {
		const mcpReadTypes: Array<WorkerRequest['type']> = [
			'mcp:context', 'mcp:search', 'mcp:query', 'mcp:stats',
			'mcp:blastRadius', 'mcp:reviewContext',
		];
		for (const type of mcpReadTypes) {
			expect(TIMEOUTS_BY_TYPE[type]).toBe(TIMEOUTS.mcpRead);
		}
	});

	it('tree:* reads share the tree budget', () => {
		const treeTypes: Array<WorkerRequest['type']> = [
			'tree:files', 'tree:nodesByFile', 'tree:edgesForSymbol',
		];
		for (const type of treeTypes) {
			expect(TIMEOUTS_BY_TYPE[type]).toBe(TIMEOUTS.tree);
		}
	});

	it('TIMEOUTS contains all the budget slots the plan defines', () => {
		expect(TIMEOUTS).toHaveProperty('init');
		expect(TIMEOUTS).toHaveProperty('fullBuild');
		expect(TIMEOUTS).toHaveProperty('incrementalUpdate');
		expect(TIMEOUTS).toHaveProperty('postprocess');
		expect(TIMEOUTS).toHaveProperty('serialize');
		expect(TIMEOUTS).toHaveProperty('dispose');
		expect(TIMEOUTS).toHaveProperty('query');
		expect(TIMEOUTS).toHaveProperty('webviewGraph');
		expect(TIMEOUTS).toHaveProperty('webviewValidation');
		expect(TIMEOUTS).toHaveProperty('webviewSearch');
		expect(TIMEOUTS).toHaveProperty('webviewBlastRadius');
		expect(TIMEOUTS).toHaveProperty('tree');
		expect(TIMEOUTS).toHaveProperty('mcpRead');
	});
});
