import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "../logger";
import {
  CLI_CONFIG_DIR,
  DAMOCLES_CONFIG_DIR,
  DAMOCLES_CREDENTIALS_FILENAME,
} from "./paths";

const PARENT_RESCAN_DEBOUNCE_MS = 500;
const ORPHAN_TMP_PATTERN = /\.tmp\.\d+\.[0-9a-f]+$/;
const CLI_DIR_NAME = path.basename(CLI_CONFIG_DIR);
const RENAME_RETRY_DELAYS_MS = [30, 60, 120, 240];
const TRANSIENT_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

interface BootstrapState {
  parentRescanTimer: NodeJS.Timeout | null;
  parentWatcher: fs.FSWatcher | null;
  homeWatcher: fs.FSWatcher | null;
  cliMirrorEngaged: boolean;
  disposed: boolean;
  warnedOverwritePaths: Set<string>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
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

export function bootstrapDamoclesConfigDir(context: vscode.ExtensionContext): void {
  try {
    fs.mkdirSync(DAMOCLES_CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    log("[auth-bootstrap] failed to create %s: %O", DAMOCLES_CONFIG_DIR, err);
    return;
  }

  cleanupOrphanTempFiles();

  const state: BootstrapState = {
    parentRescanTimer: null,
    parentWatcher: null,
    homeWatcher: null,
    cliMirrorEngaged: false,
    disposed: false,
    warnedOverwritePaths: new Set<string>(),
  };

  context.subscriptions.push({ dispose: () => disposeAll(state) });

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
        const migrated = migrateRealDirIntoTarget(linkPath, target);
        if (!migrated) {
          warnOverwriteOnce(
            state,
            linkPath,
            "[auth-bootstrap] %s could not be merged into %s — leaving real directory in place",
            linkPath,
            target,
          );
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
 * at the target path, the source version is left in place and the function
 * returns `false` so the caller can fall back to a warning. That preserves any
 * CLI-side data that was created independently and never gets clobbered.
 */
function migrateRealDirIntoTarget(source: string, target: string): boolean {
  if (!fs.existsSync(CLI_CONFIG_DIR)) {
    log(
      "[auth-bootstrap] refusing to merge %s into %s — %s no longer exists",
      source,
      target,
      CLI_CONFIG_DIR,
    );
    return false;
  }

  try {
    fs.mkdirSync(target, { recursive: false });
  } catch (err) {
    if (!isEexist(err)) {
      log("[auth-bootstrap] mkdir %s failed during merge: %O", target, err);
      return false;
    }
  }

  let succeeded = true;

  const mergeEntry = (srcPath: string, dstPath: string): void => {
    let srcStat: fs.Stats;
    try { srcStat = fs.lstatSync(srcPath); }
    catch (err) {
      log("[auth-bootstrap] lstat %s failed during merge: %O", srcPath, err);
      succeeded = false;
      return;
    }

    if (srcStat.isSymbolicLink()) {
      log(
        "[auth-bootstrap] refusing to migrate symlink %s into %s — symlinks in the Damocles mirror should not be promoted into the CLI config dir",
        srcPath,
        dstPath,
      );
      succeeded = false;
      return;
    }

    let dstStat: fs.Stats | null = null;
    try { dstStat = fs.lstatSync(dstPath); }
    catch (err) {
      if (!isEnoent(err)) {
        log("[auth-bootstrap] lstat %s failed during merge: %O", dstPath, err);
        succeeded = false;
        return;
      }
    }

    if (!dstStat) {
      try {
        fs.renameSync(srcPath, dstPath);
      } catch (err) {
        log("[auth-bootstrap] rename %s → %s failed during merge: %O", srcPath, dstPath, err);
        succeeded = false;
      }
      return;
    }

    if (srcStat.isDirectory() && dstStat.isDirectory()) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(srcPath, { withFileTypes: true }); }
      catch (err) {
        log("[auth-bootstrap] readdir %s failed during merge: %O", srcPath, err);
        succeeded = false;
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
        log("[auth-bootstrap] rmdir %s failed during merge: %O", srcPath, err);
        succeeded = false;
      }
      return;
    }

    log(
      "[auth-bootstrap] merge conflict at %s (target already has %s) — keeping target, leaving source in place",
      dstPath,
      dstStat.isDirectory() ? "directory" : dstStat.isSymbolicLink() ? "symlink" : "file",
    );
    succeeded = false;
  };

  let topLevel: fs.Dirent[];
  try { topLevel = fs.readdirSync(source, { withFileTypes: true }); }
  catch (err) {
    log("[auth-bootstrap] readdir %s failed during merge: %O", source, err);
    return false;
  }

  for (const entry of topLevel) {
    mergeEntry(path.join(source, entry.name), path.join(target, entry.name));
  }

  if (!succeeded) return false;

  try {
    fs.rmdirSync(source);
    log("[auth-bootstrap] merged %s into %s and removed source", source, target);
    return true;
  } catch (err) {
    log("[auth-bootstrap] rmdir %s failed after merge: %O", source, err);
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
