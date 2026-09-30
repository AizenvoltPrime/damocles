import { describe, it, expect } from 'vitest';
import { estimateSavings, estimateSourceChars } from '../context-savings';

describe('estimateSavings (US-009)', () => {
	it('computes savedTokens = max(0, fullSource - graph)', () => {
		const s = estimateSavings('a'.repeat(40), 4000);
		expect(s.graphTokens).toBe(10);
		expect(s.fullSourceTokens).toBe(1000);
		expect(s.savedTokens).toBe(990);
	});

	it('clamps savedTokens to 0 when the graph response exceeds the source', () => {
		const s = estimateSavings('x'.repeat(4000), 40);
		expect(s.savedTokens).toBe(0);
	});

	it('uses deterministic chars/4 rounding', () => {
		expect(estimateSavings('abc', 0).graphTokens).toBe(1);
		expect(estimateSavings('ab', 0).graphTokens).toBe(1);
		expect(estimateSavings('a', 0).graphTokens).toBe(0);
	});
});

describe('estimateSourceChars (US-009)', () => {
	it('sums non-File node line spans as a char proxy (no file I/O)', () => {
		const chars = estimateSourceChars([
			{ kind: 'Function', line_start: 1, line_end: 10 },
			{ kind: 'Class', line_start: 20, line_end: 29 },
		]);
		expect(chars).toBe(20 * 40);
	});

	it('excludes File nodes to avoid whole-file double counting', () => {
		const chars = estimateSourceChars([
			{ kind: 'File', line_start: 1, line_end: 1000 },
			{ kind: 'Function', line_start: 1, line_end: 5 },
		]);
		expect(chars).toBe(5 * 40);
	});

	it('ignores zero or negative spans', () => {
		expect(estimateSourceChars([{ kind: 'Function', line_start: 10, line_end: 4 }])).toBe(0);
		expect(estimateSourceChars([])).toBe(0);
	});
});
