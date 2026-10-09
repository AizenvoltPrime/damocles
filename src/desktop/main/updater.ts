import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { Disposable } from '../../platform/disposable';
import type { Memento } from '../../platform/key-value-state';
import type { NotificationService } from '../../platform/notification-service';
import type { ShellService } from '../../platform/shell-service';
import type { ShellPlatform } from '../preload/shell-channels';
import { canCheck, type UpdateSnapshot, type UpdateState, type VersionInfo } from '../preload/updates';
import { Emitter } from './platform/emitter';

// updater.test.ts keeps this equal to package.json repository.url.
export const RELEASES_URL = 'https://github.com/AizenvoltPrime/damocles/releases';

// Global KeyValueState: epoch ms of the last check that reached the feed.
export const LAST_CHECKED_KEY = 'damocles.desktop.update.lastCheckedAt';
// The periodic check, and how old the last check must be for a resume from sleep to check again.
export const CHECK_INTERVAL_MS: number = 4 * 60 * 60 * 1000;

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_REASON_LENGTH = 300;
// Characters of the feed's release notes kept for About and the pill; a GitHub release body is a few KB.
const MAX_NOTES_LENGTH = 64 * 1024;

// auto: the start and the periodic and resume checks. help: Help › Check for Updates, which also answers "up to date" and a
// failed check with a notice. about: Settings › About, whose version card shows those two results, so only the states
// that need the user (ready, available, a failed download) post one.
export type CheckOrigin = 'auto' | 'help' | 'about';

export interface UpdaterDeps {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  // the running version
  readonly version: string;
  readonly notifications: NotificationService;
  readonly shell: ShellService;
  // global KeyValueState
  readonly state: Memento;
  // powerMonitor resume
  readonly onResume: (listener: () => void) => Disposable;
  readonly t: (message: string, ...args: Array<string | number | boolean>) => string;
  readonly log: (line: string) => void;
  readonly showLog: () => void;
  // loadAutoUpdater in the app; called only in the packaged app, after start has returned
  readonly load: () => AppUpdater;
  // the app's quit, which asks about running terminals and unsaved editors; true when the user cancelled it
  readonly quit: () => Promise<boolean>;
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

export function shellPlatform(platform: NodeJS.Platform): ShellPlatform {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

/** What Copy version info puts on the clipboard. */
export function versionInfoText(info: VersionInfo): string {
  return [`Damocles ${info.version}`, `Electron ${info.electron}`, `Chromium ${info.chromium}`, `Node.js ${info.node}`, `${info.platform} ${info.arch}`].join('\n');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

function reason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split('\n', 1)[0]!.trim();
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH)}...` : line;
}

// The GitHub feed gives the release body as HTML, a generic feed markdown, and a full-changelog feed one note per version.
function notesText(notes: UpdateInfo['releaseNotes']): string {
  const text = typeof notes === 'string' ? notes : (notes ?? []).flatMap((entry) => entry.note ?? []).join('\n\n');
  return text.slice(0, MAX_NOTES_LENGTH);
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

/**
 * The desktop update state (plan AD9), which main owns and pushes whole to the renderers. Windows and Linux download in
 * the background and offer a restart; macOS links to the release page. Checks run after the window is up, every
 * CHECK_INTERVAL_MS, on a resume from sleep once the last check is that old, and on demand; a check while one runs, a
 * download is under way or an update waits is a no-op.
 */
export class UpdateService {
  private readonly deps: UpdaterDeps;
  private readonly changed: Emitter<[UpdateSnapshot]>;
  private current: UpdateState;
  private lastCheckedAt: number | null;
  private updater: AppUpdater | undefined;
  private origin: CheckOrigin = 'auto';
  private readonly seen = new WeakSet<object>();
  private errorShown = false;
  // A Help check's failure is told once; electron-updater emits and rejects with it.
  private checkFailureShown = false;
  // A failed check (offline, a captive portal, a firewall on github.com) happens on every such launch and is only logged;
  // once the current check found an update, the first failure to download, install or offer it in this run is shown.
  private updateFound = false;
  private started = false;
  private disposed = false;
  private pending: NodeJS.Immediate | undefined;
  private timer: NodeJS.Timeout | undefined;
  private resume: Disposable | undefined;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.changed = new Emitter('updater', deps.log);
    this.current = deps.isPackaged ? { kind: 'idle' } : { kind: 'disabled' };
    const stored = deps.state.get<unknown>(LAST_CHECKED_KEY);
    this.lastCheckedAt = typeof stored === 'number' && Number.isFinite(stored) ? stored : null;
  }

  /** Call once the window is up; returns before electron-updater loads, so startup never waits on it or the network. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.current.kind === 'disabled') {
      this.deps.log('[updater] off: the app is not packaged');
      return;
    }
    this.pending = setImmediate(() => this.check('auto'));
    this.resume = this.deps.onResume(() => {
      if (this.lastCheckedAt === null || Date.now() - this.lastCheckedAt >= CHECK_INTERVAL_MS) this.check('auto');
    });
  }

  snapshot(): UpdateSnapshot {
    return { state: this.current, lastCheckedAt: this.lastCheckedAt, platform: shellPlatform(this.deps.platform) };
  }

  onDidChange(listener: (snapshot: UpdateSnapshot) => void): Disposable {
    return this.changed.add(listener);
  }

  check(origin: CheckOrigin): void {
    const kind = this.current.kind;
    if (!this.started || this.disposed || !canCheck(this.current)) {
      this.deps.log(`[updater] ${origin} check skipped while ${kind}`);
      return;
    }
    this.origin = origin;
    this.updateFound = false;
    this.checkFailureShown = false;
    this.schedule();
    this.setState({ kind: 'checking' });
    this.run(origin).catch((err: unknown) => this.fail(err));
  }

  /**
   * Quits, then installs the downloaded update unless the user cancelled the quit; refused unless one is ready, so a second
   * press while the quit runs is refused too (a second quitAndInstall clears electron-updater's install guard).
   */
  restart(): void {
    const ready = this.current;
    if (ready.kind !== 'ready' || !this.updater) throw new Error('No update is ready to install');
    const { version } = ready;
    const updater = this.updater;
    this.deps.log(`[updater] restarting to install ${version}`);
    this.setState({ ...ready, kind: 'restarting' });
    // electron-updater starts the installer before it quits, so the quit runs first (abstractUpdateService.ts:534).
    this.deps.quit().then((cancelled) => {
      if (!cancelled) {
        updater.quitAndInstall();
        return;
      }
      this.deps.log(`[updater] the restart to install ${version} was cancelled`);
      this.setState(ready);
    }).catch((err: unknown) => this.deps.log(`[updater] the installer did not start: ${errorText(err)}`));
  }

  /** macOS: opens the available version's release page; refused unless one is available. */
  async openReleasePage(): Promise<void> {
    if (this.current.kind !== 'available') throw new Error('No update is available');
    const url = releasePageUrl(this.current.version);
    this.deps.log(`[updater] opening the release page ${url}`);
    if (!(await this.deps.shell.openExternal(url))) this.deps.log(`[updater] the release page did not open: ${url}`);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending) clearImmediate(this.pending);
    clearTimeout(this.timer);
    this.resume?.dispose();
    this.updater?.off('error', this.onError);
    this.updater?.off('download-progress', this.onProgress);
    this.changed.clear();
  }

  private readonly onError = (err: Error): void => this.fail(err);

  private readonly onProgress = (progress: ProgressInfo): void => {
    if (this.current.kind !== 'downloading') return;
    const percent = Math.min(100, Math.max(0, Math.floor(progress.percent)));
    this.setState({ ...this.current, percent });
  };

  // A periodic check skipped while an update is under way still schedules the next one.
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.schedule();
      this.check('auto');
    }, CHECK_INTERVAL_MS);
  }

  // Pushes only a changed state, so a repeated progress percent or error sends nothing.
  private setState(state: UpdateState): void {
    if (this.disposed || JSON.stringify(state) === JSON.stringify(this.current)) return;
    // drive-update.mjs reads these lines: a loopback download can finish before it sees the pill's percent.
    if (state.kind !== this.current.kind) this.deps.log(`[updater] state ${state.kind}${'version' in state ? ` ${state.version}` : ''}`);
    this.current = state;
    this.changed.fire(this.snapshot());
  }

  private loaded(): AppUpdater {
    if (this.updater) return this.updater;
    const updater = this.deps.load();
    configure(updater, this.deps);
    updater.on('error', this.onError);
    updater.on('download-progress', this.onProgress);
    this.updater = updater;
    return updater;
  }

  private async run(origin: CheckOrigin): Promise<void> {
    const updater = this.loaded();
    const result = await updater.checkForUpdates();
    if (this.disposed) return;
    const checkedAt = Date.now();
    this.lastCheckedAt = checkedAt;
    // The check reached the feed whether or not its time is stored, and a found update downloads either way.
    this.deps.state.update(LAST_CHECKED_KEY, checkedAt).catch((err: unknown) => this.deps.log(`[updater] could not record the check time: ${reason(err)}`));
    if (result?.isUpdateAvailable !== true) {
      this.setState({ kind: 'upToDate', checkedAt });
      if (origin === 'help') await this.deps.notifications.info(this.deps.t('Damocles {0} is up to date.', this.deps.version));
      return;
    }
    this.updateFound = true;
    const { version } = result.updateInfo;
    const notes = notesText(result.updateInfo.releaseNotes);
    if (this.deps.platform === 'darwin') {
      const url = releasePageUrl(version);
      this.deps.log(`[updater] ${version} is available at ${url}`);
      this.setState({ kind: 'available', version, notes });
      await this.offerReleasePage(version);
      return;
    }
    this.setState({ kind: 'downloading', version, percent: 0 });
    await result.downloadPromise;
    if (this.disposed) return;
    this.setState({ kind: 'ready', version, notes });
    await this.offerRestart(version);
  }

  private async offerRestart(version: string): Promise<void> {
    const { t } = this.deps;
    const restart = t('Restart Now');
    // deb and rpm install through electron-updater's pkexec, which asks for an administrator password.
    const message = this.deps.platform === 'linux'
      ? t('Damocles {0} is ready. Restart now to install it, or it installs when you quit. Installing asks for an administrator password.', version)
      : t('Damocles {0} is ready. Restart now to install it, or it installs when you quit.', version);
    if ((await this.deps.notifications.info(message, restart)) !== restart) this.deps.log(`[updater] ${version} installs when Damocles quits`);
    // The pill or About may have started the restart while the notice showed.
    else if (this.current.kind === 'ready') this.restart();
  }

  private async offerReleasePage(version: string): Promise<void> {
    const open = this.deps.t('Open Release Page');
    const answer = await this.deps.notifications.info(this.deps.t('Damocles {0} is available. Download it from the release page to update.', version), open);
    if (answer === open && this.current.kind === 'available') await this.openReleasePage();
  }

  // electron-updater both emits and rejects with the same error, so each is logged once and only the first is shown.
  private fail(err: unknown): void {
    const known = typeof err === 'object' && err !== null && this.seen.has(err);
    if (typeof err === 'object' && err !== null) this.seen.add(err);
    if (!known) this.deps.log(`[updater] failed: ${errorText(err)}`);
    this.setState({ kind: 'error', reason: reason(err) });
    if (this.disposed) return;
    const { t, notifications } = this.deps;
    const showLogAction = t('Show Log');
    let notice: Promise<string | undefined>;
    if (this.updateFound) {
      if (this.errorShown) return;
      this.errorShown = true;
      notice = notifications.warn(t('Damocles could not update itself: {0}', reason(err)), showLogAction);
    } else if (this.origin === 'help' && !this.checkFailureShown) {
      this.checkFailureShown = true;
      notice = notifications.warn(t('Damocles could not check for updates: {0}', reason(err)), showLogAction);
    } else {
      return;
    }
    notice.then((answer) => {
      if (answer === showLogAction) this.deps.showLog();
    }, (notifyErr: unknown) => this.deps.log(`[updater] could not show the update error: ${errorText(notifyErr)}`));
  }
}
