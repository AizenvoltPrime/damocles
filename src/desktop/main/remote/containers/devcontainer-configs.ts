// The devcontainer configuration each local or SSH project's folder holds, as main publishes it on ShellProject, so the project's
// menu offers Reopen in Container without reading the target while it opens.

export interface DevcontainerConfigsDeps {
  // the configuration's path; null for none
  readonly read: (projectKey: string) => Promise<string | null>;
  // a project's published path changed
  readonly changed: () => void;
  readonly log: (line: string) => void;
}

export class DevcontainerConfigs {
  private readonly deps: DevcontainerConfigsDeps;
  private readonly paths = new Map<string, string>();
  // per tracked project, its latest read's id; an answer counts only if no later read of it started
  private readonly reads = new Map<string, number>();
  private lastRead = 0;

  constructor(deps: DevcontainerConfigsDeps) {
    this.deps = deps;
  }

  get(projectKey: string): string | undefined {
    return this.paths.get(projectKey);
  }

  /** The projects that may reopen in a container now: a new one is read, an unlisted one forgotten. */
  sync(projectKeys: readonly string[]): void {
    const listed = new Set(projectKeys);
    let dropped = false;
    for (const key of [...this.reads.keys()]) {
      if (listed.has(key)) continue;
      this.reads.delete(key);
      if (this.paths.delete(key)) dropped = true;
    }
    if (dropped) this.deps.changed();
    for (const key of projectKeys) if (!this.reads.has(key)) this.read(key);
  }

  /** Reads these tracked projects again: their files or their host's connection changed. */
  refresh(projectKeys: readonly string[]): void {
    for (const key of projectKeys) if (this.reads.has(key)) this.read(key);
  }

  private read(key: string): void {
    const id = ++this.lastRead;
    this.reads.set(key, id);
    this.deps.read(key).then(
      (path) => this.settle(key, id, path),
      (err: unknown) => {
        this.deps.log(`[containers] reading the devcontainer configuration of ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.settle(key, id, null);
      },
    );
  }

  private settle(key: string, id: number, path: string | null): void {
    if (this.reads.get(key) !== id || (this.paths.get(key) ?? null) === path) return;
    if (path === null) this.paths.delete(key);
    else this.paths.set(key, path);
    this.deps.changed();
  }
}
