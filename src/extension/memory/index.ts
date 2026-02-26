import * as vscode from 'vscode';
import { log } from '../logger';
import { openDatabase, updateSearchTerms, getUnexpandedMemoryIds } from './database';
import { expandMemoryTerms, clearExpansionCache } from './query-expansion';
import { SessionMemoryManager } from './managers/session-memory-manager';
import { ProjectMemoryManager } from './managers/project-memory-manager';
import { GlobalMemoryManager } from './managers/global-memory-manager';
import { NoteManager } from './managers/note-manager';
import { ObservationManager } from './managers/observation-manager';
import { SearchManager } from './managers/search-manager';
import { InjectionManager } from './managers/injection-manager';
import { FileChangeTracker } from './managers/file-change-tracker';
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
  private searchManager: SearchManager | null = null;
  private injectionManager: InjectionManager | null = null;
  private fileChangeTracker: FileChangeTracker | null = null;
  private mcpModules: { createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer; tool: typeof import('@anthropic-ai/claude-agent-sdk').tool; z: typeof import('zod').z } | null = null;
  private backfillAbort: AbortController | null = null;

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
    this.searchManager = new SearchManager(this.db);
    this.injectionManager = new InjectionManager({
      session: this.sessionManager,
      project: this.projectManager,
      global: this.globalManager,
      observation: this.observationManager,
    }, this.db);
    this.fileChangeTracker = new FileChangeTracker(this.db);
    this.fileChangeTracker.initialize();
    this.startBackfill();
  }

  get isEnabled(): boolean {
    return this.db !== null;
  }

  get database(): DatabaseInstance | null {
    return this.db;
  }

  addSessionMemory(sessionId: string, content: string, tags?: string[]): MemoryEntry | null {
    const result = this.sessionManager?.add(sessionId, content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
  }

  addProjectMemory(workspace: string, content: string, tags?: string[]): MemoryEntry | null {
    const result = this.projectManager?.add(workspace, content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
  }

  addGlobalMemory(content: string, tags?: string[]): MemoryEntry | null {
    const result = this.globalManager?.add(content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
  }

  addNote(content: string, tags?: string[]): MemoryEntry | null {
    const result = this.noteManager?.add(content, tags) ?? null;
    if (result) this._expandSearchTerms(result.id, { content, ...(tags ? { tags } : {}) });
    return result;
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

    return results;
  }

  updateMemory(id: string, content: string, tags?: string[]): MemoryEntry | null {
    if (!this.db) return null;
    const now = Date.now();
    this.db.prepare(
      'UPDATE memories SET content = ?, tags = ?, updated_at = ? WHERE id = ?'
    ).run(content, JSON.stringify(tags ?? []), now, id);

    this.fileChangeTracker?.resetStaleness(id);

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!row) return null;
    this._expandSearchTerms(id, { content, ...(tags ? { tags } : {}) });
    return rowToEntry(row);
  }

  resetObservationStaleness(id: string): boolean {
    if (!this.db) return false;
    return this.fileChangeTracker?.resetStaleness(id) ?? false;
  }

  deleteMemory(id: string): boolean {
    if (!this.db) return false;
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    if (result.changes > 0) {
      this.fileChangeTracker?.removeObservation(id);
    }
    return result.changes > 0;
  }

  listNotes(tags?: string[]): MemoryEntry[] {
    return this.noteManager?.list(tags) ?? [];
  }

  addObservation(sessionId: string, workspace: string, input: ObservationInput): MemoryEntry | null {
    const result = this.observationManager?.addRichObservation(sessionId, workspace, input) ?? null;
    if (result) {
      this.fileChangeTracker?.trackObservation(result.id, input.filesRead ?? [], input.filesModified ?? []);
      this._expandSearchTerms(result.id, {
        content: input.content,
        title: input.title,
        facts: input.facts,
        ...(input.observationTags ? { tags: input.observationTags } : {}),
      });
    }
    return result;
  }

  getRecentObservations(sessionId: string, limit?: number): MemoryEntry[] {
    return this.observationManager?.getRecent(sessionId, limit) ?? [];
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
    this.observationManager?.deleteBySession(sessionId);
  }

  isFirstMessageOfSession(sessionId: string): boolean {
    return this.injectionManager?.isFirstMessageOfSession(sessionId) ?? true;
  }

  markFirstMessageSent(sessionId: string): void {
    this.injectionManager?.markFirstMessageSent(sessionId);
  }

  async buildInjectionContext(sessionId: string | null, workspace: string, activeFile: string | null, userPrompt?: string): Promise<{ context: string; metadata: import('@shared/types/context-injection').MemoryInjectionDisplay | null }> {
    return await this.injectionManager?.buildInjectionContext(sessionId, workspace, activeFile, userPrompt) ?? { context: '', metadata: null };
  }

  getMcpServerConfig(getSessionId: () => string, workspace: string): unknown {
    if (!this.isEnabled) return null;

    try {
      if (!this.mcpModules) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const zod = require('zod') as typeof import('zod');
        this.mcpModules = { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z: zod.z };
      }
      const { createSdkMcpServer, tool, z } = this.mcpModules;
      return createMemoryMcpServer(
        this, createSdkMcpServer, tool, z, getSessionId, workspace
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[MemoryService] Failed to create MCP server: ${message}`);
      return null;
    }
  }

  private _expandSearchTerms(id: string, entry: { content: string; title?: string; tags?: string[]; facts?: string[] }): void {
    if (!this.db) return;
    expandMemoryTerms(entry).then(terms => {
      if (!this.db || terms.length === 0) return;
      updateSearchTerms(this.db, id, terms);
    }).catch(err => {
      log('[MemoryService] Search term expansion failed for %s: %O', id, err);
    });
  }

  private startBackfill(): void {
    if (!this.db) return;
    const db = this.db;
    this.backfillAbort = new AbortController();
    const signal = this.backfillAbort.signal;

    const ids = getUnexpandedMemoryIds(db, 100);
    if (ids.length === 0) return;
    log('[MemoryService] Backfilling search terms for %d memories', ids.length);

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    const processNext = (index: number) => {
      if (signal.aborted || index >= ids.length) return;
      const id = ids[index]!;
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as import('./types').MemoryRow | undefined;
      if (!row) { processNext(index + 1); return; }
      const entry = {
        content: row.content,
        ...(row.title ? { title: row.title } : {}),
        tags: JSON.parse(row.tags) as string[],
        ...(row.facts && row.facts !== '[]' ? { facts: JSON.parse(row.facts) as string[] } : {}),
      };
      expandMemoryTerms(entry).then(terms => {
        if (signal.aborted) return;
        consecutiveFailures = 0;
        if (terms.length > 0) updateSearchTerms(db, id, terms);
        setTimeout(() => processNext(index + 1), 2000);
      }).catch(() => {
        if (signal.aborted) return;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log('[MemoryService] Backfill stopped after %d consecutive failures', consecutiveFailures);
          return;
        }
        setTimeout(() => processNext(index + 1), 2000);
      });
    };
    processNext(0);
  }

  dispose(): void {
    this.backfillAbort?.abort();
    this.backfillAbort = null;
    this.fileChangeTracker?.dispose();
    this.fileChangeTracker = null;
    clearExpansionCache();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
