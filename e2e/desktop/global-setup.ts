import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { EXTENSION_EXTERNALS } from '../../scripts/extension-externals.mjs';
import { windowsTerminalEnvironment } from '../../src/desktop/main/workspace/windows-terminal-environment';
import { coreLog, launchDesktop } from './support/app';
import { createHermeticHome, hermeticEnv, REPO_ROOT, WINDOWS_POWERSHELL_CACHE, WINDOWS_POWERSHELL_CACHE_IN_PROFILE } from './support/hermetic';
import { PACKAGED_APP_ENV, packagedAppPath } from './support/packaged-app';
import { SECOND_PROCESS_BUNDLE } from './support/second-process';

export default async function globalSetup(): Promise<void> {
  const packaged = packagedAppPath();
  if (packaged !== undefined) {
    if (!fs.existsSync(packaged)) throw new Error(`${PACKAGED_APP_ENV} names ${packaged}, which does not exist; build the app with \`npm run dist\` first`);
  } else {
    for (const built of ['dist/desktop/main.js', 'dist/core-host.js', 'dist/process-launcher-worker.js', 'dist/desktop/preload-panel.js', 'dist/webview/index.html']) {
      if (!fs.existsSync(path.join(REPO_ROOT, built))) {
        throw new Error(`${built} is missing; run the suite through \`npm run test:desktop\`, which builds it first`);
      }
    }
  }
  // The bundle lives under the repo so its externals (pi is ESM, loaded by import()) resolve from node_modules.
  await build({
    entryPoints: [path.join(REPO_ROOT, 'e2e', 'desktop', 'second-process', 'child.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: SECOND_PROCESS_BUNDLE,
    external: EXTENSION_EXTERNALS.filter((name) => name !== 'vscode'),
    logLevel: 'warning',
  });
  if (process.platform === 'win32') await warmWindowsPowerShellCaches();
  await warmFirstLaunch();
}

const WARM_LAUNCH_TIMEOUT_MS = 180_000;
// Damocles Core's log line of a chat that started: after the git probe, the first window, core's start and pi's import.
const CHAT_STARTED = '[perf] start.total';

/** Launches the app once to its first chat, so no test pays a fresh runner's first launch (docs/release.md, "Desktop end-to-end suite"). */
async function warmFirstLaunch(): Promise<void> {
  const home = createHermeticHome();
  const started = Date.now();
  try {
    const desktop = await launchDesktop(home);
    try {
      while (!coreLog(home).includes(CHAT_STARTED)) {
        if (Date.now() - started > WARM_LAUNCH_TIMEOUT_MS) throw new Error(`The warm-up launch's core logged no "${CHAT_STARTED}" within ${WARM_LAUNCH_TIMEOUT_MS / 1000} s:\n${coreLog(home)}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      await desktop.close();
    }
  } finally {
    await home.dispose();
  }
  console.log(`Warmed the app's first launch in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// Analysing a runner's whole module path takes minutes, never more than this.
const POWERSHELL_WARM_TIMEOUT_MS = 600_000;
// a module no cache holds yet, so the analysis always queues a save
const CACHE_PROBE_MODULE = 'DamoclesE2eCacheProbe';

const psQuote = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const execFileAsync = promisify(execFile);

/**
 * Builds the Windows PowerShell 5.1 module analysis caches the launches' shells read, each under its readers' environment:
 * one in a fresh profile under the hermetic environment, which the loopback daemon's shells and the specs' own run under,
 * kept as WINDOWS_POWERSHELL_CACHE for createHermeticHome to copy; and, when the registry names a machine-wide
 * PSModuleAnalysisCachePath (GitHub's Windows images set one), that file in place under the environment a local terminal
 * starts with, the registry's variables over the launch's.
 */
async function warmWindowsPowerShellCaches(): Promise<void> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dps')));
  const home = path.join(root, 'h');
  for (const dir of [path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  const probes = path.join(root, 'probe');
  fs.mkdirSync(path.join(probes, CACHE_PROBE_MODULE), { recursive: true });
  fs.writeFileSync(path.join(probes, CACHE_PROBE_MODULE, `${CACHE_PROBE_MODULE}.psm1`), `function Get-${CACHE_PROBE_MODULE} {}\n`);
  const hermetic = hermeticEnv({ root, home });
  const terminal = windowsTerminalEnvironment(hermetic, (line) => console.log(line));
  const machineWide = Object.entries(terminal).some(([key, value]) => key.toUpperCase() === 'PSMODULEANALYSISCACHEPATH' && value);
  const [profileCache] = await Promise.all([warmPowerShellCache(hermetic, probes), ...(machineWide ? [warmPowerShellCache(terminal, probes)] : [])]);
  fs.mkdirSync(path.dirname(WINDOWS_POWERSHELL_CACHE), { recursive: true });
  fs.copyFileSync(profileCache!, WINDOWS_POWERSHELL_CACHE);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
}

/**
 * Analyses every module on the module path under `env` and resolves the cache file PowerShell wrote. PowerShell saves the
 * cache on a timer seconds after an analysis and never at exit, so the script also analyses a probe module, which no cache
 * holds yet, and waits for a write after its start to close.
 */
async function warmPowerShellCache(env: NodeJS.ProcessEnv, probes: string): Promise<string> {
  const script = [
    `$env:PSModulePath = ${psQuote(`${probes};`)} + $env:PSModulePath`,
    `$cache = if ($env:PSModuleAnalysisCachePath) { $env:PSModuleAnalysisCachePath } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ${psQuote(WINDOWS_POWERSHELL_CACHE_IN_PROFILE)} }`,
    '$started = [DateTime]::UtcNow',
    'Get-Command | Out-Null',
    "while ($true) { if ([IO.File]::GetLastWriteTimeUtc($cache) -ge $started) { try { [IO.File]::Open($cache, 'Open', 'Read', 'None').Dispose(); break } catch {} }; Start-Sleep -Milliseconds 200 }",
    '[Console]::Out.Write($cache)',
  ].join('; ');
  const started = Date.now();
  const { stdout: cache } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env,
    encoding: 'utf8',
    timeout: POWERSHELL_WARM_TIMEOUT_MS,
    windowsHide: true,
  }).catch((error: unknown) => {
    const reason = (error as { killed?: boolean }).killed ? `no save within ${POWERSHELL_WARM_TIMEOUT_MS / 1000} s` : error instanceof Error ? error.message : String(error);
    throw new Error(`Warming Windows PowerShell's module analysis cache failed: ${reason}`);
  });
  console.log(`Warmed Windows PowerShell's module analysis cache ${cache} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return cache;
}
