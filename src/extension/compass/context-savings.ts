import type { StoredNode } from './types';

const CHARS_PER_LINE = 40;

export interface SavingsEstimate {
	graphTokens: number;
	fullSourceTokens: number;
	savedTokens: number;
}

function estimateTokens(chars: number): number {
	return Math.round(chars / 4);
}

export function estimateSourceChars(nodes: Array<Pick<StoredNode, 'kind' | 'line_start' | 'line_end'>>): number {
	let lines = 0;
	for (const node of nodes) {
		if (node.kind === 'File') continue;
		const span = node.line_end - node.line_start + 1;
		if (span > 0) lines += span;
	}
	return lines * CHARS_PER_LINE;
}

export function estimateSavings(graphResponse: string, fullSourceChars: number): SavingsEstimate {
	const graphTokens = estimateTokens(graphResponse.length);
	const fullSourceTokens = estimateTokens(fullSourceChars);
	return {
		graphTokens,
		fullSourceTokens,
		savedTokens: Math.max(0, fullSourceTokens - graphTokens),
	};
}

export function formatSavingsLine(estimate: SavingsEstimate): string {
	return `Context saved: ~${estimate.savedTokens} tokens (graph ~${estimate.graphTokens} vs full-source ~${estimate.fullSourceTokens}) — estimate`;
}
