export type SizedSection = 'projects' | 'files' | 'search' | 'scm';
export type SectionSizes = Record<SizedSection, number>;

/** Top to bottom, as the sidebar draws them. */
export const SIZED_SECTIONS: readonly SizedSection[] = ['projects', 'files', 'search', 'scm'];

// VS Code's SplitView (`splitview.ts`): the open sections that keep a size of their own (`fixed`) share `room`, the height
// left once the filler keeps its minimum. A section outside `fixed` keeps its stored size, so a collapsed one reopens at it.

/** The most one section may take: everything the others can give, each keeping `min`. */
export const largestSection = (fixed: readonly SizedSection[], room: number, min: number): number =>
  Math.max(min, room - min * (fixed.length - 1));

/**
 * Fits the stored sizes to the room, as `SplitView.layout` does with its saved proportions: sizes that fit stay, and sizes
 * that do not shrink in proportion, none below `min`.
 */
export function fitSections(stored: Readonly<SectionSizes>, fixed: readonly SizedSection[], room: number, min: number): SectionSizes {
  const sizes = { ...stored };
  for (const name of fixed) sizes[name] = Math.max(stored[name], min);
  if (fixed.reduce((sum, name) => sum + sizes[name], 0) <= room) return sizes;
  let scaled = [...fixed];
  let budget = room;
  while (scaled.length > 0) {
    const total = scaled.reduce((sum, name) => sum + sizes[name], 0);
    const pinned = scaled.filter((name) => (sizes[name] * budget) / total < min);
    if (pinned.length === 0) {
      for (const name of scaled) sizes[name] = Math.max(min, Math.floor((sizes[name] * budget) / total));
      break;
    }
    for (const name of pinned) sizes[name] = min;
    budget -= min * pinned.length;
    scaled = scaled.filter((name) => !pinned.includes(name));
  }
  return sizes;
}

/**
 * The sizes after the user expands or resizes `changed` to `size`, as `SplitView.onViewChange` does: `changed` keeps its
 * size, and the other sections give up what no longer fits from the bottom up, each down to `min`.
 */
export function yieldTo(
  current: Readonly<SectionSizes>,
  fixed: readonly SizedSection[],
  room: number,
  min: number,
  changed: SizedSection,
  size: number,
): SectionSizes {
  const sizes = { ...current };
  for (const name of fixed) sizes[name] = Math.max(current[name], min);
  sizes[changed] = Math.min(Math.max(size, min), largestSection(fixed, room, min));
  let deficit = fixed.reduce((sum, name) => sum + sizes[name], 0) - room;
  for (const name of [...fixed].reverse()) {
    if (deficit <= 0) break;
    if (name === changed) continue;
    const given = Math.min(deficit, sizes[name] - min);
    sizes[name] -= given;
    deficit -= given;
  }
  return sizes;
}
