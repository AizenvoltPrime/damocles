import type { ScratchpadEntry } from './types';

export interface StaleSectionInfo {
  section: string;
  currentVersion: number;
  lastReadVersion: number;
  author: string;
}

export interface ScratchpadRejection {
  section: string;
  attemptedBy: string;
  owner: string;
  reason: 'non-owner-overwrite';
  timestamp: number;
}

export class Scratchpad {
  private readonly sections = new Map<string, ScratchpadEntry>();
  private readonly subscribers: Array<(entry: ScratchpadEntry) => void> = [];
  private readonly rejectionSubscribers: Array<(rejection: ScratchpadRejection) => void> = [];
  // readVersions is in-memory only; teams are ephemeral per-run and not restored on session reload.
  private readonly readVersions = new Map<string, Map<string, number>>();

  set(section: string, content: string, author: string): { version: number } {
    const existing = this.sections.get(section);
    if (existing && existing.author !== author) {
      const rejection: ScratchpadRejection = {
        section,
        attemptedBy: author,
        owner: existing.author,
        reason: 'non-owner-overwrite',
        timestamp: Date.now(),
      };
      for (const cb of this.rejectionSubscribers) {
        try {
          cb(rejection);
        } catch (err) {
          console.error('[Scratchpad] Rejection subscriber error:', err);
        }
      }
      throw new Error(
        `Section "${section}" is owned by "${existing.author}" and cannot be overwritten by another agent. ` +
        `Write your contribution to a separate section you own.`
      );
    }
    const version = existing ? existing.version + 1 : 1;
    const entry: ScratchpadEntry = {
      section,
      content,
      author,
      version,
      timestamp: Date.now(),
    };
    this.sections.set(section, entry);
    this.recordRead(author, section, version);
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

  markRead(reader: string, section: string): void {
    const entry = this.sections.get(section);
    if (!entry) return;
    this.recordRead(reader, section, entry.version);
  }

  markAllRead(reader: string): void {
    for (const entry of this.sections.values()) {
      this.recordRead(reader, entry.section, entry.version);
    }
  }

  getReadVersion(reader: string, section: string): number {
    return this.readVersions.get(reader)?.get(section) ?? 0;
  }

  getSectionsAuthoredBy(author: string): ScratchpadEntry[] {
    return [...this.sections.values()].filter(e => e.author === author);
  }

  getStaleSectionsFor(reader: string, author: string): StaleSectionInfo[] {
    return this.getSectionsAuthoredBy(author)
      .filter(e => this.getReadVersion(reader, e.section) < e.version)
      .map(e => ({
        section: e.section,
        currentVersion: e.version,
        lastReadVersion: this.getReadVersion(reader, e.section),
        author: e.author,
      }));
  }

  subscribe(callback: (entry: ScratchpadEntry) => void): () => void {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  subscribeRejection(callback: (rejection: ScratchpadRejection) => void): () => void {
    this.rejectionSubscribers.push(callback);
    return () => {
      const idx = this.rejectionSubscribers.indexOf(callback);
      if (idx >= 0) this.rejectionSubscribers.splice(idx, 1);
    };
  }

  private recordRead(reader: string, section: string, version: number): void {
    let map = this.readVersions.get(reader);
    if (!map) {
      map = new Map();
      this.readVersions.set(reader, map);
    }
    const existing = map.get(section) ?? 0;
    if (version > existing) map.set(section, version);
  }
}
