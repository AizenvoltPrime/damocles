import { describe, it, expect } from 'vitest';
import { CompassService } from '../index';

describe('CompassService', () => {
	it('constructor reads config without error', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(service).toBeTruthy();
	});

	it('isEnabled returns false by default', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(service.isEnabled).toBeFalsy();
	});

	it('getStatus returns idle state initially', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const status = service.getStatus();
		expect(status.state).toBe('idle');
		expect(status.fileCount).toBe(0);
		expect(status.nodeCount).toBe(0);
		expect(status.edgeCount).toBe(0);
		expect(status.communityCount).toBe(0);
		expect(status.lastIndexedAt).toBeNull();
	});

	it('getStatus has expected shape', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const status = service.getStatus();
		expect(status).toHaveProperty('state');
		expect(status).toHaveProperty('fileCount');
		expect(status).toHaveProperty('nodeCount');
		expect(status).toHaveProperty('edgeCount');
		expect(status).toHaveProperty('communityCount');
		expect(status).toHaveProperty('lastIndexedAt');
	});

	it('queryGraph returns null when graph not built', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const result = service.queryGraph('test query');
		expect(result).toBeNull();
	});

	it('getNode returns null when graph not built', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const result = service.getNode('SomeClass');
		expect(result).toBeNull();
	});

	it('getNeighbors returns null when graph not built', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const result = service.getNeighbors('SomeClass');
		expect(result).toBeNull();
	});

	it('shortestPath returns null when graph not built', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const result = service.shortestPath('A', 'B');
		expect(result).toBeNull();
	});

	it('searchNodes returns empty array when graph not built', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		const result = service.searchNodes(['test']);
		expect(result).toEqual([]);
	});

	it('dispose cleans up without error', () => {
		const service = new CompassService('/test/workspace', '/test/damocles', '/test/extension');
		expect(() => service.dispose()).not.toThrow();
		const status = service.getStatus();
		expect(status.state).toBe('idle');
	});
});
