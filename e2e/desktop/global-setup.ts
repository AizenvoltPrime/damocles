import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  if (process.platform === 'win32') warmWindowsPowerShellCache();
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

/**
 * Builds Windows PowerShell 5.1's module analysis cache that a terminal reads and keeps a copy as WINDOWS_POWERSHELL_CACHE.
 * A terminal starts with the registry's variables over the launch's, so a machine-wide PSModuleAnalysisCachePath (GitHub's
 * Windows images set one) names its cache instead of the profile's, and that file is warmed in place. PowerShell saves the
 * cache on a timer seconds after an analysis and never at exit, so the script analyses a probe module and waits for a write
 * after its start to close.
 */
function warmWindowsPowerShellCache(): void {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dps')));
  const home = path.join(root, 'h');
  for (const dir of [path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  const probes = path.join(root, 'probe');
  fs.mkdirSync(path.join(probes, CACHE_PROBE_MODULE), { recursive: true });
  fs.writeFileSync(path.join(probes, CACHE_PROBE_MODULE, `${CACHE_PROBE_MODULE}.psm1`), `function Get-${CACHE_PROBE_MODULE} {}\n`);
  const script = [
    `$env:PSModulePath = ${psQuote(`${probes};`)} + $env:PSModulePath`,
    `$cache = if ($env:PSModuleAnalysisCachePath) { $env:PSModuleAnalysisCachePath } else { Join-Path $env:LOCALAPPDATA ${psQuote(WINDOWS_POWERSHELL_CACHE_IN_PROFILE)} }`,
    '$started = [DateTime]::UtcNow',
    'Get-Command | Out-Null',
    "while ($true) { if ([IO.File]::GetLastWriteTimeUtc($cache) -ge $started) { try { [IO.File]::Open($cache, 'Open', 'Read', 'None').Dispose(); break } catch {} }; Start-Sleep -Milliseconds 200 }",
    '[Console]::Out.Write($cache)',
  ].join('; ');
  const started = Date.now();
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    // the environment a terminal starts with, and ProgramFiles as the terminal specs pass it
    env: windowsTerminalEnvironment(hermeticEnv({ root, home }, process.env['ProgramFiles'] === undefined ? {} : { ProgramFiles: process.env['ProgramFiles'] }), (line) => console.log(line)),
    encoding: 'utf8',
    timeout: POWERSHELL_WARM_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Warming Windows PowerShell's module analysis cache failed (${result.error?.message ?? `exit ${result.status}`}): ${result.stderr}`);
  }
  const cache = result.stdout;
  fs.mkdirSync(path.dirname(WINDOWS_POWERSHELL_CACHE), { recursive: true });
  fs.copyFileSync(cache, WINDOWS_POWERSHELL_CACHE);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
  console.log(`Warmed Windows PowerShell's module analysis cache ${cache} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
