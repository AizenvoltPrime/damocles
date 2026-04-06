import { describe, it, expect } from 'vitest';
import { toJson } from '../export';
import { buildFromExtraction } from '../build';
import { cluster } from '../cluster';
import { makeSimpleExtraction } from './graph-helpers';

describe('toJson', () => {
	it('output has "nodes" and "links" keys', () => {
		const G = buildFromExtraction(makeSimpleExtraction());
		const communities = cluster(G);
		const json = toJson(G, communities);
		expect(json).toHaveProperty('nodes');
		expect(json).toHaveProperty('links');
	});

	it('nodes have "community" property when communities provided', () => {
		const G = buildFromExtraction(makeSimpleExtraction());
		const communities = cluster(G);
		const json = toJson(G, communities);
		const withCommunity = json.nodes.filter(n => n.community !== undefined);
		expect(withCommunity.length).toBeGreaterThan(0);
	});

	it('JSON is valid (parse roundtrip)', () => {
		const G = buildFromExtraction(makeSimpleExtraction());
		const communities = cluster(G);
		const json = toJson(G, communities);
		const serialized = JSON.stringify(json);
		const parsed = JSON.parse(serialized);
		expect(parsed.nodes.length).toBe(json.nodes.length);
		expect(parsed.links.length).toBe(json.links.length);
	});
});
