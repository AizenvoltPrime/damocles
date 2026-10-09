import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { EXTENSION_EXTERNALS } from '../../scripts/extension-externals.mjs';
import { hermeticEnv, REPO_ROOT, WINDOWS_POWERSHELL_CACHE, WINDOWS_POWERSHELL_CACHE_IN_PROFILE } from './support/hermetic';
import { PACKAGED_APP_ENV, packagedAppPath } from './support/packaged-app';
import { SECOND_PROCESS_BUNDLE } from './support/second-process';

export default async function globalSetup(): Promise<void> {
  const packaged = packagedAppPath();
  if (packaged !== undefined) {
    if (!fs.existsSync(packaged)) throw new Error(`${PACKAGED_APP_ENV} names ${packaged}, which does not exist; build the app with \`npm run dist\` first`);
  } else {
    for (const built of ['dist/desktop/main.js', 'dist/desktop/preload-panel.js', 'dist/webview/index.html']) {
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
}

// Analysing a runner's whole module path takes minutes, never more than this.
const POWERSHELL_WARM_TIMEOUT_MS = 600_000;

/**
 * Builds Windows PowerShell 5.1's module analysis cache in a hermetic profile and keeps it as WINDOWS_POWERSHELL_CACHE.
 * PowerShell saves the cache on a timer seconds after the analysis, never at exit, so the script waits for the file to be
 * written and closed.
 */
function warmWindowsPowerShellCache(): void {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dps')));
  const home = path.join(root, 'h');
  for (const dir of [path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  const cache = path.join(home, 'AppData', 'Local', WINDOWS_POWERSHELL_CACHE_IN_PROFILE);
  const script = [
    'Get-Command | Out-Null',
    `while ($true) { try { [IO.File]::Open('${cache}', 'Open', 'Read', 'None').Dispose(); break } catch { Start-Sleep -Milliseconds 200 } }`,
  ].join('; ');
  const started = Date.now();
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    // ProgramFiles as the terminal specs pass it; the cache is keyed by module path, so it covers launches without it too.
    env: hermeticEnv({ root, home }, process.env['ProgramFiles'] === undefined ? {} : { ProgramFiles: process.env['ProgramFiles'] }),
    encoding: 'utf8',
    timeout: POWERSHELL_WARM_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Warming Windows PowerShell's module analysis cache failed (${result.error?.message ?? `exit ${result.status}`}): ${result.stderr}`);
  }
  fs.mkdirSync(path.dirname(WINDOWS_POWERSHELL_CACHE), { recursive: true });
  fs.copyFileSync(cache, WINDOWS_POWERSHELL_CACHE);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
  console.log(`Warmed Windows PowerShell's module analysis cache in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
