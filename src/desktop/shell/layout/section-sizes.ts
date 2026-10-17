import type { SidebarSectionId } from '../../preload/shell-channels';

export type SizedSection = Exclude<SidebarSectionId, 'chats'>;
export type SectionSizes = Record<SizedSection, number>;

export const SIZED_SECTIONS: readonly SizedSection[] = ['projects', 'files', 'search', 'repos', 'scm', 'graph'];

export const isSizedSection = (name: SidebarSectionId): name is SizedSection => name !== 'chats';

// VS Code's SplitView (`splitview.ts`): the open sections that keep a size of their own (`fixed`, top to bottom) share `room`,
// the height left once the filler keeps its minimum. A section outside `fixed` keeps its stored size, so a collapsed one
// reopens at it.

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
 * The sizes after the user expands `changed` at `size`, as `SplitView.onViewChange` does: `changed` keeps its size, and
 * the other sections give up what no longer fits from the bottom up, each down to `min`.
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

/** A section as `SplitView` sees it, top to bottom: its body's size and limits. A collapsed one is 0 at 0 to 0. */
export interface SplitItem {
  readonly size: number;
  readonly min: number;
  readonly max: number;
}

const total = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

/**
 * How far the sash below `items[index]` may move up (min, <= 0) and down (max, >= 0), as `SplitView.resize` bounds its delta:
 * the items above must take what the items below give, looking past collapsed ones. Both 0 is `updateSashEnablement`'s
 * disabled sash, min 0 its AtMinimum and max 0 its AtMaximum.
 */
export function sashRange(items: readonly SplitItem[], index: number): { min: number; max: number } {
  const up = items.slice(0, index + 1);
  const down = items.slice(index + 1);
  return {
    min: Math.max(total(up.map((item) => item.min - item.size)), total(down.map((item) => item.size - item.max))),
    max: Math.min(total(down.map((item) => item.size - item.min)), total(up.map((item) => item.max - item.size))),
  };
}

/**
 * The sizes after the sash below `items[index]` moves `delta` px down, as `SplitView.resize` (no priorities or snapping) moves
 * them: the items above take the change nearest first and the items below give it nearest first, each within its limits.
 */
export function moveSash(items: readonly SplitItem[], index: number, delta: number): number[] {
  const range = sashRange(items, index);
  const moved = Math.min(Math.max(delta, range.min), range.max);
  const sizes = items.map((item) => item.size);
  const fit = (item: SplitItem, size: number): number => Math.min(Math.max(size, item.min), item.max);
  for (let i = index, deltaUp = moved; i >= 0; i--) {
    const size = fit(items[i]!, sizes[i]! + deltaUp);
    deltaUp -= size - sizes[i]!;
    sizes[i] = size;
  }
  for (let i = index + 1, deltaDown = moved; i < items.length; i++) {
    const size = fit(items[i]!, sizes[i]! - deltaDown);
    deltaDown += size - sizes[i]!;
    sizes[i] = size;
  }
  return sizes;
}
