import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonConfig } from '../../core/config/json-config-write';
import { MAX_SHELL_COORDINATE, MIN_SECTION_SIZE, MIN_SIDEBAR_WIDTH, type ShellLayout, type ShellSectionLayout } from '../preload/shell-channels';

const SCHEMA_VERSION = 1;
export const WINDOW_LAYOUT_FILE = 'window-layout.json';

// AD7: the window fits the sidebar and every slot at their minimum sizes.
export const MIN_WINDOW_WIDTH = 900;
export const MIN_WINDOW_HEIGHT = 600;
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 820;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// DIP, the window's normal (not maximized) bounds.
export interface WindowPlacement {
  readonly bounds: Rect;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

export interface WindowLayout {
  readonly window?: WindowPlacement;
  readonly sidebar: ShellLayout;
}

export const DEFAULT_SHELL_LAYOUT: ShellLayout = {
  sidebarVisible: true,
  sidebarWidth: 264,
  sections: { projects: { collapsed: false, size: 180 }, chats: { collapsed: false } },
};

type Log = (line: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function parseSection(raw: unknown): ShellSectionLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const collapsed = field(raw, 'collapsed');
  const size = field(raw, 'size');
  if (typeof collapsed !== 'boolean' || !inRange(size, MIN_SECTION_SIZE, MAX_SHELL_COORDINATE)) return undefined;
  return { collapsed, size };
}

/** A sidebar layout from the shell or the file, or undefined when any field is missing, of the wrong type or out of range. */
export function parseShellLayout(raw: unknown): ShellLayout | undefined {
  if (!isRecord(raw)) return undefined;
  const sidebarVisible = field(raw, 'sidebarVisible');
  const sidebarWidth = field(raw, 'sidebarWidth');
  const sections = field(raw, 'sections');
  if (typeof sidebarVisible !== 'boolean' || !inRange(sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SHELL_COORDINATE) || !isRecord(sections)) return undefined;
  const projects = parseSection(field(sections, 'projects'));
  const chats = field(sections, 'chats');
  // A Chats size written by an earlier version is ignored, not malformed.
  const chatsCollapsed = isRecord(chats) ? field(chats, 'collapsed') : undefined;
  if (!projects || typeof chatsCollapsed !== 'boolean') return undefined;
  return { sidebarVisible, sidebarWidth, sections: { projects, chats: { collapsed: chatsCollapsed } } };
}

function parsePlacement(raw: unknown): WindowPlacement | undefined {
  if (!isRecord(raw)) return undefined;
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => field(raw, key));
  const maximized = field(raw, 'maximized');
  const fullScreen = field(raw, 'fullScreen');
  if (!inRange(x, -MAX_SHELL_COORDINATE, MAX_SHELL_COORDINATE) || !inRange(y, -MAX_SHELL_COORDINATE, MAX_SHELL_COORDINATE)) return undefined;
  if (!inRange(width, MIN_WINDOW_WIDTH, MAX_SHELL_COORDINATE) || !inRange(height, MIN_WINDOW_HEIGHT, MAX_SHELL_COORDINATE)) return undefined;
  if (typeof maximized !== 'boolean' || typeof fullScreen !== 'boolean') return undefined;
  return { bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, maximized, fullScreen };
}

export function parseWindowLayout(text: string, log: Log): WindowLayout {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || field(parsed, 'version') !== SCHEMA_VERSION) {
    log(`[layout] ignoring ${WINDOW_LAYOUT_FILE}: unknown schema`);
    return { sidebar: DEFAULT_SHELL_LAYOUT };
  }
  const rawWindow = field(parsed, 'window');
  const placement = rawWindow === undefined ? undefined : parsePlacement(rawWindow);
  if (rawWindow !== undefined && !placement) log('[layout] dropping malformed window bounds');
  const rawSidebar = field(parsed, 'sidebar');
  const sidebar = rawSidebar === undefined ? undefined : parseShellLayout(rawSidebar);
  if (rawSidebar !== undefined && !sidebar) log('[layout] dropping a malformed sidebar layout');
  return { ...(placement ? { window: placement } : {}), sidebar: sidebar ?? DEFAULT_SHELL_LAYOUT };
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function centerDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

/**
 * Bounds that lie on a display: kept on the work area they overlap most, else moved onto the nearest one. The window
 * shrinks to fit that work area, but never below the window minimum.
 */
export function clampToWorkAreas(bounds: Rect, workAreas: readonly Rect[]): Rect {
  if (workAreas.length === 0) return bounds;
  const target = workAreas.reduce((best, area) => {
    const overlap = overlapArea(bounds, area) - overlapArea(bounds, best);
    if (overlap !== 0) return overlap > 0 ? area : best;
    return centerDistance(bounds, area) < centerDistance(bounds, best) ? area : best;
  });
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(bounds.width, target.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(bounds.height, target.height));
  const x = Math.max(target.x, Math.min(bounds.x, target.x + target.width - width));
  const y = Math.max(target.y, Math.min(bounds.y, target.y + target.height - height));
  return { x, y, width, height };
}

// The window's placement and the shell's sidebar layout under userData; a relaunch restores them.
export class WindowLayoutStore {
  private readonly filePath: string;
  private placement: WindowPlacement | undefined;
  private sidebarLayout: ShellLayout = DEFAULT_SHELL_LAYOUT;
  private readonly log: Log;
  private writing: Promise<void> = Promise.resolve();

  constructor(userDataDir: string, log: Log) {
    this.filePath = path.join(userDataDir, WINDOW_LAYOUT_FILE);
    this.log = log;
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return;
    try {
      const parsed = parseWindowLayout(text, log);
      this.placement = parsed.window;
      this.sidebarLayout = parsed.sidebar;
    } catch (err) {
      log(`[layout] ignoring unreadable ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  window(): WindowPlacement | undefined {
    return this.placement;
  }

  sidebar(): ShellLayout {
    return this.sidebarLayout;
  }

  setWindow(placement: WindowPlacement): void {
    const current = this.placement;
    if (current && JSON.stringify(current) === JSON.stringify(placement)) return;
    this.placement = placement;
    this.persist();
  }

  setSidebar(layout: ShellLayout): void {
    if (JSON.stringify(this.sidebarLayout) === JSON.stringify(layout)) return;
    this.sidebarLayout = layout;
    this.persist();
  }

  // Restore default layout, and a launch with damocles.desktop.restoreLayout off: no saved window placement or sidebar.
  reset(): void {
    this.placement = undefined;
    this.sidebarLayout = DEFAULT_SHELL_LAYOUT;
    this.persist();
  }

  // Settles once every write started so far has finished; a quit awaits it.
  flush(): Promise<void> {
    return this.writing;
  }

  private persist(): void {
    const placement = this.placement;
    const snapshot = {
      version: SCHEMA_VERSION,
      ...(placement ? { window: { ...placement.bounds, maximized: placement.maximized, fullScreen: placement.fullScreen } } : {}),
      sidebar: this.sidebarLayout,
    };
    const write = writeJsonConfig(this.filePath, () => `${JSON.stringify(snapshot, null, 2)}\n`).catch((err: unknown) => {
      this.log(`[layout] failed to write ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.writing = Promise.all([this.writing, write]).then(() => undefined);
  }
}
