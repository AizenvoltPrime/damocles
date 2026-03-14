import { log } from '../../logger';
import type { SessionTrace } from './recall-graph-state';

const MAX_TRACE_ENTRIES = 50;

export class GraphSessionState {
  private sessionTrace: SessionTrace = { entries: [], lastIntent: '', recentEntities: [] };

  getSessionTrace(): SessionTrace {
    return { ...this.sessionTrace };
  }

  updateSessionTrace(trace: SessionTrace): void {
    this.sessionTrace = {
      entries: trace.entries.slice(-MAX_TRACE_ENTRIES),
      lastIntent: trace.lastIntent,
      recentEntities: trace.recentEntities,
    };
  }

  serialize(): string {
    return JSON.stringify(this.sessionTrace);
  }

  static deserialize(data: string): GraphSessionState {
    const state = new GraphSessionState();
    try {
      const parsed = JSON.parse(data);
      if (parsed && Array.isArray(parsed.entries)) {
        state.sessionTrace = {
          entries: parsed.entries.slice(-MAX_TRACE_ENTRIES).map((e: Record<string, unknown>) => ({
            ...e,
            secondaryIntent: e['secondaryIntent'] ?? null,
          })),
          lastIntent: String(parsed.lastIntent ?? ''),
          recentEntities: Array.isArray(parsed.recentEntities) ? parsed.recentEntities : [],
        };
      }
    } catch (err) {
      log('[GraphSessionState] Failed to deserialize: %O', err);
    }
    return state;
  }

  reset(): void {
    this.sessionTrace = { entries: [], lastIntent: '', recentEntities: [] };
  }
}
