// What the desktop preview tab reads of a design (PD-8, PD-44): its widths and a screen's declared states, through the same
// confined read as the served files. Every pattern over design text is linear.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseHTML } from 'linkedom';
import { parse as parseYaml } from 'yaml';
import type { DesignBreakpoint, DesignPreviewFile, DesignPreviewInfo, JourneyViewport } from '../../shared/types/design';
import { log } from '../logger';
import { MAX_PROBE_WIDTHS, MAX_RENDER_WIDTH, MIN_RENDER_WIDTH } from '../../shared/design-render';
import { DESIGN_NAME, designStateTokens } from '../../shared/design-paths';
import type { CheckedWidth } from './design-check';
import { readServedDesignFile, readDesignFile } from './design-file-read';
import { DESIGN_DOC_FILE, MAX_DESIGN_DOC_BYTES, MAX_SCREEN_BYTES } from './design-paths';
import { readInventory } from './inventory';

// the preset below the smallest breakpoint (PD-8)
const BASE_WIDTH = 390;
const FALLBACK_PRIMARY = 1280;
const MAX_STATES = 32;
const MAX_BREAKPOINTS = 32;
const MAX_TITLE_CHARS = 200;

const isWidth = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_RENDER_WIDTH && value <= MAX_RENDER_WIDTH;

/** inventory.json's breakpoint values; none when it has none or cannot be read. */
async function breakpointValuesOf(folder: string): Promise<Readonly<Record<string, number>>> {
  try {
    return (await readInventory(folder)).breakpoints?.values ?? {};
  } catch (err) {
    log('[DesignPreview] inventory.json of %s cannot be read, so the preview has no breakpoints: %O', folder, err);
    return {};
  }
}

/** The breakpoints a design keeps of inventory.json's values, in ascending width: a name of the design alphabet and a width up to 2560. */
function breakpointsOf(values: Readonly<Record<string, number>>): DesignBreakpoint[] {
  return Object.entries(values)
    .filter(([name, width]) => DESIGN_NAME.test(name) && Number.isInteger(width) && width > 0 && width <= MAX_RENDER_WIDTH)
    .map(([name, width]) => ({ name, width }))
    .sort((a, b) => a.width - b.width)
    .slice(0, MAX_BREAKPOINTS);
}

/** The names design.md's viewports may use: base and each breakpoint a design renders at. */
export function viewportPresetNames(breakpoints: readonly DesignBreakpoint[]): string[] {
  return ['base', ...breakpoints.filter((breakpoint) => isWidth(breakpoint.width)).map((breakpoint) => breakpoint.name)];
}

/** design.md's `viewports`, each a preset name or a width; undefined when the frontmatter is missing or does not parse. */
async function viewportsOf(folder: string): Promise<Record<string, unknown> | undefined> {
  const doc = await readDesignFile(folder, DESIGN_DOC_FILE, MAX_DESIGN_DOC_BYTES);
  if (doc.kind !== 'file') return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(doc.bytes.toString('utf8'));
  if (!match) return undefined;
  let data: unknown;
  try {
    data = parseYaml(match[1]!, { maxAliasCount: 0 });
  } catch (err) {
    log('[DesignPreview] the design.md frontmatter of %s does not parse: %O', folder, err);
    return undefined;
  }
  const viewports = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['viewports'] : undefined;
  return typeof viewports === 'object' && viewports !== null ? (viewports as Record<string, unknown>) : undefined;
}

/** A viewport design.md names, as CSS px: a width from 320 to 2560 or a preset name; undefined for anything else. */
export function resolveViewportWidth(value: unknown, breakpoints: readonly DesignBreakpoint[]): number | undefined {
  if (isWidth(value)) return value;
  if (value === 'base') return BASE_WIDTH;
  const width = typeof value === 'string' ? breakpoints.find((breakpoint) => breakpoint.name === value)?.width : undefined;
  return isWidth(width) ? width : undefined;
}

/** An entry of design.md's viewports the resolution leaves out: one that resolves to no width, or a width past `MAX_PROBE_WIDTHS`. */
export interface DroppedViewport {
  readonly key: 'primary' | 'checked' | 'journey';
  readonly item: unknown;
  readonly reason: 'unresolved' | 'overLimit';
}

/**
 * design.md's `viewports` resolved against inventory.json's breakpoint values (PD-8), with what it left out. DesignCheck's
 * frontmatter rule reports each drop, and the preview, the width checks and the journeys use the widths.
 */
export function resolveDesignViewports(breakpointValues: Readonly<Record<string, number>>, viewports: Readonly<Record<string, unknown>> | undefined): { readonly viewports: DesignViewports; readonly dropped: readonly DroppedViewport[] } {
  const breakpoints = breakpointsOf(breakpointValues);
  const dropped: DroppedViewport[] = [];
  const list = (key: 'checked' | 'journey'): number[] => {
    const value = viewports?.[key];
    if (!Array.isArray(value)) return [];
    const widths = new Set<number>();
    for (const item of value) {
      const width = resolveViewportWidth(item, breakpoints);
      if (width === undefined) dropped.push({ key, item, reason: 'unresolved' });
      else widths.add(width);
    }
    const kept = new Set([...widths].sort((a, b) => a - b).slice(0, MAX_PROBE_WIDTHS));
    for (const width of widths) if (!kept.has(width)) dropped.push({ key, item: width, reason: 'overLimit' });
    return [...widths].filter((width) => kept.has(width));
  };
  const primary = resolveViewportWidth(viewports?.['primary'], breakpoints);
  if (primary === undefined && viewports?.['primary'] !== undefined) dropped.push({ key: 'primary', item: viewports['primary'], reason: 'unresolved' });
  const nameOf = (width: number): string | null => (width === BASE_WIDTH ? 'base' : breakpoints.find((breakpoint) => breakpoint.width === width)?.name ?? null);
  return {
    viewports: {
      breakpoints,
      primary: primary ?? FALLBACK_PRIMARY,
      checked: list('checked').map((width) => ({ width, breakpoint: nameOf(width) })),
      journey: list('journey'),
    },
    dropped,
  };
}

/** The screen's declared states, id and title; undefined when the file is not a readable screen of the folder. */
async function screenOf(folder: string, relPath: string): Promise<Pick<DesignPreviewInfo, 'screenId' | 'title' | 'states'> | undefined> {
  const file = await readDesignFile(folder, relPath, MAX_SCREEN_BYTES);
  if (file.kind !== 'file') return undefined;
  const { document } = parseHTML(file.bytes.toString('utf8')) as unknown as { document: { documentElement: { getAttribute(name: string): string | null } | null; title?: string } };
  const root = document.documentElement;
  const states = [...new Set(designStateTokens(root?.getAttribute('data-ds-states')).filter((state) => DESIGN_NAME.test(state)))].slice(0, MAX_STATES);
  const screenId = root?.getAttribute('data-ds-screen')?.trim() ?? '';
  const title = (document.title ?? '').trim().slice(0, MAX_TITLE_CHARS);
  return { screenId: DESIGN_NAME.test(screenId) ? screenId : null, title: title === '' ? null : title, states };
}

/** The preview's facts of screen `relPath` in design folder `folder`; undefined when the screen cannot be read. */
export async function designPreviewInfo(folder: string, relPath: string): Promise<DesignPreviewInfo | undefined> {
  const [screen, widths] = await Promise.all([screenOf(folder, relPath), designViewports(folder)]);
  if (!screen) return undefined;
  return {
    // the real path, as a mention names a file (resolveMention)
    path: path.join(await fs.realpath(folder), ...relPath.split('/')),
    ...screen,
    breakpoints: widths.breakpoints,
    primary: widths.primary,
    checked: widths.checked.map(({ width }) => width),
    journey: widths.journey,
  };
}

export interface DesignViewports {
  /** Ascending by width. */
  readonly breakpoints: readonly DesignBreakpoint[];
  readonly primary: number;
  /** In design.md's order, each once, at most the `MAX_PROBE_WIDTHS` smallest. */
  readonly checked: readonly CheckedWidth[];
  /** As `checked`. */
  readonly journey: readonly number[];
}

/** design.md's viewports resolved against inventory.json's breakpoints (PD-8). */
export async function designViewports(folder: string): Promise<DesignViewports> {
  const [values, viewports] = await Promise.all([breakpointValuesOf(folder), viewportsOf(folder)]);
  return resolveDesignViewports(values, viewports).viewports;
}

/** The widths DesignCheck and DesignScreenshot run at (PD-14): design.md's checked ones, else base and each breakpoint. */
export function checkedWidthsOf(viewports: DesignViewports): CheckedWidth[] {
  const widths = viewports.checked.length > 0
    ? [...viewports.checked]
    : [{ width: BASE_WIDTH, breakpoint: 'base' }, ...viewports.breakpoints.filter((breakpoint) => breakpoint.width >= MIN_RENDER_WIDTH && breakpoint.width !== BASE_WIDTH).map(({ name, width }) => ({ width, breakpoint: name }))];
  return widths.sort((a, b) => a.width - b.width).slice(0, MAX_PROBE_WIDTHS);
}

/** The widths a journey runs at (PD-21): design.md's `viewports.journey`, else base and the primary width; ascending. */
export function journeyViewportsOf(viewports: DesignViewports): JourneyViewport[] {
  const widths = viewports.journey.length > 0 ? [...viewports.journey] : [...new Set([BASE_WIDTH, viewports.primary])];
  const nameOf = (width: number): string | null => (width === BASE_WIDTH ? 'base' : viewports.breakpoints.find((breakpoint) => breakpoint.width === width)?.name ?? null);
  return widths.sort((a, b) => a - b).slice(0, MAX_PROBE_WIDTHS).map((width) => ({ breakpoint: nameOf(width), width }));
}

/** A file of design folder `folder` for the preview, with the fidelity it is served with; undefined when missing or outside. */
export async function readPreviewFile(folder: string, designId: string, relPath: string): Promise<DesignPreviewFile | 'tooLarge' | undefined> {
  const file = await readServedDesignFile(folder, designId, relPath);
  if (file.kind === 'file') return { bytes: file.bytes, fidelity: file.fidelity };
  return file.kind === 'tooLarge' ? 'tooLarge' : undefined;
}
