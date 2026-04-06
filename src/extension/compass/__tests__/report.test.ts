import { describe, it, expect } from 'vitest';
import { generateReport } from '../report';
import { buildFromExtraction } from '../build';
import { cluster, scoreAll } from '../cluster';
import { godNodes, surprisingConnections, suggestQuestions } from '../analyze';
import { makeSimpleExtraction } from './graph-helpers';
import type { DetectionResult, AnalysisResult } from '../types';

function buildAnalysis(): { report: string; analysis: AnalysisResult } {
	const extraction = makeSimpleExtraction();
	const G = buildFromExtraction(extraction);
	const communities = cluster(G);
	const cohesionScores = scoreAll(G, communities);
	const communityLabels: Record<number, string> = {};
	for (const cid of Object.keys(communities)) {
		communityLabels[Number(cid)] = `Group ${cid}`;
	}
	const godNodeList = godNodes(G);
	const surpriseList = surprisingConnections(G, communities);
	const questions = suggestQuestions(G, communities, communityLabels);

	const detection: DetectionResult = {
		files: { code: ['model.py'], document: ['docs.md'], paper: [], image: [] },
		total_files: 2,
		total_words: 5000,
		needs_graph: true,
		warning: null,
		skipped_sensitive: [],
	};

	const report = generateReport(
		G,
		communities,
		cohesionScores,
		communityLabels,
		godNodeList,
		surpriseList,
		detection,
		{ input: 12345, output: 6789 },
		'/my/project',
		questions,
	);

	return {
		report,
		analysis: {
			godNodes: godNodeList,
			surprisingConnections: surpriseList,
			suggestedQuestions: questions,
			communities,
			cohesionScores,
			communityLabels,
		},
	};
}

describe('generateReport', () => {
	it('contains "# Graph Report"', () => {
		const { report } = buildAnalysis();
		expect(report).toContain('# Graph Report');
	});

	it('contains "## Corpus Check"', () => {
		const { report } = buildAnalysis();
		expect(report).toContain('## Corpus Check');
	});

	it('contains "## God Nodes"', () => {
		const { report } = buildAnalysis();
		expect(report).toContain('## God Nodes');
	});

	it('contains "## Surprising Connections"', () => {
		const { report } = buildAnalysis();
		expect(report).toContain('## Surprising Connections');
	});

	it('contains "## Communities"', () => {
		const { report } = buildAnalysis();
		expect(report).toContain('## Communities');
	});

	it('contains "Cohesion:"', () => {
		const { report } = buildAnalysis();
		expect(report).toContain('Cohesion:');
	});

	it('formats token cost with commas', () => {
		const { report } = buildAnalysis();
		expect(report).toContain('12,345');
		expect(report).toContain('6,789');
	});

	it('shows avg confidence for INFERRED edges', () => {
		const { report } = buildAnalysis();
		expect(report).toMatch(/INFERRED.*\d+ edges.*avg confidence/);
	});
});
