import {
	symbol,
	symbolCircle,
	symbolCross,
	symbolDiamond,
	symbolSquare,
	symbolTriangle,
	type SymbolType,
} from 'd3-shape';
import type { CompassEdgeKind, CompassNodeKind } from '@shared/types/compass';

export const NODE_SHAPE: Record<CompassNodeKind, SymbolType> = {
	File: symbolSquare,
	Class: symbolCircle,
	Function: symbolTriangle,
	Type: symbolDiamond,
	Test: symbolCross,
};

/** d3.symbol size is the shape's area; 320 ≈ π·10.1² so symbols match a 10-radius circle. */
export const NODE_AREA = 320;

export const NODE_EQUIVALENT_RADIUS = Math.sqrt(NODE_AREA / Math.PI);

export interface EdgeStyle {
	stroke: string;
	dash: string | null;
	opacity: number;
}

export const EDGE_STYLE: Record<CompassEdgeKind, EdgeStyle> = {
	CALLS: { stroke: '#a6e3a1', dash: null, opacity: 0.6 },
	IMPORTS_FROM: { stroke: '#89b4fa', dash: '4,2', opacity: 0.6 },
	INHERITS: { stroke: '#cba6f7', dash: null, opacity: 0.6 },
	IMPLEMENTS: { stroke: '#f9e2af', dash: '2,2', opacity: 0.6 },
	TESTED_BY: { stroke: '#f38ba8', dash: '6,3', opacity: 0.6 },
	CONTAINS: {
		stroke: 'color-mix(in srgb, var(--muted-foreground) 40%, transparent)',
		dash: '1,3',
		opacity: 0.6,
	},
	DEPENDS_ON: { stroke: '#fab387', dash: '4,4', opacity: 0.6 },
	REFERENCES: { stroke: '#94e2d5', dash: '3,3', opacity: 0.6 },
};

const symbolBuilder = symbol<unknown>().size(NODE_AREA);

export function nodePathGenerator(kind: CompassNodeKind): string {
	const shape = NODE_SHAPE[kind] ?? symbolCircle;
	return symbolBuilder.type(shape)() ?? '';
}

export function useGraphSymbols() {
	return {
		NODE_SHAPE,
		NODE_AREA,
		NODE_EQUIVALENT_RADIUS,
		EDGE_STYLE,
		nodePathGenerator,
	};
}
