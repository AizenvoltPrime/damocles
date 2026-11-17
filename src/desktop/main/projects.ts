import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { OpenFolder } from '../../platform/workspace-folders';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../core/config/json-config-write';
import { folderKey } from '../../core/workspace-folders/folder-key';

const SCHEMA_VERSION = 1;
export const PROJECTS_FILE = 'projects.json';
// the relocations whose host part this list records as applied, the latest kept
export const MAX_RELOCATED = 200;

interface ListFile {
  readonly projects: readonly string[];
  // ids of the relocations whose host part changed this list, oldest first; an older version reads no such field
  readonly relocated: readonly string[];
}

function parseProjects(text: string): ListFile {
  const parsed = JSON.parse(text) as { version?: unknown; projects?: unknown; relocated?: unknown } | null;
  if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.projects)) throw new Error('unknown schema');
  const projects = (parsed.projects as unknown[]).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));
  const relocated = Array.isArray(parsed.relocated) ? [...new Set((parsed.relocated as unknown[]).filter((entry): entry is string => typeof entry === 'string'))].slice(-MAX_RELOCATED) : [];
  return { projects, relocated };
}

/**
 * The ordered, persisted project list; each project is an absolute folder path, unique by folderKey. It also records which
 * relocations' host parts it took, since core's journal is every app's and cannot say which of them applied one.
 */
export class ProjectList {
  private readonly filePath: string;
  private file: ListFile = { projects: [], relocated: [] };
  private readonly listeners = new Set<() => void>();

  constructor(userDataDir: string, log: (line: string) => void) {
    this.filePath = path.join(userDataDir, PROJECTS_FILE);
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return;
    try {
      const seen = new Set<string>();
      const parsed = parseProjects(text);
      this.file = {
        projects: parsed.projects.filter((project) => {
          const key = folderKey(project);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
        relocated: parsed.relocated,
      };
    } catch (err) {
      log(`[projects] ignoring ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  folders(): readonly OpenFolder[] {
    return this.file.projects.map((fsPath) => ({ fsPath, name: path.basename(fsPath) || fsPath }));
  }

  has(folderPath: string): boolean {
    const key = folderKey(folderPath);
    return this.file.projects.some((project) => folderKey(project) === key);
  }

  /** Whether a relocation's host part changed this list, as recorded by the write that changed it. */
  relocated(id: string): boolean {
    return this.file.relocated.includes(id);
  }

  /** Appends the folder; resolves false when it is already in the list. */
  async add(folderPath: string): Promise<boolean> {
    if (!path.isAbsolute(folderPath)) throw new Error(`Project path must be absolute: ${folderPath}`);
    if (this.has(folderPath)) return false;
    const key = folderKey(folderPath);
    return this.changeList((projects) => (projects.some((project) => folderKey(project) === key) ? projects : [...projects, folderPath]));
  }

  async remove(folderPath: string): Promise<void> {
    if (!this.has(folderPath)) return;
    const key = folderKey(folderPath);
    await this.changeList((projects) => {
      const next = projects.filter((project) => folderKey(project) !== key);
      return next.length === projects.length ? projects : next;
    });
  }

  /**
   * A relocated project: `to` takes `from`'s place in the order, or, when `to` is listed already (a merge), `from` leaves the
   * list; the same write records the relocation `id` as applied. Resolves whether the list changed; a second call changes
   * nothing.
   */
  async relocate(from: string, to: string, id: string): Promise<boolean> {
    if (!path.isAbsolute(to)) throw new Error(`Project path must be absolute: ${to}`);
    const fromKey = folderKey(from);
    const toKey = folderKey(to);
    return this.change((file) => {
      const relocated = file.relocated.includes(id) ? file.relocated : [...file.relocated, id].slice(-MAX_RELOCATED);
      const at = file.projects.findIndex((project) => folderKey(project) === fromKey);
      const projects = at < 0
        ? file.projects
        : file.projects.some((project) => folderKey(project) === toKey)
          ? file.projects.filter((_, index) => index !== at)
          : file.projects.map((project, index) => (index === at ? to : project));
      return projects === file.projects && relocated === file.relocated ? file : { projects, relocated };
    });
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private changeList(apply: (projects: readonly string[]) => readonly string[]): Promise<boolean> {
    return this.change((file) => {
      const projects = apply(file.projects);
      return projects === file.projects ? file : { ...file, projects: [...projects] };
    });
  }

  // Applied inside the serialised write and kept only once it has landed; resolves whether the list changed, which the
  // listeners hear.
  private async change(apply: (file: ListFile) => ListFile): Promise<boolean> {
    let next: ListFile = this.file;
    await writeJsonConfig(this.filePath, () => {
      next = apply(this.file);
      return `${JSON.stringify({ version: SCHEMA_VERSION, projects: next.projects, ...(next.relocated.length > 0 ? { relocated: next.relocated } : {}) }, null, 2)}\n`;
    });
    if (next === this.file) return false;
    const listChanged = next.projects !== this.file.projects;
    this.file = next;
    if (listChanged) for (const listener of [...this.listeners]) listener();
    return listChanged;
  }
}
