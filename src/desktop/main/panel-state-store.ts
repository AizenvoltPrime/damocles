import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonConfig } from '../../core/config/json-config-write';
import { MAX_PANE_URL_LENGTH, MAX_PANE_WIDTH } from '../preload/pane-channels';

const SCHEMA_VERSION = 1;
export const PANEL_STATE_FILE = 'panels.json';

// A chat tab's browser pane: whether it is open or maximized, its pages' addresses in pane order and the active one.
export interface PersistedPane {
  readonly open: boolean;
  readonly maximized: boolean;
  readonly pages: readonly string[];
  // index into pages
  readonly activePage?: number;
}

export const EMPTY_PANE: PersistedPane = { open: false, maximized: false, pages: [] };

// Every persisted panel is a chat tab; its browser pages live in its pane.
export interface PersistedPanel {
  readonly panelId: string;
  readonly kind: 'chat';
  readonly state: unknown;
  readonly pane: PersistedPane;
}

const PANEL_ID = /^[A-Za-z0-9-]+$/;

interface ParsedPanels {
  readonly panels: PersistedPanel[];
  readonly selectedPanelId: string | undefined;
  readonly paneWidth: number | undefined;
}

export function isPaneWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PANE_WIDTH;
}

function parsePane(raw: unknown, panelId: string, log: (line: string) => void): PersistedPane {
  if (raw === undefined) return EMPTY_PANE;
  const candidate = raw as { open?: unknown; maximized?: unknown; pages?: unknown; activePage?: unknown } | null;
  if (typeof candidate !== 'object' || candidate === null || !Array.isArray(candidate.pages)) {
    log(`[panels] tab ${panelId}: dropping a malformed browser pane`);
    return EMPTY_PANE;
  }
  const pages: string[] = [];
  let activePage: number | undefined;
  for (const [index, url] of (candidate.pages as unknown[]).entries()) {
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_PANE_URL_LENGTH) {
      log(`[panels] tab ${panelId}: dropping a browser page with a malformed address`);
      continue;
    }
    if (index === candidate.activePage) activePage = pages.length;
    pages.push(url);
  }
  return {
    open: candidate.open === true,
    maximized: candidate.maximized === true,
    pages,
    ...(activePage !== undefined ? { activePage } : {}),
  };
}

function parsePanels(text: string, log: (line: string) => void): ParsedPanels {
  const parsed: unknown = JSON.parse(text);
  const panels = (parsed as { version?: unknown; panels?: unknown; selectedPanelId?: unknown; paneWidth?: unknown } | null);
  if (panels?.version !== SCHEMA_VERSION || !Array.isArray(panels.panels)) {
    log(`[panels] ignoring ${PANEL_STATE_FILE}: unknown schema`);
    return { panels: [], selectedPanelId: undefined, paneWidth: undefined };
  }
  const valid: PersistedPanel[] = [];
  for (const entry of panels.panels as unknown[]) {
    const candidate = entry as { panelId?: unknown; kind?: unknown; state?: unknown; pane?: unknown } | null;
    if (typeof candidate?.panelId !== 'string' || !PANEL_ID.test(candidate.panelId)) continue;
    if (candidate.kind !== 'chat') {
      log(`[panels] dropping tab ${candidate.panelId}: not a chat tab`);
      continue;
    }
    valid.push({ panelId: candidate.panelId, kind: 'chat', state: candidate.state ?? null, pane: parsePane(candidate.pane, candidate.panelId, log) });
  }
  const selected = panels.selectedPanelId;
  if (panels.paneWidth !== undefined && !isPaneWidth(panels.paneWidth)) log('[panels] ignoring a malformed browser pane width');
  return {
    panels: valid,
    selectedPanelId: typeof selected === 'string' && valid.some((panel) => panel.panelId === selected) ? selected : undefined,
    paneWidth: isPaneWidth(panels.paneWidth) ? panels.paneWidth : undefined,
  };
}

// Open chat tabs in strip order with each one's webview state and browser pane, the selected tab and the pane width
// shared by every tab, under userData; a relaunch restores them.
export class PanelStateStore {
  private readonly filePath: string;
  // Map insertion order is the tab order.
  private panels = new Map<string, PersistedPanel>();
  private selectedPanelId: string | undefined;
  private width: number | undefined;
  private readonly log: (line: string) => void;

  constructor(userDataDir: string, log: (line: string) => void) {
    this.filePath = path.join(userDataDir, PANEL_STATE_FILE);
    this.log = log;
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return;
    try {
      const parsed = parsePanels(text, log);
      for (const panel of parsed.panels) this.panels.set(panel.panelId, panel);
      this.selectedPanelId = parsed.selectedPanelId;
      this.width = parsed.paneWidth;
    } catch (err) {
      log(`[panels] ignoring unreadable ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  list(): readonly PersistedPanel[] {
    return [...this.panels.values()];
  }

  get(panelId: string): PersistedPanel | undefined {
    return this.panels.get(panelId);
  }

  selected(): string | undefined {
    return this.selectedPanelId;
  }

  paneWidth(): number | undefined {
    return this.width;
  }

  // A new tab goes last with an empty pane; an existing one keeps its place and its pane.
  set(panel: { readonly panelId: string; readonly state: unknown }): void {
    this.panels.set(panel.panelId, { panelId: panel.panelId, kind: 'chat', state: panel.state, pane: this.panels.get(panel.panelId)?.pane ?? EMPTY_PANE });
    this.persist();
  }

  // Ignored for a tab the store does not hold.
  setPane(panelId: string, pane: PersistedPane): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    this.panels.set(panelId, { ...panel, pane });
    this.persist();
  }

  setPaneWidth(width: number): void {
    if (!isPaneWidth(width) || width === this.width) return;
    this.width = width;
    this.persist();
  }

  delete(panelId: string): void {
    if (!this.panels.delete(panelId)) return;
    if (this.selectedPanelId === panelId) this.selectedPanelId = undefined;
    this.persist();
  }

  // Ids not in the store are ignored; stored panels missing from order keep their relative order after it.
  reorder(order: readonly string[]): void {
    const next = new Map<string, PersistedPanel>();
    for (const panelId of order) {
      const panel = this.panels.get(panelId);
      if (panel) next.set(panelId, panel);
    }
    for (const [panelId, panel] of this.panels) if (!next.has(panelId)) next.set(panelId, panel);
    this.panels = next;
    this.persist();
  }

  select(panelId: string): void {
    if (this.selectedPanelId === panelId || !this.panels.has(panelId)) return;
    this.selectedPanelId = panelId;
    this.persist();
  }

  private persist(): void {
    const snapshot = {
      version: SCHEMA_VERSION,
      panels: this.list(),
      ...(this.selectedPanelId !== undefined ? { selectedPanelId: this.selectedPanelId } : {}),
      ...(this.width !== undefined ? { paneWidth: this.width } : {}),
    };
    writeJsonConfig(this.filePath, () => `${JSON.stringify(snapshot, null, 2)}\n`).catch((err: unknown) => {
      this.log(`[panels] failed to write ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
