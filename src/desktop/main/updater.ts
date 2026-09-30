import type { AppUpdater } from 'electron-updater';
import type { Disposable } from '../../platform/disposable';
import type { NotificationService } from '../../platform/notification-service';
import type { ShellService } from '../../platform/shell-service';

// updater.test.ts keeps this equal to package.json repository.url.
export const RELEASES_URL = 'https://github.com/AizenvoltPrime/damocles/releases';

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_REASON_LENGTH = 300;

export interface UpdaterDeps {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly notifications: NotificationService;
  readonly shell: ShellService;
  readonly t: (message: string, ...args: Array<string | number | boolean>) => string;
  readonly log: (line: string) => void;
  readonly showLog: () => void;
  // loadAutoUpdater in the app; called only in the packaged app, after startUpdater has returned
  readonly load: () => AppUpdater;
}

// electron-updater defines autoUpdater with an exports getter that an ESM import() namespace does not carry, so it is required.
export function loadAutoUpdater(): AppUpdater {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('electron-updater') as { readonly autoUpdater: AppUpdater }).autoUpdater;
}

// The macOS notice opens this page and nothing else, so the feed's version must be a plain release version.
export function releasePageUrl(version: string): string {
  if (!RELEASE_VERSION.test(version)) throw new Error(`The update feed named an invalid version: ${JSON.stringify(version)}`);
  return `${RELEASES_URL}/tag/v${version}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

function reason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split('\n', 1)[0]!.trim();
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH)}...` : line;
}

// The feed is only the packaged resources/app-update.yml; updater.test.ts rejects any feed override, dev config or env read here.
function configure(updater: AppUpdater, deps: UpdaterDeps): void {
  const selfUpdates = deps.platform !== 'darwin';
  updater.logger = {
    info: (message?: unknown) => deps.log(`[updater] ${String(message)}`),
    warn: (message?: unknown) => deps.log(`[updater] warning: ${String(message)}`),
    error: (message?: unknown) => deps.log(`[updater] error: ${String(message)}`),
  };
  updater.allowPrerelease = false;
  // No NSIS web installer ships, so its download path stays closed.
  updater.disableWebInstaller = true;
  updater.autoDownload = selfUpdates;
  updater.autoInstallOnAppQuit = selfUpdates;
  // Both Windows architectures publish from one release, so each reads its own latest-<arch>.yml.
  if (deps.platform === 'win32') updater.channel = `latest-${deps.arch}`;
  // After the channel: electron-updater's channel setter turns allowDowngrade on.
  updater.allowDowngrade = false;
}

// Checks once, after the window is up; Windows and Linux download and offer a restart, macOS links to the release page.
export function startUpdater(deps: UpdaterDeps): Disposable {
  if (!deps.isPackaged) {
    deps.log('[updater] off: the app is not packaged');
    return { dispose: () => undefined };
  }
  const { notifications, t, log } = deps;
  const seen = new WeakSet<object>();
  let errorShown = false;
  let disposed = false;
  let updater: AppUpdater | undefined;
  // A failed check (offline, a captive portal, a firewall on github.com) happens on every such launch and is only logged;
  // once an update was found, a failure to download, install or offer it is shown.
  let updateFound = false;

  // electron-updater both emits and rejects with the same error, so each is logged once and only the first is shown.
  const fail = (err: unknown): void => {
    const known = typeof err === 'object' && err !== null && seen.has(err);
    if (typeof err === 'object' && err !== null) seen.add(err);
    if (!known) log(`[updater] failed: ${errorText(err)}`);
    if (!updateFound || errorShown || disposed) return;
    errorShown = true;
    const showLogAction = t('Show Log');
    notifications.warn(t('Damocles could not update itself: {0}', reason(err)), showLogAction).then((answer) => {
      if (answer === showLogAction) deps.showLog();
    }, (notifyErr: unknown) => log(`[updater] could not show the update error: ${errorText(notifyErr)}`));
  };
  const onError = (err: Error): void => fail(err);

  const offerRestart = async (current: AppUpdater, version: string): Promise<void> => {
    const restart = t('Restart Now');
    // deb and rpm install through electron-updater's pkexec, which asks for an administrator password.
    const message = deps.platform === 'linux'
      ? t('Damocles {0} is ready. Restart now to install it, or it installs when you quit. Installing asks for an administrator password.', version)
      : t('Damocles {0} is ready. Restart now to install it, or it installs when you quit.', version);
    const answer = await notifications.info(message, restart);
    if (answer !== restart) {
      log(`[updater] ${version} installs when Damocles quits`);
      return;
    }
    log(`[updater] restarting to install ${version}`);
    current.quitAndInstall();
  };

  const offerReleasePage = async (version: string): Promise<void> => {
    const url = releasePageUrl(version);
    log(`[updater] ${version} is available at ${url}`);
    const open = t('Open Release Page');
    const answer = await notifications.info(t('Damocles {0} is available. Download it from the release page to update.', version), open);
    if (answer !== open) return;
    log(`[updater] opening the release page ${url}`);
    if (!(await deps.shell.openExternal(url))) log(`[updater] the release page did not open: ${url}`);
  };

  const run = async (): Promise<void> => {
    const loaded = deps.load();
    updater = loaded;
    configure(loaded, deps);
    loaded.on('error', onError);
    const result = await loaded.checkForUpdates();
    if (result?.isUpdateAvailable !== true || disposed) return;
    updateFound = true;
    const version = result.updateInfo.version;
    if (deps.platform === 'darwin') {
      await offerReleasePage(version);
      return;
    }
    await result.downloadPromise;
    if (!disposed) await offerRestart(loaded, version);
  };
  // Deferred so loading electron-updater never runs inside the startup call.
  const pending = setImmediate(() => {
    run().catch(fail);
  });

  return {
    dispose: () => {
      disposed = true;
      clearImmediate(pending);
      updater?.off('error', onError);
    },
  };
}
