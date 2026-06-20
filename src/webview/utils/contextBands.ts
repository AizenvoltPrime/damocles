/**
 * Visual context-usage warning bands derived from the auto-compact trigger percent. The usage bar
 * shades amber → orange → red as it approaches the configured compaction threshold (US-030); above
 * `hard` it matches the point where pi auto-compacts.
 */
export function contextWarningBands(triggerPercent: number): { warning: number; soft: number; hard: number } {
  const hard = triggerPercent;
  return { hard, soft: Math.max(0, hard - 10), warning: Math.max(0, hard - 20) };
}
