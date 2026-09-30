import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../util';

function delay(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

describe('mapWithConcurrency', () => {
	it('returns empty array for empty input without invoking fn', async () => {
		let calls = 0;
		const result = await mapWithConcurrency([], 8, async () => { calls++; return 1; });
		expect(result).toEqual([]);
		expect(calls).toBe(0);
	});

	it('handles a single-item input', async () => {
		const result = await mapWithConcurrency([42], 8, async n => n * 2);
		expect(result).toEqual([84]);
	});

	it('preserves input order regardless of completion order', async () => {
		const items = [0, 1, 2, 3, 4, 5, 6, 7];
		const latencies = [40, 5, 30, 10, 25, 8, 15, 20];
		const result = await mapWithConcurrency(items, 4, async (n, i) => {
			await delay(latencies[i]!);
			return n * 10;
		});
		expect(result).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
	});

	it('passes the correct index to fn', async () => {
		const items = ['a', 'b', 'c', 'd'];
		const seen: Array<[string, number]> = [];
		await mapWithConcurrency(items, 2, async (item, index) => {
			seen.push([item, index]);
			return item;
		});
		seen.sort((a, b) => a[1] - b[1]);
		expect(seen).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
	});

	it('respects the concurrency limit — never more than `limit` fns in flight', async () => {
		const items = Array.from({ length: 50 }, (_, i) => i);
		const limit = 8;
		let inFlight = 0;
		let maxInFlight = 0;
		const result = await mapWithConcurrency(items, limit, async n => {
			inFlight++;
			if (inFlight > maxInFlight) maxInFlight = inFlight;
			await delay(Math.floor(Math.random() * 10));
			inFlight--;
			return n;
		});
		expect(result).toEqual(items);
		expect(maxInFlight).toBeLessThanOrEqual(limit);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	it('clamps limit <= 0 to effectively serial execution', async () => {
		const items = [0, 1, 2, 3, 4];
		let inFlight = 0;
		let maxInFlight = 0;
		const result = await mapWithConcurrency(items, 0, async n => {
			inFlight++;
			if (inFlight > maxInFlight) maxInFlight = inFlight;
			await delay(5);
			inFlight--;
			return n;
		});
		expect(result).toEqual(items);
		expect(maxInFlight).toBe(1);
	});

	it('clamps negative limits to 1', async () => {
		const items = [0, 1, 2];
		let inFlight = 0;
		let maxInFlight = 0;
		await mapWithConcurrency(items, -5, async n => {
			inFlight++;
			if (inFlight > maxInFlight) maxInFlight = inFlight;
			await delay(3);
			inFlight--;
			return n;
		});
		expect(maxInFlight).toBe(1);
	});

	it('does not spawn more workers than items (limit > items.length)', async () => {
		const items = [10, 20, 30];
		const fnCalls = new Set<number>();
		const result = await mapWithConcurrency(items, 100, async n => {
			fnCalls.add(n);
			return n;
		});
		expect(result).toEqual([10, 20, 30]);
		expect(fnCalls.size).toBe(3);
	});

	it('propagates errors from fn through the returned promise', async () => {
		const items = [1, 2, 3, 4];
		await expect(
			mapWithConcurrency(items, 2, async n => {
				if (n === 3) throw new Error('boom');
				return n;
			}),
		).rejects.toThrow('boom');
	});

	it('handles synchronous-like fns that resolve immediately', async () => {
		const items = [1, 2, 3];
		const result = await mapWithConcurrency(items, 2, async n => n + 100);
		expect(result).toEqual([101, 102, 103]);
	});

	it('coerces non-integer limits via truncation', async () => {
		const items = [0, 1, 2, 3, 4];
		let inFlight = 0;
		let maxInFlight = 0;
		await mapWithConcurrency(items, 2.9, async n => {
			inFlight++;
			if (inFlight > maxInFlight) maxInFlight = inFlight;
			await delay(3);
			inFlight--;
			return n;
		});
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});
});
