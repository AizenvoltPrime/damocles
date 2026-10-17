import { GRAPH_LANE_WIDTH, tokenIndex } from '../../../core/scm/graph-lanes';

// The five tokens a lane colour cycles through (plan slice 13), in graph-lanes.ts's tokenIndex order, and their text forms,
// which keep AA contrast for a label drawn in a lane's colour.
const LANE_TOKENS = ['--d-accent', '--d-info', '--d-warning', '--d-success', '--d-danger'] as const;
const LANE_TEXT_TOKENS = ['--d-accent-text', '--d-info-text', '--d-warning-text', '--d-success-text', '--d-danger-text'] as const;

/** The CSS colour a lane colour of the port is drawn in. */
export const laneColor = (color: number): string => `var(${LANE_TOKENS[tokenIndex(color)]})`;

/** The CSS colour of text in a lane colour of the port. */
export const laneTextColor = (color: number): string => `var(${LANE_TEXT_TOKENS[tokenIndex(color)]})`;

// px of a lane's stroke and of a ring's thinner stroke at any font size, as the prototype draws them.
const LANE_STROKE_PX = 2;
const RING_STROKE_PX = 1.5;

/**
 * CSS px a row's lanes are drawn with: lane width, the lane and ring strokes, and the x offset that centres an odd lane stroke
 * on a device pixel.
 */
export interface LaneMetrics {
  readonly width: number;
  readonly stroke: number;
  readonly ring: number;
  readonly offset: number;
}

/**
 * Lane metrics that land on whole device pixels: the lane width (VS Code's 11px at the default font) and the strokes rounded to
 * device pixels, and an odd lane stroke shifted half a device pixel so neither of its edges blurs.
 */
export function laneMetrics(rootFontPx: number, devicePixelRatio: number): LaneMetrics {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const device = (px: number): number => Math.max(1, Math.round(px * dpr));
  const width = device((GRAPH_LANE_WIDTH * rootFontPx) / 16) / dpr;
  const strokeDevice = device(LANE_STROKE_PX);
  return { width, stroke: strokeDevice / dpr, ring: device(RING_STROKE_PX) / dpr, offset: strokeDevice % 2 === 1 ? 0.5 / dpr : 0 };
}
