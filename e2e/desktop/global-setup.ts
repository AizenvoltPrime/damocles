import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { EXTENSION_EXTERNALS } from '../../scripts/extension-externals.ts';
import { windowsTerminalEnvironment } from '../../src/desktop/main/workspace/windows-terminal-environment';
import { coreLog, launchDesktop } from './support/app';
import { createHermeticHome, hermeticEnv, REPO_ROOT, WINDOWS_POWERSHELL_CACHE } from './support/hermetic';
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
const execFileAsync = promisify(execFile);

// Windows PowerShell 5.1's own cache, by reflection: its analysis data, the file it reads and saves, and its writer and reader.
const POWERSHELL_CACHE_MEMBERS = [
  "$ErrorActionPreference = 'Stop'",
  "$data = [psobject].Assembly.GetType('System.Management.Automation.AnalysisCache').GetField('cacheData', [Reflection.BindingFlags]'NonPublic,Static').GetValue($null)",
  "$cache = $data.GetType().GetField('cacheStoreLocation', [Reflection.BindingFlags]'NonPublic,Static').GetValue($null)",
  "$serialize = $data.GetType().GetMethod('Serialize', [Reflection.BindingFlags]'NonPublic,Instance')",
  "$deserialize = $data.GetType().GetMethod('Deserialize', [Reflection.BindingFlags]'Public,NonPublic,Static')",
  "if (-not $cache -or -not $serialize -or -not $deserialize) { throw 'This PowerShell has no AnalysisCacheData.cacheStoreLocation, Serialize or Deserialize' }",
];

/**
 * Analyses every module on the module path, then saves the cache itself and reads it back until the file holds every entry:
 * PowerShell saves on its own only from a timer once analyses pause for 3 s, which also fires mid-analysis, and never at
 * exit. Serialize swallows its errors, and one meets a timer save writing the file, so a save is checked by reading it.
 */
const WARM_SCRIPT = [
  ...POWERSHELL_CACHE_MEMBERS,
  'Get-Command | Out-Null',
  '$saved = $false',
  'for ($i = 0; -not $saved -and $i -lt 50; $i++) { $serialize.Invoke($data, @($cache)) | Out-Null; try { $saved = $deserialize.Invoke($null, @($cache)).Entries.Count -ge $data.Entries.Count } catch { Start-Sleep -Milliseconds 200 } }',
  'if (-not $saved) { throw "$cache does not hold the $($data.Entries.Count) analysed modules after 50 saves" }',
  '[Console]::Out.Write($cache)',
].join('\n');

// A shell that reads the warmed cache: what its first command analyses that the cache lacks.
const CHECK_SCRIPT = [
  ...POWERSHELL_CACHE_MEMBERS,
  '$loaded = @($data.Entries.Keys)',
  'Get-Command | Out-Null',
  '$missing = @($data.Entries.Keys | Where-Object { $loaded -notcontains $_ })',
  'if ($missing.Count -gt 0) { throw "$cache lacks $($missing.Count) of the modules a shell analyses: $($missing -join \', \')" }',
].join('\n');

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
  const hermetic = hermeticEnv({ root, home });
  const terminal = windowsTerminalEnvironment(hermetic, (line) => console.log(line));
  const machineWide = Object.entries(terminal).some(([key, value]) => key.toUpperCase() === 'PSMODULEANALYSISCACHEPATH' && value);
  const [profileCache] = await Promise.all([warmPowerShellCache(hermetic), ...(machineWide ? [warmPowerShellCache(terminal)] : [])]);
  fs.mkdirSync(path.dirname(WINDOWS_POWERSHELL_CACHE), { recursive: true });
  fs.copyFileSync(profileCache!, WINDOWS_POWERSHELL_CACHE);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
}

/** Warms the cache a shell under `env` reads, checks a fresh shell finds every module in it, and resolves its path. */
async function warmPowerShellCache(env: NodeJS.ProcessEnv): Promise<string> {
  const started = Date.now();
  const cache = await runPowerShell(env, WARM_SCRIPT, 'Warming');
  const warmed = Date.now();
  await runPowerShell(env, CHECK_SCRIPT, 'Checking');
  console.log(`Warmed Windows PowerShell's module analysis cache ${cache} in ${((warmed - started) / 1000).toFixed(1)} s, checked in ${((Date.now() - warmed) / 1000).toFixed(1)} s`);
  return cache;
}

async function runPowerShell(env: NodeJS.ProcessEnv, script: string, step: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env,
    encoding: 'utf8',
    timeout: POWERSHELL_WARM_TIMEOUT_MS,
    windowsHide: true,
  }).catch((error: unknown) => {
    const reason = (error as { killed?: boolean }).killed ? `not done within ${POWERSHELL_WARM_TIMEOUT_MS / 1000} s` : error instanceof Error ? error.message : String(error);
    throw new Error(`${step} Windows PowerShell's module analysis cache failed: ${reason}`);
  });
  return stdout;
}
