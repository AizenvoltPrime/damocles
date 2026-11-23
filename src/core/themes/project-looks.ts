// Per-project looks and character pins in projects.json (docs/invariants.md "Desktop themes", "Project relocation"): this
// computer's only, keyed by project key, never in a repository, and written only inside the theme store's write lane. They
// follow a project's relocation and leave with Remove Project and Forget host, as the Git hosting bindings do.
import { authorityKeyOfProject } from '../../shared/project-location';
import { BUILTIN_THEME_ID } from '../../shared/themes/builtin';
import { PROJECTS_FILE_VERSION } from '../../shared/themes/characters';
import { MAX_PROJECT_LOOKS, parseProjectLooks, type ProjectLook } from '../../shared/themes/project-looks';
import { parseStoredJson } from '../../shared/themes/stored-json';
import { currentPathOf, type RelocationAliases } from '../project-relocation/aliases';
import { folderKey } from '../workspace-folders/folder-key';
import type { ProjectsStore } from './characters';
import type { WriteLane } from './write-lane';

export interface ProjectLooksDeps {
  readonly projects: Pick<ProjectsStore, 'readText' | 'writeText'>;
  readonly lane: Pick<WriteLane, 'run'>;
  // tells the theme store's listeners projects.json changed
  readonly changed: () => void;
  // this process's relocation journal: its folder moves and the folderKeys a pending relocation names
  readonly relocations: () => { readonly aliases: RelocationAliases; readonly pendingKeys: ReadonlySet<string> };
  // the undo history's projects.json snapshots, which every re-key and forget changes too; called inside the lane
  readonly history?: () => { mapProjects(transform: (text: string | null) => string | null): Promise<void> };
}

export interface ProjectLooks {
  /** The project's look; while a relocation is pending, a look stored under the folder it moves from maps through the aliases. */
  projectLookOf(projectKey: string): Promise<ProjectLook | undefined>;
  /** Every look by project key; a pending relocation's look is listed under its stored key and under where the aliases lead. */
  shownLooks(): Promise<Record<string, ProjectLook>>;
  /** projects.json's object with the project's look set, or removed for null, together with any stored key that maps to it. */
  withLook(raw: unknown, projectKey: string, look: ProjectLook | null): Record<string, unknown>;
  /**
   * projects.json's object with no look naming a theme of `themeIds`: a full theme becomes the built-in theme in the same look,
   * touches drop that character set; undefined when no look names one.
   */
  withoutThemes(raw: unknown, themeIds: ReadonlySet<string>): Record<string, unknown> | undefined;
  /** A moved project's look and pins go to its new key; what the new key already holds wins (a merge). */
  relocateProject(fromKey: string, toKey: string): Promise<void>;
  /** Drops the project's look and pins (Remove Project). */
  forgetProject(projectKey: string): Promise<void>;
  /** Drops the looks and pins of the authority's projects (Forget host). */
  forgetHost(authorityKey: string): Promise<void>;
  /** Drops the looks and pins of every authority but 'local' outside kept; answers the authorities dropped. */
  keepHosts(kept: ReadonlySet<string>): Promise<readonly string[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

type Entries = Array<[string, unknown]>;
// Entries, never property writes, so a key such as __proto__ from the file stays an own key.
const entriesOf = (value: unknown): Entries => (isRecord(value) ? Object.entries(value) : []);

/**
 * projects.json's object, with its looks and pins as entries. A file of another version reads as empty and is never written
 * from that: a look or pin change refuses it first (ProjectsStore.editable), and every other change finds nothing in it to change.
 */
function split(raw: unknown): { readonly rest: Entries; readonly looks: Entries; readonly pins: Entries } {
  const file = isRecord(raw) && raw['version'] === PROJECTS_FILE_VERSION ? raw : {};
  return {
    rest: Object.entries(file).filter(([key]) => key !== 'version' && key !== 'looks' && key !== 'pins'),
    looks: entriesOf(file['looks']),
    pins: entriesOf(file['pins']),
  };
}

const join = (parts: { readonly rest: Entries; readonly looks: Entries; readonly pins: Entries }): Record<string, unknown> =>
  Object.fromEntries([...parts.rest, ['version', PROJECTS_FILE_VERSION], ['pins', Object.fromEntries(parts.pins)], ['looks', Object.fromEntries(parts.looks)]]);

// Two pins of one project: the target's character per theme and its every-theme character win.
function mergePins(from: unknown, to: unknown): unknown {
  if (!isRecord(to)) return from;
  if (!isRecord(from)) return to;
  const byTheme = Object.fromEntries([...entriesOf(from['byTheme']), ...entriesOf(to['byTheme'])]);
  const everyTheme = to['everyTheme'] ?? from['everyTheme'];
  return { ...(Object.keys(byTheme).length > 0 ? { byTheme } : {}), ...(everyTheme !== undefined ? { everyTheme } : {}) };
}

function rekey(entries: Entries, fromKey: string, toKey: string, merge: (from: unknown, to: unknown) => unknown): Entries {
  const moved = entries.find(([key]) => key === fromKey);
  if (!moved) return entries;
  const target = entries.find(([key]) => key === toKey);
  const kept = entries.filter(([key]) => key !== fromKey && key !== toKey);
  return [...kept, [toKey, merge(moved[1], target?.[1])]];
}

export function createProjectLooks(deps: ProjectLooksDeps): ProjectLooks {
  const read = async (): Promise<unknown> => {
    const text = await deps.projects.readText();
    if (text === null) return undefined;
    try {
      return parseStoredJson(text);
    } catch {
      return undefined;
    }
  };
  // Where a stored key leads while a relocation that names it is pending; undefined for any other key, which is current.
  const pendingTarget = (stored: string): string | undefined => {
    if (authorityKeyOfProject(stored) !== 'local') return undefined;
    const { aliases, pendingKeys } = deps.relocations();
    if (!pendingKeys.has(folderKey(stored))) return undefined;
    const now = folderKey(currentPathOf(aliases, stored));
    return now === folderKey(stored) ? undefined : now;
  };
  const shownOf = (raw: unknown): Record<string, ProjectLook> => {
    const looks = parseProjectLooks(raw);
    const mapped = Object.entries(looks).flatMap(([key, look]) => {
      const target = pendingTarget(key);
      return target !== undefined && looks[target] === undefined ? [[target, look] as const] : [];
    });
    return Object.fromEntries([...Object.entries(looks), ...mapped]);
  };
  const textOf = (parts: ReturnType<typeof split>): string => `${JSON.stringify(join(parts), null, 2)}\n`;
  // The same change on a history snapshot's text; one that does not parse, or that the change leaves alone, stays as it is.
  const snapshotWith = (change: (parts: ReturnType<typeof split>) => ReturnType<typeof split> | undefined) => (text: string | null): string | null => {
    if (text === null) return null;
    let raw: unknown;
    try {
      raw = parseStoredJson(text);
    } catch {
      return text;
    }
    const next = change(split(raw));
    return next ? textOf(next) : text;
  };
  // One write of projects.json inside the lane, made only when `change` returns another object; with `snapshots` the undo
  // history's copies take the same change, so undoing an older entry never brings back a key that moved or was forgotten.
  const update = async (change: (parts: ReturnType<typeof split>) => ReturnType<typeof split> | undefined, snapshots = false): Promise<void> => {
    const wrote = await deps.lane.run(async () => {
      // read first, so a projects.json that cannot be read leaves the history's snapshots as they were
      const current = await read();
      if (snapshots) await deps.history?.().mapProjects(snapshotWith(change));
      const next = change(split(current));
      if (!next) return false;
      await deps.projects.writeText(textOf(next));
      return true;
    });
    if (wrote) deps.changed();
  };
  const drop = (gone: (key: string) => boolean) => (parts: ReturnType<typeof split>): ReturnType<typeof split> | undefined => {
    const looks = parts.looks.filter(([key]) => !gone(key));
    const pins = parts.pins.filter(([key]) => !gone(key));
    return looks.length === parts.looks.length && pins.length === parts.pins.length ? undefined : { rest: parts.rest, looks, pins };
  };
  return {
    async projectLookOf(projectKey) {
      return shownOf(await read())[projectKey];
    },
    // The list the core protocol carries holds at most MAX_PROJECT_LOOKS: the stored looks come first, so only a pending
    // relocation's copies are ever left out, and projectLookOf still finds each of them.
    shownLooks: async () => Object.fromEntries(Object.entries(shownOf(await read())).slice(0, MAX_PROJECT_LOOKS)),
    withLook(raw, projectKey, look) {
      const parts = split(raw);
      const looks = parts.looks.filter(([key]) => key !== projectKey && pendingTarget(key) !== projectKey);
      return join({ ...parts, looks: look === null ? looks : [...looks, [projectKey, look]] });
    },
    withoutThemes(raw, themeIds) {
      const parts = split(raw);
      let changed = false;
      const looks = parts.looks.map(([key, look]): [string, unknown] => {
        if (!isRecord(look)) return [key, look];
        if (look['mode'] === 'full' && typeof look['themeId'] === 'string' && themeIds.has(look['themeId'])) {
          changed = true;
          return [key, { ...look, themeId: BUILTIN_THEME_ID }];
        }
        if (look['mode'] === 'touches' && typeof look['characterSet'] === 'string' && themeIds.has(look['characterSet'])) {
          changed = true;
          return [key, Object.fromEntries(Object.entries(look).filter(([field]) => field !== 'characterSet'))];
        }
        return [key, look];
      });
      return changed ? join({ ...parts, looks }) : undefined;
    },
    relocateProject: (fromKey, toKey) => update((parts) => {
      if (fromKey === toKey || !parts.looks.concat(parts.pins).some(([key]) => key === fromKey)) return undefined;
      return { rest: parts.rest, looks: rekey(parts.looks, fromKey, toKey, (from, to) => to ?? from), pins: rekey(parts.pins, fromKey, toKey, mergePins) };
    }, true),
    forgetProject: (projectKey) => update(drop((key) => key === projectKey), true),
    forgetHost: (authorityKey) => update(drop((key) => authorityKeyOfProject(key) === authorityKey), true),
    async keepHosts(kept) {
      const gone = (key: string): boolean => {
        const authority = authorityKeyOfProject(key);
        return authority !== 'local' && !kept.has(authority);
      };
      let dropped: string[] = [];
      // update runs the change over the snapshots first, so its last run, which sets `dropped`, is projects.json's
      await update((parts) => {
        dropped = [...new Set(parts.looks.concat(parts.pins).map(([key]) => key).filter(gone).map(authorityKeyOfProject))];
        return drop(gone)(parts);
      }, true);
      return dropped;
    },
  };
}
