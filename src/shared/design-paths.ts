// Design folder paths both core and desktop main read (docs/invariants.md "Design mode").
import { isSafeAgentPathId } from './agent-path-id';

/** A screen file relative to its design folder: `screens/<name>.html`, `screens/` exactly as spelled, the extension in any case. */
export const SCREEN_FILE: RegExp = /^screens\/([^/]+)\.[Hh][Tt][Mm][Ll]$/;

/** The longest design id: every design message on the core protocol carries one, and its parser refuses a longer one. */
export const MAX_DESIGN_ID_CHARS = 128;

/** A design id: one safe path segment of at most MAX_DESIGN_ID_CHARS. */
export function isDesignId(id: string): boolean {
  return id.length <= MAX_DESIGN_ID_CHARS && isSafeAgentPathId(id);
}

/** The design alphabet: a screen, state or breakpoint name. */
export const DESIGN_NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_DESIGN_NAME_CHARS = 64;

/**
 * The states `data-ds-states` or `data-ds-state-only` lists: an HTML token list, split on ASCII whitespace only, as the
 * preview's `[data-ds-state-only~="S"]` splits it.
 */
export function designStateTokens(value: string | null | undefined): string[] {
  return (value ?? '').split(/[\t\n\f\r ]+/).filter((token) => token !== '');
}
