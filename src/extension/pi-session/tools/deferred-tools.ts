import { BROWSER_PI_TOOL_NAMES } from './browser-tools';
import { COMPASS_PI_TOOL_NAMES } from './compass-tools';
import { WEB_PI_TOOL_NAMES } from '../web-access/web-tool-specs';

/**
 * Which tools are deferrable, and what group names address them. A leaf module by design: it composes
 * the existing `*_PI_TOOL_NAMES` exports and imports nothing else from `tools/`, so it can be pulled in
 * from `tool-status.ts` and the ToolSearch tool without joining the eval-time cycle `browser-tools.ts`
 * documents (`permission-gate` → `tool-catalog` → `browser-tools`).
 *
 * The web names come from the declaration leaf, NOT the `web-access` barrel — not for graph weight
 * (this already pulls `browser-tools.ts` and with it `../../browser`), but because the barrel re-exports
 * `./config` and its `vscode` import. Taking it would force the enforcing test to be relaxed to "any
 * import is fine", retiring the guard for every group at once.
 */

export type BuiltinDeferredGroup = 'browser' | 'compass' | 'web';

/**
 * The built-in deferrable groups, in the order the ToolSearch inventory lists them — what the model
 * reads, so it is pinned by test rather than left to import order. The pin encodes exactly one claim:
 * `web` comes last, after `browser`. It is NOT "mirrors `FULL_TOOL_CATALOG`", which runs
 * compass → browser → web and so already disagrees. Group #4 needs a deliberate position and a pin edit.
 */
export const BUILTIN_DEFERRED_GROUPS: readonly { group: BuiltinDeferredGroup; names: readonly string[] }[] = [
  { group: 'browser', names: BROWSER_PI_TOOL_NAMES },
  { group: 'compass', names: COMPASS_PI_TOOL_NAMES },
  { group: 'web', names: WEB_PI_TOOL_NAMES },
];

export interface ToolSearchResolution {
  /** Deferrable tool names the entries resolved to, in entry order, de-duplicated. */
  matches: string[];
  /** Entries that named neither a known group nor a deferrable tool, in entry order, de-duplicated. */
  unknown: string[];
  /** Requested built-in group names that also name an MCP server; the built-in won. */
  shadowedGroups: string[];
  /**
   * Requested group names that ARE known groups but hold nothing this caller can activate — the group's
   * subsystem is off, or every tool in it is user-disabled. Distinct from `unknown` (a name that
   * addresses nothing) because the fix differs: an inert group is not a typo to correct but a
   * capability that is switched off, and without this the caller sees a bare "nothing loaded" and
   * cannot tell a disabled subsystem from a misspelling.
   */
  inertGroups: string[];
}

/**
 * The deferrable subset of an eligible set: browser + compass + web + MCP, intersected with `eligible`.
 * Intersecting here is what makes eligibility authoritative — a tool the user disabled via
 * `damocles.tools.disabled`, or whose subsystem is off, is absent from `eligible` and therefore never
 * deferrable, so `ToolSearch` can never resurrect it.
 */
export function deferredToolNames(eligible: Iterable<string>, mcpNames: Iterable<string>): string[] {
  const deferrable = new Set<string>([...BUILTIN_DEFERRED_GROUPS.flatMap((g) => [...g.names]), ...mcpNames]);
  return [...new Set(eligible)].filter((name) => deferrable.has(name));
}

/** `(eligible \ deferred) ∪ (deferred ∩ activated)`, in `eligible` order. */
export function initialActiveToolNames(
  eligible: Iterable<string>,
  deferred: Iterable<string>,
  activated: ReadonlySet<string>,
): string[] {
  const deferredSet = new Set(deferred);
  return [...new Set(eligible)].filter((name) => !deferredSet.has(name) || activated.has(name));
}

/**
 * Resolve `ToolSearch` entries (exact tool names and group names) against a caller's deferrable
 * universe. Every match is intersected with `deferrable`, so a caller can only ever activate inside its
 * own universe. Built-in group names resolve first: an MCP server named `browser`/`compass`/`web` is
 * shadowed and reported, and its tools stay reachable by exact name (the inventory always lists them).
 */
export function resolveToolSearchEntries(
  entries: readonly string[],
  deferrable: Iterable<string>,
  mcpGroups: ReadonlyMap<string, readonly string[]>,
): ToolSearchResolution {
  const universe = new Set(deferrable);
  const matches: string[] = [];
  const matched = new Set<string>();
  const unknown: string[] = [];
  const unknownSeen = new Set<string>();
  const shadowedGroups: string[] = [];
  const inertGroups: string[] = [];

  const addMatch = (name: string): void => {
    if (!universe.has(name) || matched.has(name)) return;
    matched.add(name);
    matches.push(name);
  };

  /** A group resolved to nothing this caller can activate — record it once so the caller can say why. */
  const noteIfInert = (entry: string, names: readonly string[]): void => {
    if (names.some((name) => universe.has(name)) || inertGroups.includes(entry)) return;
    inertGroups.push(entry);
  };

  for (const entry of entries) {
    const builtin = BUILTIN_DEFERRED_GROUPS.find((g) => g.group === entry);
    if (builtin) {
      if (mcpGroups.has(entry) && !shadowedGroups.includes(entry)) shadowedGroups.push(entry);
      for (const name of builtin.names) addMatch(name);
      noteIfInert(entry, builtin.names);
      continue;
    }
    const mcpGroup = mcpGroups.get(entry);
    if (mcpGroup) {
      for (const name of mcpGroup) addMatch(name);
      noteIfInert(entry, mcpGroup);
      continue;
    }
    if (universe.has(entry)) {
      addMatch(entry);
      continue;
    }
    if (!unknownSeen.has(entry)) {
      unknownSeen.add(entry);
      unknown.push(entry);
    }
  }

  return { matches, unknown, shadowedGroups, inertGroups };
}
