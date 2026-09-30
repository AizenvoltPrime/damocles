import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { OpenFolder } from '../../platform/workspace-folders';
import { writeJsonConfig } from '../../core/config/json-config-write';
import { folderKey } from '../../core/workspace-folders/folder-key';

const SCHEMA_VERSION = 1;
export const PROJECTS_FILE = 'projects.json';

function parseProjects(text: string): string[] {
  const parsed = JSON.parse(text) as { version?: unknown; projects?: unknown } | null;
  if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.projects)) throw new Error('unknown schema');
  return (parsed.projects as unknown[]).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));
}

/** The ordered, persisted project list; each project is an absolute folder path, unique by folderKey. */
export class ProjectList {
  private readonly filePath: string;
  private projects: string[] = [];
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
      this.projects = parseProjects(text).filter((project) => {
        const key = folderKey(project);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (err) {
      log(`[projects] ignoring ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  folders(): readonly OpenFolder[] {
    return this.projects.map((fsPath) => ({ fsPath, name: path.basename(fsPath) || fsPath }));
  }

  has(folderPath: string): boolean {
    const key = folderKey(folderPath);
    return this.projects.some((project) => folderKey(project) === key);
  }

  /** Appends the folder; resolves false when it is already in the list. */
  async add(folderPath: string): Promise<boolean> {
    if (!path.isAbsolute(folderPath)) throw new Error(`Project path must be absolute: ${folderPath}`);
    if (this.has(folderPath)) return false;
    const key = folderKey(folderPath);
    return this.change((projects) => (projects.some((project) => folderKey(project) === key) ? projects : [...projects, folderPath]));
  }

  async remove(folderPath: string): Promise<void> {
    if (!this.has(folderPath)) return;
    const key = folderKey(folderPath);
    await this.change((projects) => {
      const next = projects.filter((project) => folderKey(project) !== key);
      return next.length === projects.length ? projects : next;
    });
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  // Applied inside the serialised write and kept only once it has landed; resolves whether the list changed.
  private async change(apply: (projects: readonly string[]) => readonly string[]): Promise<boolean> {
    let next: readonly string[] = this.projects;
    await writeJsonConfig(this.filePath, () => {
      next = apply(this.projects);
      return `${JSON.stringify({ version: SCHEMA_VERSION, projects: next }, null, 2)}\n`;
    });
    if (next === this.projects) return false;
    this.projects = [...next];
    for (const listener of [...this.listeners]) listener();
    return true;
  }
}
