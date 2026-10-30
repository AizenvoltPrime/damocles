// The smoke app's own home, seeded read-only from the developer's; see README.md "Hermetic home".
import fs from 'node:fs';
import path from 'node:path';

// pi-ai auth/resolve.js DEFAULT_OAUTH_MINIMUM_VALIDITY_MS: pi refreshes an OAuth token once less than this is left.
export const PI_REFRESH_WINDOW_MS = 5 * 60 * 1000;
/** How long a copied OAuth token must stay usable after pi's refresh window for a smoke run to finish on it. */
export const RUN_MARGIN_MS = 30 * 60 * 1000;
export const OWNER_MARKER = '.damocles-smoke';

/** Preferences and one-time migration markers under `~/.damocles`; never registries, sessions, memory or hooks. */
const DAMOCLES_FILES = ['settings.json', 'provider-key-sweep.json', 'openai-api-key-moved.json'];
/** What pi's providers need under its agent dir: its settings (package list), model lists, and installed packages. */
const AGENT_ENTRIES = ['settings.json', 'models.json', 'models-store.json', 'git', 'npm', 'extensions'];

const PASSTHROUGH_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'SystemDrive',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'SHELL', 'TERM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The credentials the smoke app gets: api_key entries as they are, oauth entries without their refresh token, so the app
 * uses the current access token but can never rotate the developer's sign-in. Notices name each entry it cannot rely on.
 */
export function seedAuth(real, now) {
  const auth = {};
  const notices = [];
  for (const [provider, entry] of Object.entries(real ?? {})) {
    if (entry?.type === 'api_key') {
      auth[provider] = structuredClone(entry);
      continue;
    }
    if (entry?.type !== 'oauth') {
      notices.push(`The "${provider}" entry of auth.json is not an api_key or oauth credential, so it was not copied.`);
      continue;
    }
    const copy = structuredClone(entry);
    delete copy.refresh;
    auth[provider] = copy;
    const expires = Number.isFinite(entry.expires) ? entry.expires : 0;
    if (expires - PI_REFRESH_WINDOW_MS - now >= RUN_MARGIN_MS) continue;
    const refreshFrom = expires - PI_REFRESH_WINDOW_MS;
    const left = expires > now ? `expires at ${clock(expires)} (in ${Math.floor((expires - now) / 60_000)} minutes)` : 'has expired';
    notices.push(
      `The copied "${provider}" sign-in ${left}, and the smoke app cannot refresh it: a run needs ${RUN_MARGIN_MS / 60_000} minutes of it `
      + `beyond pi's ${PI_REFRESH_WINDOW_MS / 60_000}-minute refresh window. Send one message with that provider in your own Damocles app `
      + `${refreshFrom > now ? `after ${clock(refreshFrom)}` : 'now'}, which refreshes the sign-in, or sign in again there; then post --quit and --launch again. `
      + `A smoke test that does not use "${provider}" can ignore this.`,
    );
  }
  return { auth, notices };
}

function isLink(file) {
  return fs.lstatSync(file).isSymbolicLink();
}

function present(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `from` to `to` and never follows a linked folder, which could lead back into the developer's home. A top-level
 * linked file (a stow-managed ~/.gitconfig) is copied as a plain file holding its content.
 */
function copyEntry(from, to, notices) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (isLink(from)) {
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, to);
    else notices.push(`Skipped ${from}: it is a link to a folder, and links to folders are never copied into the smoke home.`);
    return;
  }
  const skipped = [];
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      if (!isLink(source)) return true;
      skipped.push(path.relative(from, source));
      return false;
    },
  });
  if (skipped.length === 0) return;
  const named = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? ', ...' : '');
  notices.push(`Skipped ${skipped.length} ${skipped.length === 1 ? 'link' : 'links'} in ${from} (${named}); links inside a copied folder are never copied into the smoke home.`);
}

/**
 * Deletes the folder `root`. fs.rm unlinks a link or junction inside it without entering it (unlike PowerShell's
 * Remove-Item -Recurse); the smoke-hermetic test guards that.
 */
export async function removeTree(root) {
  if (!fs.existsSync(root)) return;
  if (isLink(root)) throw new Error(`${root} is a link; refusing to delete it as a folder`);
  // Chromium's helper processes free their handles a moment after the app exits.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
}

function createOwned(folder) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, OWNER_MARKER), 'Created by scripts/smoke-desktop, which deletes this folder.\n');
}

/** Throws unless `folder` is a real folder holding the marker the runner writes into every folder it creates. */
function assertOwned(folder) {
  if (isLink(folder)) throw new Error(`${folder} is a link; refusing to delete it as a folder`);
  const marker = path.join(folder, OWNER_MARKER);
  if (!present(marker) || !fs.lstatSync(marker).isFile()) {
    throw new Error(`${folder} has no ${OWNER_MARKER} file, so the smoke runner did not create it; refusing to delete it. Move it, or set SMOKE_DIR to a folder of its own.`);
  }
}

/** Deletes `folder` only when the runner created it. */
async function removeOwnedTree(folder) {
  if (!present(folder)) return;
  assertOwned(folder);
  await removeTree(folder);
}

/** Replaces `<dir>/logs` with a copy of `source`; leaves the previous logs when `source` does not exist. */
async function keepLogs(dir, source) {
  if (!fs.existsSync(source)) return undefined;
  const logs = path.join(dir, 'logs');
  await removeOwnedTree(logs);
  createOwned(logs);
  fs.cpSync(source, logs, { recursive: true, filter: (file) => !isLink(file) });
  return logs;
}

/**
 * Deletes `<dir>/run`, keeping its app logs in `<dir>/logs`. The home holding the copied credentials goes first, so a
 * failure to keep the logs never leaves them behind; that failure becomes a notice.
 */
export async function retireRun(dir) {
  const run = path.join(dir, 'run');
  if (!present(run)) return { notices: [] };
  assertOwned(run);
  await removeTree(path.join(run, 'h'));
  const notices = [];
  let logs;
  try {
    logs = await keepLogs(dir, path.join(run, 'ud', 'logs'));
  } catch (err) {
    notices.push(`The run's logs were not kept: ${err instanceof Error ? err.message : String(err)}`);
  }
  await removeTree(run);
  return { removed: run, logs, notices };
}

/**
 * Recreates `<dir>/run` with a home (`h`), userData (`ud`) and temp folder, seeded from `realHome`, after keeping the
 * previous run's logs. Names stay short, as e2e/desktop/support/hermetic.ts explains: git refuses a checkpoint GIT_DIR
 * over 220 characters.
 */
export async function createSmokeHome({ dir, realHome, realLocalAppData, now = Date.now() }) {
  const retired = await retireRun(dir);
  createOwned(path.join(dir, 'run'));
  // Native realpath resolves Windows 8.3 short names (os.tmpdir() can return one); folder keys compare exact paths.
  const root = fs.realpathSync.native(path.join(dir, 'run'));
  const home = path.join(root, 'h');
  const userData = path.join(root, 'ud');
  const tmp = path.join(root, 'tmp');
  const damoclesDir = path.join(home, '.damocles');
  const agentDir = path.join(damoclesDir, 'pi', 'agent');
  for (const folder of [userData, tmp, agentDir, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  const notices = [...retired.notices];
  const realDamocles = path.join(realHome, '.damocles');
  const realAgent = path.join(realDamocles, 'pi', 'agent');
  for (const name of DAMOCLES_FILES) copyEntry(path.join(realDamocles, name), path.join(damoclesDir, name), notices);
  for (const name of AGENT_ENTRIES) copyEntry(path.join(realAgent, name), path.join(agentDir, name), notices);
  copyEntry(path.join(realHome, '.gitconfig'), path.join(home, '.gitconfig'), notices);
  // smokeEnv points XDG_CONFIG_HOME at AppData/Roaming, where git then reads its XDG config.
  copyEntry(path.join(realHome, '.config', 'git', 'config'), path.join(home, 'AppData', 'Roaming', 'git', 'config'), notices);
  if (realLocalAppData) {
    // Without Windows PowerShell's module analysis cache a shell's first cmdlet analyses every module on the path first.
    const cache = path.join('Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache');
    copyEntry(path.join(realLocalAppData, cache), path.join(home, 'AppData', 'Local', cache), notices);
  }
  const realAuth = path.join(realAgent, 'auth.json');
  if (fs.existsSync(realAuth)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(realAuth, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      notices.push(`${realAuth} is not valid JSON, so the smoke app starts signed out.`);
    }
    if (parsed) {
      const seeded = seedAuth(parsed, now);
      notices.push(...seeded.notices);
      // A copy, never a link: pi locks auth.json by its literal path, so a link would share one credential between two unlocked writers.
      fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify(seeded.auth, null, 2), { mode: 0o600 });
    }
  }
  return { root, home, userData, tmp, notices };
}

/**
 * The smoke app's environment, as e2e/desktop/support/hermetic.ts hermeticEnv builds it: an allowlist of OS variables plus
 * the hermetic home. Unlike e2e it keeps proxy and CA variables and sets no PI_OFFLINE or GitHub block, since a smoke run
 * reaches real providers.
 */
export function smokeEnv(h, source = process.env) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) if (source[key] !== undefined) env[key] = source[key];
  const appData = path.join(h.home, 'AppData', 'Roaming');
  const localAppData = path.join(h.home, 'AppData', 'Local');
  Object.assign(env, {
    HOME: h.home,
    USERPROFILE: h.home,
    // Chrome refuses a debugging pipe when LOCALAPPDATA is not under USERPROFILE.
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: appData,
    XDG_CACHE_HOME: localAppData,
    TMPDIR: h.tmp,
    TEMP: h.tmp,
    TMP: h.tmp,
    // libsecret falls back to $XDG_RUNTIME_DIR/bus, so without an unusable address safeStorage writes the real keyring.
    DBUS_SESSION_BUS_ADDRESS: 'disabled:',
  });
  return env;
}
