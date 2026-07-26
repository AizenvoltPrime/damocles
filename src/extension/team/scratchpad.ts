import type { ScratchpadEntry } from './types';

/**
 * Ring capacity for an append-only section. Each append re-persists and re-emits the entire section, so
 * an unbounded ledger is quadratic in append count and unbounded in JSONL/webview payload size.
 */
export const MAX_APPEND_ONLY_ENTRIES = 200;

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
  reason: 'non-owner-overwrite' | 'immutable-section';
  timestamp: number;
}

export class Scratchpad {
  private readonly sections = new Map<string, ScratchpadEntry>();
  private readonly subscribers: Array<(entry: ScratchpadEntry) => void> = [];
  private readonly rejectionSubscribers: Array<(rejection: ScratchpadRejection) => void> = [];
  // readVersions is in-memory only; teams are ephemeral per-run and not restored on session reload.
  private readonly readVersions = new Map<string, Map<string, number>>();
  // System-owned sections that no agent (not even a second `system` write) may overwrite.
  private readonly locked = new Set<string>();
  // System-seeded sections every agent may APPEND to (the verification ledger). Distinct from both other
  // kinds: `set()` rejects a non-owner and `seedImmutable` rejects everyone, but a shared ledger needs
  // many writers. Append is the only mutation path — single-owner enforcement on normal sections is
  // untouched, because that guard is what keeps parallel specialists from clobbering each other.
  private readonly appendOnly = new Set<string>();

  /**
   * Seed a system-owned, immutable section (e.g. the authoritative `mission-brief`) before any agent
   * runs: writes version 1, records the author-read, fires `subscribers` (so the runner persists +
   * broadcasts it), then locks the section so every subsequent `set()` is rejected.
   */
  seedImmutable(section: string, content: string, author = 'system'): void {
    const entry: ScratchpadEntry = {
      section,
      content,
      author,
      version: 1,
      timestamp: Date.now(),
    };
    this.sections.set(section, entry);
    this.recordRead(author, section, 1);
    this.notifySubscribers(entry);
    this.locked.add(section);
  }

  /**
   * Seed an empty, system-owned APPEND-ONLY section (the `verification` ledger) before any agent runs.
   * Unlike `seedImmutable` it does not lock the section against writes — it routes them: `appendTo` is
   * open to every agent, while `set()` rejects the section outright, so no agent can replace the ledger
   * wholesale. Fires `subscribers` like every other mutation so the runner persists + streams it.
   */
  seedAppendOnly(section: string, author = 'system'): void {
    const entry: ScratchpadEntry = {
      section,
      content: '',
      author,
      version: 1,
      timestamp: Date.now(),
    };
    this.sections.set(section, entry);
    this.recordRead(author, section, 1);
    this.notifySubscribers(entry);
    this.appendOnly.add(section);
  }

  /**
   * Append one entry to an append-only section. Every agent may append; nothing is ever overwritten, so
   * two agents appending in sequence both land. The section's `author` stays `system` (it is shared, not
   * owned) while the appending agent is recorded in the entry text it supplies.
   *
   * Bounded as a ring (oldest entries drop first, like `MessageBus.appendMessage`) because every append
   * re-persists and re-emits the WHOLE cumulative section: cost is quadratic in append count, and the
   * point of the ledger is a long session with many recorded runs. Trimming from the head keeps the
   * recent entries, which are the ones a redundancy check keys on — an old entry is stale by fingerprint
   * anyway.
   */
  appendTo(section: string, content: string, author: string): { version: number } {
    const existing = this.sections.get(section);
    if (!existing || !this.appendOnly.has(section)) {
      throw new Error(`Section "${section}" is not an append-only section.`);
    }
    const version = existing.version + 1;
    const lines = existing.content ? [...existing.content.split('\n'), content] : [content];
    const entry: ScratchpadEntry = {
      section,
      content: lines.slice(-MAX_APPEND_ONLY_ENTRIES).join('\n'),
      author: existing.author,
      version,
      timestamp: Date.now(),
    };
    this.sections.set(section, entry);
    this.recordRead(author, section, version);
    this.notifySubscribers(entry);
    return { version };
  }

  /** Whether a section is the shared append-only ledger rather than a normal single-owner section. */
  isAppendOnly(section: string): boolean {
    return this.appendOnly.has(section);
  }

  set(section: string, content: string, author: string): { version: number } {
    // Before the owner check, not after: the owner of an append-only section is the literal string
    // `system`, and nothing reserves that name in the lead's `create_team` roster — so an agent named
    // `system` would otherwise pass the owner check and replace the ledger wholesale. A ledger that can
    // be silently rewritten is worthless as evidence, which is the one thing it exists to be.
    if (this.appendOnly.has(section)) {
      throw new Error(
        `Section "${section}" is append-only and cannot be overwritten — record entries via team_record_verification.`,
      );
    }
    if (this.locked.has(section)) {
      const existing = this.sections.get(section);
      const rejection: ScratchpadRejection = {
        section,
        attemptedBy: author,
        owner: existing?.author ?? 'system',
        reason: 'immutable-section',
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
        `Section "${section}" is a system-owned, immutable section and cannot be overwritten. ` +
        `It is the authoritative source of truth — write your contribution to a separate section you own.`
      );
    }
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
    this.notifySubscribers(entry);
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

  private notifySubscribers(entry: ScratchpadEntry): void {
    for (const cb of this.subscribers) {
      try {
        cb(entry);
      } catch (err) {
        console.error('[Scratchpad] Subscriber error:', err);
      }
    }
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
