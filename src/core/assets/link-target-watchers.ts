import type { Disposable } from '../../platform/disposable';
import type { FileWatcher, FileWatcherFactory } from '../../platform/file-watcher';
import { DRIVE_ANSWER_TTL_MS } from '../local-links';
import { folderKey } from '../workspace-folders/folder-key';
import type { WatchTarget } from './asset-walk';

interface Held {
  readonly watcher: FileWatcher;
  // folderKey of each watched file; undefined for a glob watch, which reports every match
  files: Set<string> | undefined;
}

/**
 * Watches the targets a scan followed through links, which no root watcher reports. File targets in one folder share one
 * shallow watch filtered to their realpaths; a base that does not exist yet waits, as every FileWatcher does. A retry target
 * calls onRetry once, after the drive probe's answer expired, so a drive that did not answer is asked again; an owner whose
 * onChange reloads pi passes an onRetry that rescans alone, since pi's synchronous walk would block on that drive.
 */
export class LinkTargetWatchers implements Disposable {
  private readonly held = new Map<string, Held>();
  private retry: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly factory: FileWatcherFactory;
  private readonly onChange: () => void;
  private readonly onRetry: () => void;

  constructor(factory: FileWatcherFactory, onChange: () => void, onRetry: () => void = onChange) {
    this.factory = factory;
    this.onChange = onChange;
    this.onRetry = onRetry;
  }

  /** Makes the watched set exactly targets, keeping each watch that targets still name and a retry still waiting. */
  sync(targets: Iterable<WatchTarget>): void {
    if (this.disposed) return;
    const wanted = new Map<string, { base: string; glob: string; files: Set<string> | undefined }>();
    let retry = false;
    for (const target of targets) {
      if ('retry' in target) {
        retry = true;
        continue;
      }
      const glob = 'glob' in target ? target.glob : '*';
      // a file watch never shares a key with a glob watch, which reports everything it matches
      const key = `${folderKey(target.base)}\0${'glob' in target ? glob : ''}`;
      const entry = wanted.get(key) ?? { base: target.base, glob, files: 'glob' in target ? undefined : new Set<string>() };
      if ('files' in target) for (const file of target.files) entry.files?.add(folderKey(file));
      wanted.set(key, entry);
    }
    for (const [key, held] of this.held) {
      if (wanted.has(key)) continue;
      held.watcher.dispose();
      this.held.delete(key);
    }
    for (const [key, want] of wanted) {
      const held = this.held.get(key);
      if (held !== undefined) {
        held.files = want.files;
        continue;
      }
      this.held.set(key, this.watch(want.base, want.glob, want.files));
    }
    if (!retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    } else if (this.retry === undefined) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.onRetry();
      }, DRIVE_ANSWER_TTL_MS);
    }
  }

  private watch(base: string, glob: string, files: Set<string> | undefined): Held {
    const held: Held = { watcher: this.factory.watch(base, glob), files };
    const fire = (fsPath: string): void => {
      if (held.files === undefined || held.files.has(folderKey(fsPath))) this.onChange();
    };
    held.watcher.onDidCreate(fire);
    held.watcher.onDidChange(fire);
    held.watcher.onDidDelete(fire);
    return held;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    for (const held of this.held.values()) held.watcher.dispose();
    this.held.clear();
  }
}
