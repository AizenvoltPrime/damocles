import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { resolveBundledClaudeBinary } from "./native-binary-resolver";
import {
  DAMOCLES_CONFIG_DIR,
  DAMOCLES_CREDENTIALS_FILENAME,
  DAMOCLES_CREDENTIALS_PATH,
  DAMOCLES_LOGIN_CAPTURE_PREFIX,
} from "./paths";
import {
  clearAnthropicGrant,
  hasValidAnthropicGrant,
  parseAnthropicGrant,
  setAnthropicGrant,
} from "./anthropic-token";
import { log } from "../logger";

const SIGN_IN_TERMINAL_NAME = "Damocles Sign In";
const SIGN_OUT_TERMINAL_NAME = "Damocles Sign Out";
const ISSUES_URL = "https://github.com/AizenvoltPrime/damocles/issues";
const CREDENTIALS_POLL_INTERVAL_MS = 250;

/**
 * On Linux the bundled binary cannot persist a real token to a custom
 * `CLAUDE_CONFIG_DIR` (no secure-store backend), so Damocles owns the grant
 * lifecycle. Login capture and logout take a dedicated path; Windows/macOS keep
 * the original terminal-watches-`.credentials.json` flow byte-for-byte.
 */
const IS_LINUX = process.platform === "linux";

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

    const alreadySignedIn = IS_LINUX ? hasValidAnthropicGrant() : fs.existsSync(DAMOCLES_CREDENTIALS_PATH);
    if (!opts?.force && alreadySignedIn) {
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

    if (IS_LINUX) startLinuxCaptureSignIn(context, binary, onAuthRefreshed);
    else startDefaultSignIn(context, binary, onAuthRefreshed);
  });
}

/**
 * Windows/macOS sign-in: the binary persists a real token to the Damocles config
 * dir (secure-store backed), so watch `.credentials.json` for an mtime change.
 */
function startDefaultSignIn(
  context: vscode.ExtensionContext,
  binary: string,
  onAuthRefreshed: () => Promise<void>,
): void {
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

  const detect = (): boolean => {
    const m = safeMtimeMs(DAMOCLES_CREDENTIALS_PATH);
    return m > 0 && m !== preMtimeMs;
  };

  const lifecycle = createCredentialsLifecycle({
    term,
    watchPath: DAMOCLES_CREDENTIALS_PATH,
    watchDir: DAMOCLES_CONFIG_DIR,
    watchFilename: DAMOCLES_CREDENTIALS_FILENAME,
    detect,
    onSuccess: async () => {
      vscode.window.showInformationMessage("Damocles: sign-in successful. Refreshing session…");
      try { await onAuthRefreshed(); } catch (err) { log("[signIn] refresh failed: %O", err); }
    },
    onCancelled: () => {
      vscode.window.showWarningMessage("Damocles: sign-in terminal closed without writing credentials.");
    },
    closedOutcome: () => (detect() ? "success" : "cancelled"),
  });
  context.subscriptions.push(lifecycle);
}

/**
 * Linux sign-in: run the bundled `claude /login` under an ephemeral `HOME` with
 * no custom `CLAUDE_CONFIG_DIR`, so the binary writes a real token to its
 * default-dir file (the one code path that works on Linux). Capture that grant
 * into the Damocles-owned store, then delete the temp HOME. Success requires a
 * real `accessToken` — a `{}` placeholder is treated as failure.
 */
function startLinuxCaptureSignIn(
  context: vscode.ExtensionContext,
  binary: string,
  onAuthRefreshed: () => Promise<void>,
): void {
  let captureHome: string;
  try {
    captureHome = fs.mkdtempSync(DAMOCLES_LOGIN_CAPTURE_PREFIX);
  } catch (err) {
    log("[signIn] mkdtemp failed: %O", err);
    vscode.window.showErrorMessage(
      `Damocles: could not create a temporary directory for sign-in. ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const captureCredsDir = path.join(captureHome, ".claude");
  const captureCredsPath = path.join(captureCredsDir, DAMOCLES_CREDENTIALS_FILENAME);
  try { fs.mkdirSync(captureCredsDir, { recursive: true, mode: 0o700 }); }
  catch (err) { log("[signIn] mkdir %s failed: %O", captureCredsDir, err); }

  const cleanupHome = (): void => {
    try { fs.rmSync(captureHome, { recursive: true, force: true }); }
    catch (err) { log("[signIn] temp HOME cleanup failed: %O", err); }
  };

  const readCapturedGrant = (): ReturnType<typeof parseAnthropicGrant> => {
    let raw: string;
    try { raw = fs.readFileSync(captureCredsPath, "utf8"); }
    catch { return null; }
    return parseAnthropicGrant(raw);
  };

  const term = vscode.window.createTerminal({
    name: SIGN_IN_TERMINAL_NAME,
    shellPath: binary,
    shellArgs: ["/login"],
    env: {
      HOME: captureHome,
      CLAUDE_CONFIG_DIR: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_API_KEY: null,
    },
  });
  term.show();

  const lifecycle = createCredentialsLifecycle({
    term,
    watchPath: captureCredsPath,
    watchDir: captureCredsDir,
    watchFilename: DAMOCLES_CREDENTIALS_FILENAME,
    detect: () => readCapturedGrant() !== null,
    onSuccess: async () => {
      const captured = readCapturedGrant();
      cleanupHome();
      if (!captured) {
        showLinuxCaptureFailure();
        return;
      }
      try {
        setAnthropicGrant(captured.grant, captured.organizationUuid);
      } catch (err) {
        log("[signIn] persisting captured grant failed: %O", err);
        vscode.window.showErrorMessage(
          `Damocles: captured sign-in but could not store it. ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      vscode.window.showInformationMessage("Damocles: sign-in successful. Refreshing session…");
      try { await onAuthRefreshed(); } catch (err) { log("[signIn] refresh failed: %O", err); }
    },
    onCancelled: () => {
      cleanupHome();
      showLinuxCaptureFailure();
    },
    closedOutcome: () => (readCapturedGrant() !== null ? "success" : "cancelled"),
  });
  context.subscriptions.push(lifecycle);
}

function showLinuxCaptureFailure(): void {
  vscode.window.showErrorMessage(
    "Damocles: sign-in did not capture a token. Complete the browser authorization fully, " +
    "then run /login again. (On Linux the bundled Claude binary has no system keyring, so " +
    "Damocles captures the token directly during sign-in.)",
  );
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

    const signedIn = IS_LINUX ? hasValidAnthropicGrant() : fs.existsSync(DAMOCLES_CREDENTIALS_PATH);
    if (!signedIn) {
      vscode.window.showInformationMessage("Damocles: you are not signed in.");
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      IS_LINUX
        ? "Sign out of Claude? This clears the locally stored OAuth token."
        : "Sign out of Claude? This revokes the current OAuth token and clears local credentials.",
      { modal: true },
      "Sign Out",
    );
    if (confirmed !== "Sign Out") return;

    if (IS_LINUX) {
      await signOutLinux(onAuthCleared);
      return;
    }

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
      watchPath: DAMOCLES_CREDENTIALS_PATH,
      watchDir: DAMOCLES_CONFIG_DIR,
      watchFilename: DAMOCLES_CREDENTIALS_FILENAME,
      detect: () => safeMtimeMs(DAMOCLES_CREDENTIALS_PATH) === 0,
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
      closedOutcome: () => (!fs.existsSync(DAMOCLES_CREDENTIALS_PATH) ? "success" : "cancelled"),
    });
    context.subscriptions.push(lifecycle);
  });
}

/**
 * Linux sign-out: clear the Damocles-owned grant (store + in-memory token +
 * refresh timer) and remove any `{}` placeholder the binary left behind. The
 * bundled `/logout` cannot find the token on Linux, so it is not invoked; the
 * bundled SDK exposes no token-revocation endpoint, so revocation is local-only.
 */
async function signOutLinux(onAuthCleared: () => Promise<void>): Promise<void> {
  clearAnthropicGrant();
  try { fs.unlinkSync(DAMOCLES_CREDENTIALS_PATH); }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log("[signOut] placeholder credentials delete failed: %O", err);
    }
  }
  vscode.window.showInformationMessage("Damocles: signed out. Active session will reload.");
  try { await onAuthCleared(); } catch (err) { log("[signOut] session reload failed: %O", err); }
}

interface LifecycleOptions {
  term: vscode.Terminal;
  watchPath: string;
  watchDir: string;
  watchFilename: string;
  detect: () => boolean;
  onSuccess: () => void | Promise<void>;
  onCancelled: () => void | Promise<void>;
  closedOutcome: () => "success" | "cancelled";
}

function createCredentialsLifecycle(opts: LifecycleOptions): vscode.Disposable {
  const { term, watchPath, watchDir, watchFilename, detect, onSuccess, onCancelled, closedOutcome } = opts;

  let settled = false;
  let watchFileActive = true;
  let dirWatcher: fs.FSWatcher | null = null;

  const cleanup = () => {
    if (watchFileActive) {
      fs.unwatchFile(watchPath, onCredentialsChanged);
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

  function onCredentialsChanged() {
    if (settled) return;
    if (detect()) void settle("success");
  }

  function onDirEvent(_event: string, filename: string | Buffer | null) {
    if (settled) return;
    const name = typeof filename === "string" ? filename : filename?.toString();
    if (name && name !== watchFilename) return;
    if (detect()) void settle("success");
  }

  fs.watchFile(
    watchPath,
    { interval: CREDENTIALS_POLL_INTERVAL_MS, persistent: false },
    onCredentialsChanged,
  );

  try {
    if (fs.existsSync(watchDir)) {
      dirWatcher = fs.watch(watchDir, { persistent: false }, onDirEvent);
    }
  } catch (err) {
    log("[auth] fs.watch on %s failed, relying on watchFile fallback: %O", watchDir, err);
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
