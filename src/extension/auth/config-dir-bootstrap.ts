import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { log } from "../logger";
import { resolveBundledClaudeBinary } from "./native-binary-resolver";
import { buildSdkEnv } from "./sdk-env";
import {
  CLAUDE_CONFIG_FILENAME,
  CLI_CONFIG_DIR,
  DAMOCLES_ANTHROPIC_GRANT_FILENAME,
  DAMOCLES_CONFIG_DIR,
  DAMOCLES_CREDENTIALS_FILENAME,
} from "./paths";

const PARENT_RESCAN_DEBOUNCE_MS = 500;
const ORPHAN_TMP_PATTERN = /\.tmp\.\d+\.[0-9a-f]+$/;
const CLI_DIR_NAME = path.basename(CLI_CONFIG_DIR);
const RENAME_RETRY_DELAYS_MS = [30, 60, 120, 240];
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const CLI_INIT_TIMEOUT_MS = 8000;

interface BootstrapState {
  parentRescanTimer: NodeJS.Timeout | null;
  parentWatcher: fs.FSWatcher | null;
  homeWatcher: fs.FSWatcher | null;
  cliMirrorEngaged: boolean;
  disposed: boolean;
  warnedOverwritePaths: Set<string>;
  failedMergeSources: Set<string>;
  claudeConfigActivationLogged: boolean;
  claudeConfigLastSeen: "present" | "missing" | "unknown";
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}

/** A transient lock (EBUSY/EPERM/EACCES) — the file/dir is momentarily in use (CLI or Damocles writing
 *  it concurrently). Not a real failure: the merge re-runs on the next sync pass when the lock clears. */
function isTransientLockError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    TRANSIENT_RENAME_ERROR_CODES.has((err as { code?: string }).code ?? '')
  );
}

function getErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function renameWithRetryOnContention(tempPath: string, destination: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tempPath, destination);
      return;
    } catch (err) {
      const code = getErrorCode(err);
      const isTransient = code !== undefined && TRANSIENT_RENAME_ERROR_CODES.has(code);
      if (!isTransient || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/**
 * Initialize `~/.damocles/auth/.claude.json` by invoking the bundled CLI binary
 * in an ephemeral temporary directory and copying the result into the Damocles
 * config dir. The CLI is the canonical source of the file's schema
 * (`firstStartTime`, `userID`, `migrationVersion`, `opusProMigrationComplete`,
 * `sonnet1m45MigrationComplete`); manually seeded shapes are rejected by the SDK.
 *
 * The CLI cannot be run directly in the Damocles dir because it sees the
 * existing `backups/` symlink (pointing at `~/.claude/backups/` which contains
 * SDK-created sentinel backups) and refuses to bootstrap, instead emitting
 * "manually restore from backup" stderr. Running in a fresh tmpdir bypasses
 * that detection — no backups exist there, so the CLI bootstraps freely.
 *
 * `mcp list` is the chosen subcommand because it exits cleanly without user
 * interaction and triggers the CLI's full `.claude.json` initialization as a
 * side-effect of its config-loading step. The MCP-list output itself is
 * discarded (stdio: "ignore"); we only care about the file the CLI writes.
 *
 * Async (cooperative) instead of `spawnSync` so VS Code activation isn't frozen
 * for the duration of the spawn on first install. Env is built via `buildSdkEnv`
 * to inherit the project-wide SDK env-sanitization invariant (strip CLI auth env
 * vars, force-enable PowerShell tool on Windows), then `CLAUDE_CONFIG_DIR` is
 * overridden to point at the tmpdir for this one call.
 *
 * Skips entirely if the file already exists in the Damocles dir.
 */
async function initializeClaudeConfigViaCli(): Promise<void> {
  const claudeConfigPath = path.join(DAMOCLES_CONFIG_DIR, CLAUDE_CONFIG_FILENAME);
  if (fs.existsSync(claudeConfigPath)) return;

  const binary = resolveBundledClaudeBinary();
  if (!binary) {
    log("[auth-bootstrap] cannot initialize %s — bundled Claude binary not resolved", claudeConfigPath);
    return;
  }

  let tmpDir: string;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "damocles-cli-init-"));
  } catch (err) {
    log("[auth-bootstrap] CLI init tmpdir creation failed: %O", err);
    return;
  }

  try {
    const env = buildSdkEnv();
    env["CLAUDE_CONFIG_DIR"] = tmpDir;

    const outcome = await spawnCliForInit(binary, ["mcp", "list"], env);
    if (!outcome.ok) {
      log("[auth-bootstrap] CLI init failed: %s", outcome.reason);
      return;
    }

    const tmpConfig = path.join(tmpDir, CLAUDE_CONFIG_FILENAME);
    if (!fs.existsSync(tmpConfig)) {
      log("[auth-bootstrap] CLI init exited (status=%d) but produced no %s in tmpdir", outcome.exitCode, CLAUDE_CONFIG_FILENAME);
      return;
    }

    fs.copyFileSync(tmpConfig, claudeConfigPath);
    fs.chmodSync(claudeConfigPath, 0o600);
    const size = fs.statSync(claudeConfigPath).size;
    log("[auth-bootstrap] CLI initialized %s via tmpdir bootstrap (%d bytes)", claudeConfigPath, size);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    catch (err) { log("[auth-bootstrap] tmpdir cleanup failed: %O", err); }
  }
}

type CliInitOutcome =
  | { ok: true; exitCode: number }
  | { ok: false; reason: string };

function spawnCliForInit(binary: string, args: string[], env: Record<string, string>): Promise<CliInitOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(binary, args, { env, windowsHide: true, stdio: "ignore" });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: false, reason: `timed out after ${CLI_INIT_TIMEOUT_MS}ms` });
    }, CLI_INIT_TIMEOUT_MS);

    child.once("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn error: ${err instanceof Error ? err.message : String(err)}` });
    });

    child.once("exit", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, exitCode: code ?? -1 });
    });
  });
}

/**
 * Observe `.claude.json` presence and log state transitions across rescans.
 * The SDK uses atomic-write-via-rename + mkdir lockfile to maintain this file
 * once initialized. This helper is observation-only — its purpose is to surface
 * concurrency anomalies (e.g. failed renames leaving the file missing) without
 * per-rescan log spam.
 *
 * Logging policy:
 *   First call (state = "unknown"): one line stating present-with-size or missing
 *   Later calls: silent unless presence flips, in which case one transition line
 */
function observeClaudeConfigState(state: BootstrapState): void {
  const claudeConfigPath = path.join(DAMOCLES_CONFIG_DIR, CLAUDE_CONFIG_FILENAME);

  let stat: fs.Stats | null = null;
  let statError: NodeJS.ErrnoException | null = null;
  try { stat = fs.statSync(claudeConfigPath); }
  catch (err) {
    if (!isEnoent(err)) statError = err as NodeJS.ErrnoException;
  }

  if (!state.claudeConfigActivationLogged) {
    state.claudeConfigActivationLogged = true;
    if (statError) {
      log("[auth-bootstrap] cannot observe %s at activation (%s) — will retry on rescan", claudeConfigPath, statError.code);
      return;
    }
    if (stat) {
      log("[auth-bootstrap] %s present at activation (%d bytes)", claudeConfigPath, stat.size);
      state.claudeConfigLastSeen = "present";
    } else {
      log("[auth-bootstrap] %s missing at activation — SDK will run without persistence", claudeConfigPath);
      state.claudeConfigLastSeen = "missing";
    }
    return;
  }

  if (statError) {
    log("[auth-bootstrap] stat %s failed: %O", claudeConfigPath, statError);
    return;
  }

  const next: "present" | "missing" = stat ? "present" : "missing";
  if (state.claudeConfigLastSeen !== next) {
    log("[auth-bootstrap] %s state changed: %s → %s", claudeConfigPath, state.claudeConfigLastSeen, next);
    state.claudeConfigLastSeen = next;
  }
}

/**
 * Remove a stale `.claude.json.lock/` directory left behind by a crashed SDK subprocess.
 * The SDK uses mkdir-as-mutex with no apparent staleness detection; once orphaned, the
 * lock dir permanently jams every future spawn's atomic-write attempt on `.claude.json`.
 *
 * Safe to call at activation because no SDK subprocess of ours is running yet — any
 * pre-existing lock dir is necessarily from a prior session that crashed or was killed.
 * If the entry is not a directory or does not exist, this is a no-op.
 */
function cleanupStaleClaudeJsonLock(): void {
  const lockPath = path.join(DAMOCLES_CONFIG_DIR, `${CLAUDE_CONFIG_FILENAME}.lock`);

  let stat: fs.Stats;
  try { stat = fs.lstatSync(lockPath); }
  catch (err) {
    if (!isEnoent(err)) log("[auth-bootstrap] cannot stat %s: %O", lockPath, err);
    return;
  }

  if (!stat.isDirectory()) return;

  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    log("[auth-bootstrap] removed stale lock dir %s", lockPath);
  } catch (err) {
    log("[auth-bootstrap] failed to remove stale lock dir %s: %O", lockPath, err);
  }
}

export async function bootstrapDamoclesConfigDir(context: vscode.ExtensionContext): Promise<void> {
  try {
    fs.mkdirSync(DAMOCLES_CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    log("[auth-bootstrap] failed to create %s: %O", DAMOCLES_CONFIG_DIR, err);
    return;
  }

  cleanupOrphanTempFiles();
  cleanupStaleClaudeJsonLock();
  await initializeClaudeConfigViaCli();

  const state: BootstrapState = {
    parentRescanTimer: null,
    parentWatcher: null,
    homeWatcher: null,
    cliMirrorEngaged: false,
    disposed: false,
    warnedOverwritePaths: new Set<string>(),
    failedMergeSources: new Set<string>(),
    claudeConfigActivationLogged: false,
    claudeConfigLastSeen: "unknown",
  };

  context.subscriptions.push({ dispose: () => disposeAll(state) });

  observeClaudeConfigState(state);

  if (fs.existsSync(CLI_CONFIG_DIR)) {
    engageCliMirror(state);
  } else {
    log(
      "[auth-bootstrap] %s does not exist — Damocles will run with defaults; " +
      "watching home directory for CLI install",
      CLI_CONFIG_DIR,
    );
    registerCliAppearanceWatcher(state);
  }
}

function disposeAll(state: BootstrapState): void {
  if (state.disposed) return;
  state.disposed = true;

  if (state.parentRescanTimer) {
    clearTimeout(state.parentRescanTimer);
    state.parentRescanTimer = null;
  }
  if (state.parentWatcher) {
    try { state.parentWatcher.close(); } catch { /* ignore */ }
    state.parentWatcher = null;
  }
  if (state.homeWatcher) {
    try { state.homeWatcher.close(); } catch { /* ignore */ }
    state.homeWatcher = null;
  }
  state.warnedOverwritePaths.clear();
  state.failedMergeSources.clear();
}

function engageCliMirror(state: BootstrapState): void {
  if (state.disposed || state.cliMirrorEngaged) return;
  state.cliMirrorEngaged = true;

  rescan(state);
  registerParentWatcher(state);
}

function disengageCliMirror(state: BootstrapState): void {
  if (state.disposed || !state.cliMirrorEngaged) return;
  log("[auth-bootstrap] %s no longer exists — disengaging mirror and watching for re-install", CLI_CONFIG_DIR);

  if (state.parentRescanTimer) {
    clearTimeout(state.parentRescanTimer);
    state.parentRescanTimer = null;
  }
  if (state.parentWatcher) {
    try { state.parentWatcher.close(); } catch { /* ignore */ }
    state.parentWatcher = null;
  }

  state.cliMirrorEngaged = false;
  registerCliAppearanceWatcher(state);
}

function rescan(state: BootstrapState): void {
  if (state.disposed) return;

  observeClaudeConfigState(state);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(CLI_CONFIG_DIR, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) {
      disengageCliMirror(state);
      return;
    }
    log("[auth-bootstrap] readdir %s failed: %O", CLI_CONFIG_DIR, err);
    return;
  }

  const wantedNames = new Set<string>();

  for (const entry of entries) {
    if (entry.name === DAMOCLES_CREDENTIALS_FILENAME) continue;
    if (entry.name === CLAUDE_CONFIG_FILENAME) continue;
    if (entry.name === DAMOCLES_ANTHROPIC_GRANT_FILENAME) continue;

    const target = path.join(CLI_CONFIG_DIR, entry.name);
    const linkPath = path.join(DAMOCLES_CONFIG_DIR, entry.name);
    wantedNames.add(entry.name);

    if (entry.isDirectory()) {
      linkDirectory(state, target, linkPath);
    } else if (entry.isFile()) {
      mirrorFile(state, target, linkPath);
    }
  }

  removeStaleEntries(state, wantedNames);
}

function warnOverwriteOnce(state: BootstrapState, linkPath: string, message: string, ...args: unknown[]): void {
  if (state.warnedOverwritePaths.has(linkPath)) return;
  state.warnedOverwritePaths.add(linkPath);
  log(message, ...args);
}

function linkDirectory(state: BootstrapState, target: string, linkPath: string): void {
  try {
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(linkPath); }
    catch (err) {
      if (!isEnoent(err)) throw err;
    }

    if (stat) {
      if (stat.isSymbolicLink()) {
        if (symlinkPointsAt(linkPath, target)) return;
        try { fs.unlinkSync(linkPath); }
        catch (err) {
          if (!isEnoent(err)) {
            log("[auth-bootstrap] failed to remove stale link %s: %O", linkPath, err);
            return;
          }
        }
      } else if (stat.isDirectory()) {
        if (state.failedMergeSources.has(linkPath)) return;
        const result = migrateRealDirIntoTarget(linkPath, target);
        if (result.conflict) {
          // Surface the genuine conflict now (deduped) even if a sibling is also busy — a transient
          // lock must not be able to swallow the warning.
          warnOverwriteOnce(
            state,
            linkPath,
            "[auth-bootstrap] %s could not be merged into %s — leaving real directory in place",
            linkPath,
            target,
          );
        }
        if (result.busy) {
          // A concurrent writer still holds part of the dir (e.g. file-history during an active turn).
          // Retry on the next sync once the lock clears; don't latch yet, or a still-mergeable entry
          // sharing the dir with a conflict would be abandoned. The conflict (if any) was warned above
          // and latches on a later pass once nothing is busy.
          return;
        }
        if (result.conflict) {
          state.failedMergeSources.add(linkPath);
          return;
        }
      } else {
        warnOverwriteOnce(
          state,
          linkPath,
          "[auth-bootstrap] %s exists as a non-directory file — refusing to overwrite with directory symlink",
          linkPath,
        );
        return;
      }
    }

    const symlinkType: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(target, linkPath, symlinkType);
    state.warnedOverwritePaths.delete(linkPath);
  } catch (err) {
    log("[auth-bootstrap] symlink %s → %s failed: %O", linkPath, target, err);
  }
}

/**
 * Merge a real directory at `source` into `target`, then remove the now-empty
 * source so the caller can replace it with a symlink pointing at `target`.
 *
 * Used to heal pre-existing state from the era when Damocles's SDK subprocess
 * wrote runtime state (projects/, file-history/, plans/, session-env/) directly
 * into `~/.damocles/auth/*` as real directories. Moving that content into
 * `~/.claude/*` unifies session history between Damocles and the CLI — both
 * tools then read and write through the symlink into the shared CLI store.
 *
 * Merge rules (move, do not overwrite): if a file or directory already exists
 * at the target path, the source version is left in place and the conflict is
 * reported so the caller can fall back to a warning. That preserves any CLI-side
 * data that was created independently and never gets clobbered.
 *
 * `conflict` and `busy` are independent: a single pass can see both (one entry
 * genuinely conflicts while a sibling is momentarily locked). The caller warns on
 * a conflict but only latches it once nothing is still busy — so a coincident
 * transient lock can't suppress the warning, and a coincident conflict can't
 * permanently abandon the still-locked sibling before it gets a chance to merge.
 */
interface MergeResult {
  conflict: boolean;
  busy: boolean;
}

const MERGED: MergeResult = { conflict: false, busy: false };

function migrateRealDirIntoTarget(source: string, target: string): MergeResult {
  if (!fs.existsSync(CLI_CONFIG_DIR)) {
    log(
      "[auth-bootstrap] refusing to merge %s into %s — %s no longer exists",
      source,
      target,
      CLI_CONFIG_DIR,
    );
    return { conflict: true, busy: false };
  }

  try {
    fs.mkdirSync(target, { recursive: false });
  } catch (err) {
    if (!isEexist(err)) {
      if (isTransientLockError(err)) return { conflict: false, busy: true };
      log("[auth-bootstrap] mkdir %s failed during merge: %O", target, err);
      return { conflict: true, busy: false };
    }
  }

  let succeeded = true;
  let sawTransient = false;
  let sawConflict = false;

  // A transient lock isn't a real merge failure — record it, stay quiet, and let the next sync pass
  // retry once the file/dir is no longer in use. Anything else is a genuine conflict worth logging.
  const noteError = (message: string, target_: string, err: unknown): void => {
    succeeded = false;
    if (isTransientLockError(err)) { sawTransient = true; return; }
    sawConflict = true;
    log(message, target_, err);
  };

  const mergeEntry = (srcPath: string, dstPath: string): void => {
    let srcStat: fs.Stats;
    try { srcStat = fs.lstatSync(srcPath); }
    catch (err) {
      noteError("[auth-bootstrap] lstat %s failed during merge: %O", srcPath, err);
      return;
    }

    if (srcStat.isSymbolicLink()) {
      log(
        "[auth-bootstrap] refusing to migrate symlink %s into %s — symlinks in the Damocles mirror should not be promoted into the CLI config dir",
        srcPath,
        dstPath,
      );
      succeeded = false;
      sawConflict = true;
      return;
    }

    let dstStat: fs.Stats | null = null;
    try { dstStat = fs.lstatSync(dstPath); }
    catch (err) {
      if (!isEnoent(err)) {
        noteError("[auth-bootstrap] lstat %s failed during merge: %O", dstPath, err);
        return;
      }
    }

    if (!dstStat) {
      try {
        fs.renameSync(srcPath, dstPath);
      } catch (err) {
        noteError("[auth-bootstrap] rename %s failed during merge: %O", srcPath, err);
      }
      return;
    }

    if (srcStat.isDirectory() && dstStat.isDirectory()) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(srcPath, { withFileTypes: true }); }
      catch (err) {
        noteError("[auth-bootstrap] readdir %s failed during merge: %O", srcPath, err);
        return;
      }

      for (const entry of entries) {
        mergeEntry(path.join(srcPath, entry.name), path.join(dstPath, entry.name));
      }

      try {
        const remaining = fs.readdirSync(srcPath);
        if (remaining.length === 0) fs.rmdirSync(srcPath);
        else succeeded = false;
      } catch (err) {
        noteError("[auth-bootstrap] rmdir %s failed during merge: %O", srcPath, err);
      }
      return;
    }

    if (
      srcStat.isFile() &&
      dstStat.isFile() &&
      srcStat.size === dstStat.size &&
      filesHaveIdenticalContent(srcPath, dstPath)
    ) {
      try {
        fs.unlinkSync(srcPath);
        return;
      } catch (err) {
        noteError("[auth-bootstrap] failed to remove redundant duplicate %s: %O", srcPath, err);
        return;
      }
    }

    log(
      "[auth-bootstrap] merge conflict at %s (target already has %s) — keeping target, leaving source in place",
      dstPath,
      dstStat.isDirectory() ? "directory" : dstStat.isSymbolicLink() ? "symlink" : "file",
    );
    succeeded = false;
    sawConflict = true;
  };

  let topLevel: fs.Dirent[];
  try { topLevel = fs.readdirSync(source, { withFileTypes: true }); }
  catch (err) {
    if (isTransientLockError(err)) return { conflict: false, busy: true };
    log("[auth-bootstrap] readdir %s failed during merge: %O", source, err);
    return { conflict: true, busy: false };
  }

  for (const entry of topLevel) {
    mergeEntry(path.join(source, entry.name), path.join(target, entry.name));
  }

  if (!succeeded) return { conflict: sawConflict, busy: sawTransient };

  try {
    fs.rmdirSync(source);
    log("[auth-bootstrap] merged %s into %s and removed source", source, target);
    return MERGED;
  } catch (err) {
    if (isTransientLockError(err)) return { conflict: false, busy: true };
    log("[auth-bootstrap] rmdir %s failed after merge: %O", source, err);
    return { conflict: true, busy: false };
  }
}

/**
 * Compare two files by SHA-256 of their full contents. Used to detect
 * redundant duplicates during merge — when source and target contain
 * byte-identical data, the source can be safely deleted without data loss.
 * Caller must verify sizes match first (cheap pre-check) so we don't hash
 * obviously-different files.
 */
function filesHaveIdenticalContent(a: string, b: string): boolean {
  try {
    const hashA = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
    const hashB = crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex');
    return hashA === hashB;
  } catch (err) {
    log("[auth-bootstrap] hash comparison %s vs %s failed: %O", a, b, err);
    return false;
  }
}

function symlinkPointsAt(linkPath: string, target: string): boolean {
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

function mirrorFile(state: BootstrapState, target: string, linkPath: string): void {
  let sourceStat: fs.Stats;
  try { sourceStat = fs.statSync(target); }
  catch (err) {
    if (!isEnoent(err)) log("[auth-bootstrap] cannot stat source %s: %O", target, err);
    return;
  }

  let destStat: fs.Stats | null = null;
  try { destStat = fs.lstatSync(linkPath); }
  catch (err) {
    if (!isEnoent(err)) log("[auth-bootstrap] cannot stat dest %s: %O", linkPath, err);
  }

  if (destStat && !destStat.isFile()) {
    warnOverwriteOnce(
      state,
      linkPath,
      "[auth-bootstrap] %s exists as a %s — refusing to overwrite with file mirror",
      linkPath,
      destStat.isSymbolicLink() ? "symlink" : destStat.isDirectory() ? "directory" : "non-file",
    );
    return;
  }

  if (destStat && destStat.size === sourceStat.size && destStat.mtimeMs === sourceStat.mtimeMs) {
    return;
  }

  copyFileAtomic(target, linkPath, sourceStat);
  state.warnedOverwritePaths.delete(linkPath);
}

function copyFileAtomic(source: string, destination: string, sourceStat: fs.Stats): void {
  let tempPath: string | null = null;
  try {
    tempPath = `${destination}.tmp.${process.pid}.${Date.now().toString(16)}${Math.floor(Math.random() * 0x100000).toString(16)}`;
    fs.copyFileSync(source, tempPath);
    try { fs.utimesSync(tempPath, sourceStat.atime, sourceStat.mtime); }
    catch (err) { log("[auth-bootstrap] utimes %s failed (continuing): %O", tempPath, err); }
    renameWithRetryOnContention(tempPath, destination);
    tempPath = null;
  } catch (err) {
    log("[auth-bootstrap] atomic copy %s → %s failed: %O", source, destination, err);
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }
}

function removeStaleEntries(state: BootstrapState, wantedNames: Set<string>): void {
  let damoclesEntries: string[];
  try {
    damoclesEntries = fs.readdirSync(DAMOCLES_CONFIG_DIR);
  } catch (err) {
    log("[auth-bootstrap] readdir %s failed: %O", DAMOCLES_CONFIG_DIR, err);
    return;
  }

  for (const name of damoclesEntries) {
    if (name === DAMOCLES_CREDENTIALS_FILENAME) continue;
    if (name === CLAUDE_CONFIG_FILENAME) continue;
    if (name === DAMOCLES_ANTHROPIC_GRANT_FILENAME) continue;
    if (wantedNames.has(name)) continue;
    if (ORPHAN_TMP_PATTERN.test(name)) continue;

    const linkPath = path.join(DAMOCLES_CONFIG_DIR, name);

    let stat: fs.Stats;
    try { stat = fs.lstatSync(linkPath); }
    catch (err) {
      if (isEnoent(err)) continue;
      log("[auth-bootstrap] stat stale entry %s failed: %O", linkPath, err);
      continue;
    }

    if (stat.isDirectory()) {
      warnOverwriteOnce(
        state,
        linkPath,
        "[auth-bootstrap] stale entry %s is a real directory — leaving it in place to avoid data loss",
        linkPath,
      );
      continue;
    }

    if (stat.isSymbolicLink() || stat.isFile()) {
      try { fs.unlinkSync(linkPath); }
      catch (err) {
        if (isEnoent(err)) continue;
        log("[auth-bootstrap] removing stale entry %s failed: %O", linkPath, err);
      }
    }
  }
}

function cleanupOrphanTempFiles(): void {
  let entries: string[];
  try { entries = fs.readdirSync(DAMOCLES_CONFIG_DIR); }
  catch { return; }

  for (const name of entries) {
    if (!ORPHAN_TMP_PATTERN.test(name)) continue;
    try { fs.unlinkSync(path.join(DAMOCLES_CONFIG_DIR, name)); }
    catch (err) {
      log("[auth-bootstrap] removing orphan temp %s failed: %O", name, err);
    }
  }
}

function registerParentWatcher(state: BootstrapState): void {
  if (state.disposed || state.parentWatcher) return;
  try {
    state.parentWatcher = fs.watch(CLI_CONFIG_DIR, { persistent: false }, () => {
      if (state.disposed) return;
      if (state.parentRescanTimer) clearTimeout(state.parentRescanTimer);
      state.parentRescanTimer = setTimeout(() => {
        state.parentRescanTimer = null;
        rescan(state);
      }, PARENT_RESCAN_DEBOUNCE_MS);
    });
  } catch (err) {
    log("[auth-bootstrap] fs.watch on %s failed: %O", CLI_CONFIG_DIR, err);
  }
}

function registerCliAppearanceWatcher(state: BootstrapState): void {
  if (state.disposed || state.homeWatcher) return;
  try {
    state.homeWatcher = fs.watch(os.homedir(), { persistent: false }, (_event, filename) => {
      if (state.disposed || state.cliMirrorEngaged) return;
      if (filename !== CLI_DIR_NAME) return;
      if (!fs.existsSync(CLI_CONFIG_DIR)) return;

      log("[auth-bootstrap] %s appeared — engaging mirror", CLI_CONFIG_DIR);
      try { state.homeWatcher?.close(); } catch { /* ignore */ }
      state.homeWatcher = null;
      engageCliMirror(state);
    });
  } catch (err) {
    log("[auth-bootstrap] home-dir watch failed (CLI install during session won't auto-engage mirror): %O", err);
  }
}
