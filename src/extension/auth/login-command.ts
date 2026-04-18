import * as vscode from "vscode";
import * as fs from "fs";
import { exec } from "child_process";
import { resolveBundledClaudeBinary } from "./native-binary-resolver";
import {
  DAMOCLES_CONFIG_DIR,
  DAMOCLES_CREDENTIALS_FILENAME,
  DAMOCLES_CREDENTIALS_PATH,
} from "./paths";
import { log } from "../logger";

const SIGN_IN_TERMINAL_NAME = "Damocles Sign In";
const SIGN_OUT_TERMINAL_NAME = "Damocles Sign Out";
const ISSUES_URL = "https://github.com/AizenvoltPrime/damocles/issues";
const CREDENTIALS_POLL_INTERVAL_MS = 250;

export function registerSignInCommand(
  context: vscode.ExtensionContext,
  onAuthRefreshed: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand("damocles.signIn", async (opts?: { force?: boolean }) => {
    const binary = resolveBundledClaudeBinary();
    if (!binary) {
      vscode.window.showErrorMessage(
        `Damocles: bundled Claude binary not found for ${process.platform}-${process.arch}. ` +
        `This is a packaging issue — please report at ${ISSUES_URL}.`,
      );
      return;
    }

    if (!opts?.force && fs.existsSync(DAMOCLES_CREDENTIALS_PATH)) {
      const choice = await vscode.window.showInformationMessage(
        "Damocles: you are already signed in.",
        "Re-authenticate",
        "Cancel",
      );
      if (choice !== "Re-authenticate") return;
    }

    const existing = vscode.window.terminals.find(t => t.name === SIGN_IN_TERMINAL_NAME);
    if (existing) {
      existing.show();
      return;
    }

    const preMtimeMs = safeMtimeMs(DAMOCLES_CREDENTIALS_PATH);

    try { fs.mkdirSync(DAMOCLES_CONFIG_DIR, { recursive: true, mode: 0o700 }); }
    catch (err) { log("[signIn] mkdir %s failed: %O", DAMOCLES_CONFIG_DIR, err); }

    const term = vscode.window.createTerminal({
      name: SIGN_IN_TERMINAL_NAME,
      shellPath: binary,
      shellArgs: ["/login"],
      env: {
        CLAUDE_CONFIG_DIR: DAMOCLES_CONFIG_DIR,
        CLAUDE_CODE_OAUTH_TOKEN: null,
        ANTHROPIC_API_KEY: null,
      },
    });
    term.show();

    const lifecycle = createCredentialsLifecycle({
      term,
      detect: (curr) => curr.mtimeMs > 0 && curr.mtimeMs !== preMtimeMs,
      onSuccess: async () => {
        vscode.window.showInformationMessage("Damocles: sign-in successful. Refreshing session…");
        try { await onAuthRefreshed(); } catch (err) { log("[signIn] refresh failed: %O", err); }
      },
      onCancelled: () => {
        vscode.window.showWarningMessage("Damocles: sign-in terminal closed without writing credentials.");
      },
      closedOutcome: () => safeMtimeMs(DAMOCLES_CREDENTIALS_PATH) > 0 && safeMtimeMs(DAMOCLES_CREDENTIALS_PATH) !== preMtimeMs
        ? "success" : "cancelled",
    });
    context.subscriptions.push(lifecycle);
  });
}

export function registerSignOutCommand(
  context: vscode.ExtensionContext,
  onAuthCleared: () => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand("damocles.signOut", async () => {
    const binary = resolveBundledClaudeBinary();
    if (!binary) {
      vscode.window.showErrorMessage(
        `Damocles: bundled Claude binary not found for ${process.platform}-${process.arch}. ` +
        `This is a packaging issue — please report at ${ISSUES_URL}.`,
      );
      return;
    }

    if (!fs.existsSync(DAMOCLES_CREDENTIALS_PATH)) {
      vscode.window.showInformationMessage("Damocles: you are not signed in.");
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      "Sign out of Claude? This revokes the current OAuth token and clears local credentials.",
      { modal: true },
      "Sign Out",
    );
    if (confirmed !== "Sign Out") return;

    const existing = vscode.window.terminals.find(t => t.name === SIGN_OUT_TERMINAL_NAME);
    if (existing) {
      existing.show();
      return;
    }

    try { fs.mkdirSync(DAMOCLES_CONFIG_DIR, { recursive: true, mode: 0o700 }); }
    catch (err) { log("[signOut] mkdir %s failed: %O", DAMOCLES_CONFIG_DIR, err); }

    const term = vscode.window.createTerminal({
      name: SIGN_OUT_TERMINAL_NAME,
      shellPath: binary,
      shellArgs: ["/logout"],
      env: {
        CLAUDE_CONFIG_DIR: DAMOCLES_CONFIG_DIR,
        CLAUDE_CODE_OAUTH_TOKEN: null,
        ANTHROPIC_API_KEY: null,
      },
    });
    term.show();

    const lifecycle = createCredentialsLifecycle({
      term,
      detect: (curr) => curr.mtimeMs === 0,
      onSuccess: async () => {
        if (fs.existsSync(DAMOCLES_CREDENTIALS_PATH)) {
          log("[signOut] bundled /logout did not clear %s — falling back to local delete", DAMOCLES_CREDENTIALS_PATH);
          try { fs.unlinkSync(DAMOCLES_CREDENTIALS_PATH); }
          catch (err) {
            log("[signOut] local credentials delete failed: %O", err);
            vscode.window.showErrorMessage(
              `Damocles: failed to remove ${DAMOCLES_CREDENTIALS_PATH}. ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          }
        }
        vscode.window.showInformationMessage("Damocles: signed out. Active session will reload.");
        try { await onAuthCleared(); } catch (err) { log("[signOut] session reload failed: %O", err); }
      },
      onCancelled: async () => {
        if (fs.existsSync(DAMOCLES_CREDENTIALS_PATH)) {
          try { fs.unlinkSync(DAMOCLES_CREDENTIALS_PATH); }
          catch (err) { log("[signOut] local credentials delete on cancel failed: %O", err); return; }
        }
        vscode.window.showInformationMessage("Damocles: signed out. Active session will reload.");
        try { await onAuthCleared(); } catch (err) { log("[signOut] session reload failed: %O", err); }
      },
      closedOutcome: () => !fs.existsSync(DAMOCLES_CREDENTIALS_PATH) ? "success" : "cancelled",
    });
    context.subscriptions.push(lifecycle);
  });
}

interface MtimeProbe { mtimeMs: number; }

interface LifecycleOptions {
  term: vscode.Terminal;
  detect: (curr: MtimeProbe) => boolean;
  onSuccess: () => void | Promise<void>;
  onCancelled: () => void | Promise<void>;
  closedOutcome: () => "success" | "cancelled";
}

function createCredentialsLifecycle(opts: LifecycleOptions): vscode.Disposable {
  const { term, detect, onSuccess, onCancelled, closedOutcome } = opts;

  let settled = false;
  let watchFileActive = true;
  let dirWatcher: fs.FSWatcher | null = null;

  const cleanup = () => {
    if (watchFileActive) {
      fs.unwatchFile(DAMOCLES_CREDENTIALS_PATH, onCredentialsChanged);
      watchFileActive = false;
    }
    if (dirWatcher) {
      try { dirWatcher.close(); } catch { /* ignore */ }
      dirWatcher = null;
    }
    closeDisposable.dispose();
  };

  const settle = async (outcome: "success" | "cancelled") => {
    if (settled) return;
    settled = true;
    cleanup();

    await killTerminalProcess(term);
    try { term.dispose(); } catch { /* ignore */ }

    try {
      if (outcome === "success") await onSuccess();
      else await onCancelled();
    } catch (err) {
      log("[auth] lifecycle callback failed: %O", err);
    }
  };

  function onCredentialsChanged(curr: MtimeProbe) {
    if (settled) return;
    if (detect(curr)) void settle("success");
  }

  function onDirEvent(_event: string, filename: string | Buffer | null) {
    if (settled) return;
    const name = typeof filename === "string" ? filename : filename?.toString();
    if (name && name !== DAMOCLES_CREDENTIALS_FILENAME) return;
    const curr = safeStat(DAMOCLES_CREDENTIALS_PATH);
    if (detect(curr)) void settle("success");
  }

  fs.watchFile(
    DAMOCLES_CREDENTIALS_PATH,
    { interval: CREDENTIALS_POLL_INTERVAL_MS, persistent: false },
    onCredentialsChanged,
  );

  try {
    if (fs.existsSync(DAMOCLES_CONFIG_DIR)) {
      dirWatcher = fs.watch(DAMOCLES_CONFIG_DIR, { persistent: false }, onDirEvent);
    }
  } catch (err) {
    log("[auth] fs.watch on %s failed, relying on watchFile fallback: %O", DAMOCLES_CONFIG_DIR, err);
  }

  const closeDisposable = vscode.window.onDidCloseTerminal((closed) => {
    if (closed !== term) return;
    void settle(closedOutcome());
  });

  return {
    dispose: () => {
      if (!settled) {
        settled = true;
        cleanup();
      }
    },
  };
}

async function killTerminalProcess(term: vscode.Terminal): Promise<void> {
  try {
    const pid = await term.processId;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        exec(`taskkill /PID ${pid} /T /F`, (err) => {
          if (err) log("[auth] taskkill failed for pid %d: %O", pid, err);
          resolve();
        });
      });
    } else {
      try { process.kill(-pid, "SIGKILL"); }
      catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  } catch (err) {
    log("[auth] killTerminalProcess failed: %O", err);
  }
}

function safeMtimeMs(p: string): number {
  try { return fs.statSync(p).mtimeMs; }
  catch { return 0; }
}

function safeStat(p: string): MtimeProbe {
  try { return { mtimeMs: fs.statSync(p).mtimeMs }; }
  catch { return { mtimeMs: 0 }; }
}
