import * as path from 'path';
import * as os from 'os';
import type { ContextDocument } from './types';

export const CONTEXT_DIR: string = path.join(os.homedir(), '.damocles', 'context');

export class ContextStore {
  private document: ContextDocument | null = null;

  getContext(): ContextDocument | null {
    return this.document;
  }

  updateContext(content: string): void {
    const turnCount = (this.document?.turnCount ?? 0) + 1;
    this.document = {
      content,
      lastUpdatedAt: Date.now(),
      turnCount,
    };
  }

  loadContent(content: string): void {
    this.document = {
      content,
      lastUpdatedAt: Date.now(),
      turnCount: 0,
    };
  }

  reset(): void {
    this.document = null;
  }
}
