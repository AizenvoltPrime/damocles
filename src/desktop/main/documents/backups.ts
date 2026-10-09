import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { renameWithRetry } from '../../../core/config/json-config-write';
import { isRelativeFilePath } from '../../../shared/relative-path';
import { settlePending } from '../../../shared/settle-pending';
import type { SettingsFileScope } from '../../../shared/types/messages';
import { MAX_ID_LENGTH, MAX_RELATIVE_PATH_LENGTH } from '../../preload/shell-channels';
import type { TextEncoding } from '../platform/editor-document';
import { savedText, type Backups, type TextDocument } from './document-service';

export const BACKUP_DIR = 'backups';
// VS Code backs a dirty buffer up a second after its last change (workingCopyBackupTracker).
export const BACKUP_DELAY_MS = 1000;
const BACKUP_VERSION = 1;
// Backup ids are main's randomUUIDs; a file named otherwise is not a backup.
const BACKUP_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
// A backup file holds at most a document's text as JSON, escapes included.
const MAX_BACKUP_FILE_BYTES: number = 64 * 1024 * 1024;

export interface BackupRecord {
  readonly backupId: string;
  readonly name: string;
  readonly languageId: string;
  readonly encoding: TextEncoding;
  readonly bom: boolean;
  readonly eol: '\n' | '\r\n';
  readonly text: string;
  // where the buffer belongs: a project file, a settings file, or nothing (untitled)
  readonly target:
    | { readonly kind: 'project'; readonly projectKey: string; readonly relativePath: string }
    // path: the file the buffer was opened from; a restore that finds the scope naming another file drops it
    | { readonly kind: 'settings'; readonly scope: SettingsFileScope; readonly path: string }
    | { readonly kind: 'untitled' }
    // an untitled Search Editor, text in the .code-search form; projectKey is resolved again against the open projects on restore
    | { readonly kind: 'searchEditor'; readonly projectKey?: string };
}

type Log = (line: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseTarget(raw: unknown): BackupRecord['target'] | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = field(raw, 'kind');
  if (kind === 'untitled') return { kind };
  if (kind === 'searchEditor') {
    const projectKey = field(raw, 'projectKey');
    if (projectKey === undefined) return { kind };
    return isBoundedText(projectKey, MAX_ID_LENGTH) ? { kind, projectKey } : undefined;
  }
  if (kind === 'settings') {
    const scope = field(raw, 'scope');
    const filePath = field(raw, 'path');
    if (scope !== 'user' && scope !== 'project' && scope !== 'local') return undefined;
    return typeof filePath === 'string' && filePath.length <= MAX_RELATIVE_PATH_LENGTH && path.isAbsolute(filePath) && !filePath.includes('\0') ? { kind, scope, path: filePath } : undefined;
  }
  if (kind !== 'project') return undefined;
  const projectKey = field(raw, 'projectKey');
  const relativePath = field(raw, 'relativePath');
  return isBoundedText(projectKey, MAX_ID_LENGTH) && isRelativeFilePath(relativePath) ? { kind, projectKey, relativePath } : undefined;
}

/** A backup file's record, or undefined when any field is missing, of the wrong type or out of range. */
export function parseBackup(text: string, backupId: string): BackupRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || field(raw, 'version') !== BACKUP_VERSION || field(raw, 'backupId') !== backupId) return undefined;
  const name = field(raw, 'name');
  const languageId = field(raw, 'languageId');
  const encoding = field(raw, 'encoding');
  const bom = field(raw, 'bom');
  const eol = field(raw, 'eol');
  const body = field(raw, 'text');
  const target = parseTarget(field(raw, 'target'));
  if (!isBoundedText(name, 255) || !isBoundedText(languageId, 64)) return undefined;
  if (encoding !== 'utf8' && encoding !== 'utf16le' && encoding !== 'utf16be') return undefined;
  if (typeof bom !== 'boolean' || (eol !== '\n' && eol !== '\r\n') || typeof body !== 'string' || !target) return undefined;
  return { backupId, name, languageId, encoding, bom, eol, text: body, target };
}

function targetOf(document: TextDocument): BackupRecord['target'] | undefined {
  if (document.untitled && document.searchEditor) {
    const projectKey = document.searchEditor.projectKey;
    return projectKey === undefined ? { kind: 'searchEditor' } : { kind: 'searchEditor', projectKey };
  }
  if (document.untitled) return { kind: 'untitled' };
  if (document.settingsScope !== undefined && document.location) return { kind: 'settings', scope: document.settingsScope, path: document.location.path };
  const location = document.location;
  if (location?.projectKey !== undefined && location.relativePath !== undefined) {
    return { kind: 'project', projectKey: location.projectKey, relativePath: location.relativePath };
  }
  return undefined;
}

/**
 * Hot exit: each dirty buffer is written to `<userData>/backups/<backupId>.json` a second after its last change,
 * through a temp file renamed into place, so a crash leaves the old backup or the new one, never a torn one.
 */
export class BackupStore implements Backups {
  private readonly dir: string;
  private readonly log: Log;
  private readonly delayMs: number;
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; document: TextDocument }>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(userDataDir: string, log: Log, delayMs: number = BACKUP_DELAY_MS) {
    this.dir = path.join(userDataDir, BACKUP_DIR);
    this.log = log;
    this.delayMs = delayMs;
  }

  changed(document: TextDocument, now = false): void {
    if (!targetOf(document)) return;
    const pending = this.timers.get(document.backupId);
    if (pending) clearTimeout(pending.timer);
    if (now) {
      this.timers.delete(document.backupId);
      this.write(document);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(document.backupId);
      this.write(document);
    }, this.delayMs);
    this.timers.set(document.backupId, { timer, document });
  }

  writeNow(document: TextDocument): Promise<void> {
    this.changed(document, true);
    return this.writes.get(document.backupId) ?? Promise.resolve();
  }

  remove(backupId: string): void {
    const pending = this.timers.get(backupId);
    if (pending) clearTimeout(pending.timer);
    this.timers.delete(backupId);
    this.chain(backupId, async () => {
      await fs.rm(this.fileOf(backupId), { force: true });
    });
  }

  /** Writes every pending backup now and settles once every write and removal, one queued meanwhile included, has landed; quit awaits it. */
  async flush(): Promise<void> {
    for (const [backupId, { timer, document }] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(backupId);
      this.write(document);
    }
    await settlePending(() => this.writes.values());
  }

  /** Every readable backup, at launch before any write; a malformed file is logged and left alone. */
  async list(): Promise<BackupRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const records: BackupRecord[] = [];
    for (const name of names) {
      // A temp file is a write a crash cut short; the backup it would have replaced is still whole.
      if (name.endsWith('.tmp')) {
        await fs.rm(path.join(this.dir, name), { force: true });
        continue;
      }
      const backupId = BACKUP_FILE.exec(name)?.[1];
      if (backupId === undefined) continue;
      const file = path.join(this.dir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_BACKUP_FILE_BYTES) {
        this.log(`[backups] ignoring ${name}: not a backup file`);
        continue;
      }
      const record = parseBackup(await fs.readFile(file, 'utf8'), backupId);
      if (record) records.push(record);
      else this.log(`[backups] ignoring malformed ${name}`);
    }
    return records;
  }

  private write(document: TextDocument): void {
    const target = targetOf(document);
    if (!target) return;
    const record = {
      version: BACKUP_VERSION,
      backupId: document.backupId,
      name: document.name,
      languageId: document.languageId,
      encoding: document.encoding,
      bom: document.bom,
      eol: document.eol,
      text: savedText(document),
      target,
    };
    this.chain(document.backupId, async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const temp = path.join(this.dir, `${document.backupId}.${randomBytes(6).toString('hex')}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temp, this.fileOf(document.backupId));
    });
  }

  // One backup's writes and removal run in order, so a removal never lands before a write it follows.
  private chain(backupId: string, step: () => Promise<void>): void {
    const previous = this.writes.get(backupId) ?? Promise.resolve();
    const next = previous.then(step).catch((err: unknown) => {
      this.log(`[backups] ${backupId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.writes.set(backupId, next);
    void next.then(() => {
      if (this.writes.get(backupId) === next) this.writes.delete(backupId);
    });
  }

  private fileOf(backupId: string): string {
    return path.join(this.dir, `${backupId}.json`);
  }
}
