import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isInsideRealRoot, type Project } from '../../local-services/confine';
import { isValidFileName } from '../../preload/file-names';
import { MAX_COPY_IN_PATHS, type FileRef, type FilesCopyInRequest, type FilesDropRowRequest, type FilesPasteResult, type FilesTransferStartResult } from '../../preload/shell-channels';
import { visibleText } from '../../../shared/visible-text';
import type { AskCheckedMessage } from '../message-dialog';
import type { FilesTarget } from './file-tree';
import type { TransferKind } from '../../workspace/transfer-ops';
import type { FilesClipboard } from './files-clipboard';
import type { TransferRequest } from './file-transfer';

export const LAST_DOWNLOAD_FOLDER_KEY = 'files.lastDownloadFolder';

export interface TransferGestureDeps {
  readonly start: (request: TransferRequest) => Promise<FilesTransferStartResult>;
  readonly connected: (projectKey: string) => boolean;
  // false while the project's host is connected to a Damocles server that carries no transfers
  readonly transfers: (projectKey: string) => boolean;
  readonly projects: () => readonly Project[];
  readonly target: (projectKey: string) => FilesTarget;
  // the folder as this computer reaches it (a local project, or a WSL distro's through \\wsl.localhost), else undefined
  readonly localPathOf: (projectKey: string, relativeDir: string) => string | undefined;
  // a project entry's kind, a link never followed; undefined when it is not there
  readonly kindOf: (file: FileRef) => Promise<TransferKind | undefined>;
  readonly clipboard: FilesClipboard;
  readonly askChecked: AskCheckedMessage;
  readonly notify: (severity: 'info' | 'warning' | 'error', message: string) => void;
  readonly setting: (key: 'confirmDragAndDrop' | 'confirmPasteNative') => boolean;
  // "Don't ask again": the setting turns off in user scope
  readonly stopAsking: (key: 'confirmDragAndDrop' | 'confirmPasteNative') => Promise<void>;
  // the OS pickers; undefined: cancelled
  readonly pickToCopyIn: () => Promise<readonly string[] | undefined>;
  // defaultPath undefined: the OS dialog opens where it opens by default
  readonly pickDownloadFolder: (defaultPath: string | undefined) => Promise<string | undefined>;
  readonly pickDownloadFile: (defaultPath: string) => Promise<string | undefined>;
  readonly lastDownloadFolder: () => string | undefined;
  readonly rememberDownloadFolder: (folder: string) => Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
}

const parentOf = (relativePath: string): string => (relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '');

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The shell's Files gestures that start a transfer; each asks what it must, then hands the transfer to the service. */
export class TransferGestures {
  private readonly deps: TransferGestureDeps;

  constructor(deps: TransferGestureDeps) {
    this.deps = deps;
  }

  private folderName(ref: FileRef): string {
    if (ref.relativePath !== '') return path.posix.basename(ref.relativePath);
    return this.deps.projects().find((project) => project.key === ref.projectKey)?.name ?? ref.projectKey;
  }

  // why a transfer to or from the project cannot start, told to the user, before any dialog asks about it
  private offline(projectKey: string): FilesTransferStartResult | undefined {
    if (!this.deps.connected(projectKey)) {
      this.deps.notify('warning', this.deps.t('{0} is offline. Reconnect to copy files.', this.deps.target(projectKey).host ?? projectKey));
      return { ok: false, reason: 'offline' };
    }
    if (this.deps.transfers(projectKey)) return undefined;
    // only a remote project's host can lack the transfers, and a remote project always names its host
    const host = this.deps.target(projectKey).host ?? this.folderName({ projectKey, relativePath: '' });
    this.deps.notify('warning', this.deps.t('The Damocles server on {0} is too old to copy files. Reconnect to update it.', visibleText(host)));
    return { ok: false, reason: 'refused' };
  }

  // a folder's real path, or why it cannot be read, for the user
  private async realFolder(folder: string): Promise<{ readonly real: string } | { readonly refused: string }> {
    try {
      return { real: await fs.realpath(folder) };
    } catch (err) {
      this.deps.log(`[files] ${folder} cannot be read: ${errorText(err)}`);
      return { refused: this.deps.t('\'{0}\' is no longer there or cannot be read.', visibleText(folder)) };
    }
  }

  // each path must be absolute, present by lstat, no drive or file system root, and neither the destination nor a folder
  // holding it
  private async checkedPaths(paths: readonly string[], destination: FileRef): Promise<readonly string[] | string> {
    const { t } = this.deps;
    const destPath = this.deps.localPathOf(destination.projectKey, destination.relativePath);
    const dest = destPath === undefined ? undefined : await this.realFolder(destPath);
    if (dest && 'refused' in dest) return dest.refused;
    const realDest = dest?.real;
    for (const candidate of paths) {
      if (!path.isAbsolute(candidate)) return t('\'{0}\' is not a file or folder on this computer.', visibleText(candidate));
      if (path.basename(candidate) === '') return t('\'{0}\' is a whole drive. Copy the folders in it instead.', visibleText(candidate));
      try {
        await fs.lstat(candidate);
      } catch (err) {
        this.deps.log(`[files] a copy-in path cannot be read: ${errorText(err)}`);
        return t('\'{0}\' is not a file or folder on this computer.', visibleText(candidate));
      }
      if (realDest === undefined) continue;
      const parent = await this.realFolder(path.dirname(candidate));
      if ('refused' in parent) return parent.refused;
      // the item itself, never what a link at it leads to
      const realItem = path.join(parent.real, path.basename(candidate));
      if (isInsideRealRoot(realItem, realDest)) return t('Damocles can\'t copy \'{0}\' into itself.', visibleText(path.basename(candidate)));
    }
    return paths;
  }

  /** A drop or paste of files from the OS file manager, or the picker's answer. */
  async copyIn(request: FilesCopyInRequest | { readonly projectKey: string; readonly relativeDir: string; readonly paths: readonly string[]; readonly withoutPath: 0; readonly origin: 'picker' }): Promise<FilesTransferStartResult> {
    const { t } = this.deps;
    const destination: FileRef = { projectKey: request.projectKey, relativePath: request.relativeDir };
    if (!this.deps.projects().some((project) => project.key === request.projectKey)) return { ok: false, reason: 'refused' };
    if (request.withoutPath > 0) this.deps.notify('warning', t('{0} of the dropped items are not files on this computer, such as an image from a web page, and were not copied.', request.withoutPath));
    if (request.paths.length === 0) return { ok: false, reason: 'refused' };
    if (request.paths.length > MAX_COPY_IN_PATHS) {
      this.deps.notify('warning', t('Damocles copies at most {0} items at a time. Copy their folder instead, or fewer at once.', MAX_COPY_IN_PATHS));
      return { ok: false, reason: 'refused' };
    }
    const offline = this.offline(request.projectKey);
    if (offline) return offline;
    const checked = await this.checkedPaths(request.paths, destination);
    if (typeof checked === 'string') {
      this.deps.notify('warning', checked);
      return { ok: false, reason: 'refused' };
    }
    if (request.origin === 'paste' && this.deps.setting('confirmPasteNative')) {
      const count = checked.length;
      const answer = await this.deps.askChecked({
        severity: 'info',
        message: count === 1
          ? t('Paste \'{0}\' into \'{1}\'?', visibleText(path.basename(checked[0]!)), visibleText(this.folderName(destination)))
          : t('Paste {0} items into \'{1}\'?', count, visibleText(this.folderName(destination))),
        actions: [t('Paste')],
        cancelLabel: t('Cancel'),
        defaultAction: 0,
        checkbox: { label: t('Don\'t ask again'), checked: false },
      });
      if (answer.action !== 0) return { ok: false, reason: 'cancelled' };
      if (answer.checked) await this.deps.stopAsking('confirmPasteNative');
    }
    return this.deps.start({ op: 'copy', sources: checked.map((candidate) => ({ kind: 'local', path: candidate })), destination: { kind: 'project', projectKey: request.projectKey, relativeDir: request.relativeDir } });
  }

  /** "Copy files here...": the OS picker, then the same copy as a drop. */
  async pickCopyIn(folder: FileRef): Promise<FilesTransferStartResult> {
    const offline = this.offline(folder.projectKey);
    if (offline) return offline;
    const paths = await this.deps.pickToCopyIn();
    if (!paths || paths.length === 0) return { ok: false, reason: 'cancelled' };
    return this.copyIn({ projectKey: folder.projectKey, relativeDir: folder.relativePath, paths, withoutPath: 0, origin: 'picker' });
  }

  /** A Files row dropped on a folder: a move after its confirm, or a copy with the modifier held. */
  async dropRow(request: FilesDropRowRequest): Promise<FilesTransferStartResult> {
    const { t } = this.deps;
    const { from, toDir, copy } = request;
    const sameFolder = from.projectKey === toDir.projectKey && parentOf(from.relativePath) === toDir.relativePath;
    if (sameFolder && !copy) return { ok: false, reason: 'cancelled' };
    for (const key of new Set([from.projectKey, toDir.projectKey])) {
      const offline = this.offline(key);
      if (offline) return offline;
    }
    if (!copy && this.deps.setting('confirmDragAndDrop')) {
      const answer = await this.deps.askChecked({
        severity: 'info',
        message: t('Move \'{0}\' into \'{1}\'?', visibleText(path.posix.basename(from.relativePath)), visibleText(this.folderName(toDir))),
        detail: this.deps.platform === 'darwin' ? t('Open tabs follow the file. Hold Option while dropping to copy instead.') : t('Open tabs follow the file. Hold Ctrl while dropping to copy instead.'),
        actions: [t('Move')],
        cancelLabel: t('Cancel'),
        defaultAction: 0,
        checkbox: { label: t('Don\'t ask again'), checked: false },
      });
      if (answer.action !== 0) return { ok: false, reason: 'cancelled' };
      if (answer.checked) await this.deps.stopAsking('confirmDragAndDrop');
    }
    return this.deps.start({
      op: copy ? 'copy' : 'move',
      sources: [{ kind: 'project', projectKey: from.projectKey, relativePath: from.relativePath }],
      destination: { kind: 'project', projectKey: toDir.projectKey, relativeDir: toDir.relativePath },
      ...(copy && sameFolder ? { keepBothWithItself: true } : {}),
    });
  }

  /** Paste of the window's Files clipboard into a folder; a copy into its own folder keeps both without asking. */
  async paste(toDir: FileRef): Promise<FilesPasteResult> {
    const item = this.deps.clipboard.current();
    if (!item) return { ok: false, reason: 'empty' };
    const { ref } = item;
    const sameFolder = ref.projectKey === toDir.projectKey && parentOf(ref.relativePath) === toDir.relativePath;
    if (item.op === 'cut' && sameFolder) {
      this.deps.clipboard.clearCut();
      return { ok: false, reason: 'cancelled' };
    }
    for (const key of new Set([ref.projectKey, toDir.projectKey])) {
      const offline = this.offline(key);
      if (offline) return offline;
    }
    const started = await this.deps.start({
      op: item.op === 'cut' ? 'move' : 'copy',
      sources: [{ kind: 'project', projectKey: ref.projectKey, relativePath: ref.relativePath }],
      destination: { kind: 'project', projectKey: toDir.projectKey, relativeDir: toDir.relativePath },
      ...(item.op === 'copy' && sameFolder ? { keepBothWithItself: true } : {}),
    });
    if (started.ok && item.op === 'cut') this.deps.clipboard.clearCut();
    return started;
  }

  /** Download... of a remote file (the Save dialog) or folder (a folder picker, landing as <picked>/<name>). */
  async download(file: FileRef): Promise<FilesTransferStartResult> {
    const { t } = this.deps;
    if (this.deps.target(file.projectKey).host === undefined) return { ok: false, reason: 'refused' };
    const offline = this.offline(file.projectKey);
    if (offline) return offline;
    const kind = await this.deps.kindOf(file);
    if (kind === undefined) {
      this.deps.notify('warning', t('\'{0}\' is no longer there.', visibleText(this.folderName(file))));
      return { ok: false, reason: 'refused' };
    }
    const name = this.folderName(file);
    // a link never leaves its host, and the Save dialog would name a file the plan then refuses
    if (kind === 'link') {
      this.deps.notify('warning', t('\'{0}\' is a link. Download the file or folder it leads to instead.', visibleText(name)));
      return { ok: false, reason: 'refused' };
    }
    const folder = kind === 'dir';
    if (!isValidFileName(name, this.deps.platform)) {
      this.deps.notify('warning', t('\'{0}\' is not a name this computer allows, so it was not downloaded.', visibleText(name)));
      return { ok: false, reason: 'refused' };
    }
    const last = this.deps.lastDownloadFolder();
    const source = { kind: 'project' as const, projectKey: file.projectKey, relativePath: file.relativePath };
    if (!folder) {
      // before the first download the Save dialog opens in its own default folder with the file's name
      const chosen = await this.deps.pickDownloadFile(last === undefined ? name : path.join(last, name));
      if (chosen === undefined) return { ok: false, reason: 'cancelled' };
      const chosenName = path.basename(chosen);
      if (!path.isAbsolute(chosen) || !isValidFileName(chosenName, this.deps.platform)) return { ok: false, reason: 'refused' };
      await this.deps.rememberDownloadFolder(path.dirname(chosen));
      return this.deps.start({ op: 'download', sources: [source], destination: { kind: 'download', folder: path.dirname(chosen), name: chosenName } });
    }
    const picked = await this.deps.pickDownloadFolder(last);
    if (picked === undefined) return { ok: false, reason: 'cancelled' };
    if (!path.isAbsolute(picked)) return { ok: false, reason: 'refused' };
    await this.deps.rememberDownloadFolder(picked);
    return this.deps.start({ op: 'download', sources: [source], destination: { kind: 'download', folder: picked } });
  }
}
