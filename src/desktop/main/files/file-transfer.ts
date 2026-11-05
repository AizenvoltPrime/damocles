import * as path from 'node:path';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { pathFor } from '../../../shared/project-location';
import { visibleText } from '../../../shared/visible-text';
import type { Project } from '../../local-services/confine';
import { isValidFileName } from '../../preload/file-names';
import type { FilesChanged, FilesMutationResult, FilesTransferProgress, FilesTransferStartResult } from '../../preload/shell-channels';
import { FILES_TRANSFER_PROGRESS_MS } from '../../preload/shell-channels';
import type { WorkspaceFileSystem } from '../../workspace/file-system';
import type { Clash, ClashesResult, MoveResult, TransferEntry, TransferKind, TransferResult } from '../../workspace/transfer-ops';
import type { AskCheckedMessage } from '../message-dialog';
import { TransfersUnsupportedError } from '../workspace/remote-workspace';
import { NotConnectedError } from '../workspace/workspaces';
import type { FilesTarget } from './file-tree';
import { incrementFileName } from './increment-name';

// Copies and moves into Files, and downloads out of a remote project (docs/invariants.md "File transfers").

export type TransferSource = { readonly kind: 'local'; readonly path: string } | { readonly kind: 'project'; readonly projectKey: string; readonly relativePath: string };

// download: a folder on this computer the user picked; name renames the item (the Save dialog's answer), whose replace the
// OS dialog already asked
export type TransferDestination =
  | { readonly kind: 'project'; readonly projectKey: string; readonly relativeDir: string }
  | { readonly kind: 'download'; readonly folder: string; readonly name?: string };

export interface TransferRequest {
  readonly op: 'copy' | 'move' | 'download';
  readonly sources: readonly TransferSource[];
  readonly destination: TransferDestination;
  // a copy into the folder it came from: its clash with itself keeps both without asking, as VS Code's paste does
  readonly keepBothWithItself?: boolean;
}

// why an item did not arrive, as the summary's details list it; unreadable and notListed carry their value as the message
export type SkipReason = 'name' | 'linkWindows' | 'linkOutside' | 'special' | 'permission' | 'exists' | 'chosen' | 'changed' | 'invalid' | 'missing' | 'outside' | 'noSpace' | 'unreadable' | 'notListed' | 'failed';

export interface SkippedItem {
  readonly path: string;
  readonly reason: SkipReason;
  readonly message?: string;
}

export type TransferFiles = Pick<WorkspaceFileSystem, 'walk' | 'clashes' | 'receiveFile' | 'copy' | 'move' | 'makeFolder' | 'makeLink' | 'verifyLink' | 'removeFolder' | 'readFile' | 'deleteEntry'>;

export interface FileTransferDeps {
  readonly projects: () => readonly Project[];
  // throws NotConnectedError while the project's host is not connected
  readonly filesOf: (projectKey: string) => TransferFiles;
  readonly target: (projectKey: string) => FilesTarget;
  // whether a project's files are on this computer, its WSL distro's included
  readonly authorityOf: (projectKey: string) => string;
  // false while the project's host is connected to a Damocles server that carries no transfers
  readonly transfers: (projectKey: string) => boolean;
  // this computer's operations, for local paths and downloads
  readonly local: TransferFiles;
  readonly platform: NodeJS.Platform;
  readonly askChecked: AskCheckedMessage;
  readonly notify: (severity: 'info' | 'warning' | 'error', message: string, actions: readonly string[]) => Promise<number | undefined>;
  readonly showDetails: (message: string, lines: readonly string[]) => Promise<void>;
  // a move inside one project, so its open documents, tabs and undo follow (EditorPane.fileRenamed)
  readonly renameInProject: (projectKey: string, from: string, renameOnDisk: () => Promise<FilesMutationResult>) => Promise<FilesMutationResult>;
  readonly progress: (progress: FilesTransferProgress) => void;
  readonly changed: (change: FilesChanged) => void;
  // shows a download's landed path, below the folder the user picked in the Save or folder dialog
  readonly revealDownload: (absolutePath: string) => Promise<void>;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

class TransferCancelled extends Error {
  override readonly name = 'TransferCancelled';
}

// Settles as work does, or rejects with TransferCancelled once signal aborts first; work then goes on unobserved here.
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new TransferCancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new TransferCancelled());
    signal.addEventListener('abort', abort, { once: true });
    work.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (err: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(err);
    });
  });
}

// Merging a folder sends its entries' names in requests of at most this many, well under the host parser's MAX_ITEMS.
export const CLASHES_CHUNK_NAMES = 10_000;

// One end of a transfer: a project, a folder of this computer holding local sources, or the folder a download lands in.
interface Side {
  readonly authority: string;
  readonly projectKey?: string;
  readonly project: Project;
  readonly files: TransferFiles;
  readonly os: NodeJS.Platform;
}

interface TreeNode {
  readonly entry: TransferEntry;
  readonly name: string;
  readonly children: TreeNode[];
}

type Step =
  | { readonly kind: 'folder'; readonly destDir: string; readonly name: string; readonly label: string; readonly mode: number }
  // within: a link from another machine must resolve inside this folder of the destination, the copied item's own
  | { readonly kind: 'file' | 'link' | 'moveTree'; readonly side: Side; readonly node: TreeNode; readonly srcRel: string; readonly destDir: string; readonly name: string; readonly replace: boolean; readonly label: string; readonly items: number; readonly within?: string }
  | { readonly kind: 'removeSource'; readonly side: Side; readonly node: TreeNode; readonly srcRel: string }
  // after the last link and before the source folders go: every link made is followed again, and a moved one's source deleted
  | { readonly kind: 'settleLinks' };

interface Plan {
  readonly steps: Step[];
  readonly skipped: SkippedItem[];
  readonly items: number;
  readonly bytes: number;
  // the name each top-level item lands under in the destination, after Keep both or a merge chose it
  readonly tops: string[];
}

type Answer = 'replace' | 'keepBoth' | 'skip';

// a link a step made, which the transfer follows again once every link landed (within), and whose source a move between hosts
// deletes only after that
interface MadeLink {
  readonly destDir: string;
  readonly name: string;
  readonly label: string;
  readonly within?: string;
  readonly source?: { readonly side: Side; readonly srcRel: string; readonly identity: TransferEntry['identity'] };
}

type StepResult = { readonly ok: true; readonly left: readonly string[]; readonly leftMore?: number } | { readonly ok: false; readonly reason: SkipReason; readonly message?: string };

const joinRel = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);
const parentRel = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const isUnder = (rel: string, dir: string): boolean => rel === dir || rel.startsWith(`${dir}/`);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// non-folder entries under node, node included
function itemCount(node: TreeNode): number {
  return node.entry.kind === 'dir' ? node.children.reduce((sum, child) => sum + itemCount(child), 0) : 1;
}

function byteCount(node: TreeNode): number {
  return node.entry.kind === 'dir' ? node.children.reduce((sum, child) => sum + byteCount(child), 0) : node.entry.size;
}

// A walk's entries as a tree; an entry whose folder is missing or not a folder in the walk is listed as failed.
function treeOf(entries: readonly TransferEntry[], topName: string, skipped: SkippedItem[]): TreeNode | undefined {
  const nodes = new Map<string, TreeNode>();
  let top: TreeNode | undefined;
  for (const entry of entries) {
    if (entry.relativePath === '') {
      if (top) continue;
      top = { entry, name: topName, children: [] };
      nodes.set('', top);
      continue;
    }
    const parent = nodes.get(parentRel(entry.relativePath));
    if (!parent || parent.entry.kind !== 'dir' || nodes.has(entry.relativePath)) {
      skipped.push({ path: joinRel(topName, entry.relativePath), reason: 'failed' });
      continue;
    }
    const node: TreeNode = { entry, name: entry.relativePath.slice(entry.relativePath.lastIndexOf('/') + 1), children: [] };
    parent.children.push(node);
    nodes.set(entry.relativePath, node);
  }
  return top;
}

/**
 * Whether a link at relativePath under the copied item names a relative target that never climbs above it, read lexically:
 * the first filter for a link from another machine ("zip slip"). The host that makes the link then follows it on disk
 * through every link (makeLink's within), which decides.
 */
export function linkStaysInside(relativePath: string, rawTarget: string, sourceOs: NodeJS.Platform): boolean {
  if (relativePath === '') return false;
  const target = sourceOs === 'win32' ? rawTarget.replace(/\\/g, '/') : rawTarget;
  if (target === '' || target.startsWith('/') || /^[a-z]:/i.test(target) || target.includes('\0')) return false;
  const stack = relativePath.split('/').slice(0, -1);
  const segments = target.split('/').filter((segment) => segment !== '' && segment !== '.');
  for (const segment of segments) {
    if (segment !== '..') {
      stack.push(segment);
      continue;
    }
    if (stack.length === 0) return false;
    stack.pop();
  }
  return true;
}

// A host's refusal as the summary lists it: its errno code first, else its reason; only 'failed' keeps the host's own text.
function skipReasonOf(result: Exclude<TransferResult, { readonly ok: true }>): SkipReason {
  switch (result.code) {
    case 'EACCES': case 'EPERM': return 'permission';
    case 'ENOSPC': return 'noSpace';
    case 'EINVAL': return 'invalid';
  }
  switch (result.reason) {
    case 'exists': return 'exists';
    case 'invalidName': return 'name';
    case 'unsupported': return 'linkWindows';
    case 'changed': case 'incomplete': case 'notAFile': return 'changed';
    case 'missing': case 'notFolder': return 'missing';
    case 'outside': return 'outside';
    default: return 'failed';
  }
}

interface Running {
  readonly id: number;
  readonly projectKey: string;
  readonly op: FilesTransferProgress['op'];
  readonly controller: AbortController;
  // the steps a cancel stopped waiting for, which the project's next transfer waits for
  inFlight: Promise<void>;
  state: FilesTransferProgress['state'];
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  lastSent: number;
}

/** Runs every copy, move and download, one per project at a time in the order they started. */
export class FileTransferService {
  private readonly deps: FileTransferDeps;
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<number, Running>();
  // steps a cancel stopped waiting for, still removing what they were writing
  private readonly settling = new Set<Promise<void>>();
  private nextId = 1;

  constructor(deps: FileTransferDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Shows the transfer as preparing, plans it, asking about each clash, then queues it; ok once it is queued. */
  async start(request: TransferRequest): Promise<FilesTransferStartResult> {
    const { t } = this.deps;
    const keys = [...new Set([...request.sources.flatMap((source) => (source.kind === 'project' ? [source.projectKey] : [])), ...(request.destination.kind === 'project' ? [request.destination.projectKey] : [])])];
    for (const key of keys) {
      if (this.connected(key)) continue;
      void this.deps.notify('warning', t('{0} is offline. Reconnect to copy files.', this.deps.target(key).host ?? key), []);
      return { ok: false, reason: 'offline' };
    }
    const unsupported = keys.find((key) => !this.deps.transfers(key));
    if (unsupported !== undefined) {
      void this.deps.notify('warning', this.unsupportedText(unsupported), []);
      return { ok: false, reason: 'refused' };
    }
    const dest = this.destinationSide(request.destination);
    if (!dest) return { ok: false, reason: 'refused' };
    const destDir = request.destination.kind === 'project' ? request.destination.relativeDir : '';
    const refused = this.intoItself(request, dest);
    if (refused !== undefined) {
      void this.deps.notify('warning', t('Damocles can\'t copy \'{0}\' into itself.', visibleText(refused)), []);
      return { ok: false, reason: 'refused' };
    }
    const queueKey = request.destination.kind === 'project' ? request.destination.projectKey : (request.sources[0]?.kind === 'project' ? request.sources[0].projectKey : 'local');
    const transfer: Running = {
      id: this.nextId++,
      projectKey: queueKey,
      op: request.op,
      controller: new AbortController(),
      inFlight: Promise.resolve(),
      state: 'preparing',
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      lastSent: 0,
    };
    this.running.set(transfer.id, transfer);
    this.send(transfer, true);
    let plan: Plan;
    try {
      plan = await this.plan(request, dest, destDir, transfer);
    } catch (err) {
      const cancelled = err instanceof TransferCancelled || transfer.controller.signal.aborted;
      this.endPreparing(transfer, cancelled ? 'cancelled' : 'failed');
      if (cancelled) return { ok: false, reason: 'cancelled' };
      if (err instanceof NotConnectedError) {
        void this.deps.notify('warning', err.message, []);
        return { ok: false, reason: 'offline' };
      }
      const unsupportedKey = err instanceof TransfersUnsupportedError ? keys.find((key) => this.deps.authorityOf(key) === err.authorityKey) : undefined;
      if (unsupportedKey !== undefined) {
        void this.deps.notify('warning', this.unsupportedText(unsupportedKey), []);
        return { ok: false, reason: 'refused' };
      }
      this.deps.log(`[files] planning a transfer failed: ${errorText(err)}`);
      void this.deps.notify('error', t('Damocles could not copy the files: {0}', visibleText(errorText(err))), []);
      return { ok: false, reason: 'failed' };
    }
    // a cancel while the last answer was awaited already ended the row
    if (transfer.controller.signal.aborted) return { ok: false, reason: 'cancelled' };
    transfer.state = 'queued';
    transfer.filesTotal = plan.items;
    transfer.bytesTotal = plan.bytes;
    this.send(transfer, true);
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(() => this.run(transfer, request, plan, dest, destDir)).finally(() => transfer.inFlight);
    const settled = run.then(() => undefined, (err: unknown) => this.deps.log(`[files] transfer ${transfer.id} failed: ${errorText(err)}`));
    this.queues.set(queueKey, settled);
    void settled.then(() => {
      if (this.queues.get(queueKey) === settled) this.queues.delete(queueKey);
    });
    return { ok: true, transferId: transfer.id };
  }

  /** Stops a transfer after the current file's part is removed; files that finished stay. */
  cancel(transferId: number): void {
    const transfer = this.running.get(transferId);
    if (!transfer) return;
    transfer.controller.abort();
    // one still planning or waiting for its turn ends now, so its row leaves
    if (transfer.state !== 'queued' && transfer.state !== 'preparing') return;
    transfer.state = 'cancelled';
    this.running.delete(transferId);
    this.send(transfer, true);
  }

  /** Cancels every transfer; settles once each stopped and removed the part it was writing (a quit). */
  async cancelAll(): Promise<void> {
    for (const transferId of [...this.running.keys()]) this.cancel(transferId);
    await Promise.all([...this.queues.values(), ...this.settling]);
  }

  connected(projectKey: string): boolean {
    try {
      this.deps.filesOf(projectKey);
      return true;
    } catch (err) {
      if (err instanceof NotConnectedError) return false;
      throw err;
    }
  }

  // only a remote project's host can lack the transfers, and a remote project always names its host
  private unsupportedText(projectKey: string): string {
    const host = this.deps.target(projectKey).host ?? this.deps.projects().find((project) => project.key === projectKey)?.name ?? '';
    return this.deps.t('The Damocles server on {0} is too old to copy files. Reconnect to update it.', visibleText(host));
  }

  // a planning transfer's one end state, unless a cancel already sent it
  private endPreparing(transfer: Running, state: 'cancelled' | 'failed'): void {
    if (!this.running.delete(transfer.id)) return;
    transfer.state = state;
    this.send(transfer, true);
  }

  private projectSide(projectKey: string): Side | undefined {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project) return undefined;
    return { authority: this.deps.authorityOf(projectKey), projectKey, project, files: this.deps.filesOf(projectKey), os: this.deps.target(projectKey).os };
  }

  // a folder of this computer as a project, so every write under it is confined to it
  private localSide(folder: string): Side {
    return { authority: 'local', project: { key: folderKey(folder), fsPath: folder, name: path.basename(folder) }, files: this.deps.local, os: this.deps.platform };
  }

  private destinationSide(destination: TransferDestination): Side | undefined {
    return destination.kind === 'project' ? this.projectSide(destination.projectKey) : this.localSide(destination.folder);
  }

  // the name of a folder source the destination lies in, the project's own for its root, or undefined
  private intoItself(request: TransferRequest, dest: Side): string | undefined {
    const destination = request.destination;
    if (destination.kind !== 'project') return undefined;
    for (const source of request.sources) {
      if (source.kind !== 'project' || source.projectKey !== destination.projectKey) continue;
      if (source.relativePath === '') return dest.project.name;
      if (isUnder(destination.relativeDir, source.relativePath)) return path.posix.basename(source.relativePath);
    }
    return undefined;
  }

  private async plan(request: TransferRequest, dest: Side, destDir: string, transfer: Running): Promise<Plan> {
    const { t } = this.deps;
    const steps: Step[] = [];
    const links: Step[] = [];
    const removals: Step[] = [];
    const skipped: SkippedItem[] = [];
    const landedTops: string[] = [];
    let items = 0;
    let bytes = 0;
    let applyAll: Answer | undefined;
    const foldsCase = dest.os === 'win32' || dest.os === 'darwin';
    const fold = (name: string): string => (foldsCase ? name.toLowerCase() : name);
    const folderLabel = (dir: string): string => (dir === '' ? (request.destination.kind === 'project' ? dest.project.name : dest.project.fsPath) : path.posix.basename(dir));
    const stopIfCancelled = (): void => {
      if (transfer.controller.signal.aborted) throw new TransferCancelled();
    };

    // the destination folder's listing failed: the error says which folder and why
    const unreadable = (dir: string, found: Extract<ClashesResult, { readonly ok: false }>): Error => new Error(found.message !== undefined
      ? t('Damocles could not read the folder \'{0}\': {1}', visibleText(folderLabel(dir)), visibleText(found.message))
      : t('Damocles could not read the folder \'{0}\'.', visibleText(folderLabel(dir))));

    const ask = async (name: string, dir: string, canReplace: boolean): Promise<Answer> => {
      if (applyAll !== undefined && (canReplace || applyAll !== 'replace')) return applyAll;
      stopIfCancelled();
      const actions = canReplace ? [t('Replace'), t('Keep both'), t('Skip')] : [t('Keep both'), t('Skip')];
      const answers: readonly Answer[] = canReplace ? ['replace', 'keepBoth', 'skip'] : ['keepBoth', 'skip'];
      const answer = await this.deps.askChecked({
        severity: 'warning',
        message: t('\'{0}\' already exists in \'{1}\'', visibleText(name), visibleText(folderLabel(dir))),
        detail: canReplace ? t('Replace it with the one you are copying, keep both, or skip it.') : t('Keep both, or skip the one you are copying.'),
        actions,
        cancelLabel: t('Cancel'),
        defaultAction: 0,
        checkbox: { label: t('Apply to all remaining conflicts'), checked: false },
      });
      if (answer.action === undefined) throw new TransferCancelled();
      const chosen = answers[answer.action]!;
      if (answer.checked) applyAll = chosen;
      return chosen;
    };

    // the next name Keep both may take in dir, which neither exists there nor is planned; undefined once the names grow past
    // what the host allows, since a host refuses a request naming one as a protocol violation
    const freeName = async (dir: string, name: string, folder: boolean, exists: boolean, planned: Map<string, TransferKind>): Promise<string | undefined> => {
      let candidate = name;
      for (;;) {
        candidate = incrementFileName(candidate, folder);
        if (!isValidFileName(candidate, dest.os)) return undefined;
        if (planned.has(fold(candidate))) continue;
        if (!exists) return candidate;
        const found = await dest.files.clashes(dest.project, dir, [candidate]);
        if (!found.ok) throw unreadable(dir, found);
        if (found.clashes[0] === null) return candidate;
      }
    };

    const skipTree = (label: string, reason: SkipReason): void => {
      skipped.push({ path: label, reason });
    };

    interface Placed {
      readonly side: Side;
      readonly node: TreeNode;
      readonly srcRel: string;
      readonly name: string;
      readonly label: string;
      readonly withItself: boolean;
      // a source the user named, whose landed name the summary's Reveal opens
      readonly top: boolean;
      // where the copied item lands in the destination; undefined for the item itself until its name is decided
      readonly root?: string;
    }

    // each name's clash in dir, asked in requests of at most CLASHES_CHUNK_NAMES names
    const clashesIn = async (dir: string, names: readonly string[]): Promise<ReadonlyArray<Clash | null>> => {
      const found: Array<Clash | null> = [];
      for (let start = 0; start < names.length; start += CLASHES_CHUNK_NAMES) {
        const chunk = await dest.files.clashes(dest.project, dir, names.slice(start, start + CLASHES_CHUNK_NAMES));
        if (!chunk.ok) throw unreadable(dir, chunk);
        found.push(...chunk.clashes);
      }
      return found;
    };

    const place = async (placed: readonly Placed[], dir: string, exists: boolean): Promise<void> => {
      const valid: Placed[] = [];
      for (const item of placed) {
        const { entry } = item.node;
        if (entry.kind === 'other' && entry.error !== undefined) skipped.push({ path: item.label, reason: entry.error === 'EACCES' || entry.error === 'EPERM' ? 'permission' : 'unreadable', message: entry.error });
        else if (entry.kind === 'other') skipTree(item.label, 'special');
        else if (!isValidFileName(item.name, dest.os)) skipTree(item.label, 'name');
        else valid.push(item);
      }
      const clashes: ReadonlyArray<Clash | null> = exists && valid.length > 0 ? await clashesIn(dir, valid.map((item) => item.name)) : valid.map(() => null);
      const planned = new Map<string, TransferKind>();
      for (const [index, item] of valid.entries()) {
        const { node } = item;
        const kind = node.entry.kind;
        const sameHost = item.side.authority === dest.authority;
        if (kind === 'link' && dest.os === 'win32') {
          skipTree(item.label, 'linkWindows');
          continue;
        }
        if (kind === 'link' && !sameHost && !linkStaysInside(node.entry.relativePath, node.entry.linkTarget ?? '', item.side.os)) {
          skipTree(item.label, 'linkOutside');
          continue;
        }
        const plannedKind = planned.get(fold(item.name));
        const clash = clashes[index] ?? (plannedKind !== undefined ? { name: item.name, kind: plannedKind } : null);
        let name = item.name;
        let replace = false;
        if (clash) {
          // a folder copied into its own folder lands beside itself, never merged into itself
          if (kind === 'dir' && clash.kind === 'dir' && plannedKind === undefined && !item.withItself) {
            // a folder clash merges into the existing folder and asks only about its files
            planned.set(fold(clash.name), 'dir');
            if (item.top) landedTops.push(clash.name);
            await descend({ ...item, root: item.root ?? joinRel(dir, clash.name) }, joinRel(dir, clash.name), true);
            continue;
          }
          const canReplace = kind !== 'dir' && clash.kind !== 'dir';
          const answer = item.withItself ? 'keepBoth' : await ask(item.name, dir, canReplace);
          if (answer === 'skip') {
            skipTree(item.label, 'chosen');
            continue;
          }
          if (answer === 'replace') {
            replace = true;
          } else {
            const free = await freeName(dir, item.name, kind === 'dir', exists, planned);
            if (free === undefined) {
              skipTree(item.label, 'name');
              continue;
            }
            name = free;
          }
        }
        planned.set(fold(name), kind);
        if (item.top) landedTops.push(name);
        const target = { side: item.side, node, srcRel: item.srcRel, destDir: dir, name, replace, label: item.label, items: itemCount(node), ...(kind === 'link' && !sameHost && item.root !== undefined ? { within: item.root } : {}) };
        if (request.op === 'move' && sameHost) {
          steps.push({ kind: 'moveTree', ...target });
          items += target.items;
          bytes += byteCount(node);
          continue;
        }
        if (kind === 'dir') {
          steps.push({ kind: 'folder', destDir: dir, name, label: item.label, mode: node.entry.mode });
          if (node.entry.unreadable !== undefined) skipped.push({ path: item.label, reason: node.entry.unreadable === 'EACCES' || node.entry.unreadable === 'EPERM' ? 'permission' : 'failed' });
          await descend({ ...item, name, root: item.root ?? joinRel(dir, name) }, joinRel(dir, name), false);
          continue;
        }
        (kind === 'link' ? links : steps).push({ kind: kind === 'link' ? 'link' : 'file', ...target });
        items += 1;
        bytes += node.entry.size;
      }
    };

    // a folder's entries into destFolder; a moved folder is removed once its entries left it, so after its subfolders
    const descend = async (item: Placed, destFolder: string, exists: boolean): Promise<void> => {
      await place(item.node.children.map((child) => ({
        side: item.side,
        node: child,
        srcRel: joinRel(item.srcRel, child.name),
        name: child.name,
        label: joinRel(item.label, child.name),
        withItself: false,
        top: false,
        ...(item.root !== undefined ? { root: item.root } : {}),
      })), destFolder, exists);
      if (request.op === 'move') removals.push({ kind: 'removeSource', side: item.side, node: item.node, srcRel: item.srcRel });
    };

    const tops: Placed[] = [];
    for (const source of request.sources) {
      const side = source.kind === 'local' ? this.localSide(path.dirname(source.path)) : this.projectSide(source.projectKey);
      if (!side) {
        skipped.push({ path: source.kind === 'local' ? source.path : source.relativePath, reason: 'failed' });
        continue;
      }
      const srcRel = source.kind === 'local' ? path.basename(source.path) : source.relativePath;
      const topName = request.destination.kind === 'download' && request.destination.name !== undefined
        ? request.destination.name
        : srcRel === '' ? pathFor({ os: side.os }).basename(side.project.fsPath) : srcRel.slice(srcRel.lastIndexOf('/') + 1);
      const entries: TransferEntry[] = [];
      try {
        for await (const page of side.files.walk(side.project, srcRel)) {
          stopIfCancelled();
          entries.push(...page);
          for (const entry of page) {
            if (entry.kind === 'dir') continue;
            transfer.filesTotal += 1;
            transfer.bytesTotal += entry.size;
          }
          this.send(transfer, false);
        }
      } catch (err) {
        if (err instanceof NotConnectedError || err instanceof TransferCancelled || err instanceof TransfersUnsupportedError) throw err;
        skipped.push({ path: topName, reason: 'failed', message: errorText(err) });
        continue;
      }
      const top = treeOf(entries, topName, skipped);
      if (!top) continue;
      const withItself = request.keepBothWithItself === true && source.kind === 'project' && request.destination.kind === 'project' && source.projectKey === request.destination.projectKey && parentRel(source.relativePath) === destDir;
      tops.push({ side, node: top, srcRel, name: topName, label: topName, withItself, top: true });
    }
    if (request.destination.kind === 'download' && request.destination.name !== undefined) {
      // the Save dialog asked before replacing the one file it named
      for (const top of tops) {
        steps.push({ kind: 'file', side: top.side, node: top.node, srcRel: top.srcRel, destDir: '', name: top.name, replace: true, label: top.label, items: 1 });
        landedTops.push(top.name);
        items += 1;
        bytes += top.node.entry.size;
      }
      if (tops.some((top) => top.node.entry.kind !== 'file') || !isValidFileName(request.destination.name, dest.os)) throw new Error(t('Only a file downloads to a name the Save dialog picked.'));
    } else {
      await place(tops, destDir, true);
    }
    return { steps: [...steps, ...links, ...(links.length > 0 ? [{ kind: 'settleLinks' } as const] : []), ...removals], skipped, items, bytes, tops: landedTops };
  }

  private send(transfer: Running, force: boolean): void {
    const now = this.now();
    if (!force && now - transfer.lastSent < FILES_TRANSFER_PROGRESS_MS) return;
    transfer.lastSent = now;
    const { id: transferId, projectKey, op, state, filesDone, filesTotal, bytesDone, bytesTotal } = transfer;
    this.deps.progress({ transferId, projectKey, op, state, filesDone, filesTotal, bytesDone, bytesTotal });
  }

  // the source's bytes, counted into the progress; a cancel ends the wait for the next chunk at once, which ends the stream
  // short so the receiving host removes its part
  private counted(transfer: Running, chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    const signal = transfer.controller.signal;
    const source = chunks[Symbol.asyncIterator]();
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        const next = await untilCancelled(source.next(), signal);
        if (next.done) {
          if (signal.aborted) throw new TransferCancelled();
          return next;
        }
        transfer.bytesDone += next.value.length;
        this.send(transfer, false);
        return next;
      },
      return: async () => {
        await source.return?.();
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  private async run(transfer: Running, request: TransferRequest, plan: Plan, dest: Side, destDir: string): Promise<void> {
    const skipped = [...plan.skipped];
    const touched = new Map<string, Set<string>>();
    const touch = (side: Side, dir: string): void => {
      if (side.projectKey === undefined) return;
      const dirs = touched.get(side.projectKey) ?? new Set<string>();
      dirs.add(dir);
      touched.set(side.projectKey, dirs);
    };
    const failedDirs: string[] = [];
    const madeLinks: MadeLink[] = [];
    let landed = 0;
    let stopped: string | undefined;
    if (transfer.controller.signal.aborted) return;
    transfer.state = 'running';
    this.send(transfer, true);
    try {
      for (const step of plan.steps) {
        if (transfer.controller.signal.aborted) throw new TransferCancelled();
        if (step.kind === 'settleLinks') {
          landed -= await this.settleLinks(madeLinks.splice(0), dest, skipped, touch);
          continue;
        }
        if (step.kind === 'removeSource') {
          const removed = await step.side.files.removeFolder(step.side.project, step.srcRel, step.node.entry.identity);
          if (removed.ok) touch(step.side, parentRel(step.srcRel));
          else if (removed.reason !== 'notEmpty') this.deps.log(`[files] the moved folder ${step.srcRel} stays: ${removed.reason}`);
          continue;
        }
        if (failedDirs.some((dir) => isUnder(step.destDir, dir))) {
          if (step.kind !== 'folder') skipped.push({ path: step.label, reason: 'failed' });
          continue;
        }
        if (step.kind === 'folder') {
          const made = await dest.files.makeFolder(dest.project, step.destDir, step.name, step.mode);
          touch(dest, step.destDir);
          if (!made.ok) {
            failedDirs.push(joinRel(step.destDir, step.name));
            skipped.push({ path: step.label, reason: skipReasonOf(made), ...(made.message !== undefined ? { message: made.message } : {}) });
          }
          continue;
        }
        const result = await this.runStep(transfer, request, step, dest);
        touch(dest, step.destDir);
        if (result.ok) {
          const leftMore = result.leftMore ?? 0;
          landed += step.items - result.left.length - leftMore;
          for (const left of result.left) skipped.push({ path: left === '' ? step.label : joinRel(step.label, left), reason: 'failed' });
          if (leftMore > 0) skipped.push({ path: step.label, reason: 'notListed', message: String(leftMore) });
          // a move between hosts empties the source's folder as a move on one host does
          if (step.kind === 'moveTree' || (request.op === 'move' && step.side.authority !== dest.authority)) touch(step.side, parentRel(step.srcRel));
          if (step.kind === 'link') {
            const moved = request.op === 'move' && step.side.authority !== dest.authority;
            madeLinks.push({ destDir: step.destDir, name: step.name, label: step.label, ...(step.within !== undefined ? { within: step.within } : {}), ...(moved ? { source: { side: step.side, srcRel: step.srcRel, identity: step.node.entry.identity } } : {}) });
          }
        } else {
          skipped.push({ path: step.label, reason: result.reason, ...(result.message !== undefined ? { message: result.message } : {}) });
        }
        transfer.filesDone += step.items;
        this.send(transfer, false);
      }
      transfer.state = 'done';
    } catch (err) {
      if (err instanceof TransferCancelled) {
        transfer.state = 'cancelled';
      } else {
        transfer.state = 'failed';
        stopped = errorText(err);
        this.deps.log(`[files] transfer ${transfer.id} stopped: ${stopped}`);
      }
    } finally {
      // a cancel or a failure among the links still checks those made, and no link step is in flight then
      landed -= await this.settleLinks(madeLinks.splice(0), dest, skipped, touch);
      this.running.delete(transfer.id);
      this.send(transfer, true);
      for (const [projectKey, dirs] of touched) this.deps.changed({ projectKey, relativeDirs: [...dirs] });
    }
    this.summarize(transfer, request, dest, destDir, plan, landed, plan.items + plan.skipped.length, skipped, stopped);
  }

  // A later Replace can change where a link already made leads, so each is followed again once the links landed; one that now
  // leads out, or whose check cannot finish, is listed and not carried, and a moved link's source goes only once its link
  // passed. How many did not land.
  private async settleLinks(links: readonly MadeLink[], dest: Side, skipped: SkippedItem[], touch: (side: Side, dir: string) => void): Promise<number> {
    let dropped = 0;
    for (const link of links) {
      const failed = (reason: SkipReason, message?: string): void => {
        dropped += 1;
        skipped.push({ path: link.label, reason, ...(message !== undefined ? { message } : {}) });
      };
      try {
        if (link.within !== undefined) {
          const verified = await dest.files.verifyLink(dest.project, joinRel(link.destDir, link.name), link.within);
          if (!verified.ok) {
            failed(verified.reason === 'outside' ? 'linkOutside' : skipReasonOf(verified), verified.message);
            continue;
          }
        }
        if (!link.source) continue;
        const { side, srcRel, identity } = link.source;
        const deleted = await side.files.deleteEntry(side.project, srcRel, identity);
        if (deleted.ok) touch(side, parentRel(srcRel));
        else failed(deleted.reason === 'changed' ? 'changed' : deleted.reason === 'missing' ? 'missing' : 'failed', deleted.message);
      } catch (err) {
        this.deps.log(`[files] the link ${link.label} could not be settled: ${errorText(err)}`);
        failed('failed', errorText(err));
      }
    }
    return dropped;
  }

  // a step raced against the transfer's cancel; a step the cancel stopped waiting for still settles, and the project's next
  // transfer and a quit wait for it. A link moves no bytes and is never raced, so the links are settled once none is in flight
  private runStep(transfer: Running, request: TransferRequest, step: Extract<Step, { readonly side: Side; readonly destDir: string }>, dest: Side): Promise<StepResult> {
    const signal = transfer.controller.signal;
    const work = this.stepWork(transfer, request, step, dest);
    if (step.kind === 'link') return work;
    const settled = work.then(() => undefined, (err: unknown) => {
      if (signal.aborted && !(err instanceof TransferCancelled)) this.deps.log(`[files] ${step.label} ended after its cancel: ${errorText(err)}`);
    });
    this.settling.add(settled);
    void settled.then(() => this.settling.delete(settled));
    transfer.inFlight = Promise.all([transfer.inFlight, settled]).then(() => undefined);
    return untilCancelled(work, signal);
  }

  private async stepWork(transfer: Running, request: TransferRequest, step: Extract<Step, { readonly side: Side; readonly destDir: string }>, dest: Side): Promise<StepResult> {
    const source = step.side;
    const signal = transfer.controller.signal;
    const sameHost = source.authority === dest.authority;
    const failed = (result: Exclude<TransferResult, { readonly ok: true }>): StepResult => ({ ok: false, reason: skipReasonOf(result), ...(result.message !== undefined ? { message: result.message } : {}) });
    if (step.kind === 'moveTree') {
      const move = (): Promise<MoveResult> => dest.files.move(source.project, step.srcRel, dest.project, step.destDir, step.name, step.replace, signal);
      if (source.projectKey !== undefined && source.projectKey === dest.projectKey) {
        let moved: MoveResult | undefined;
        await this.deps.renameInProject(source.projectKey, step.srcRel, async () => {
          moved = await move();
          return moved.ok ? { ok: true, relativePath: joinRel(step.destDir, step.name) } : { ok: false, reason: 'failed' };
        });
        if (!moved) return { ok: false, reason: 'failed' };
        transfer.bytesDone += byteCount(step.node);
        return moved.ok ? moved : failed(moved);
      }
      const moved = await move();
      transfer.bytesDone += byteCount(step.node);
      return moved.ok ? moved : failed(moved);
    }
    const { entry } = step.node;
    let result: TransferResult;
    if (step.kind === 'link') {
      // a relative Windows target names its folders with backslashes, which a POSIX host reads as part of one name
      const target = source.os === 'win32' && dest.os !== 'win32' ? (entry.linkTarget ?? '').replace(/\\/g, '/') : entry.linkTarget ?? '';
      result = await dest.files.makeLink(dest.project, step.destDir, step.name, target, step.replace, step.within);
      if (!result.ok && result.reason === 'outside') return { ok: false, reason: 'linkOutside' };
    } else if (sameHost) {
      result = await dest.files.copy(source.project, step.srcRel, dest.project, step.destDir, step.name, step.replace, signal);
      if (result.ok) transfer.bytesDone += entry.size;
    } else {
      const read = await source.files.readFile(source.project, step.srcRel);
      // the source's own refusals: gone, no longer a file, or its folder now leading out of its project
      if (!read.ok) return { ok: false, reason: read.code === 'EACCES' || read.code === 'EPERM' ? 'permission' : read.reason === 'failed' ? 'failed' : 'changed' };
      // the source's stream is returned however the receiver ends, before or after it started reading
      try {
        if (request.op === 'move' && read.size !== entry.size) return { ok: false, reason: 'changed' };
        result = await dest.files.receiveFile(dest.project, step.destDir, step.name, this.counted(transfer, read.chunks), { mode: entry.mode, mtimeMs: entry.mtimeMs, replace: step.replace, size: read.size }, signal);
      } finally {
        await read.chunks[Symbol.asyncIterator]().return?.();
      }
    }
    if (!result.ok) return failed(result);
    // a move between hosts deletes each source item only after its copy landed with the size the walk saw, a link's only once
    // the links were settled
    if (request.op === 'move' && !sameHost && step.kind !== 'link') {
      const deleted = await source.files.deleteEntry(source.project, step.srcRel, entry.identity);
      if (!deleted.ok) return { ok: false, reason: deleted.reason === 'changed' ? 'changed' : deleted.reason === 'missing' ? 'missing' : 'failed', ...(deleted.message !== undefined ? { message: deleted.message } : {}) };
    }
    return { ok: true, left: [] };
  }

  private reasonText(reason: SkipReason, message: string | undefined): string {
    const { t } = this.deps;
    switch (reason) {
      case 'name': return t('its name is not allowed there');
      case 'linkWindows': return t('a link, which a Windows host cannot make');
      case 'linkOutside': return t('a link that leads outside what was copied');
      case 'special': return t('a special file (socket, pipe or device)');
      case 'permission': return t('permission denied');
      case 'exists': return t('a file of that name appeared meanwhile');
      case 'chosen': return t('you chose Skip');
      case 'changed': return t('it changed during the copy');
      case 'invalid': return t('its size, time or link target cannot be stored there');
      case 'missing': return t('it or its folder is no longer there');
      case 'outside': return t('its folder now leads outside the destination folder');
      case 'noSpace': return t('the disk is full');
      case 'unreadable': return message !== undefined ? t('it could not be read ({0})', visibleText(message)) : t('it could not be copied');
      case 'notListed': return t('more items stayed where they were and are not listed: {0}', message ?? '');
      case 'failed': return message !== undefined ? visibleText(message) : t('it could not be copied');
    }
  }

  private summarize(transfer: Running, request: TransferRequest, dest: Side, destDir: string, plan: Plan, landed: number, total: number, skipped: readonly SkippedItem[], stopped: string | undefined): void {
    const { t } = this.deps;
    if (transfer.state === 'cancelled') return;
    const where = request.destination.kind === 'download'
      ? dest.project.fsPath
      : dest.projectKey !== undefined && this.deps.target(dest.projectKey).host !== undefined ? this.deps.target(dest.projectKey).host! : destDir === '' ? dest.project.name : path.posix.basename(destDir);
    const counts = request.op === 'move' ? t('Moved {0} of {1} items to {2}.', landed, total, visibleText(where))
      : request.op === 'download' ? t('Downloaded {0} of {1} items to {2}.', landed, total, visibleText(where))
        : t('Copied {0} of {1} items to {2}.', landed, total, visibleText(where));
    const details = skipped.map((item) => `${visibleText(item.path)}: ${this.reasonText(item.reason, item.message)}`);
    const showDetails = t('Show details');
    const reveal = t('Reveal in File Explorer');
    const offerDetails = (answer: number | undefined, detailsIndex: number): void => {
      if (answer === detailsIndex) void this.deps.showDetails(counts, details);
    };
    if (stopped !== undefined) {
      const message = `${counts} ${t('The transfer stopped: {0}', visibleText(stopped))}`;
      void this.deps.notify('error', message, details.length > 0 ? [showDetails] : []).then((answer) => offerDetails(answer, 0));
      return;
    }
    const skippedText = skipped.length > 0 ? ` ${t('{0} skipped', skipped.length)}` : '';
    if (request.destination.kind === 'download') {
      const top = plan.tops[0] ?? request.destination.name ?? (request.sources[0]?.kind === 'project' ? path.posix.basename(request.sources[0].relativePath) : '');
      // only a name the plan landed or the Save dialog gave, so the unchecked reveal stays below the folder the user picked
      const landedName = plan.tops[0] ?? request.destination.name;
      const landedAt = landedName !== undefined ? path.join(dest.project.fsPath, landedName) : dest.project.fsPath;
      const message = skipped.length > 0 ? `${counts}${skippedText}` : t('Downloaded \'{0}\' to {1}.', visibleText(top), visibleText(dest.project.fsPath));
      const actions = skipped.length > 0 ? [reveal, showDetails] : [reveal];
      void this.deps.notify(skipped.length > 0 ? 'warning' : 'info', message, actions).then((answer) => {
        if (answer === 0) this.deps.revealDownload(landedAt).catch((err: unknown) => this.deps.log(`[files] revealing ${landedAt} failed: ${errorText(err)}`));
        offerDetails(answer, 1);
      });
      return;
    }
    if (skipped.length === 0) return;
    void this.deps.notify('warning', `${counts}${skippedText}`, [showDetails]).then((answer) => offerDetails(answer, 0));
  }
}
