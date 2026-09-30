import { test, expect } from 'bun:test';

function add(a: number, b: number): number {
	return a + b;
}

test('add returns the sum', () => {
	expect(add(2, 3)).toBe(5);
});

test('add handles zero', () => {
	expect(add(0, 0)).toBe(0);
});
