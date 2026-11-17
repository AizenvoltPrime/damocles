import { PRESENCE_TIMEOUT_MS, type FolderPresence, type PathPresence } from '../../core/workspace-folders/folder-presence-probe';

// A project's folder as main last found it: there, gone (moved, renamed or deleted), or on a drive, share, WSL distro or mount
// that is not there or did not answer in time.
export type ProjectPresence = FolderPresence;

/**
 * A host path's presence by its workspace's `isDirectory`, within PRESENCE_TIMEOUT_MS: a request still running then is
 * cancelled and reads as unreachable, as a local stat past its deadline does.
 */
export async function remotePathPresence(isDirectory: (signal: AbortSignal) => Promise<boolean>, timeoutMs: number = PRESENCE_TIMEOUT_MS): Promise<PathPresence> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), timeoutMs);
  });
  try {
    const found = await Promise.race([isDirectory(controller.signal), expired]);
    if (found !== 'expired') return found ? 'directory' : 'missing';
    controller.abort();
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

export interface CheckedProject {
  readonly key: string;
  readonly fsPath: string;
}

export interface ProjectPresencesDeps {
  readonly presence: (project: CheckedProject) => Promise<ProjectPresence>;
  // a project's presence changed; `previous` is 'present' for a project checked for the first time
  readonly changed: (key: string, presence: ProjectPresence, previous: ProjectPresence) => void;
}

/** Each listed project's presence. A project never checked, and any other key, reads as present. */
export class ProjectPresences {
  private readonly deps: ProjectPresencesDeps;
  private readonly presences = new Map<string, ProjectPresence>();
  // per project, its latest check's id; an answer counts only if no later check of it started
  private readonly checks = new Map<string, number>();
  // projects checked again after a late answer since their last other check, which no later late answer checks again
  private readonly lateChecked = new Set<string>();
  private lastCheck = 0;

  constructor(deps: ProjectPresencesDeps) {
    this.deps = deps;
  }

  of(key: string): ProjectPresence {
    return this.presences.get(key) ?? 'present';
  }

  absent(key: string): boolean {
    return this.of(key) !== 'present';
  }

  /** The listed projects: each new one is checked, and each other one `again` selects; any project not listed is forgotten. */
  sync(projects: readonly CheckedProject[], again: (project: CheckedProject) => boolean = () => true): Promise<readonly string[]> {
    const listed = new Set(projects.map((project) => project.key));
    for (const key of [...this.checks.keys()]) {
      if (listed.has(key)) continue;
      this.checks.delete(key);
      this.presences.delete(key);
      this.lateChecked.delete(key);
    }
    return this.check(projects.filter((project) => !this.checks.has(project.key) || again(project)));
  }

  /** Checks these projects again; resolves, once every answer is in, to the keys that came back present. */
  check(projects: readonly CheckedProject[]): Promise<readonly string[]> {
    for (const { key } of projects) this.lateChecked.delete(key);
    return this.run(projects);
  }

  /**
   * Checks an unavailable project once more after a stat its check gave up on answered: a WSL distro that took longer than the
   * deadline to start, say. Until another check of it runs, a later late answer checks it no more.
   */
  answeredLate(project: CheckedProject): Promise<readonly string[]> {
    if (this.of(project.key) !== 'unavailable' || this.lateChecked.has(project.key)) return Promise.resolve([]);
    this.lateChecked.add(project.key);
    return this.run([project]);
  }

  private async run(projects: readonly CheckedProject[]): Promise<readonly string[]> {
    const cameBack: string[] = [];
    await Promise.all(projects.map(async ({ key, fsPath }) => {
      const id = ++this.lastCheck;
      this.checks.set(key, id);
      const presence = await this.deps.presence({ key, fsPath });
      if (this.checks.get(key) !== id) return;
      const previous = this.of(key);
      if (presence === 'present') this.presences.delete(key);
      else this.presences.set(key, presence);
      if (presence === previous) return;
      if (presence === 'present') cameBack.push(key);
      this.deps.changed(key, presence, previous);
    }));
    return cameBack;
  }
}
