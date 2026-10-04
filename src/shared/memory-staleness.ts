import type { MemoryEntry } from './types/memory';

/** File changes since a memory was recorded at which it counts as stale, for the injection gate and the Memory overlay alike. */
export const STALENESS_THRESHOLD = 3;

export function isStaleMemory(entry: Pick<MemoryEntry, 'fileChangeCount'>): boolean {
  return (entry.fileChangeCount ?? 0) >= STALENESS_THRESHOLD;
}
