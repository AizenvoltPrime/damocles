import { promises as fs } from 'node:fs';
import { writeJsonConfig } from '../config/json-config-write';

// One JSON file of <userData>/forge/ (servers.json, accounts.json, bindings.json): written through writeJsonConfig with mode
// 0600, memory changed only after the write landed. A file that does not parse keeps its last records and refuses writes for
// the rest of the run (docs/invariants.md "GitHub and GitLab accounts", storage).

export const FORGE_FILE_MODE = 0o600;
export const FORGE_DIR_MODE = 0o700;

/** A write refused because the file did not parse in this run. */
export class ForgeFileBrokenError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`${filePath} does not parse; Damocles changes nothing in it until it restarts`);
    this.name = 'ForgeFileBrokenError';
    this.filePath = filePath;
  }
}

/** A change refused before the write because the file would not parse with it. */
export class ForgeFileInvalidChangeError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`${filePath} would not parse after this change; nothing was written`);
    this.name = 'ForgeFileInvalidChangeError';
    this.filePath = filePath;
  }
}

export interface ForgeFile<T> {
  readonly filePath: string;
  /** The last records read or written. */
  value(): T;
  /** True once the file failed to parse in this run. */
  broken(): boolean;
  load(): Promise<void>;
  /**
   * Writes mutate's result over the file's current records and returns it; rejects with ForgeFileBrokenError when broken,
   * and with ForgeFileInvalidChangeError, writing nothing, when the result would not parse.
   */
  update(mutate: (current: T) => T): Promise<T>;
}

export interface ForgeFileOptions<T> {
  readonly filePath: string;
  /** The records in a parsed JSON value, or undefined when it is not this file's shape. */
  readonly parse: (raw: unknown) => T | undefined;
  readonly empty: T;
  readonly log: (line: string) => void;
}

export function createForgeFile<T>(options: ForgeFileOptions<T>): ForgeFile<T> {
  const { filePath, parse, log } = options;
  let current = options.empty;
  let isBroken = false;

  function parseText(text: string): T | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return undefined;
    }
    return parse(raw);
  }

  function markBroken(): ForgeFileBrokenError {
    if (!isBroken) log(`[forge] ${filePath} does not parse; its last records stay and writes are refused for this run`);
    isBroken = true;
    return new ForgeFileBrokenError(filePath);
  }

  return {
    filePath,
    value: () => current,
    broken: () => isBroken,
    async load() {
      let text: string;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      const parsed = parseText(text);
      if (parsed === undefined) {
        markBroken();
        return;
      }
      current = parsed;
    },
    async update(mutate) {
      if (isBroken) throw new ForgeFileBrokenError(filePath);
      let next: T | undefined;
      await writeJsonConfig(filePath, (text) => {
        const onDisk = text === undefined ? options.empty : parseText(text);
        if (onDisk === undefined) throw markBroken();
        next = mutate(onDisk);
        const written = `${JSON.stringify(next, null, 2)}\n`;
        // a record the parser refuses would leave the whole file unreadable at the next start
        if (parseText(written) === undefined) throw new ForgeFileInvalidChangeError(filePath);
        return written;
      }, { fileMode: FORGE_FILE_MODE, dirMode: FORGE_DIR_MODE });
      current = next!;
      return current;
    },
  };
}
