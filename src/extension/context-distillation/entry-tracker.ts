import { log } from '../logger';
import { insertEntry } from './context-database';
import { FILE_TOOLS, WRITE_TOOLS, IGNORED_TOOLS, TOOL_AGENT, TOOL_READ, TOOL_WRITE, TOOL_EDIT, TOOL_BASH, TOOL_GLOB, TOOL_GREP, TOOL_WEB_SEARCH, TOOL_WEB_FETCH } from '../../shared/tool-names';
import type { DatabaseInstance } from '../memory/types';
import type { EntryType, ToolCallRecord } from './types';

export function extractAgentResultTexts(result: string): string[] | null {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const items = parsed['content'];
    if (!Array.isArray(items)) return null;
    const texts = (items as Array<Record<string, unknown>>)
      .filter((item): item is Record<string, unknown> & { text: string } =>
        item['type'] === 'text' && typeof item['text'] === 'string')
      .map(item => item.text);
    return texts.length > 0 ? texts : null;
  } catch {
    return null;
  }
}

interface PendingToolCall extends ToolCallRecord {
  toolUseId?: string;
}

interface PendingEntry {
  filePath: string | null;
  toolCalls: PendingToolCall[];
  hasWrite: boolean;
}

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case TOOL_READ:
    case TOOL_WRITE:
    case TOOL_EDIT:
      return String(input['file_path'] ?? '');
    case TOOL_BASH:
      return String(input['command'] ?? '').slice(0, 200);
    case TOOL_GLOB:
      return String(input['pattern'] ?? '');
    case TOOL_GREP:
      return `pattern="${input['pattern'] ?? ''}" path=${input['path'] ?? '.'}`;
    case TOOL_AGENT:
      return String(input['prompt'] ?? input['description'] ?? '');
    case TOOL_WEB_SEARCH:
      return String(input['query'] ?? '');
    case TOOL_WEB_FETCH:
      return String(input['url'] ?? '');
    default: {
      const vals = Object.entries(input)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([, v]) => String(v));
      return vals.length > 0 ? vals.join(', ') : Object.keys(input).join(', ');
    }
  }
}

function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === TOOL_READ || toolName === TOOL_WRITE || toolName === TOOL_EDIT) {
    return typeof input['file_path'] === 'string' ? input['file_path'] : null;
  }
  if (toolName === TOOL_GLOB) {
    return typeof input['path'] === 'string' ? input['path'] : null;
  }
  if (toolName === TOOL_GREP) {
    return typeof input['path'] === 'string' ? input['path'] : null;
  }
  return null;
}

function classifyEntryType(entry: PendingEntry, toolCalls: ToolCallRecord[]): EntryType {
  if (entry.hasWrite) return 'file_change';

  const toolNames = new Set(toolCalls.map(tc => tc.tool_name));
  if (toolNames.has(TOOL_BASH)) return 'command';
  if (toolNames.has(TOOL_WEB_SEARCH) || toolNames.has(TOOL_WEB_FETCH)) return 'web';
  return 'research';
}

export class EntryTracker {
  private db: DatabaseInstance;
  private sessionId: string;
  private promptIndex: number;
  private pending: Map<string, PendingEntry> = new Map();
  private callCounter = 0;

  constructor(db: DatabaseInstance, sessionId: string, promptIndex: number) {
    this.db = db;
    this.sessionId = sessionId;
    this.promptIndex = promptIndex;
  }

  onToolUse(toolName: string, input: Record<string, unknown>, toolUseId?: string): void {
    if (IGNORED_TOOLS.has(toolName)) return;

    const inputSummary = summarizeToolInput(toolName, input);
    const record: PendingToolCall = { tool_name: toolName, input_summary: inputSummary };
    if (toolUseId) record.toolUseId = toolUseId;

    let key: string;
    let filePath: string | null = null;

    if (FILE_TOOLS.has(toolName)) {
      filePath = extractFilePath(toolName, input);
      key = filePath ?? `_file_${this.callCounter++}`;
    } else if (toolName === TOOL_BASH) {
      key = `_cmd_${this.callCounter++}`;
    } else if (toolName === TOOL_WEB_SEARCH || toolName === TOOL_WEB_FETCH) {
      key = `_web_${this.callCounter++}`;
    } else {
      key = `_other_${this.callCounter++}`;
    }

    let entry = this.pending.get(key);
    if (!entry) {
      entry = { filePath, toolCalls: [], hasWrite: false };
      this.pending.set(key, entry);
    }

    entry.toolCalls.push(record);
    if (WRITE_TOOLS.has(toolName)) entry.hasWrite = true;
  }

  finalize(): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      const entryType = classifyEntryType(entry, entry.toolCalls);
      const cleanCalls = entry.toolCalls.map(({ tool_name, input_summary }) => ({ tool_name, input_summary }));
      insertEntry(this.db, this.sessionId, this.promptIndex, entry.filePath, entryType, cleanCalls);
      count++;
    }
    if (count > 0) {
      log('[EntryTracker] Finalized %d entries for prompt %d', count, this.promptIndex);
    }
    this.pending.clear();
    return count;
  }

  reset(promptIndex: number): void {
    this.pending.clear();
    this.promptIndex = promptIndex;
    this.callCounter = 0;
  }

  get entryCount(): number {
    return this.pending.size;
  }
}
