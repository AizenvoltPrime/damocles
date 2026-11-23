// The window arrangement's parsers, shared by main's window-layout.json and a theme's `layout`, and when a pick applies one,
// shared by main and core. Pure: no Node, no Electron.
import { MAX_ARRANGEMENT_COORDINATE, MIN_ARRANGEMENT_SECTION } from './limits';
import { ARRANGEMENT_PANES, ARRANGEMENT_SECTIONS, parseSectionOrder, type Arrangement, type ArrangementSection, type Origin, type ThemeFile } from './schema';

export { MAX_ARRANGEMENT_COORDINATE, MIN_ARRANGEMENT_SECTION } from './limits';
export { parseSectionOrder, type ArrangementSection } from './schema';
export type ArrangementPane = (typeof ARRANGEMENT_PANES)[number];
// Must match GRID_SLOTS in src/desktop/preload/shell-channels.ts.
export const ARRANGEMENT_SLOTS = ['main', 'side', 'bottom'] as const;

export interface ArrangementGridSizes {
  readonly sideWidth: number;
  readonly bottomHeight: number;
}

export interface ArrangementGridLayout extends ArrangementGridSizes {
  readonly slots: { readonly main: ArrangementPane; readonly side: ArrangementPane; readonly bottom: ArrangementPane };
  readonly visible: { readonly editor: boolean; readonly terminal: boolean };
  readonly maximized: ArrangementPane | null;
}

// Themes from outside this computer: their arrangement applies only when the user opted in at install.
const OUTSIDE_ORIGINS: ReadonlySet<string> = new Set(['import', 'vscode', 'link', 'store']);

/** Whether a manual pick of `theme`, the user's or an agent's, applies its window arrangement. */
export function arrangementApplies(theme: Pick<ThemeFile, 'layout' | 'origin'>): boolean {
  if (theme.layout === undefined) return false;
  const origin = theme.origin;
  if (origin === undefined) return true;
  return OUTSIDE_ORIGINS.has(origin.kind) ? origin.layoutOptIn === true : origin.layoutOptIn !== false;
}

/** What a copy's origin keeps of `source`'s: a copy of an outside theme the user did not opt into stays opted out. */
export function copiedLayoutOptIn(source: Origin | undefined): { readonly layoutOptIn?: false } {
  if (source === undefined) return {};
  const optedOut = OUTSIDE_ORIGINS.has(source.kind) ? source.layoutOptIn !== true : source.layoutOptIn === false;
  return optedOut ? { layoutOptIn: false } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isPane(value: unknown): value is ArrangementPane {
  return (ARRANGEMENT_PANES as readonly unknown[]).includes(value);
}

/** The grid's sash sizes, or undefined unless both are in range. */
export function parseGridSizes(raw: unknown): ArrangementGridSizes | undefined {
  if (!isRecord(raw)) return undefined;
  const sideWidth = field(raw, 'sideWidth');
  const bottomHeight = field(raw, 'bottomHeight');
  if (!inRange(sideWidth, 0, MAX_ARRANGEMENT_COORDINATE) || !inRange(bottomHeight, 0, MAX_ARRANGEMENT_COORDINATE)) return undefined;
  return { sideWidth, bottomHeight };
}

/** A grid layout, or undefined unless its slots are a permutation of the panes and every field is in range. */
export function parseGridLayout(raw: unknown): ArrangementGridLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const slots = field(raw, 'slots');
  const visible = field(raw, 'visible');
  const maximized = field(raw, 'maximized');
  if (!isRecord(slots) || !isRecord(visible)) return undefined;
  const [main, side, bottom] = ARRANGEMENT_SLOTS.map((slot) => field(slots, slot));
  if (!isPane(main) || !isPane(side) || !isPane(bottom) || new Set([main, side, bottom]).size !== ARRANGEMENT_PANES.length) return undefined;
  const editor = field(visible, 'editor');
  const terminal = field(visible, 'terminal');
  if (typeof editor !== 'boolean' || typeof terminal !== 'boolean') return undefined;
  const sizes = parseGridSizes(raw);
  if (!sizes) return undefined;
  if (maximized !== null && !isPane(maximized)) return undefined;
  return { slots: { main, side, bottom }, visible: { editor, terminal }, ...sizes, maximized };
}

/** A theme's window arrangement (the schema's Arrangement), or undefined when any field it has is malformed. */
export function parseArrangement(raw: unknown): Arrangement | undefined {
  if (!isRecord(raw)) return undefined;
  const out: { grid?: NonNullable<Arrangement['grid']>; sidebarWidth?: number; sectionOrder?: readonly ArrangementSection[]; sections?: NonNullable<Arrangement['sections']> } = {};
  const grid = field(raw, 'grid');
  if (grid !== undefined) {
    const parsed = isRecord(grid) ? parseGridLayout({ ...grid, maximized: null }) : undefined;
    if (!parsed) return undefined;
    out.grid = { slots: parsed.slots, visible: parsed.visible, sideWidth: parsed.sideWidth, bottomHeight: parsed.bottomHeight };
  }
  const sidebarWidth = field(raw, 'sidebarWidth');
  if (sidebarWidth !== undefined) {
    if (!inRange(sidebarWidth, 0, MAX_ARRANGEMENT_COORDINATE)) return undefined;
    out.sidebarWidth = sidebarWidth;
  }
  const order = field(raw, 'sectionOrder');
  if (order !== undefined) {
    const parsed = parseSectionOrder(order);
    if (!parsed) return undefined;
    out.sectionOrder = parsed;
  }
  const sections = field(raw, 'sections');
  if (sections !== undefined) {
    if (!isRecord(sections)) return undefined;
    const parsed: Partial<Record<ArrangementSection, { collapsed: boolean; size?: number }>> = {};
    for (const [id, section] of Object.entries(sections)) {
      if (!(ARRANGEMENT_SECTIONS as readonly string[]).includes(id) || !isRecord(section) || typeof section['collapsed'] !== 'boolean') return undefined;
      const size = field(section, 'size');
      if (size !== undefined && !inRange(size, MIN_ARRANGEMENT_SECTION, MAX_ARRANGEMENT_COORDINATE)) return undefined;
      parsed[id as ArrangementSection] = { collapsed: section['collapsed'], ...(size !== undefined ? { size } : {}) };
    }
    out.sections = parsed;
  }
  return out;
}
