import type { ScratchpadEntry } from './types';

export class Scratchpad {
  private readonly sections = new Map<string, ScratchpadEntry>();
  private readonly subscribers: Array<(entry: ScratchpadEntry) => void> = [];

  set(section: string, content: string, author: string): { version: number } {
    const existing = this.sections.get(section);
    const version = existing ? existing.version + 1 : 1;
    const entry: ScratchpadEntry = {
      section,
      content,
      author,
      version,
      timestamp: Date.now(),
    };
    this.sections.set(section, entry);
    for (const cb of this.subscribers) {
      try {
        cb(entry);
      } catch (err) {
        console.error('[Scratchpad] Subscriber error:', err);
      }
    }
    return { version };
  }

  get(section: string): ScratchpadEntry | undefined {
    return this.sections.get(section);
  }

  getAll(): ScratchpadEntry[] {
    return [...this.sections.values()];
  }

  subscribe(callback: (entry: ScratchpadEntry) => void): () => void {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }
}
