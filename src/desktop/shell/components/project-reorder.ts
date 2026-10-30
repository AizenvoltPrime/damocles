// The Projects list's reorder rules, shared by drag and keyboard. Each returns the whole new order for main to write.

export interface OrderedProject {
  readonly key: string;
  // the project's authority key: 'local', 'loopback', 'ssh+<hostId>'
  readonly group: string;
}

export type ReorderResult =
  | { readonly ok: true; readonly order: readonly string[] }
  | { readonly ok: false; readonly reason: 'otherGroup' | 'unchanged' };

const UNCHANGED: ReorderResult = { ok: false, reason: 'unchanged' };

function moveKey(keys: readonly string[], key: string, toIndex: number): ReorderResult {
  const from = keys.indexOf(key);
  if (from < 0 || toIndex < 0 || toIndex >= keys.length || toIndex === from) return UNCHANGED;
  const rest = keys.filter((other) => other !== key);
  return { ok: true, order: [...rest.slice(0, toIndex), key, ...rest.slice(toIndex)] };
}

export function moveProject(projects: readonly OrderedProject[], key: string, toIndex: number): ReorderResult {
  return moveKey(projects.map((project) => project.key), key, toIndex);
}

// The group's projects keep the set of positions they hold in the one order, so every other row stays where it is.
export function moveProjectInGroup(
  projects: readonly OrderedProject[],
  key: string,
  targetGroup: string,
  toIndexInGroup: number,
): ReorderResult {
  const group = projects.find((project) => project.key === key)?.group;
  if (group === undefined) return UNCHANGED;
  if (group !== targetGroup) return { ok: false, reason: 'otherGroup' };
  const members = projects.filter((project) => project.group === group).map((project) => project.key);
  const moved = moveKey(members, key, toIndexInGroup);
  if (!moved.ok) return moved;
  let rank = 0;
  // moved.order holds exactly the group's keys, one per slot
  return { ok: true, order: projects.map((project) => (project.group === group ? moved.order[rank++]! : project.key)) };
}

export function moveGroup(groupOrder: readonly string[], group: string, toIndex: number): ReorderResult {
  return moveKey(groupOrder, group, toIndex);
}

export function stepProject(
  projects: readonly OrderedProject[],
  key: string,
  delta: -1 | 1,
  view: 'flat' | 'grouped',
): ReorderResult {
  if (view === 'flat') return moveProject(projects, key, projects.findIndex((project) => project.key === key) + delta);
  const group = projects.find((project) => project.key === key)?.group;
  if (group === undefined) return UNCHANGED;
  const members = projects.filter((project) => project.group === group);
  return moveProjectInGroup(projects, key, group, members.findIndex((project) => project.key === key) + delta);
}

export function stepGroup(groupOrder: readonly string[], group: string, delta: -1 | 1): ReorderResult {
  return moveGroup(groupOrder, group, groupOrder.indexOf(group) + delta);
}
