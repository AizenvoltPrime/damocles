import { log } from '../logger';
import { insertEntry } from './context-database';
import type { DatabaseInstance } from '../memory/types';
import type { EntryType, ToolCallRecord } from './types';

const MAX_RESULT_CHARS = 200;

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);
const IGNORED_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'TodoRead', 'TodoWrite']);

export function extractTaskResultTexts(result: string): string[] | null {
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
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input['file_path'] ?? '');
    case 'Bash':
      return String(input['command'] ?? '').slice(0, 200);
    case 'Glob':
      return String(input['pattern'] ?? '');
    case 'Grep':
      return `pattern="${input['pattern'] ?? ''}" path=${input['path'] ?? '.'}`;
    case 'Task':
      return String(input['prompt'] ?? input['description'] ?? '');
    case 'WebSearch':
      return String(input['query'] ?? '');
    case 'WebFetch':
      return String(input['url'] ?? '');
    default:
      return Object.keys(input).join(', ');
  }
}

function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    return typeof input['file_path'] === 'string' ? input['file_path'] : null;
  }
  if (toolName === 'Glob') {
    return typeof input['path'] === 'string' ? input['path'] : null;
  }
  if (toolName === 'Grep') {
    return typeof input['path'] === 'string' ? input['path'] : null;
  }
  return null;
}

function classifyEntryType(entry: PendingEntry, toolCalls: ToolCallRecord[]): EntryType {
  if (entry.hasWrite) return 'file_change';

  const toolNames = new Set(toolCalls.map(tc => tc.tool_name));
  if (toolNames.has('Bash')) return 'command';
  if (toolNames.has('WebSearch') || toolNames.has('WebFetch')) return 'web';
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
    const record: PendingToolCall = { tool_name: toolName, input_summary: inputSummary, result_summary: '' };
    if (toolUseId) record.toolUseId = toolUseId;

    let key: string;
    let filePath: string | null = null;

    if (FILE_TOOLS.has(toolName)) {
      filePath = extractFilePath(toolName, input);
      key = filePath ?? `_file_${this.callCounter++}`;
    } else if (toolName === 'Bash') {
      key = `_cmd_${this.callCounter++}`;
    } else if (toolName === 'WebSearch' || toolName === 'WebFetch') {
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

  onToolResult(toolName: string, result: string, toolUseId?: string): void {
    const call = this.findCallForResult(toolName, toolUseId);
    if (!call) return;

    const effective = toolName === 'Task' ? (extractTaskResultTexts(result)?.join('\n') ?? result) : result;
    call.result_summary = effective.length > MAX_RESULT_CHARS
      ? effective.slice(0, MAX_RESULT_CHARS) + '...'
      : effective;
  }

  finalize(): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      const entryType = classifyEntryType(entry, entry.toolCalls);
      const cleanCalls = entry.toolCalls.map(({ tool_name, input_summary, result_summary }) => ({ tool_name, input_summary, result_summary }));
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

  private findCallForResult(toolName: string, toolUseId?: string): PendingToolCall | undefined {
    if (toolUseId) {
      for (const entry of this.pending.values()) {
        for (const call of entry.toolCalls) {
          if (call.toolUseId === toolUseId && !call.result_summary) return call;
        }
      }
    }

    for (const entry of this.pending.values()) {
      const lastCall = entry.toolCalls[entry.toolCalls.length - 1];
      if (lastCall && lastCall.tool_name === toolName && !lastCall.result_summary) {
        return lastCall;
      }
    }
    return undefined;
  }
}
