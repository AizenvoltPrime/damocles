import type { SidebarSectionId } from '../../preload/shell-channels';

export type SectionOrder = readonly SidebarSectionId[];
export type DropEdge = 'before' | 'after';

/** The order with `moved` dropped on `edge` of `target`, as VS Code's ViewPaneContainer drops a view on a pane's half. */
export function dropSection(order: SectionOrder, moved: SidebarSectionId, target: SidebarSectionId, edge: DropEdge): SectionOrder {
  if (moved === target) return order;
  const rest = order.filter((name) => name !== moved);
  const at = rest.indexOf(target) + (edge === 'after' ? 1 : 0);
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/** The order with `moved` swapped with its neighbour `offset` (-1 up, 1 down) away; unchanged at either end. */
export function shiftSection(order: SectionOrder, moved: SidebarSectionId, offset: -1 | 1): SectionOrder {
  const from = order.indexOf(moved);
  const to = from + offset;
  if (to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export const sameOrder = (a: SectionOrder, b: SectionOrder): boolean => a.length === b.length && a.every((name, index) => name === b[index]);
