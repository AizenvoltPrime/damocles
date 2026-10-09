import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startFeedServer } from '../../../scripts/desktop-update-feed.mjs';
import { writeOverride } from '../../../scripts/desktop-update-override.mjs';
import { isEntryPoint } from '../../../scripts/entry-point.mjs';
import {
  aboutRestart,
  aboutUpdateStatus,
  NOTIFIER_URL,
  noticeAction,
  OVERLAY_URL,
  PILL_AVAILABLE,
  PILL_READY,
  RELEASE_PAGE_ACTION,
  RESTART_ACTION,
  SHELL_URL,
  updatePill,
} from './update-notice.mjs';

// Installs version N of the packaged desktop app, points it at a loopback feed holding N+1, and checks the
// update end to end. Windows and Linux: the app must download N+1 and the title-bar pill read "Restart to update", the
// notice must offer "Restart Now", Settings › About must show the ready state, and its Restart must install and relaunch
// N+1. macOS: the pill must read "Update available", and the notice's action must target the N+1 release page. Drives
// the real renderers over --remote-debugging-port, which reaches renderers only; the app itself carries no test hook.

const USAGE = `Usage: node e2e/desktop/update/drive-update.mjs --platform <win32|linux|darwin> --installer <file>
         --feed-dir <dir> --from-version <N> --to-version <N+1> [--mode restart|quit] [--work-dir <dir>]
         [--grant-pkexec] [--timeout-s <seconds>]

--installer     version N: the NSIS .exe (win32), the .deb (linux) or the .dmg (darwin)
--feed-dir      electron-builder output of N+1: its latest*.yml plus the installer and blockmap it names
--mode          restart (default): press Restart in Settings › About; quit: close the window and let install-on-quit run.
                Ignored on darwin, where the notice's "Open Release Page" action is taken.
--work-dir      scratch directory without spaces (default: a new temp dir)
--grant-pkexec  linux on GitHub Actions only: add a polkit rule letting this user run /bin/bash through pkexec
                without a password, so electron-updater's own pkexec path runs unattended (removed afterwards)

Refuses to run where Damocles is already installed (HKCU uninstall entry or the damocles package), and
uninstalls what it installed when it finishes, pass or fail.
--timeout-s     overall wait for each phase (default 600)

Exits 0 on success, 1 on a failed check, 2 on a usage error.`;

const RELEASES_URL = 'https://github.com/AizenvoltPrime/damocles/releases';
const POLKIT_RULE = '/etc/polkit-1/rules.d/00-damocles-update-test.rules';

function say(line) {
  console.log(`[drive-update] ${line}`);
}

function run(command, args, options = {}) {
  say(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10 * 60_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Polls until check returns a value; failFast throws as soon as the app logs an updater failure.
async function waitFor(what, timeoutMs, check, failFast = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    failFast();
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(1000);
  }
}

// --- per-platform install and version checks ---

const windows = {
  // The per-user Uninstall key appears only with the first per-user install, so its absence means nothing is installed.
  // Any other registry error fails the run.
  uninstallEntry() {
    const out = powershell(
      "$ErrorActionPreference = 'Stop'; " +
      "$root = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; " +
      "if (Test-Path -LiteralPath $root) { " +
      "$k = Get-ItemProperty -Path \"$root\\*\" | Where-Object { $_.DisplayName -like 'Damocles*' } | Select-Object -First 1; " +
      "if ($k) { \"$($k.DisplayVersion)|$($k.UninstallString)\" } }",
    );
    if (out === '') return undefined;
    const [version, uninstall] = out.split('|');
    const quoted = /^"([^"]+)"/.exec(uninstall ?? '');
    if (!quoted) throw new Error(`Unexpected UninstallString: ${uninstall}`);
    return { version, installDir: dirname(quoted[1]), uninstaller: quoted[1] };
  },
  // A per-user install with the same appId would replace the user's real install, so an existing one stops the run.
  refuseExisting() {
    const existing = windows.uninstallEntry();
    if (existing) throw new Error(`Damocles ${existing.version} is already installed at ${existing.installDir}; run this only where no Damocles is installed`);
  },
  install(installer, work) {
    const target = join(work, 'app');
    run(installer, ['/S', `/D=${target}`]);
    const entry = windows.uninstallEntry();
    if (!entry) throw new Error('The installer left no per-user uninstall entry');
    if (!isInside(work, entry.installDir)) throw new Error(`The installer ignored /D and installed to ${entry.installDir}, outside ${work}`);
    return entry.installDir;
  },
  executable: (installDir) => join(installDir, 'Damocles.exe'),
  installedVersion(installDir) {
    const entry = windows.uninstallEntry();
    if (!entry) return undefined;
    const product = powershell(`(Get-Item -LiteralPath '${windows.executable(installDir)}').VersionInfo.ProductVersion`);
    return { registry: entry.version, binary: product };
  },
  matches: (installed, version) => installed?.registry === version && installed.binary.startsWith(version.split('-')[0]),
  // The installer starts the app through its shortcut with only --updated, so the relaunch shares none of this run's
  // arguments or its log; a browser process of this install running after version N exited is the relaunch.
  relaunched: ({ installDir }) => powershell(
    "$ErrorActionPreference = 'Stop'; " +
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${installDir}\\*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`,
  ) !== '',
  writeOverride: (installDir, url) => writeOverride(installDir, url),
  stop(installDir) {
    // Get-Process -Name exits 1 when nothing matches, so the whole list is filtered by path instead.
    powershell(`Get-Process | Where-Object { $_.Path -like '${installDir}\\*' } | Stop-Process -Force`);
  },
  // The NSIS uninstaller copies itself to %TEMP% and returns before it has finished, so the entry is polled.
  async uninstall(timeoutMs) {
    const entry = windows.uninstallEntry();
    if (!entry) return;
    run(entry.uninstaller, ['/S', '/currentuser']);
    await waitFor('the test install to be uninstalled', timeoutMs, () => windows.uninstallEntry() === undefined);
    say(`uninstalled ${entry.installDir}`);
  },
};

const linux = {
  // Installing replaces the system package in /opt, so an existing one stops the run.
  refuseExisting() {
    const existing = linux.installedVersion();
    if (existing) throw new Error(`damocles ${existing.package} is already installed; run this only where no Damocles is installed`);
  },
  install(installer) {
    run('sudo', ['apt-get', 'install', '-y', resolve(installer)]);
    const files = run('dpkg', ['-L', 'damocles']).split('\n');
    const yml = files.find((file) => file.endsWith('/resources/app-update.yml'));
    if (!yml) throw new Error('The deb installed no resources/app-update.yml');
    return dirname(dirname(yml));
  },
  executable: (installDir) => join(installDir, 'damocles'),
  installedVersion() {
    const result = spawnSync('dpkg-query', ['-W', '-f=${db:Status-Status}|${Version}', 'damocles'], { encoding: 'utf8' });
    if (result.status !== 0) return undefined;
    const [status, version] = result.stdout.trim().split('|');
    return status === 'installed' ? { package: version } : undefined;
  },
  // Debian versions may spell a semver prerelease separator as '~'.
  matches: (installed, version) => installed?.package.replace(/~/g, '-') === version,
  // app.relaunch() starts the app with its original arguments, so the relaunched version logs to the same file.
  relaunched: ({ logFile, version }) => readLog(logFile).includes(`Damocles desktop starting (version ${version},`),
  // The installed tree is root-owned, so the writer runs under sudo with the same Node.
  writeOverride(installDir, url) {
    const script = fileURLToPath(new URL('../../../scripts/desktop-update-override.mjs', import.meta.url));
    run('sudo', [process.execPath, script, '--install-dir', installDir, '--url', url]);
  },
  stop(installDir) {
    spawnSync('pkill', ['-f', `^${linux.executable(installDir)}`]);
  },
  async uninstall() {
    if (!linux.installedVersion()) return;
    run('sudo', ['apt-get', 'remove', '-y', 'damocles']);
    say('removed the damocles package');
  },
  // Only for this user and only for the program electron-updater's LinuxUpdater runs through pkexec (bash -c '<dpkg -i ...>').
  grantPkexec() {
    // Without pkexec and polkit, electron-updater falls back to sudo and the run would pass without testing pkexec.
    if (!existsSync(dirname(POLKIT_RULE))) throw new Error(`${dirname(POLKIT_RULE)} does not exist; install pkexec and polkitd first`);
    if (spawnSync('sh', ['-c', 'command -v pkexec']).status !== 0) throw new Error('pkexec is not installed');
    const user = run('id', ['-un']);
    const rule = [
      'polkit.addRule(function (action, subject) {',
      `  var program = action.lookup("program");`,
      `  if (action.id === "org.freedesktop.policykit.exec" && subject.user === ${JSON.stringify(user)} && (program === "/bin/bash" || program === "/usr/bin/bash")) return polkit.Result.YES;`,
      '});',
      '',
    ].join('\n');
    run('sudo', ['tee', POLKIT_RULE], { input: rule });
  },
  revokePkexec() {
    run('sudo', ['rm', '-f', POLKIT_RULE]);
  },
};

const mac = {
  install(installer, work) {
    const mount = join(work, 'dmg');
    mkdirSync(mount, { recursive: true });
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, resolve(installer)]);
    try {
      run('ditto', [join(mount, 'Damocles.app'), join(work, 'Damocles.app')]);
    } finally {
      run('hdiutil', ['detach', mount]);
    }
    return join(work, 'Damocles.app');
  },
  executable: (appDir) => join(appDir, 'Contents', 'MacOS', 'Damocles'),
  // The override edits a sealed resource, so the test copy is re-signed ad hoc like the shipped build.
  writeOverride(appDir, url) {
    writeOverride(appDir, url);
    run('codesign', ['--force', '--deep', '--sign', '-', appDir]);
  },
};

// --- the app under test ---

// The caller's environment minus anything that changes how Electron starts (ELECTRON_RUN_AS_NODE from a VS Code
// terminal turns the app into Node), with the home and the per-user app data folders moved into the work dir.
function appEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ELECTRON_') && key !== 'NODE_OPTIONS'));
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  };
}

function launch(executable, work, port) {
  const home = join(work, 'home');
  const userData = join(work, 'user-data');
  mkdirSync(home, { recursive: true });
  mkdirSync(userData, { recursive: true });
  // The runner's macOS Keychain would prompt modally and block the main thread; the e2e launchers pass the same switches.
  const args = ['--user-data-dir', userData, '--use-mock-keychain', '--password-store=basic', `--remote-debugging-port=${port}`, '--lang=en-US'];
  say(`launching ${executable} ${args.join(' ')}`);
  const child = spawn(executable, args, {
    env: appEnv(home),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { child, logFile: join(userData, 'logs', 'Damocles.log') };
}

function readLog(logFile) {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

function failOnUpdaterError(logFile) {
  return () => {
    const failure = readLog(logFile).split('\n').find((line) => line.includes('[updater] failed:'));
    if (failure) throw new Error(`The app reported an update failure: ${failure}`);
  };
}

async function appPages(port, timeoutMs, failFast) {
  const browser = await waitFor(`the app's debugging port ${port}`, timeoutMs, async () => {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    } catch (err) {
      say(`debugging port not ready: ${err.message.split('\n', 1)[0]}`);
      return undefined;
    }
  }, failFast);
  const pageAt = (url) => browser.contexts().flatMap((context) => context.pages()).find((p) => p.url() === url);
  const shell = await waitFor('the shell page', timeoutMs, () => pageAt(SHELL_URL), failFast);
  return { browser, shell, pageAt };
}

// The pill's data-state is the update state main pushed; a loopback download may end before a poll sees its percent, so
// the downloading state is read from main's state log lines instead.
async function pillShows(shell, state, label, timeoutMs, failFast) {
  const pill = updatePill(shell);
  await waitFor(`the "${label}" pill`, timeoutMs, async () => {
    if ((await pill.count()) === 0 || (await pill.getAttribute('data-state')) !== state) return false;
    return (await pill.innerText()).includes(label);
  }, failFast);
  say(`title-bar pill reads "${label}"`);
}

function assertDownloadedBeforeReady(logFile, version) {
  const states = readLog(logFile).split('\n').flatMap((line) => {
    const match = /\[updater\] state (downloading|ready) (\S+)$/.exec(line.trimEnd());
    return match ? [`${match[1]} ${match[2]}`] : [];
  });
  const downloading = states.indexOf(`downloading ${version}`);
  if (downloading === -1 || states.indexOf(`ready ${version}`) < downloading) {
    throw new Error(`Expected the downloading state, then ready, for ${version}; the log has ${JSON.stringify(states)}`);
  }
  say(`main reported downloading, then ready, for ${version}`);
}

// Restart from Settings › About, opened through the shell bridge the title-bar gear uses.
async function restartFromAbout(pages, timeoutMs, failFast) {
  await pages.shell.evaluate(() => window.damoclesShell.openSettings('about'));
  const overlay = await waitFor('the overlay page', timeoutMs, () => pages.pageAt(OVERLAY_URL), failFast);
  const status = aboutUpdateStatus(overlay);
  await waitFor('About showing the ready state', timeoutMs, async () => (await status.count()) > 0 && (await status.getAttribute('data-state')) === 'ready', failFast);
  say('Settings › About shows the ready state');
  return { overlay, button: aboutRestart(overlay) };
}

// The popup window's page exists once the first popup opened it, which the update notice may be.
async function toastActionShows(pages, label, timeoutMs, failFast) {
  const popup = await waitFor('the popup window page', timeoutMs, () => pages.pageAt(NOTIFIER_URL), failFast);
  const button = noticeAction(popup, label);
  await waitFor(`the "${label}" toast action`, timeoutMs, () => button.isVisible(), failFast);
  say(`toast action "${label}" is showing`);
  return { popup, button };
}

function disconnect(browser) {
  return browser.close().catch((err) => say(`debugging connection already closed: ${err.message.split('\n', 1)[0]}`));
}

// Answering the update notice quits the app, and a deb or rpm install first blocks its main process, so Chromium may
// acknowledge the action only as the app quits, or never. The page or the connection closing completes the action too.
async function actionThatQuits({ browser, page }, action) {
  const closed = new Promise((resolve) => {
    browser.once('disconnected', resolve);
    page.once('close', resolve);
  });
  await Promise.race([
    action().catch((err) => {
      if (!page.isClosed() && browser.isConnected()) throw err;
    }),
    closed,
  ]);
}

// Runs every step even when one fails; a cleanup failure is reported without replacing the failure that led to it.
async function cleanUp(failed, steps) {
  const errors = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      errors.push(err);
    }
  }
  if (!failed && errors.length > 0) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Cleanup failed');
  for (const err of errors) say(`cleanup also failed: ${err.stack ?? err}`);
}

// --- flows ---

async function selfUpdate(target, options, work) {
  target.refuseExisting();
  let installDir;
  let feed;
  let browser;
  let failed = false;
  try {
    installDir = target.install(options.installer, work);
    say(`installed N at ${installDir}`);
    const before = target.installedVersion(installDir);
    if (!target.matches(before, options.fromVersion)) throw new Error(`Expected ${options.fromVersion} installed, found ${JSON.stringify(before)}`);
    feed = await startFeedServer({ dir: options.feedDir, log: say });
    target.writeOverride(installDir, feed.url);
    const port = await freePort();
    const { logFile, child: app } = launch(target.executable(installDir), work, port);
    const failFast = failOnUpdaterError(logFile);
    const pages = await appPages(port, options.timeoutMs, failFast);
    browser = pages.browser;
    await pillShows(pages.shell, 'ready', PILL_READY, options.timeoutMs, failFast);
    assertDownloadedBeforeReady(logFile, options.toVersion);
    await toastActionShows(pages, RESTART_ACTION, options.timeoutMs, failFast);
    if (options.mode === 'restart') {
      const restart = await restartFromAbout(pages, options.timeoutMs, failFast);
      await actionThatQuits({ browser, page: restart.overlay }, () => restart.button.click({ timeout: options.timeoutMs }));
    } else {
      say('closing the window so install-on-quit runs');
      await actionThatQuits({ browser, page: pages.shell }, () => pages.shell.evaluate(() => window.close()));
    }
    await disconnect(browser);
    browser = undefined;
    const after = await waitFor(`${options.toVersion} installed`, options.timeoutMs, () => {
      const installed = target.installedVersion(installDir);
      return target.matches(installed, options.toVersion) ? installed : undefined;
    });
    say(`installed version is now ${JSON.stringify(after)}`);
    if (options.mode === 'restart') {
      await waitFor(`version ${options.fromVersion} to exit`, options.timeoutMs, () => app.exitCode !== null || app.signalCode !== null);
      await waitFor(`the relaunched ${options.toVersion}`, options.timeoutMs, () => target.relaunched({ installDir, logFile, version: options.toVersion }));
      say(`${options.toVersion} relaunched`);
    }
    // Restart mode installs before the app quits, so electron-updater's elevation line reaches the log; install-on-quit runs after the log closes.
    if (options.grantPkexec && options.mode === 'restart') {
      const elevation = readLog(logFile).split('\n').find((line) => line.includes('using sudo to install:'));
      if (!elevation?.includes('pkexec')) throw new Error(`electron-updater did not elevate through pkexec: ${elevation ?? 'no elevation line in the log'}`);
      say(`elevation: ${elevation}`);
    }
    say(`app log:\n${readLog(logFile)}`);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await cleanUp(failed, [
      () => browser && disconnect(browser),
      // Stops the relaunched N+1 (restart mode) or a hung N; only processes of this test install.
      () => installDir && target.stop(installDir),
      () => feed?.close(),
      () => target.uninstall(options.timeoutMs),
    ]);
  }
}

async function macNotice(options, work) {
  const appDir = mac.install(options.installer, work);
  const feed = await startFeedServer({ dir: options.feedDir, log: say });
  let child;
  let browser;
  try {
    mac.writeOverride(appDir, feed.url);
    const port = await freePort();
    const launched = launch(mac.executable(appDir), work, port);
    child = launched.child;
    const failFast = failOnUpdaterError(launched.logFile);
    const pages = await appPages(port, options.timeoutMs, failFast);
    browser = pages.browser;
    await pillShows(pages.shell, 'available', PILL_AVAILABLE, options.timeoutMs, failFast);
    const open = await toastActionShows(pages, RELEASE_PAGE_ACTION, options.timeoutMs, failFast);
    await open.button.click();
    const expected = `[updater] opening the release page ${RELEASES_URL}/tag/v${options.toVersion}`;
    await waitFor(`the log line "${expected}"`, options.timeoutMs, () => readLog(launched.logFile).split('\n').some((line) => line.endsWith(expected)), failFast);
    const opened = readLog(launched.logFile).split('\n').filter((line) => line.includes('[updater] opening the release page'));
    if (opened.length !== 1) throw new Error(`Expected exactly one release page open, found ${opened.length}`);
    say(`notice action targets ${RELEASES_URL}/tag/v${options.toVersion}`);
    say(`app log:\n${readLog(launched.logFile)}`);
  } finally {
    if (browser) await disconnect(browser);
    if (child?.pid !== undefined && child.exitCode === null) process.kill(child.pid);
    await feed.close();
  }
}

function parseArgs(argv) {
  const options = { mode: 'restart', timeoutMs: 600_000, grantPkexec: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--grant-pkexec') {
      options.grantPkexec = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg === '--platform') options.platform = value;
    else if (arg === '--installer') options.installer = resolve(value);
    else if (arg === '--feed-dir') options.feedDir = resolve(value);
    else if (arg === '--from-version') options.fromVersion = value;
    else if (arg === '--to-version') options.toVersion = value;
    else if (arg === '--mode') options.mode = value;
    else if (arg === '--work-dir') options.workDir = resolve(value);
    else if (arg === '--timeout-s') options.timeoutMs = Number(value) * 1000;
    else throw new Error(`Unknown option ${arg}`);
  }
  for (const key of ['platform', 'installer', 'feedDir', 'fromVersion', 'toVersion']) {
    if (options[key] === undefined) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!['win32', 'linux', 'darwin'].includes(options.platform)) throw new Error('--platform must be win32, linux or darwin');
  if (options.platform !== process.platform) throw new Error(`--platform ${options.platform} does not match this machine (${process.platform})`);
  if (!['restart', 'quit'].includes(options.mode)) throw new Error('--mode must be restart or quit');
  if (options.grantPkexec && options.platform !== 'linux') throw new Error('--grant-pkexec is linux only');
  // The rule is passwordless root for bash until removed, so it is written only on a throwaway CI runner.
  if (options.grantPkexec && process.env.GITHUB_ACTIONS !== 'true') throw new Error('--grant-pkexec runs only on GitHub Actions runners');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('--timeout-s must be a positive number');
  return options;
}

async function main(options) {
  const work = options.workDir ?? mkdtempSync(join(tmpdir(), 'dmu-'));
  mkdirSync(work, { recursive: true });
  // NSIS takes /D=<dir> unquoted, so the scratch path must not contain spaces.
  if (/\s/.test(work)) throw new Error(`--work-dir must not contain spaces: ${work}`);
  say(`work dir ${work}`);
  writeFileSync(join(work, 'drive-update.json'), JSON.stringify({ ...options, startedAt: new Date().toISOString() }, null, 2));
  if (options.platform === 'darwin') {
    await macNotice(options, work);
    return;
  }
  if (options.platform === 'win32') {
    await selfUpdate(windows, options, work);
    return;
  }
  if (options.grantPkexec) linux.grantPkexec();
  try {
    await selfUpdate(linux, options, work);
  } finally {
    if (options.grantPkexec) linux.revokePkexec();
  }
}

if (isEntryPoint(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
  } else {
    try {
      await main(options);
      say('PASS');
    } catch (err) {
      console.error(`[drive-update] FAIL: ${err.stack ?? err}`);
      process.exit(1);
    }
  }
}
