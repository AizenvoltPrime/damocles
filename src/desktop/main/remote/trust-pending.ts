import type { HostTrustFolder } from './remote-trust';

/**
 * By authority, the folders an Add Project or a Locate asked trust for and still runs on, before the project list or a Locate
 * target names them: the authority's core reads trust only from main's mirror, which lists these while a flow holds them.
 */
export class TrustPending {
  private readonly held = new Map<string, Set<{ readonly folder: HostTrustFolder }>>();
  private readonly changed: (authority: string) => void;

  // changed: the mirror republishes the authority's set
  constructor(changed: (authority: string) => void) {
    this.changed = changed;
  }

  folders(authority: string): HostTrustFolder[] {
    return [...(this.held.get(authority) ?? [])].map((entry) => entry.folder);
  }

  /** Lists the folder until the returned release; each hold is its own, so another flow's release of the same folder keeps it. */
  hold(authority: string, folder: HostTrustFolder): () => void {
    const entry = { folder };
    const entries = this.held.get(authority) ?? new Set();
    entries.add(entry);
    this.held.set(authority, entries);
    this.changed(authority);
    return () => {
      if (!entries.delete(entry)) return;
      if (entries.size === 0 && this.held.get(authority) === entries) this.held.delete(authority);
      this.changed(authority);
    };
  }
}
