import { describe, it, expect } from 'vitest';
import { buildFromExtraction } from '../build';
import { cluster, scoreAll } from '../cluster';
import { godNodes, surprisingConnections, suggestQuestions } from '../analyze';
import { generateReport } from '../report';
import { makeSimpleExtraction, loadFixtureExtraction } from './graph-helpers';
import type { DetectionResult, Confidence } from '../types';
import { VALID_CONFIDENCES } from '../types';

describe('end-to-end pipeline', () => {
	const extraction = makeSimpleExtraction();
	const G = buildFromExtraction(extraction);
	const communities = cluster(G);
	const cohesionScores = scoreAll(G, communities);
	const communityLabels: Record<number, string> = {};
	for (const cid of Object.keys(communities)) {
		communityLabels[Number(cid)] = `Group ${cid}`;
	}

	it('buildGraph produces graph from extraction', () => {
		expect(G.order).toBeGreaterThan(0);
		expect(G.size).toBeGreaterThan(0);
	});

	it('cluster assigns communities', () => {
		expect(Object.keys(communities).length).toBeGreaterThan(0);
		const allNodes = new Set<string>();
		for (const nodes of Object.values(communities)) {
			for (const n of nodes) allNodes.add(n);
		}
		G.forEachNode(nodeId => {
			expect(allNodes.has(nodeId)).toBe(true);
		});
	});

	it('godNodes returns results', () => {
		const gods = godNodes(G);
		expect(Array.isArray(gods)).toBe(true);
		for (const g of gods) {
			expect(g).toHaveProperty('id');
			expect(g).toHaveProperty('label');
			expect(g).toHaveProperty('edges');
		}
	});

	it('surprisingConnections returns list', () => {
		const surprises = surprisingConnections(G, communities);
		expect(Array.isArray(surprises)).toBe(true);
	});

	it('suggestQuestions returns list', () => {
		const questions = suggestQuestions(G, communities, communityLabels);
		expect(Array.isArray(questions)).toBe(true);
		expect(questions.length).toBeGreaterThan(0);
		for (const q of questions) {
			expect(q).toHaveProperty('type');
			expect(q).toHaveProperty('why');
		}
	});

	it('generateReport produces markdown string', () => {
		const detection: DetectionResult = {
			files: { code: ['model.py'], document: ['docs.md'], paper: [], image: [] },
			total_files: 2,
			total_words: 5000,
			needs_graph: true,
			warning: null,
			skipped_sensitive: [],
		};
		const report = generateReport(
			G, communities, cohesionScores, communityLabels,
			godNodes(G),
			surprisingConnections(G, communities),
			detection,
			{ input: 1000, output: 500 },
			'/project',
			suggestQuestions(G, communities, communityLabels),
		);
		expect(typeof report).toBe('string');
		expect(report).toContain('# Graph Report');
		expect(report.length).toBeGreaterThan(100);
	});

	it('all confidences are valid values', () => {
		G.forEachEdge((_, attrs) => {
			expect(VALID_CONFIDENCES.has(attrs.confidence)).toBe(true);
		});
	});

	it('fixture extraction produces valid pipeline output', () => {
		const fixture = loadFixtureExtraction();
		const fixtureG = buildFromExtraction(fixture);
		const fixtureCommunities = cluster(fixtureG);
		const fixtureCohesion = scoreAll(fixtureG, fixtureCommunities);

		expect(fixtureG.order).toBeGreaterThan(0);
		expect(Object.keys(fixtureCommunities).length).toBeGreaterThan(0);

		for (const [cid, score] of Object.entries(fixtureCohesion)) {
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}

		fixtureG.forEachEdge((_, attrs) => {
			expect(VALID_CONFIDENCES.has(attrs.confidence as Confidence)).toBe(true);
		});
	});
});
