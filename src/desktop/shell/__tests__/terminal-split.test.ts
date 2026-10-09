import { describe, expect, it } from 'vitest';
import { equalSizes, moveSash, paneOffsets, paneMinPx, resizePaneWidths, toFractions } from '../terminal/terminal-split';

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

describe('split pane sizes', () => {
  it('places each pane at the sum of the fractions before it', () => {
    expect(paneOffsets([0.25, 0.25, 0.5])).toEqual([0, 0.25, 0.5]);
    expect(paneOffsets([1])).toEqual([0]);
  });

  it('distributes equally, as VS Code resets a sash', () => {
    expect(equalSizes(1)).toEqual([1]);
    expect(equalSizes(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(sum(equalSizes(3))).toBeCloseTo(1, 12);
  });

  it('turns widths into fractions of the group that sum to 1', () => {
    const sizes = toFractions([300, 300, 400]);
    expect(sizes).toEqual([0.3, 0.3, 0.4]);
    expect(sum(sizes)).toBeCloseTo(1, 12);
  });

  it('keeps the minimum at 80 px unless the group is too narrow for every pane to have it, and never below the fraction main requires', () => {
    expect(paneMinPx(1000, 2, 80, 0.05)).toBe(80);
    expect(paneMinPx(150, 2, 80, 0.05)).toBe(75);
    expect(paneMinPx(4000, 2, 80, 0.05)).toBe(200);
  });
});

describe('sash drag', () => {
  it('moves the boundary between two panes', () => {
    expect(moveSash([500, 500], 0, 600, 80)).toEqual([400, 600]);
    expect(moveSash([500, 500], 0, 300, 80)).toEqual([700, 300]);
  });

  it('stops each pane at the minimum', () => {
    expect(moveSash([500, 500], 0, 990, 80)).toEqual([80, 920]);
    expect(moveSash([500, 500], 0, 0, 80)).toEqual([920, 80]);
  });

  // VS Code's SplitView: a shrinking side gives from the pane nearest the sash first, then the next one.
  it('takes from the nearest pane first and then from the ones beyond it', () => {
    expect(moveSash([300, 300, 400], 1, 700, 80)).toEqual([220, 80, 700]);
    expect(moveSash([300, 300, 400], 0, 900, 80)).toEqual([100, 500, 400]);
    expect(moveSash([300, 300, 400], 0, 80 + 80, 80)).toEqual([840, 80, 80]);
  });

  it('keeps the group width', () => {
    for (const right of [0, 150, 333, 777, 2000]) expect(sum(moveSash([300, 300, 400], 1, right, 80))).toBeCloseTo(1000, 9);
  });
});

describe('Resize Pane Left and Right', () => {
  // terminalGroup.ts resizePane: the active pane trades with the one to its right, the last pane with the one to its left.
  it('moves the active pane\'s right edge, or the last pane\'s left edge', () => {
    expect(resizePaneWidths([500, 500], 0, 'left', 32, 80)).toEqual([468, 532]);
    expect(resizePaneWidths([500, 500], 0, 'right', 32, 80)).toEqual([532, 468]);
    expect(resizePaneWidths([500, 500], 1, 'left', 32, 80)).toEqual([468, 532]);
    expect(resizePaneWidths([500, 500], 1, 'right', 32, 80)).toEqual([532, 468]);
    expect(resizePaneWidths([300, 300, 400], 1, 'right', 40, 80)).toEqual([300, 340, 360]);
  });

  it('stops at the minimum and leaves a single pane alone', () => {
    expect(resizePaneWidths([100, 900], 0, 'left', 32, 80)).toEqual([80, 920]);
    expect(resizePaneWidths([900, 100], 0, 'right', 32, 80)).toEqual([920, 80]);
    expect(resizePaneWidths([1000], 0, 'left', 32, 80)).toEqual([1000]);
  });
});
