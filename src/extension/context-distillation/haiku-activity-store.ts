import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../logger';
import { CONTEXT_DIR } from './context-store';
import type { HaikuLogEvent, HaikuPromptActivity } from '../../shared/types/haiku-observer';

export class HaikuActivityStore {
  private basePath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private _generation = 0;

  constructor(sessionId: string) {
    this.basePath = path.join(CONTEXT_DIR, 'haiku', sessionId);
  }

  logEvent(promptIndex: number, event: HaikuLogEvent): void {
    const gen = this._generation;
    const filePath = this.haikuLogPath(promptIndex);
    const line = JSON.stringify(event) + '\n';
    this.writeQueue = this.writeQueue
      .then(() => {
        if (gen !== this._generation) return;
        return fs.mkdir(path.dirname(filePath), { recursive: true });
      })
      .then(() => {
        if (gen !== this._generation) return;
        return fs.appendFile(filePath, line, 'utf-8');
      })
      .catch(err => log('[HaikuActivityStore] logEvent failed:', err));
  }

  async loadPromptActivity(promptIndex: number): Promise<HaikuPromptActivity | null> {
    const filePath = this.haikuLogPath(promptIndex);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      let finalEvent: HaikuLogEvent | null = null;

      for (const line of lines) {
        let event: HaikuLogEvent;
        try {
          event = JSON.parse(line) as HaikuLogEvent;
        } catch {
          continue;
        }
        if (event.event === 'observation_complete') {
          finalEvent = event;
        }
      }

      if (!finalEvent) return null;

      return {
        promptIndex,
        thinking: finalEvent.thinking ?? '',
        text: finalEvent.text ?? '',
        contextSnapshot: finalEvent.contextSnapshot ?? '',
        timestamp: finalEvent.timestamp,
      };
    } catch {
      return null;
    }
  }

  async loadAllActivities(): Promise<HaikuPromptActivity[]> {
    try {
      const entries = await fs.readdir(this.basePath, { withFileTypes: true });
      const promptDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('prompt-'))
        .sort((a, b) => {
          const numA = parseInt(a.name.match(/prompt-(\d+)/)?.[1] ?? '0');
          const numB = parseInt(b.name.match(/prompt-(\d+)/)?.[1] ?? '0');
          return numA - numB;
        });

      const activities: HaikuPromptActivity[] = [];
      for (const dir of promptDirs) {
        const idx = parseInt(dir.name.match(/prompt-(\d+)/)?.[1] ?? '0');
        const activity = await this.loadPromptActivity(idx);
        if (activity) activities.push(activity);
      }
      return activities;
    } catch {
      return [];
    }
  }

  async getMaxPromptIndex(): Promise<number> {
    try {
      const entries = await fs.readdir(this.basePath, { withFileTypes: true });
      let max = -1;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^prompt-(\d+)$/);
        if (match) {
          const idx = parseInt(match[1]!);
          if (idx > max) max = idx;
        }
      }
      return max;
    } catch {
      return -1;
    }
  }

  async loadLatestContextSnapshot(): Promise<string | null> {
    try {
      const entries = await fs.readdir(this.basePath, { withFileTypes: true });
      let maxIndex = -1;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^prompt-(\d+)$/);
        if (match) {
          const idx = parseInt(match[1]!);
          if (idx > maxIndex) maxIndex = idx;
        }
      }
      if (maxIndex < 0) return null;
      const filePath = path.join(this.basePath, `prompt-${maxIndex}`, 'context.md');
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  saveContextSnapshot(promptIndex: number, content: string): void {
    const gen = this._generation;
    const filePath = path.join(this.promptDir(promptIndex), 'context.md');
    this.writeQueue = this.writeQueue
      .then(() => {
        if (gen !== this._generation) return;
        return fs.mkdir(path.dirname(filePath), { recursive: true });
      })
      .then(() => {
        if (gen !== this._generation) return;
        return fs.writeFile(filePath, content, 'utf-8');
      })
      .catch(err => log('[HaikuActivityStore] saveContextSnapshot failed:', err));
  }

  reset(newSessionId: string): void {
    this._generation++;
    this.basePath = path.join(CONTEXT_DIR, 'haiku', newSessionId);
    this.writeQueue = Promise.resolve();
  }

  private promptDir(promptIndex: number): string {
    return path.join(this.basePath, `prompt-${promptIndex}`);
  }

  private haikuLogPath(promptIndex: number): string {
    return path.join(this.promptDir(promptIndex), 'haiku.jsonl');
  }
}
