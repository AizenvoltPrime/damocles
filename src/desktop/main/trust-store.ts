import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { TrustChange } from '../../platform/trust-service';
import { jsonConfigWritesSettled, writeJsonConfig } from '../../core/config/json-config-write';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { isEmptyTrustChange, mergeTrustChanges, workingFolderTrust } from '../local-services/working-folder-trust';
import type { AskMessage } from './message-dialog';

const SCHEMA_VERSION = 1;
export const TRUST_FILE = 'trusted-folders.json';

export type Translate = (message: string, ...args: string[]) => string;

/** A trust question's answer; `undo` takes back the grant this call's own prompt made, and exists only then. */
export interface TrustAnswer {
  readonly trusted: boolean;
  readonly undo?: () => Promise<void>;
}

// granted: this prompt's grant trusted it; trusted: it was trusted by the time the grant ran
export type PromptOutcome = 'granted' | 'trusted' | 'declined';

// A question still open; joined: another call waits on its answer, which an undo would take from it.
export interface PendingPrompt {
  readonly outcome: Promise<PromptOutcome>;
  joined: boolean;
}

/** Runs `run`; when it throws, a trust answer's undo runs first, and an undo that fails throws beside the error. */
export async function undoOnThrow<T>(undo: TrustAnswer['undo'], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    try {
      await undo?.();
    } catch (undoErr) {
      throw new AggregateError([err, undoErr], `${messageOf(err)} (the folder's trust was not taken back: ${messageOf(undoErr)})`);
    }
    throw err;
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The worktree registry as trust reads it: live chat records only, never adopted or deleted ones.
export interface TrustWorktrees {
  // the project of the live chat worktree whose working folder this is
  projectOf(folder: string): string | undefined;
  // the working folder of every live chat worktree
  liveWorkingFolders(): readonly string[];
  onDidChange(listener: () => void): Disposable;
}

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
  private readonly listeners = new Set<(change: TrustChange) => void>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly ask: AskMessage;
  private readonly t: Translate;
  private readonly log: (line: string) => void;
  private worktrees: TrustWorktrees | undefined;
  private readonly workingFolders = workingFolderTrust(() => this.worktrees?.liveWorkingFolders() ?? [], (folder) => this.isTrusted(folder), (folder) => this.trusted.has(folderKey(folder)));

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

  /**
   * Lets a live chat worktree's working folder answer with its project's trust (AD12 Identity, slice 12a rule 8); a registry
   * change that changes a working folder's answer fires onDidChange naming it.
   */
  setWorktrees(worktrees: TrustWorktrees): Disposable {
    this.worktrees = worktrees;
    const fireWorkingFolders = (): void => {
      const change = this.workingFolders();
      if (!isEmptyTrustChange(change)) this.fire(change);
    };
    fireWorkingFolders();
    return worktrees.onDidChange(fireWorkingFolders);
  }

  isTrusted(folderPath: string): boolean {
    if (this.trusted.has(folderKey(folderPath))) return true;
    const project = this.worktrees?.projectOf(folderPath);
    return project !== undefined && this.trusted.has(folderKey(project));
  }

  /** The allowlist's folders, as granted. */
  trustedFolders(): readonly string[] {
    return [...this.trusted.values()];
  }

  onDidChange(listener: (change: TrustChange) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Resolves whether this call trusted the folder; false when it was trusted already. */
  async grant(folderPath: string): Promise<boolean> {
    const key = folderKey(folderPath);
    if (this.trusted.has(key)) return false;
    await writeJsonConfig(this.filePath, () => {
      const folders = this.trusted.has(key) ? [...this.trusted.values()] : [...this.trusted.values(), folderPath];
      return `${JSON.stringify({ version: SCHEMA_VERSION, folders }, null, 2)}\n`;
    });
    // Trusted in memory only once the allowlist on disk says so, so a failed write leaves the grant retryable.
    if (this.trusted.has(key)) return false;
    this.trusted.set(key, folderPath);
    this.log(`[trust] granted ${folderPath}`);
    this.fire(mergeTrustChanges({ granted: [folderPath], revoked: [] }, this.workingFolders()));
    return true;
  }

  /** Trusted no more, by exact folderKey; a no-op for a folder not trusted. */
  async revoke(folderPath: string): Promise<void> {
    const key = folderKey(folderPath);
    const granted = this.trusted.get(key);
    if (granted === undefined) return;
    await writeJsonConfig(this.filePath, () => {
      const folders = [...this.trusted].filter(([trustedKey]) => trustedKey !== key).map(([, folder]) => folder);
      return `${JSON.stringify({ version: SCHEMA_VERSION, folders }, null, 2)}\n`;
    });
    // untrusted in memory only once the allowlist on disk says so, as grant does
    this.trusted.delete(key);
    this.log(`[trust] revoked ${folderPath}`);
    this.fire(mergeTrustChanges({ granted: [], revoked: [granted] }, this.workingFolders()));
  }

  private fire(change: TrustChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  /** Settles once every write to the file, one queued meanwhile included, has landed or failed; a quit awaits it. */
  flush(): Promise<void> {
    return jsonConfigWritesSettled(this.filePath);
  }

  /** Resolves whether the folder is trusted afterwards. */
  async requestTrust(folder: string): Promise<boolean> {
    return (await this.askTrust(folder)).trusted;
  }

  /**
   * Asks once per pending request. A call that found the folder trusted, or joined another call's pending question, gets no
   * undo; the call whose question granted it gets one, which revokes that grant, unless another call joined the question.
   */
  async askTrust(folder: string): Promise<TrustAnswer> {
    if (this.isTrusted(folder)) return { trusted: true };
    // a working folder's trust is its project's, so the question names the project
    const folderPath = this.worktrees?.projectOf(folder) ?? folder;
    const key = folderKey(folderPath);
    const pending = this.prompts.get(key);
    if (pending) {
      pending.joined = true;
      return { trusted: (await pending.outcome) !== 'declined' };
    }
    const prompt: PendingPrompt = { outcome: this.prompt(folderPath).finally(() => this.prompts.delete(key)), joined: false };
    this.prompts.set(key, prompt);
    const outcome = await prompt.outcome;
    return outcome === 'granted' && !prompt.joined ? { trusted: true, undo: () => this.revoke(folderPath) } : { trusted: outcome !== 'declined' };
  }

  // Don't Trust is Cancel and takes focus first, so neither Enter nor Escape grants trust.
  private async prompt(folderPath: string): Promise<PromptOutcome> {
    const chosen = await this.ask({
      severity: 'warning',
      message: this.t('Do you trust the authors of the files in {0}?', folderPath),
      detail: this.t('Damocles loads a trusted folder\'s own instructions, skills, hooks, MCP servers, subagents, permission rules and settings. Until you trust it, only your user-level configuration applies there. Trusting this folder does not trust its subfolders.'),
      actions: [this.t('Trust Folder')],
      cancelLabel: this.t('Don\'t Trust'),
    });
    if (chosen !== 0) {
      this.log(`[trust] declined ${folderPath}`);
      return 'declined';
    }
    return (await this.grant(folderPath)) ? 'granted' : 'trusted';
  }
}
