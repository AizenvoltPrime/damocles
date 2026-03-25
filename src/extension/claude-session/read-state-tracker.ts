import { stat } from 'fs/promises';
import { resolve } from 'path';
import { log } from '../logger';

export class ReadStateTracker {
  private reads = new Map<string, number>();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async trackRead(filePath: string): Promise<void> {
    const resolved = resolve(this.cwd, filePath);
    try {
      const s = await stat(resolved);
      this.reads.set(resolved, Math.floor(s.mtimeMs));
    } catch {
      log('[ReadStateTracker] Failed to stat %s, skipping', resolved);
    }
  }

  entries(): IterableIterator<[string, number]> {
    return this.reads.entries();
  }

  get size(): number {
    return this.reads.size;
  }

  clear(): void {
    this.reads.clear();
  }
}
