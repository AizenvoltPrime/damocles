// Project files the design tools cite, read only through the host's confinement rule (`platform.confinement`).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileConfinement } from '../../platform/file-confinement';

/** A cited source file is read up to this size. */
export const MAX_CITED_FILE_BYTES: number = 2 * 1024 * 1024;

/** A `file:line` reference split; undefined when it is not one. */
export function parseFileLine(ref: string): { file: string; line: number } | undefined {
  const colon = ref.lastIndexOf(':');
  if (colon <= 0) return undefined;
  const digits = ref.slice(colon + 1);
  if (!/^[1-9][0-9]{0,6}$/.test(digits)) return undefined;
  return { file: ref.slice(0, colon), line: Number(digits) };
}

/** `file` as a '/'-separated path relative to the working folder; undefined for an absolute or empty one. */
export function relativeProjectPath(file: string): string | undefined {
  const slashed = file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (slashed === '' || path.isAbsolute(slashed) || path.win32.isAbsolute(slashed) || slashed.startsWith('/')) return undefined;
  return slashed;
}

/** Reads cited project files once each, confined to the chat's working folder. */
export class ProjectFiles {
  private readonly lines = new Map<string, Promise<string[] | string>>();
  private readonly cwd: string;
  private readonly confinement: FileConfinement;

  constructor(cwd: string, confinement: FileConfinement) {
    this.cwd = cwd;
    this.confinement = confinement;
  }

  /** The real path of project file `file`, or why it cannot be used. */
  async resolve(file: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const relative = relativeProjectPath(file);
    if (!relative) return { ok: false, reason: `${file} is not a path relative to the working folder` };
    const confined = await this.confinement.confineExisting(this.cwd, relative);
    if (!confined.ok) {
      return { ok: false, reason: confined.reason === 'missing' ? `${file} does not exist` : confined.reason === 'outside' ? `${file} is outside the working folder` : `${file} could not be read` };
    }
    return { ok: true, path: confined.path };
  }

  /** The lines of project file `file`, or why it cannot be read. */
  readLines(file: string): Promise<string[] | string> {
    let pending = this.lines.get(file);
    if (!pending) {
      pending = this.read(file);
      this.lines.set(file, pending);
    }
    return pending;
  }

  private async read(file: string): Promise<string[] | string> {
    const resolved = await this.resolve(file);
    if (!resolved.ok) return resolved.reason;
    const stat = await fs.stat(resolved.path);
    if (!stat.isFile()) return `${file} is not a file`;
    if (stat.size > MAX_CITED_FILE_BYTES) return `${file} is larger than ${MAX_CITED_FILE_BYTES} bytes`;
    return (await fs.readFile(resolved.path, 'utf8')).split(/\r?\n/);
  }

  /** Why `ref` is not a `file:line` inside an existing project file, or undefined when it is. `withLine`: the line is required. */
  async checkRef(ref: string, withLine: boolean): Promise<string | undefined> {
    const parsed = parseFileLine(ref);
    if (!parsed && withLine) return `${ref} is not a file:line reference`;
    const file = parsed?.file ?? ref;
    const lines = await this.readLines(file);
    if (typeof lines === 'string') return lines;
    if (parsed && parsed.line > lines.length) return `${ref}: ${file} has only ${lines.length} lines`;
    return undefined;
  }

  /** The text of cited line `ref`, or why there is none. */
  async lineText(ref: string): Promise<{ text: string } | { reason: string }> {
    const parsed = parseFileLine(ref);
    if (!parsed) return { reason: `${ref} is not a file:line reference` };
    const lines = await this.readLines(parsed.file);
    if (typeof lines === 'string') return { reason: lines };
    if (parsed.line > lines.length) return { reason: `${ref}: ${parsed.file} has only ${lines.length} lines` };
    return { text: lines[parsed.line - 1]! };
  }
}
