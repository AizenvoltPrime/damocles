import { describe, it, expect } from 'vitest';
import { validateExtraction, assertValid } from '../validate';

const VALID_DATA = {
	nodes: [
		{ id: 'a', label: 'Alpha', file_type: 'code', source_file: 'a.py' },
		{ id: 'b', label: 'Beta', file_type: 'code', source_file: 'b.py' },
	],
	edges: [
		{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
	],
};

describe('validateExtraction', () => {
	it('accepts valid data', () => {
		expect(validateExtraction(VALID_DATA)).toEqual([]);
	});

	it('rejects non-object', () => {
		expect(validateExtraction('string')).toEqual(['Extraction must be a JSON object']);
	});

	it('rejects missing nodes key', () => {
		expect(validateExtraction({ edges: [] })).toContainEqual(expect.stringContaining("Missing required key 'nodes'"));
	});

	it('rejects missing edges key', () => {
		expect(validateExtraction({ nodes: [] })).toContainEqual(expect.stringContaining("Missing required key 'edges'"));
	});

	it('rejects non-list nodes', () => {
		expect(validateExtraction({ nodes: 'bad', edges: [] })).toContainEqual(expect.stringContaining("'nodes' must be a list"));
	});

	it('rejects invalid file_type', () => {
		const data = {
			nodes: [{ id: 'a', label: 'A', file_type: 'video', source_file: 'a.py' }],
			edges: [],
		};
		const errors = validateExtraction(data);
		expect(errors.some(e => e.includes('invalid file_type'))).toBe(true);
	});

	it('rejects invalid confidence', () => {
		const data = {
			nodes: [
				{ id: 'a', label: 'A', file_type: 'code', source_file: 'a.py' },
				{ id: 'b', label: 'B', file_type: 'code', source_file: 'b.py' },
			],
			edges: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'CERTAIN', source_file: 'a.py' }],
		};
		const errors = validateExtraction(data);
		expect(errors.some(e => e.includes('invalid confidence'))).toBe(true);
	});

	it('detects dangling edge source', () => {
		const data = {
			nodes: [{ id: 'a', label: 'A', file_type: 'code', source_file: 'a.py' }],
			edges: [{ source: 'missing', target: 'a', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' }],
		};
		const errors = validateExtraction(data);
		expect(errors.some(e => e.includes("does not match any node id"))).toBe(true);
	});

	it('detects missing node fields', () => {
		const data = {
			nodes: [{ id: 'a' }],
			edges: [],
		};
		const errors = validateExtraction(data);
		expect(errors.some(e => e.includes("missing required field 'label'"))).toBe(true);
	});

	it('collects all errors', () => {
		const errors = validateExtraction({});
		expect(errors.length).toBe(2);
	});
});

describe('assertValid', () => {
	it('does not throw for valid data', () => {
		expect(() => assertValid(VALID_DATA)).not.toThrow();
	});

	it('throws for invalid data', () => {
		expect(() => assertValid({})).toThrow(/error\(s\)/);
	});
});
