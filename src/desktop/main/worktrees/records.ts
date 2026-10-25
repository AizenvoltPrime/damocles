import { liveChatRecordAt, liveChatRecords, validRecord } from '../../../core/worktrees/records';
import type { ChatWorktreeRecord, WorktreeRecord } from '../../../core/worktrees/registry';
import type { Disposable } from '../../../platform/disposable';
import { pathFor } from '../../../shared/project-location';
import { Emitter } from '../../local-services/emitter';

/** The registry reads main makes (WorktreeRegistry's), answered from the records core last published. */
export interface WorktreeRecordReader {
  records(): readonly WorktreeRecord[];
  get(id: string): WorktreeRecord | undefined;
  liveChatRecordAt(folder: string): ChatWorktreeRecord | undefined;
  liveChatRecords(projectPath: string): readonly ChatWorktreeRecord[];
}

/** This computer's registry rule: registry.json's, against main's own registry folder, since trust follows a chat record to its project. */
export function localRecord(rootDir: string): (raw: unknown) => WorktreeRecord | undefined {
  return (raw) => validRecord(raw, rootDir);
}

/**
 * A remote core's registry rule: only a live chat record of one of that host's open projects (`projectPaths`, paths on the
 * target), checked by the registry rule in the path rules of the target's `os` against the worktrees folder its own worktree
 * sits in; nothing else of a target is kept.
 */
export function remoteChatRecord(projectPaths: () => readonly string[], os: () => NodeJS.Platform): (raw: unknown) => WorktreeRecord | undefined {
  return (raw) => {
    const candidate = raw as { readonly kind?: unknown; readonly worktreeRoot?: unknown; readonly projectPath?: unknown } | null;
    const target = os();
    const flavor = pathFor({ os: target });
    if (candidate?.kind !== 'chat' || typeof candidate.worktreeRoot !== 'string' || !flavor.isAbsolute(candidate.worktreeRoot)) return undefined;
    if (!projectPaths().includes(candidate.projectPath as string)) return undefined;
    return validRecord(raw, flavor.dirname(flavor.dirname(candidate.worktreeRoot)), target);
  };
}

/**
 * A core's worktree registry as main reads it: the records of that core's `worktrees` mirror, each checked by its rule and
 * looked up in the path rules of the OS that core runs on. They outlive a core: a restarted core's first delta replaces them.
 */
export class WorktreeRecords implements WorktreeRecordReader, Disposable {
  private readonly valid: (raw: unknown) => WorktreeRecord | undefined;
  private readonly log: (line: string) => void;
  private readonly os: () => NodeJS.Platform | undefined;
  private current: readonly WorktreeRecord[] = [];
  private json = '[]';
  private readonly changed: Emitter<[]>;

  constructor(valid: (raw: unknown) => WorktreeRecord | undefined, log: (line: string) => void, os: () => NodeJS.Platform | undefined = () => undefined) {
    this.valid = valid;
    this.log = log;
    this.os = os;
    this.changed = new Emitter('worktree-records', log);
  }

  /** Takes the records core published; one that fails the registry's rule is dropped, and logged. */
  apply(raw: readonly unknown[]): void {
    const records = raw.flatMap((candidate) => {
      const record = this.valid(candidate);
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
    return liveChatRecordAt(this.current, folder, this.os());
  }

  liveChatRecords(projectPath: string): readonly ChatWorktreeRecord[] {
    return liveChatRecords(this.current, projectPath, this.os());
  }

  onDidChange(listener: () => void): Disposable {
    return this.changed.add(listener);
  }

  dispose(): void {
    this.changed.clear();
  }
}
