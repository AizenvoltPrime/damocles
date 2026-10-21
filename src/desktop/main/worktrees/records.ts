import { liveChatRecordAt, liveChatRecords, validRecord } from '../../../core/worktrees/records';
import type { ChatWorktreeRecord, WorktreeRecord } from '../../../core/worktrees/registry';
import type { Disposable } from '../../../platform/disposable';
import { Emitter } from '../../local-services/emitter';

/** The registry reads main makes (WorktreeRegistry's), answered from the records core last published. */
export interface WorktreeRecordReader {
  records(): readonly WorktreeRecord[];
  get(id: string): WorktreeRecord | undefined;
  liveChatRecordAt(folder: string): ChatWorktreeRecord | undefined;
  liveChatRecords(projectPath: string): readonly ChatWorktreeRecord[];
}

/**
 * Core's worktree registry as main reads it: the records of core's `worktrees` mirror, each checked by the rule registry.json
 * is read with against main's own registry folder, since trust follows a chat record from its worktree to its project. They
 * outlive a core: a restarted core's first delta replaces them.
 */
export class WorktreeRecords implements WorktreeRecordReader, Disposable {
  private readonly rootDir: string;
  private readonly log: (line: string) => void;
  private current: readonly WorktreeRecord[] = [];
  private json = '[]';
  private readonly changed: Emitter<[]>;

  constructor(rootDir: string, log: (line: string) => void) {
    this.rootDir = rootDir;
    this.log = log;
    this.changed = new Emitter('worktree-records', log);
  }

  /** Takes the records core published; one that fails the registry's rule is dropped, and logged. */
  apply(raw: readonly unknown[]): void {
    const records = raw.flatMap((candidate) => {
      const record = validRecord(candidate, this.rootDir);
      if (!record) this.log(`[worktrees] dropped a worktree record core published that the registry rule refuses: ${JSON.stringify(candidate)?.slice(0, 300)}`);
      return record ? [record] : [];
    });
    const json = JSON.stringify(records);
    if (json === this.json) return;
    this.json = json;
    this.current = records;
    this.changed.fire();
  }

  records(): readonly WorktreeRecord[] {
    return this.current;
  }

  get(id: string): WorktreeRecord | undefined {
    return this.current.find((record) => record.id === id);
  }

  liveChatRecordAt(folder: string): ChatWorktreeRecord | undefined {
    return liveChatRecordAt(this.current, folder);
  }

  liveChatRecords(projectPath: string): readonly ChatWorktreeRecord[] {
    return liveChatRecords(this.current, projectPath);
  }

  onDidChange(listener: () => void): Disposable {
    return this.changed.add(listener);
  }

  dispose(): void {
    this.changed.clear();
  }
}
