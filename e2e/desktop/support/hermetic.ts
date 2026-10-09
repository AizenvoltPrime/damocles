import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SUBSCRIPTION_SOURCE } from '../../../src/core/pi-session/subscription';
import { describeLeftovers } from './file-holders';
import { STUB_MODEL_ID } from './openai-stub';

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface HermeticHome {
  readonly root: string;
  readonly home: string;
  readonly userData: string;
  readonly damoclesDir: string;
  readonly agentDir: string;
  /** A project folder with its own .damocles dir, outside the home. */
  readonly project: string;
  dispose(): Promise<void>;
}

/**
 * Windows PowerShell 5.1's module analysis cache, warmed once per run by global-setup.ts and copied into each home: without
 * it a shell's first cmdlet analyses every module on the module path first, which on a GitHub runner (AWSPowershell, Az,
 * Microsoft.Graph) outlasts a test's wait.
 */
export const WINDOWS_POWERSHELL_CACHE = path.join(REPO_ROOT, 'dist', 'e2e-cache', 'ModuleAnalysisCache');
// Where Windows PowerShell 5.1 keeps the cache under a profile's LOCALAPPDATA.
export const WINDOWS_POWERSHELL_CACHE_IN_PROFILE = path.join('Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache');

/**
 * A fresh HOME, userData and project folder under one temp root; nothing outside it is touched. Names stay short:
 * a checkpoint repo's GIT_DIR nests the encoded project path under the home, and git refuses one over 220 characters.
 */
export function createHermeticHome(): HermeticHome {
  // Native realpath resolves the macOS /var symlink and Windows 8.3 short names; folder keys compare exact paths.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'd')));
  const home = path.join(root, 'h');
  const userData = path.join(root, 'ud');
  const project = path.join(root, 'p', 'alpha');
  const damoclesDir = path.join(home, '.damocles');
  const agentDir = path.join(damoclesDir, 'pi', 'agent');
  for (const dir of [home, userData, project, agentDir, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local'), path.join(root, 'tmp')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (process.platform === 'win32') {
    const cache = path.join(home, 'AppData', 'Local', WINDOWS_POWERSHELL_CACHE_IN_PROFILE);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.copyFileSync(WINDOWS_POWERSHELL_CACHE, cache);
  }
  return {
    root,
    home,
    userData,
    damoclesDir,
    agentDir,
    project,
    // Windows frees a dead process's file handles late, and Chrome's helper processes (crashpad) outlive the browser by seconds,
    // so rm retries EBUSY and EPERM. rmSync would sleep between its retries on the worker's thread, where the foreground lock
    // refreshes (foreground.ts). A delete that still fails names what is left and the processes holding it.
    dispose: async () => {
      try {
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${describeLeftovers(root)}`, { cause: err });
      }
    },
  };
}

/** Registers the stub as pi's `openai` provider with an api_key credential, and selects its model. */
export function seedStubModel(h: HermeticHome, baseUrl: string): void {
  const models = {
    providers: {
      openai: {
        baseUrl,
        api: 'openai-completions',
        models: [
          {
            id: STUB_MODEL_ID,
            name: 'Stub model',
            reasoning: false,
            input: ['text'],
            contextWindow: 272000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(h.agentDir, 'models.json'), JSON.stringify(models, null, 2));
  // The runner cannot seed the safeStorage secret store. A persistent store gets this key at the first start; without a
  // keyring (the Linux runner) it stays in auth.json, where pi reads it again on every relaunch.
  writeAuth(h, { openai: { type: 'api_key', key: 'stub-key' } });
  writeUserSettings(h, { 'damocles.model': STUB_MODEL_ID });
}

/**
 * Installs the subscription plugin stub as pi's clone of the pinned plugin and lists it, as a finished download leaves them, so
 * signing in to Claude finds the plugin installed and downloads nothing.
 */
export function seedSubscriptionPlugin(h: HermeticHome): void {
  const repo = new URL(SUBSCRIPTION_SOURCE.slice(0, SUBSCRIPTION_SOURCE.lastIndexOf('@')));
  const clone = path.join(h.agentDir, 'git', repo.hostname, ...repo.pathname.split('/').filter(Boolean));
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'subscription-plugin', 'src', 'index.ts'), path.join(clone, 'src', 'index.ts'));
  fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'subscription-plugin-stub', type: 'module', pi: { extensions: ['./src/index.ts'] } }, null, 2));
  const settings = path.join(h.agentDir, 'settings.json');
  const current = fs.existsSync(settings) ? (JSON.parse(fs.readFileSync(settings, 'utf8')) as Record<string, unknown>) : {};
  fs.writeFileSync(settings, JSON.stringify({ ...current, packages: [SUBSCRIPTION_SOURCE] }, null, 2));
}

export function writeAuth(h: HermeticHome, auth: Record<string, unknown>): void {
  fs.writeFileSync(path.join(h.agentDir, 'auth.json'), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

/** ~/.damocles/settings.json, the desktop user settings scope; empty until something writes it. Main writes it by rename, so a read never sees half a file. */
export function readUserSettings(h: HermeticHome): Record<string, unknown> {
  const file = path.join(h.damoclesDir, 'settings.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

/** Merges flat dotted keys into ~/.damocles/settings.json. */
export function writeUserSettings(h: HermeticHome, values: Record<string, unknown>): void {
  fs.writeFileSync(path.join(h.damoclesDir, 'settings.json'), JSON.stringify({ ...readUserSettings(h), ...values }, null, 2));
}

/** Where git is sent for every GitHub URL in a launched app: a folder that does not exist, so nothing is fetched. */
const GITHUB_BLOCKED = 'file:///damocles-e2e-no-network/';

/** Set to `1` to let launches reach the developer's Linux keyring (Secret Service over the session D-Bus). */
export const OS_KEYRING_ENV = 'DAMOCLES_E2E_OS_KEYRING';

const PASSTHROUGH_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'SystemDrive',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL', 'SHELL', 'TERM',
];

function appData(h: Pick<HermeticHome, 'home'>): string {
  return path.join(h.home, 'AppData', 'Roaming');
}

function localAppData(h: Pick<HermeticHome, 'home'>): string {
  return path.join(h.home, 'AppData', 'Local');
}

/**
 * The environment every launched process gets: an allowlist of OS variables plus the hermetic home.
 * Provider keys, proxies and CA overrides from the developer's shell never leak in.
 */
export function hermeticEnv(h: Pick<HermeticHome, 'root' | 'home'>, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: h.home,
    USERPROFILE: h.home,
    // The Windows profile layout under the home: Chrome refuses a debugging pipe when LOCALAPPDATA is not under USERPROFILE.
    APPDATA: appData(h),
    LOCALAPPDATA: localAppData(h),
    XDG_CONFIG_HOME: appData(h),
    XDG_CACHE_HOME: localAppData(h),
    TMPDIR: path.join(h.root, 'tmp'),
    TEMP: path.join(h.root, 'tmp'),
    TMP: path.join(h.root, 'tmp'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    // A git clone or fetch from GitHub (pi installing a package) fails at once instead of reaching the network.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${GITHUB_BLOCKED}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  });
  // libsecret falls back to $XDG_RUNTIME_DIR/bus, so without an unusable address safeStorage reads and writes the real keyring.
  // macOS safeStorage uses the mock keychain every launcher requests (--use-mock-keychain); Windows DPAPI stores nothing outside userData.
  const osKeyring = process.env[OS_KEYRING_ENV] === '1';
  if (!osKeyring) env['DBUS_SESSION_BUS_ADDRESS'] = 'disabled:';
  else if (process.env['DBUS_SESSION_BUS_ADDRESS'] !== undefined) env['DBUS_SESSION_BUS_ADDRESS'] = process.env['DBUS_SESSION_BUS_ADDRESS'];
  return { ...env, ...extra };
}
