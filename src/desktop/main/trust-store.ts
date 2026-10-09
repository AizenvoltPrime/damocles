import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../core/config/json-config-write';
import { folderKey } from '../../core/workspace-folders/folder-key';
import type { AskMessage } from './message-dialog';

const SCHEMA_VERSION = 1;
export const TRUST_FILE = 'trusted-folders.json';

export type Translate = (message: string, ...args: string[]) => string;

function parseFolders(text: string): string[] {
  const parsed = JSON.parse(text) as { version?: unknown; folders?: unknown } | null;
  if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.folders)) throw new Error('unknown schema');
  return (parsed.folders as unknown[]).filter((entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry));
}

/**
 * The folders whose authors the user trusts, persisted under userData. A folder is trusted only by exact
 * folderKey match: trusting a parent never trusts a child.
 */
export class TrustStore {
  private readonly filePath: string;
  private readonly trusted = new Map<string, string>();
  private readonly grantListeners = new Set<(folderPaths: readonly string[]) => void>();
  private readonly prompts = new Map<string, Promise<boolean>>();
  private readonly ask: AskMessage;
  private readonly t: Translate;
  private readonly log: (line: string) => void;

  constructor(userDataDir: string, ask: AskMessage, t: Translate, log: (line: string) => void) {
    this.filePath = path.join(userDataDir, TRUST_FILE);
    this.ask = ask;
    this.t = t;
    this.log = log;
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text === undefined) return;
    // An unreadable allowlist trusts nothing; the file is rewritten on the next grant.
    try {
      for (const folder of parseFolders(text)) this.trusted.set(folderKey(folder), folder);
    } catch (err) {
      log(`[trust] ignoring ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  isTrusted(folderPath: string): boolean {
    return this.trusted.has(folderKey(folderPath));
  }

  onDidGrant(listener: (folderPaths: readonly string[]) => void): Disposable {
    this.grantListeners.add(listener);
    return { dispose: () => { this.grantListeners.delete(listener); } };
  }

  async grant(folderPath: string): Promise<void> {
    const key = folderKey(folderPath);
    if (this.trusted.has(key)) return;
    await writeJsonConfig(this.filePath, () => {
      const folders = this.trusted.has(key) ? [...this.trusted.values()] : [...this.trusted.values(), folderPath];
      return `${JSON.stringify({ version: SCHEMA_VERSION, folders }, null, 2)}\n`;
    });
    // Trusted in memory only once the allowlist on disk says so, so a failed write leaves the grant retryable.
    if (this.trusted.has(key)) return;
    this.trusted.set(key, folderPath);
    this.log(`[trust] granted ${folderPath}`);
    for (const listener of [...this.grantListeners]) listener([folderPath]);
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }

  /** Asks once per pending request; resolves whether the folder is trusted afterwards. */
  requestTrust(folderPath: string): Promise<boolean> {
    if (this.isTrusted(folderPath)) return Promise.resolve(true);
    const key = folderKey(folderPath);
    const pending = this.prompts.get(key);
    if (pending) return pending;
    const prompt = this.prompt(folderPath).finally(() => this.prompts.delete(key));
    this.prompts.set(key, prompt);
    return prompt;
  }

  // Don't Trust is Cancel and takes focus first, so neither Enter nor Escape grants trust.
  private async prompt(folderPath: string): Promise<boolean> {
    const chosen = await this.ask({
      severity: 'warning',
      message: this.t('Do you trust the authors of the files in {0}?', folderPath),
      detail: this.t('Damocles loads a trusted folder\'s own instructions, skills, hooks, MCP servers, subagents, permission rules and settings. Until you trust it, only your user-level configuration applies there. Trusting this folder does not trust its subfolders.'),
      actions: [this.t('Trust Folder')],
      cancelLabel: this.t('Don\'t Trust'),
    });
    if (chosen !== 0) {
      this.log(`[trust] declined ${folderPath}`);
      return false;
    }
    await this.grant(folderPath);
    return true;
  }
}
