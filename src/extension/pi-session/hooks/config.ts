import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../logger';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { hookEntrySchema, type HookEntry } from './types';

const RELOAD_DEBOUNCE_MS = 300;
const HOOKS_FILE = 'hooks.json';

/**
 * Strip `//` line and slash-star block comments so `hooks.json` can be authored as JSONC (FR-15). A small
 * state machine that ignores comment markers inside string literals; newlines from line comments are
 * preserved so a post-strip parse error still points at the right line.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parse + validate one `hooks.json`. Missing → `{}`; malformed → logged once and `{}`; invalid entries
 *  are dropped individually so the rest of the file still loads (US-001). */
export function parseHooksFile(filePath: string): Record<string, HookEntry[]> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    log('[Hooks] failed to parse %s (ignored): %O', filePath, err);
    return {};
  }
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object') return {};

  const result: Record<string, HookEntry[]> = {};
  for (const [eventKey, rawEntries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) {
      log('[Hooks] %s: "%s" is not an array — skipped', filePath, eventKey);
      continue;
    }
    const valid: HookEntry[] = [];
    for (const entry of rawEntries) {
      const res = hookEntrySchema.safeParse(entry);
      if (res.success) valid.push(res.data);
      else log('[Hooks] %s: dropped invalid "%s" entry: %s', filePath, eventKey, res.error.message);
    }
    if (valid.length > 0) result[eventKey] = valid;
  }
  return result;
}

/**
 * Loads, validates, watches, and trust-gates the global (`~/.damocles/hooks.json`) and project
 * (`<ws>/.damocles/hooks.json`) hook configs. Global is always honored; the project file is exposed only
 * when the VS Code workspace is trusted (re-evaluated live). Both files hot-reload on a 300 ms debounce.
 * Disposable: tears down both watchers and the trust listener.
 */
export class HooksConfigService {
  private globalEntries: Record<string, HookEntry[]> = {};
  private projectEntries: Record<string, HookEntry[]> = {};
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private trustListener: vscode.Disposable | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workspaceRoot: string | undefined;

  constructor(workspaceRoot: string | undefined) {
    this.workspaceRoot = workspaceRoot;
    this.loadAll();
    this.setupWatchers();
    this.trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => this.loadAll());
  }

  private globalPath(): string {
    return path.join(DAMOCLES_HOME_DIR, HOOKS_FILE);
  }

  private projectDir(): string | undefined {
    return this.workspaceRoot ? path.join(this.workspaceRoot, '.damocles') : undefined;
  }

  private loadAll(): void {
    this.globalEntries = parseHooksFile(this.globalPath());
    const dir = this.projectDir();
    this.projectEntries = dir ? parseHooksFile(path.join(dir, HOOKS_FILE)) : {};
  }

  private setupWatchers(): void {
    const reload = () => this.scheduleReload();
    const globalWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(DAMOCLES_HOME_DIR, HOOKS_FILE),
    );
    globalWatcher.onDidCreate(reload);
    globalWatcher.onDidChange(reload);
    globalWatcher.onDidDelete(reload);
    this.watchers.push(globalWatcher);

    const dir = this.projectDir();
    if (dir) {
      const projectWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, HOOKS_FILE));
      projectWatcher.onDidCreate(reload);
      projectWatcher.onDidChange(reload);
      projectWatcher.onDidDelete(reload);
      this.watchers.push(projectWatcher);
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.loadAll();
    }, RELOAD_DEBOUNCE_MS);
  }

  /** The ordered entries for an event key: global first, then project (project only when trusted). */
  getEntries(eventKey: string): HookEntry[] {
    const global = this.globalEntries[eventKey] ?? [];
    const project = vscode.workspace.isTrusted ? this.projectEntries[eventKey] ?? [] : [];
    return [...global, ...project];
  }

  /** Whether any hook (after trust gating) is configured for an event key — the FR-14 zero-cost guard. */
  hasEntries(eventKey: string): boolean {
    if (this.globalEntries[eventKey]?.length) return true;
    return vscode.workspace.isTrusted && !!this.projectEntries[eventKey]?.length;
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers.length = 0;
    this.trustListener?.dispose();
    this.trustListener = undefined;
  }
}
