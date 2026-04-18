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
import { sanitizeProcessEnvForSdk } from "./sdk-env";

const PARENT_RESCAN_DEBOUNCE_MS = 500;
const ORPHAN_TMP_PATTERN = /\.tmp\.\d+\.[0-9a-f]+$/;
const CLI_DIR_NAME = path.basename(CLI_CONFIG_DIR);

interface BootstrapState {
  parentRescanTimer: NodeJS.Timeout | null;
  parentWatcher: fs.FSWatcher | null;
  homeWatcher: fs.FSWatcher | null;
  cliMirrorEngaged: boolean;
  disposed: boolean;
}

export function bootstrapDamoclesConfigDir(context: vscode.ExtensionContext): void {
  try {
    fs.mkdirSync(DAMOCLES_CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    log("[auth-bootstrap] failed to create %s: %O", DAMOCLES_CONFIG_DIR, err);
    sanitizeProcessEnvForSdk();
    return;
  }

  sanitizeProcessEnvForSdk();
  cleanupOrphanTempFiles();

  const state: BootstrapState = {
    parentRescanTimer: null,
    parentWatcher: null,
    homeWatcher: null,
    cliMirrorEngaged: false,
    disposed: false,
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
}

function engageCliMirror(state: BootstrapState): void {
  if (state.disposed || state.cliMirrorEngaged) return;
  state.cliMirrorEngaged = true;

  rescan(state);
  registerParentWatcher(state);
}

function rescan(state: BootstrapState): void {
  if (state.disposed) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(CLI_CONFIG_DIR, { withFileTypes: true });
  } catch (err) {
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
      linkDirectory(target, linkPath);
    } else if (entry.isFile()) {
      mirrorFile(target, linkPath);
    }
  }

  removeStaleEntries(wantedNames);
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    if (fs.existsSync(linkPath)) {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        if (symlinkPointsAt(linkPath, target)) return;
        try { fs.unlinkSync(linkPath); }
        catch (err) {
          log("[auth-bootstrap] failed to remove stale link %s: %O", linkPath, err);
          return;
        }
      } else {
        log(
          "[auth-bootstrap] %s exists as a real %s — refusing to overwrite. " +
          "Delete it manually to enable shared-config mirroring.",
          linkPath,
          stat.isDirectory() ? "directory" : "file",
        );
        return;
      }
    }

    const symlinkType: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(target, linkPath, symlinkType);
  } catch (err) {
    log("[auth-bootstrap] symlink %s → %s failed: %O", linkPath, target, err);
  }
}

function symlinkPointsAt(linkPath: string, target: string): boolean {
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(target);
  } catch {
    return false;
  }
}

function mirrorFile(target: string, linkPath: string): void {
  let sourceStat: fs.Stats;
  try { sourceStat = fs.statSync(target); }
  catch (err) {
    log("[auth-bootstrap] cannot stat source %s: %O", target, err);
    return;
  }

  let destStat: fs.Stats | null = null;
  try { destStat = fs.lstatSync(linkPath); }
  catch { /* destination absent — proceed to copy */ }

  if (destStat && !destStat.isFile()) {
    log(
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
}

function copyFileAtomic(source: string, destination: string, sourceStat: fs.Stats): void {
  let tempPath: string | null = null;
  try {
    tempPath = `${destination}.tmp.${process.pid}.${Date.now().toString(16)}${Math.floor(Math.random() * 0x100000).toString(16)}`;
    fs.copyFileSync(source, tempPath);
    try { fs.utimesSync(tempPath, sourceStat.atime, sourceStat.mtime); }
    catch (err) { log("[auth-bootstrap] utimes %s failed (continuing): %O", tempPath, err); }
    fs.renameSync(tempPath, destination);
    tempPath = null;
  } catch (err) {
    log("[auth-bootstrap] atomic copy %s → %s failed: %O", source, destination, err);
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }
}

function removeStaleEntries(wantedNames: Set<string>): void {
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
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(linkPath);
      } else if (stat.isDirectory()) {
        log(
          "[auth-bootstrap] stale entry %s is a real directory — leaving it in place to avoid data loss",
          linkPath,
        );
      }
    } catch (err) {
      log("[auth-bootstrap] removing stale entry %s failed: %O", linkPath, err);
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
