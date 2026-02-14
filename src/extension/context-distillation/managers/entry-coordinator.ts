import { log } from '../../logger';
import { EntryTracker, summarizeToolInput } from '../entry-tracker';
import { insertEntry } from '../context-database';
import type { DatabaseInstance } from '../../memory/types';

export interface EntryCoordinatorDeps {
  getDb: () => DatabaseInstance | null;
  getPersistenceSessionId: () => string;
}

export class EntryCoordinator {
  private deps: EntryCoordinatorDeps;
  private entryTracker: EntryTracker | null = null;
  private assistantTextBuffer = '';
  private _promptIndex = -1;
  private _lastUserPrompt = '';

  constructor(deps: EntryCoordinatorDeps) {
    this.deps = deps;
  }

  get promptIndex(): number {
    return this._promptIndex;
  }

  set promptIndex(value: number) {
    this._promptIndex = value;
  }

  get lastUserPrompt(): string {
    return this._lastUserPrompt;
  }

  onPromptSubmit(userPrompt: string): void {
    this._lastUserPrompt = userPrompt;
    this._promptIndex++;
    this.assistantTextBuffer = '';
    log('[EntryCoordinator.onPromptSubmit] promptIndex=%d, prompt=%s',
      this._promptIndex, userPrompt.slice(0, 80));

    const db = this.deps.getDb();
    if (db) {
      this.entryTracker = new EntryTracker(db, this.deps.getPersistenceSessionId(), this._promptIndex);
    }
  }

  onFlushedPromptSubmit(userPrompt: string): void {
    this._lastUserPrompt = userPrompt;
    this._promptIndex++;
    this.assistantTextBuffer = '';

    const db = this.deps.getDb();
    if (db) {
      this.entryTracker = new EntryTracker(db, this.deps.getPersistenceSessionId(), this._promptIndex);
    }
  }

  onToolUse(toolName: string, input: Record<string, unknown>, toolUseId?: string): void {
    this.entryTracker?.onToolUse(toolName, input, toolUseId);
    this.assistantTextBuffer += `\n[${toolName}] ${summarizeToolInput(toolName, input)}\n`;
  }

  onInterjection(text: string): void {
    this.assistantTextBuffer += `\n[User interjection]: ${text}\n`;
  }

  appendToBuffer(text: string): void {
    this.assistantTextBuffer += text;
  }

  finalize(): { promptIndex: number; userPrompt: string; assistantText: string } | null {
    if (!this.entryTracker) return null;

    const entryCount = this.entryTracker.finalize();

    if (entryCount === 0 && this.assistantTextBuffer.trim().length > 0) {
      const db = this.deps.getDb();
      if (db) {
        insertEntry(db, this.deps.getPersistenceSessionId(), this._promptIndex, null, 'discussion', []);
        log('[EntryCoordinator] Inserted discussion entry for text-only response at prompt %d', this._promptIndex);
      }
    }

    return {
      promptIndex: this._promptIndex,
      userPrompt: this._lastUserPrompt,
      assistantText: this.assistantTextBuffer,
    };
  }

  regenerateTracker(): void {
    const db = this.deps.getDb();
    if (db && this._lastUserPrompt) {
      this.entryTracker = new EntryTracker(db, this.deps.getPersistenceSessionId(), this._promptIndex);
    }
  }

  reset(): void {
    this._promptIndex = -1;
    this._lastUserPrompt = '';
    this.assistantTextBuffer = '';
    this.entryTracker = null;
  }
}
