import type { DatabaseInstance } from './types';

/** Separator- and (on win32) case-insensitive comparison key for a folder or file path. */
function pathKey(p: string, platform: NodeJS.Platform): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

export function sameWorkspace(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/**
 * Re-keys every row of folder `from` to `to` (a moved project, docs/invariants.md "Project relocation"), in the caller's
 * transaction. `to` takes the spelling the store already has for it; a profile section `to` already has wins over `from`'s,
 * and among `from`'s spellings of one section the latest edit wins.
 */
export function relocateWorkspaceRows(db: DatabaseInstance, from: string, to: string, platform: NodeJS.Platform = process.platform): void {
  const spellingsOf = (table: string, column: string): string[] =>
    (db.prepare(`SELECT DISTINCT ${column} AS w FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ w: string }>).map((row) => row.w);
  const target = matchKnownWorkspace(to, spellingsOf('memories', 'workspace'), platform) ?? to;
  const columns: ReadonlyArray<readonly [string, string]> = [
    ['memories', 'workspace'],
    ['memory_candidates', 'workspace'],
    ['memory_retrievals', 'workspace'],
    ['memory_audit_proposals', 'target_workspace'],
    ['memory_audit_proposals', 'profile_workspace'],
  ];
  for (const [table, column] of columns) {
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`);
    for (const spelling of spellingsOf(table, column)) if (sameWorkspace(spelling, from, platform)) update.run(target, spelling);
  }
  relocateAuditStates(db, from, target, platform);
  const profile = db
    .prepare("SELECT workspace, section FROM memory_profile WHERE scope = 'project' ORDER BY updated_at DESC")
    .all() as Array<{ workspace: string; section: string }>;
  const claimed = new Set(profile.filter((row) => sameWorkspace(row.workspace, to, platform)).map((row) => row.section));
  const remove = db.prepare("DELETE FROM memory_profile WHERE scope = 'project' AND workspace = ? AND section = ?");
  const move = db.prepare("UPDATE memory_profile SET workspace = ? WHERE scope = 'project' AND workspace = ? AND section = ?");
  for (const row of profile) {
    if (!sameWorkspace(row.workspace, from, platform)) continue;
    if (claimed.has(row.section)) {
      remove.run(row.workspace, row.section);
    } else {
      move.run(target, row.workspace, row.section);
      claimed.add(row.section);
    }
  }
}

/** Points the folder a memory proposal's `before_state` recorded (`row`, `applied`) at `target`, so revert matches and restores the moved row. */
function relocateAuditStates(db: DatabaseInstance, from: string, target: string, platform: NodeJS.Platform): void {
  const proposals = db
    .prepare('SELECT id, before_state FROM memory_audit_proposals WHERE before_state IS NOT NULL')
    .all() as Array<{ id: string; before_state: string }>;
  const update = db.prepare('UPDATE memory_audit_proposals SET before_state = ? WHERE id = ?');
  for (const { id, before_state } of proposals) {
    const state = JSON.parse(before_state) as { row?: { workspace?: unknown }; applied?: { workspace?: unknown } };
    let changed = false;
    for (const recorded of [state.row, state.applied]) {
      if (recorded && typeof recorded.workspace === 'string' && sameWorkspace(recorded.workspace, from, platform)) {
        recorded.workspace = target;
        changed = true;
      }
    }
    if (changed) update.run(JSON.stringify(state), id);
  }
}

/** The spelling in `known` that names the same folder as `candidate`, or null when none does. */
export function matchKnownWorkspace(
  candidate: string,
  known: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  return known.find(k => sameWorkspace(k, candidate, platform)) ?? null;
}

/**
 * Distinct `workspace` values of live rows that `wanted` keeps and whose folder exists, plus the open folders,
 * leaving out `nonProject` folders (the home-directory bucket of a window with no folder open), which contain
 * nearly every path. Only a stored folder `wanted` keeps is checked. A database spelling wins over an open
 * folder's spelling of the same path, so a row filed under the result lands in the bucket other windows already query.
 */
export async function listKnownWorkspaces(
  db: DatabaseInstance,
  openFolders: readonly string[],
  nonProject: readonly string[],
  exists: (folder: string) => Promise<boolean>,
  wanted: (folder: string) => boolean = () => true,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const rows = db
    .prepare('SELECT DISTINCT workspace FROM memories WHERE is_latest = 1 AND forgotten = 0 AND workspace IS NOT NULL')
    .all() as Array<{ workspace: string }>;
  const admit = (folder: string, listed: readonly string[]): boolean =>
    !matchKnownWorkspace(folder, listed, platform) && !matchKnownWorkspace(folder, nonProject, platform);
  const stored: string[] = [];
  for (const { workspace } of rows) {
    if (workspace && wanted(workspace) && admit(workspace, stored)) stored.push(workspace);
  }
  const present = await Promise.all(stored.map(folder => exists(folder)));
  const known = stored.filter((_, i) => present[i]);
  for (const folder of openFolders) {
    if (admit(folder, known)) known.push(folder);
  }
  return known;
}

/** The known workspace containing absolute `file`, preferring the deepest match; null when none does. */
export function workspaceContaining(
  file: string,
  known: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const fileKey = pathKey(file, platform);
  let best: string | null = null;
  let bestLength = -1;
  for (const workspace of known) {
    const key = pathKey(workspace, platform);
    if ((fileKey === key || fileKey.startsWith(`${key}/`)) && key.length > bestLength) {
      best = workspace;
      bestLength = key.length;
    }
  }
  return best;
}

function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

/**
 * The single known workspace other than `current` that holds every one of `files`, or null. Files all
 * inside `current` (a nested known workspace included), any relative path, any file outside the known
 * set, or files split across workspaces keep the memory in `current`. `known` is read only when a
 * move is possible.
 */
export async function attributeFilesToWorkspace(
  files: readonly string[],
  current: string,
  known: () => Promise<readonly string[]>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (files.length === 0 || !files.every(isAbsolutePath)) return null;
  if (files.every(file => workspaceContaining(file, [current], platform) !== null)) return null;
  const folders = await known();
  let target: string | null = null;
  for (const file of files) {
    const owner = workspaceContaining(file, folders, platform);
    if (!owner) return null;
    if (target === null) target = owner;
    else if (!sameWorkspace(target, owner, platform)) return null;
  }
  return target !== null && !sameWorkspace(target, current, platform) ? target : null;
}
