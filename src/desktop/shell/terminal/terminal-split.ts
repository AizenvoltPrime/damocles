// A split group's pane widths (VS Code's terminalGroup.ts SplitPaneContainer over its SplitView): px while the shell
// measures and moves them, fractions of the group when main stores them.

// VS Code's SplitPaneMinSize, 80px at the default font.
export const TERMINAL_PANE_MIN_REM = 5;
// Cells one Resize Pane Left or Right moves (VS Code's ResizePartCellCount).
export const RESIZE_PANE_CELLS = 4;

/** Each pane's left edge as a fraction of the group. */
export function paneOffsets(sizes: readonly number[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const size of sizes) {
    offsets.push(at);
    at += size;
  }
  return offsets;
}

/** VS Code's distributeViewSizes, which a sash's double-click and every split, kill and unsplit apply. */
export function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

export function toFractions(widths: readonly number[]): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map((width) => width / total);
}

/** The narrowest a pane may be: minPx and main's fraction, unless the group cannot give every pane that much. */
export function paneMinPx(groupPx: number, count: number, minPx: number, minFraction: number): number {
  return Math.min(Math.max(minPx, minFraction * groupPx), groupPx / count);
}

/**
 * The widths once the sash after pane `index` leaves the panes to its right `rightPx` in total. The shrinking side gives
 * from the pane nearest the sash first, down to `minPx`, then from the next; the growing side's nearest pane takes it all,
 * as VS Code's SplitView resizes.
 */
export function moveSash(widths: readonly number[], index: number, rightPx: number, minPx: number): number[] {
  const next = [...widths];
  const total = next.reduce((sum, width) => sum + width, 0);
  const right = next.slice(index + 1).reduce((sum, width) => sum + width, 0);
  const target = Math.min(Math.max(rightPx, (next.length - index - 1) * minPx), total - (index + 1) * minPx);
  let delta = target - right;
  if (delta === 0) return next;
  const grow = delta > 0 ? index + 1 : index;
  const shrink = delta > 0 ? range(index, -1) : range(index + 1, next.length);
  delta = Math.abs(delta);
  for (const at of shrink) {
    const give = Math.min(delta, Math.max(0, next[at]! - minPx));
    next[at] = next[at]! - give;
    next[grow] = next[grow]! + give;
    delta -= give;
    if (delta <= 0) break;
  }
  return next;
}

function range(from: number, to: number): number[] {
  const step = from <= to ? 1 : -1;
  const out: number[] = [];
  for (let at = from; at !== to; at += step) out.push(at);
  return out;
}

/**
 * VS Code's Resize Pane Left and Right (terminalGroup.ts resizePane): the active pane trades `amountPx` with the pane to its
 * right, or the last pane with the one to its left, so the edge between them moves in `direction`; neither goes below
 * `minPx`.
 */
export function resizePaneWidths(widths: readonly number[], index: number, direction: 'left' | 'right', amountPx: number, minPx: number): number[] {
  if (widths.length <= 1) return [...widths];
  const next = [...widths];
  const last = index === next.length - 1;
  const partner = last ? index - 1 : index + 1;
  let amount = (!last && direction === 'left') || (last && direction === 'right') ? -amountPx : amountPx;
  if (next[index]! + amount < minPx) amount = minPx - next[index]!;
  else if (next[partner]! - amount < minPx) amount = next[partner]! - minPx;
  next[index] = next[index]! + amount;
  next[partner] = next[partner]! - amount;
  return next;
}
