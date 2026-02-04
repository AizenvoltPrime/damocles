import * as vscode from 'vscode';
import { log } from '../logger';
import { openDatabase } from './database';
import { SessionMemoryManager } from './managers/session-memory-manager';
import { ProjectMemoryManager } from './managers/project-memory-manager';
import { GlobalMemoryManager } from './managers/global-memory-manager';
import { NoteManager } from './managers/note-manager';
import { ObservationManager } from './managers/observation-manager';
import { AutoSummaryManager } from './managers/auto-summary-manager';
import { SearchManager } from './managers/search-manager';
import { InjectionManager } from './managers/injection-manager';
import { createMemoryMcpServer } from './mcp-server';
import type { DatabaseInstance, MemoryRow } from './types';
import { rowToEntry } from './types';
import type {
  MemoryEntry,
  MemoryTier,
  ObservationInput,
  SearchQuery,
  SearchResult,
  TimelineEntry,
} from '@shared/types/memory';

export class MemoryService {
  private db: DatabaseInstance | null;
  private sessionManager: SessionMemoryManager | null = null;
  private projectManager: ProjectMemoryManager | null = null;
  private globalManager: GlobalMemoryManager | null = null;
  private noteManager: NoteManager | null = null;
  private observationManager: ObservationManager | null = null;
  private autoSummaryManager: AutoSummaryManager | null = null;
  private searchManager: SearchManager | null = null;
  private injectionManager: InjectionManager | null = null;
  private mcpModules: { sdk: typeof import('@anthropic-ai/claude-agent-sdk'); z: typeof import('zod') } | null = null;

  constructor() {
    const config = vscode.workspace.getConfiguration('damocles.memory');
    const enabled = config.get<boolean>('enabled', true);

    if (!enabled) {
      this.db = null;
      return;
    }

    this.db = openDatabase();
    if (!this.db) return;

    this.sessionManager = new SessionMemoryManager(this.db);
    this.projectManager = new ProjectMemoryManager(this.db);
    this.globalManager = new GlobalMemoryManager(this.db);
    this.noteManager = new NoteManager(this.db);
    this.observationManager = new ObservationManager(this.db);
    this.autoSummaryManager = new AutoSummaryManager(this.db);
    this.searchManager = new SearchManager(this.db);
    this.injectionManager = new InjectionManager({
      session: this.sessionManager,
      project: this.projectManager,
      global: this.globalManager,
      observation: this.observationManager,
      autoSummary: this.autoSummaryManager,
    });
  }

  get isEnabled(): boolean {
    return this.db !== null;
  }

  addSessionMemory(sessionId: string, content: string, tags?: string[]): MemoryEntry | null {
    return this.sessionManager?.add(sessionId, content, tags) ?? null;
  }

  addProjectMemory(workspace: string, content: string, tags?: string[]): MemoryEntry | null {
    return this.projectManager?.add(workspace, content, tags) ?? null;
  }

  addGlobalMemory(content: string, tags?: string[]): MemoryEntry | null {
    return this.globalManager?.add(content, tags) ?? null;
  }

  addNote(content: string, tags?: string[]): MemoryEntry | null {
    return this.noteManager?.add(content, tags) ?? null;
  }

  getAllMemories(tier?: MemoryTier, sessionId?: string, workspace?: string): MemoryEntry[] {
    if (!this.db) return [];

    const results: MemoryEntry[] = [];

    if (!tier || tier === 'session') {
      if (sessionId) results.push(...(this.sessionManager?.list(sessionId) ?? []));
    }
    if (!tier || tier === 'project') {
      if (workspace) results.push(...(this.projectManager?.list(workspace) ?? []));
    }
    if (!tier || tier === 'global') {
      results.push(...(this.globalManager?.list() ?? []));
    }
    if (!tier || tier === 'note') {
      results.push(...(this.noteManager?.list() ?? []));
    }
    if (!tier || tier === 'observation') {
      if (sessionId) results.push(...(this.observationManager?.getRecent(sessionId, 50) ?? []));
      else if (workspace) results.push(...(this.observationManager?.getRecentForWorkspace(workspace, 50) ?? []));
    }
    if (!tier || tier === 'auto-summary') {
      if (workspace) results.push(...(this.autoSummaryManager?.getLatest(workspace) ?? []));
    }

    return results;
  }

  updateMemory(id: string, content: string, tags?: string[]): MemoryEntry | null {
    if (!this.db) return null;
    const now = Date.now();
    this.db.prepare(
      'UPDATE memories SET content = ?, tags = ?, updated_at = ? WHERE id = ?'
    ).run(content, JSON.stringify(tags ?? []), now, id);

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return null;
    return rowToEntry(row);
  }

  deleteMemory(id: string): boolean {
    if (!this.db) return false;
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listNotes(tags?: string[]): MemoryEntry[] {
    return this.noteManager?.list(tags) ?? [];
  }

  addObservation(sessionId: string, workspace: string, input: ObservationInput): MemoryEntry | null {
    return this.observationManager?.addRichObservation(sessionId, workspace, input) ?? null;
  }

  getRecentObservations(sessionId: string, limit?: number): MemoryEntry[] {
    return this.observationManager?.getRecent(sessionId, limit) ?? [];
  }

  captureAutoSummary(sessionId: string, workspace: string, summary: string): void {
    this.autoSummaryManager?.capture(sessionId, workspace, summary);
  }

  getLatestAutoSummaries(workspace: string, limit?: number): MemoryEntry[] {
    return this.autoSummaryManager?.getLatest(workspace, limit) ?? [];
  }

  searchMemories(query: SearchQuery): SearchResult[] {
    return this.searchManager?.search(query) ?? [];
  }

  getMemoryDetails(ids: string[]): MemoryEntry[] {
    return this.searchManager?.getDetails(ids) ?? [];
  }

  getTimeline(anchorId: string, before?: number, after?: number, workspace?: string): TimelineEntry[] {
    return this.searchManager?.getTimeline(anchorId, before, after, workspace) ?? [];
  }

  migrateSessionId(oldId: string, newId: string): void {
    if (!this.db) return;
    this.db.prepare('UPDATE memories SET session_id = ? WHERE session_id = ?').run(newId, oldId);
  }

  deleteSessionMemories(sessionId: string): void {
    this.sessionManager?.deleteBySession(sessionId);
    this.autoSummaryManager?.deleteBySession(sessionId);
    this.observationManager?.deleteBySession(sessionId);
  }

  isFirstMessageOfSession(sessionId: string): boolean {
    return this.injectionManager?.isFirstMessageOfSession(sessionId) ?? true;
  }

  markFirstMessageSent(sessionId: string): void {
    this.injectionManager?.markFirstMessageSent(sessionId);
  }

  buildInjectionContext(sessionId: string | null, workspace: string, activeFile: string | null): string {
    return this.injectionManager?.buildInjectionContext(sessionId, workspace, activeFile) ?? '';
  }

  async getMcpServerConfig(getSessionId: () => string, workspace: string): Promise<unknown> {
    if (!this.isEnabled) return null;

    try {
      if (!this.mcpModules) {
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        const z = await import('zod');
        this.mcpModules = { sdk, z };
      }
      const { sdk, z } = this.mcpModules;
      return createMemoryMcpServer(
        this, sdk.createSdkMcpServer, sdk.tool, z.z, getSessionId, workspace
      );
    } catch (err) {
      log('[MemoryService] Failed to create MCP server:', err);
      return null;
    }
  }

  dispose(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
