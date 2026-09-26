/** A cache hit rate as a whole percent, floored so a rate short of 100% never reads 100%. */
export function cacheHitPercent(rate: number): number {
  // The epsilon absorbs float error: 0.29 * 100 is 28.999999999999996.
  return Math.floor(rate * 100 + 1e-9);
}
