import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { log } from '../logger';
import type { ContextDocument } from './types';

export const CONTEXT_DIR: string = path.join(os.homedir(), '.damocles', 'context');
const WRITE_DEBOUNCE_MS = 500;

export class ContextStore {
  private document: ContextDocument | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private contextPath: string;

  constructor(sessionId: string) {
    this.contextPath = path.join(CONTEXT_DIR, `${sessionId}.context.md`);
  }

  getContext(): ContextDocument | null {
    return this.document;
  }

  getContextPath(): string {
    return this.contextPath;
  }

  updateContext(content: string): void {
    const turnCount = (this.document?.turnCount ?? 0) + 1;
    this.document = {
      content,
      lastUpdatedAt: Date.now(),
      turnCount,
    };
    this.scheduleDiskWrite();
  }

  reset(): void {
    this.document = null;
    this.cancelPendingWrite();
    fs.unlink(this.contextPath).catch(() => {});
  }

  async loadFromDisk(): Promise<void> {
    try {
      const content = await fs.readFile(this.contextPath, 'utf-8');
      if (content.trim()) {
        this.document = {
          content: content.trim(),
          lastUpdatedAt: Date.now(),
          turnCount: 0,
        };
      }
    } catch {
      this.document = null;
    }
  }

  async flush(): Promise<void> {
    this.cancelPendingWrite();
    await this.writeToDisk();
  }

  dispose(): void {
    this.cancelPendingWrite();
  }

  private scheduleDiskWrite(): void {
    this.cancelPendingWrite();
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writeToDisk().catch(err => {
        log('[ContextStore] Disk write failed:', err);
      });
    }, WRITE_DEBOUNCE_MS);
  }

  private cancelPendingWrite(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  private async writeToDisk(): Promise<void> {
    if (!this.document) return;
    try {
      await fs.mkdir(path.dirname(this.contextPath), { recursive: true });
      await fs.writeFile(this.contextPath, this.document.content, 'utf-8');
    } catch (err) {
      log('[ContextStore] Failed to write context file:', err);
    }
  }
}
