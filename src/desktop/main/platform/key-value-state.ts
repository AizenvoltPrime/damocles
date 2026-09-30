import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../../platform/disposable';
import type { KeyValueState, Memento } from '../../../platform/key-value-state';
import { writeJsonConfig } from '../../../core/config/json-config-write';
import { Emitter } from './emitter';

function readValues(filePath: string, log: (line: string) => void): Map<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return new Map(Object.entries(parsed));
  } catch (err) {
    log(`[state] ignoring unreadable ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

// Reads are served from memory; each update rewrites the whole file atomically (temp file + rename), and memory
// changes only once that write has landed.
class JsonFileMemento implements Memento {
  private readonly filePath: string;
  private values: Map<string, unknown>;
  private readonly listeners = new Map<string, Emitter<[]>>();
  private readonly log: (line: string) => void;

  constructor(filePath: string, log: (line: string) => void) {
    this.filePath = filePath;
    this.log = log;
    this.values = readValues(filePath, log);
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    let next = this.values;
    // Built inside the serialised write, so it starts from every update that landed before it.
    await writeJsonConfig(this.filePath, () => {
      next = new Map(this.values);
      // As in VS Code, storing undefined removes the key.
      if (value === undefined) next.delete(key);
      else next.set(key, value);
      return `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`;
    });
    this.values = next;
    this.listeners.get(key)?.fire();
  }

  onDidChange(key: string, listener: () => void): Disposable {
    let emitter = this.listeners.get(key);
    if (!emitter) {
      emitter = new Emitter('state', this.log);
      this.listeners.set(key, emitter);
    }
    return emitter.add(listener);
  }
}

export type StateScope = 'global' | 'workspace';

export interface DesktopKeyValueState extends KeyValueState {
  // Fires after an update of key in this process has been written; the files are private to this app.
  onDidChange(scope: StateScope, key: string, listener: () => void): Disposable;
}

// On desktop the app window is the workspace, so both mementos live under userData/state.
export function createDesktopKeyValueState(userDataDir: string, log: (line: string) => void): DesktopKeyValueState {
  const dir = path.join(userDataDir, 'state');
  const mementos = {
    global: new JsonFileMemento(path.join(dir, 'global.json'), log),
    workspace: new JsonFileMemento(path.join(dir, 'workspace.json'), log),
  };
  return {
    ...mementos,
    onDidChange: (scope, key, listener) => mementos[scope].onDidChange(key, listener),
  };
}
