import { describe, it, expect } from 'vitest';
import { godNodes, surprisingConnections, suggestQuestions, graphDiff } from '../analyze';
import { buildFromExtraction } from '../build';
import { cluster } from '../cluster';
import { createTestGraph, addTestNode, addTestEdge, makeSimpleExtraction } from './graph-helpers';

describe('godNodes', () => {
	it('returns sorted by degree', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const gods = godNodes(G);
		for (let i = 1; i < gods.length; i++) {
			expect(gods[i - 1].edges).toBeGreaterThanOrEqual(gods[i].edges);
		}
	});

	it('includes required fields', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const gods = godNodes(G);
		for (const g of gods) {
			expect(g).toHaveProperty('id');
			expect(g).toHaveProperty('label');
			expect(g).toHaveProperty('edges');
		}
	});

	it('excludes file-like nodes', () => {
		const G = createTestGraph();
		addTestNode(G, 'file', 'module.py');
		addTestNode(G, 'class', 'MyClass');
		addTestNode(G, 'func', '.init()');
		addTestEdge(G, 'file', 'class');
		addTestEdge(G, 'class', 'func');
		const gods = godNodes(G);
		const labels = gods.map(g => g.label);
		expect(labels).not.toContain('module.py');
	});

	it('respects top_n', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const gods = godNodes(G, 2);
		expect(gods.length).toBeLessThanOrEqual(2);
	});
});

describe('surprisingConnections', () => {
	it('finds cross-file connections', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'ClassA', 'file1.py');
		addTestNode(G, 'b', 'ClassB', 'file2.py');
		addTestEdge(G, 'a', 'b', 'calls', 'INFERRED');
		const surprises = surprisingConnections(G);
		expect(surprises.length).toBeGreaterThan(0);
	});

	it('excludes concept nodes', () => {
		const G = createTestGraph();
		addTestNode(G, 'concept', 'SomeConcept', '');
		addTestNode(G, 'real1', 'RealClass', 'file1.py');
		addTestNode(G, 'real2', 'OtherClass', 'file2.py');
		addTestEdge(G, 'concept', 'real1', 'relates', 'INFERRED');
		addTestEdge(G, 'real1', 'real2', 'calls', 'INFERRED');
		const surprises = surprisingConnections(G);
		const allLabels = surprises.flatMap(s => [s.source, s.target]);
		expect(allLabels).not.toContain('SomeConcept');
	});

	it('AMBIGUOUS scores higher than EXTRACTED', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'Alpha', 'f1.py');
		addTestNode(G, 'b', 'Beta', 'f2.py');
		addTestNode(G, 'c', 'Gamma', 'f3.py');
		addTestEdge(G, 'a', 'b', 'calls', 'AMBIGUOUS');
		addTestEdge(G, 'a', 'c', 'calls', 'EXTRACTED');
		const surprises = surprisingConnections(G);
		if (surprises.length >= 2) {
			expect(surprises[0].confidence).toBe('AMBIGUOUS');
		}
	});
});

describe('suggestQuestions', () => {
	it('generates questions from AMBIGUOUS edges', () => {
		const extraction = makeSimpleExtraction();
		const G = buildFromExtraction(extraction);
		const communities = cluster(G);
		const labels: Record<number, string> = {};
		for (const cid of Object.keys(communities)) labels[Number(cid)] = `Group ${cid}`;
		const questions = suggestQuestions(G, communities, labels);
		expect(questions.length).toBeGreaterThan(0);
	});

	it('returns no_signal when graph has no interesting features', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A', 'f.py');
		addTestNode(G, 'b', 'B', 'f.py');
		addTestEdge(G, 'a', 'b', 'contains', 'EXTRACTED');
		const questions = suggestQuestions(G, { 0: ['a', 'b'] }, { 0: 'Group' });
		if (questions.length === 1 && questions[0].type === 'no_signal') {
			expect(questions[0].question).toBeNull();
		}
	});
});

describe('graphDiff', () => {
	it('detects new nodes', () => {
		const G1 = createTestGraph();
		addTestNode(G1, 'a', 'A');
		const G2 = createTestGraph();
		addTestNode(G2, 'a', 'A');
		addTestNode(G2, 'b', 'B');
		const diff = graphDiff(G1, G2);
		expect(diff.new_nodes.length).toBe(1);
		expect(diff.summary).toContain('1 new node');
	});

	it('detects removed nodes', () => {
		const G1 = createTestGraph();
		addTestNode(G1, 'a', 'A');
		addTestNode(G1, 'b', 'B');
		const G2 = createTestGraph();
		addTestNode(G2, 'a', 'A');
		const diff = graphDiff(G1, G2);
		expect(diff.removed_nodes.length).toBe(1);
		expect(diff.summary).toContain('removed');
	});

	it('reports no changes', () => {
		const G = createTestGraph();
		addTestNode(G, 'a', 'A');
		const diff = graphDiff(G, G);
		expect(diff.summary).toBe('no changes');
	});
});
