// The damocles command's requests in main, from a target terminal's CLI socket (relayed by its daemon) and from the app's own
// command line (dist/cli.js), handled alike; no renderer reaches this (docs/invariants.md "The damocles command"). Opens stay
// project-relative: a file outside every project of its host is refused.
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../shared/types/messages';
import { pathFor } from '../../shared/project-location';
import type { FileBytes } from '../local-services/file-bytes';
import type { ConfineFailure, Confined, Project } from '../local-services/confine';
import { isRemoteForm, joinPosition } from '../cli/args';
import { CommandLineRefusal, MAX_CLI_MESSAGE_CHARS, parseCommandLine, WAIT_MARKER_NAME, type CliCommandLine, type CliOpenItem, type CliRelay, type CliRelayAnswer, type CliRequest } from '../cli/cli-protocol';
import { decodeDocument } from './platform/editor-document';
import { authorityKeyOfHost, destinationLabel, normalizeHostName, type HostRecord, type SshHostRecord, type WslHostRecord } from './remote/host-store';

export type PatchContent = { readonly kind: 'patch'; readonly patch: string } | { readonly kind: 'binary' } | { readonly kind: 'tooLarge' };

// name and folder are split by the host's own path rules
export interface PatchSide {
  readonly name: string;
  readonly folder: string;
  readonly path: string;
}

export interface PatchTab {
  readonly left: PatchSide;
  readonly right: PatchSide;
  readonly content: PatchContent;
}

// Where `--remote` sends a command-line request: a host's authority, a WSL distro (connected on the way), or nowhere.
export type RemoteTarget =
  | { readonly kind: 'authority'; readonly authorityKey: string; readonly hostId?: string }
  | { readonly kind: 'wsl'; readonly distro: string }
  | { readonly kind: 'unsaved'; readonly query: string }
  | { readonly kind: 'loopbackOff' };

export type CliOpenResult = { readonly ok: true; readonly tabId: string } | { readonly ok: false; readonly reason: ConfineFailure };

export interface CliRequestsDeps {
  // the listed projects of an authority, by main's keys
  readonly projects: (authorityKey: string) => readonly Project[];
  // the OS whose path rules the authority's paths follow
  readonly os: (authorityKey: string) => NodeJS.Platform;
  // a target's name; this computer's messages have their own wording
  readonly hostName: (authorityKey: string) => string;
  readonly isDirectory: (authorityKey: string, folder: string) => Promise<boolean>;
  // the deepest of projects holding target, by the host's own rules
  readonly projectOfPath: (authorityKey: string, projects: readonly Project[], target: string) => Promise<{ readonly project: Project; readonly relativePath: string } | undefined>;
  // an existing file's real path inside its project, every link followed, or why it has none
  readonly confineExisting: (authorityKey: string, project: Project, relativePath: string) => Promise<Confined>;
  readonly read: (authorityKey: string, file: string) => Promise<FileBytes>;
  // the folder's project key on the authority, and whether that project is listed
  readonly folderProject: (authorityKey: string, folder: string) => Promise<{ readonly projectKey: string; readonly listed: boolean }>;
  readonly selectProject: (projectKey: string) => Promise<void>;
  // adds the folder as a project of its authority with the usual trust question, and selects it
  readonly addFolder: (authorityKey: string, folder: string) => Promise<void>;
  // a yes or no question whose yes is action, focused only when focusAction
  readonly confirm: (question: string, action: string, focusAction: boolean) => Promise<boolean>;
  // opens a project file at a position
  readonly openFile: (projectKey: string, relativePath: string, position: { readonly line?: number; readonly column?: number }) => Promise<CliOpenResult>;
  readonly showPatch: (tab: PatchTab) => string;
  readonly whenClosed: (tabId: string) => Promise<void>;
  readonly showWindow: () => void;
  // a target terminal's BROWSER: the link checks and the notice (open-url.ts)
  readonly openExternal: (authorityKey: string, url: string) => Promise<void>;
  // --remote's host, never connecting a host that is not saved
  readonly resolveRemote: (spec: string) => RemoteTarget;
  // connects a saved host (a WSL distro's record is made on its first use) and resolves its authority
  readonly connect: (target: Extract<RemoteTarget, { kind: 'authority' | 'wsl' }>) => Promise<string>;
  // Connect to Host with the host typed in, starting nothing
  readonly openConnect: (query: string) => Promise<void>;
  // a command-line request's refusal, which has no terminal to print in
  readonly notify: (message: string) => void;
  // writes main's pid into a command line's wait marker; false when the marker is gone
  readonly claimWaitMarker: (marker: string) => Promise<boolean>;
  readonly deleteWaitMarker: (marker: string) => Promise<void>;
  // --diff's time bound; default DIFF_TIMEOUT_MS
  readonly diffTimeoutMs?: number;
  readonly t: (message: string, ...args: string[]) => string;
  readonly log: (line: string) => void;
}

// --diff gives up past this and says the diff is too large, as VS Code's diffEditor.maxComputationTime does
export const DIFF_TIMEOUT_MS: number = 5000;

/** A refusal whose message the CLI prints as it is. */
export class CliRefusal extends Error {
  override readonly name: string = 'CliRefusal';
}

// What a handled request leaves: the tabs it opened, which --wait waits for.
interface Opened {
  readonly tabs: readonly string[];
}

// A file inside a project or a folder, resolved before anything opens so a refusal opens nothing; shown is the path as typed.
type Resolved =
  | { readonly kind: 'file'; readonly shown: string; readonly project: Project; readonly relativePath: string; readonly line?: number; readonly column?: number }
  | { readonly kind: 'folder'; readonly folder: string };

// What an open request does once every item resolved and every question was answered.
type OpenStep = Extract<Resolved, { kind: 'file' }> | { readonly kind: 'select'; readonly projectKey: string } | { readonly kind: 'add'; readonly folder: string };

export class CliRequests {
  private readonly deps: CliRequestsDeps;
  // the --wait of every request waiting on its tabs ends here, which the quit calls
  private readonly waits = new Set<() => void>();
  // the command line's wait markers not deleted yet
  private readonly markers = new Set<string>();
  private disposed = false;

  constructor(deps: CliRequestsDeps) {
    this.deps = deps;
  }

  /**
   * The quit: tabs are kept for the next launch, never closed, so every --wait ends here. A socket's request answers, and each
   * command line's wait marker is deleted before this settles, so no dist/cli.js polls on after the app is gone. A request
   * that arrives from now on opens nothing.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const end of [...this.waits]) end();
    await Promise.all([...this.markers].map((marker) => this.deleteMarker(marker)));
  }

  /** A request a target terminal's CLI socket sent; its daemon relays it from authorityKey. Answered once --wait is over. */
  async fromSocket(authorityKey: string, relay: CliRelay): Promise<CliRelayAnswer> {
    try {
      const opened = await this.handle(authorityKey, relay.request, 'socket');
      if (relay.request.kind !== 'openExternal' && relay.request.kind !== 'status' && relay.request.wait) await this.closed(opened);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: this.refusalText(err).slice(0, MAX_CLI_MESSAGE_CHARS) };
    }
  }

  /**
   * The app's command line, a first launch's or a second instance's: the request dist/cli.js put in it, if any. One main
   * refuses to parse, or one that arrives once quitting (the quit has begun), opens nothing and has its wait marker deleted,
   * so its command returns.
   */
  async fromArgv(argv: readonly string[], ready: Promise<void>, quitting: boolean): Promise<void> {
    let commandLine: CliCommandLine | undefined;
    try {
      commandLine = parseCommandLine(argv);
    } catch (err) {
      this.deps.log(`[cli] ignoring the command line's request: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof CommandLineRefusal && err.waitMarker !== undefined) await this.dropMarker(err.waitMarker);
      return;
    }
    if (!commandLine) return;
    if (quitting) {
      this.deps.log('[cli] refused a command line request: the app is quitting');
      if (commandLine.waitMarker !== undefined) await this.dropMarker(commandLine.waitMarker);
      return;
    }
    await this.fromCommandLine(commandLine, ready);
  }

  /**
   * A request on the app's command line, from dist/cli.js, handled once ready settles. Its wait marker is claimed at once, so
   * the command can tell when the app is gone, and a quit deletes it.
   */
  async fromCommandLine(commandLine: CliCommandLine, ready: Promise<void> = Promise.resolve()): Promise<void> {
    const marker = commandLine.waitMarker;
    if (marker !== undefined) this.markers.add(marker);
    try {
      const waiting = marker !== undefined && !this.disposed && (await this.deps.claimWaitMarker(marker));
      await ready;
      if (this.disposed) {
        this.deps.log('[cli] refused a command line request: the app is quitting');
        return;
      }
      const authorityKey = commandLine.remote === undefined ? 'local' : await this.remoteAuthority(commandLine.remote);
      const opened = await this.handle(authorityKey, commandLine.request, 'commandLine');
      if (waiting) await this.closed(opened);
    } catch (err) {
      this.deps.notify(this.refusalText(err));
    } finally {
      if (marker !== undefined) await this.deleteMarker(marker);
    }
  }

  // once per marker, whoever ends its wait first
  private async deleteMarker(marker: string): Promise<void> {
    if (!this.markers.delete(marker)) return;
    await this.dropMarker(marker);
  }

  private async dropMarker(marker: string): Promise<void> {
    try {
      await this.deps.deleteWaitMarker(marker);
    } catch (err) {
      this.deps.log(`[cli] deleting the wait marker ${marker} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private refusalText(err: unknown): string {
    if (err instanceof CliRefusal) return err.message;
    this.deps.log(`[cli] a request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return this.deps.t('damocles: {0}', err instanceof Error ? err.message : String(err));
  }

  private async closed(opened: Opened): Promise<void> {
    if (this.disposed) return;
    let end = (): void => undefined;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.waits.add(end);
    try {
      await Promise.race([Promise.all(opened.tabs.map((tab) => this.deps.whenClosed(tab))), ended]);
    } finally {
      this.waits.delete(end);
    }
  }

  // The host connected first (a WSL distro as Reopen in WSL connects it), so its folders resolve and add like any host's.
  private async remoteAuthority(spec: string): Promise<string> {
    const { t } = this.deps;
    // the switch reaches main from any program that starts the app, past dist/cli.js's own check
    if (!isRemoteForm(spec)) throw new CliRefusal(t('damocles: {0} names no host. Use wsl+<distro>, ssh+<host> or loopback.', spec));
    const target = this.deps.resolveRemote(spec);
    switch (target.kind) {
      case 'loopbackOff':
        throw new CliRefusal(t('damocles: loopback names the local daemon, which runs only in a development build.'));
      case 'unsaved':
        await this.deps.openConnect(target.query);
        throw new CliRefusal(t('damocles: no saved host is called {0}. Connect to it, then run the command again.', target.query));
      case 'wsl':
      case 'authority':
        return this.deps.connect(target);
    }
  }

  private async handle(authorityKey: string, request: CliRequest, origin: 'socket' | 'commandLine'): Promise<Opened> {
    switch (request.kind) {
      case 'status':
        throw new Error('status is the daemon\'s to answer');
      case 'openExternal':
        if (origin !== 'socket' || authorityKey === 'local') throw new Error('Only a target terminal\'s BROWSER sends an address');
        await this.deps.openExternal(authorityKey, request.url);
        return { tabs: [] };
      case 'diff':
        return this.diff(authorityKey, request.left, request.right);
      case 'open':
        return this.open(authorityKey, request.items, origin);
    }
  }

  private async open(authorityKey: string, items: readonly CliOpenItem[], origin: 'socket' | 'commandLine'): Promise<Opened> {
    const { t } = this.deps;
    const resolved: Resolved[] = [];
    for (const item of items) resolved.push(await this.resolve(authorityKey, item));
    let shown = false;
    const show = (): void => {
      if (shown) return;
      shown = true;
      this.deps.showWindow();
    };
    const steps: OpenStep[] = [];
    for (const entry of resolved) {
      if (entry.kind === 'file') {
        steps.push(entry);
        continue;
      }
      const { projectKey, listed } = await this.deps.folderProject(authorityKey, entry.folder);
      if (listed) {
        steps.push({ kind: 'select', projectKey });
        continue;
      }
      // any process of the user's on a target reaches its sockets, so a folder joins only once the user agrees, and for a
      // socket's request a stray Enter never agrees
      show();
      const question = authorityKey === 'local' ? t('Add {0} on this computer as a project?', entry.folder) : t('Add {0} on {1} as a project?', entry.folder, this.deps.hostName(authorityKey));
      if (!(await this.deps.confirm(question, t('Add Project'), origin === 'commandLine'))) throw new CliRefusal(t('damocles: {0} was not added as a project.', entry.folder));
      steps.push({ kind: 'add', folder: entry.folder });
    }
    if (this.disposed) throw new CliRefusal(t('damocles: Damocles is quitting, so nothing was opened.'));
    show();
    const tabs: string[] = [];
    for (const step of steps) {
      if (step.kind === 'select') {
        await this.deps.selectProject(step.projectKey);
      } else if (step.kind === 'add') {
        await this.deps.addFolder(authorityKey, step.folder);
      } else {
        const opened = await this.deps.openFile(step.project.key, step.relativePath, { ...(step.line !== undefined ? { line: step.line } : {}), ...(step.column !== undefined ? { column: step.column } : {}) });
        if (!opened.ok) throw this.unreachable(step.shown, opened.reason);
        tabs.push(opened.tabId);
      }
    }
    return { tabs };
  }

  // An absolute path as the host names it: `.` and `..` segments resolved, no trailing separator but the root's. A relative
  // one, or a Windows one without its drive, would resolve against main's or the daemon's working folder. A refusal names shown.
  private clean(authorityKey: string, target: string, shown: string): string {
    const flavor = pathFor({ os: this.deps.os(authorityKey) });
    const normal = flavor.normalize(target);
    const root = flavor.parse(normal).root;
    if (!flavor.isAbsolute(normal) || (flavor.sep === '\\' && /^[\\/]$/.test(root))) {
      const { t } = this.deps;
      throw new CliRefusal(authorityKey === 'local' ? t('damocles: {0} is not an absolute path on this computer.', shown) : t('damocles: {0} is not an absolute path on {1}.', shown, this.deps.hostName(authorityKey)));
    }
    const trimmed = normal.replace(flavor.sep === '/' ? /\/+$/ : /[\\/]+$/, '');
    return trimmed.length > root.length ? trimmed : normal;
  }

  // `path:line:column` is read that way only when the path as typed does not exist; a refusal names what was typed.
  private async resolve(authorityKey: string, typedItem: CliOpenItem): Promise<Resolved> {
    const item = { ...typedItem, path: this.clean(authorityKey, typedItem.path, joinPosition(typedItem)) };
    const typed = joinPosition(item);
    if (item.line !== undefined) {
      if (await this.deps.isDirectory(authorityKey, typed)) return { kind: 'folder', folder: typed };
      const file = await this.projectFile(authorityKey, typed);
      if (file?.real.ok === true) return { kind: 'file', shown: typed, project: file.project, relativePath: file.relativePath };
    }
    if (await this.deps.isDirectory(authorityKey, item.path)) return { kind: 'folder', folder: item.path };
    const file = await this.projectFile(authorityKey, item.path);
    if (!file) throw await this.outside(authorityKey, typed, item.path);
    if (!file.real.ok) throw this.unreachable(typed, file.real.reason);
    return { kind: 'file', shown: typed, project: file.project, relativePath: file.relativePath, ...(item.line !== undefined ? { line: item.line } : {}), ...(item.column !== undefined ? { column: item.column } : {}) };
  }

  // the project holding target, and its real path inside that project or why it has none
  private async projectFile(authorityKey: string, target: string): Promise<{ readonly project: Project; readonly relativePath: string; readonly real: Confined } | undefined> {
    const found = await this.deps.projectOfPath(authorityKey, this.deps.projects(authorityKey), target);
    if (!found) return undefined;
    return { project: found.project, relativePath: found.relativePath, real: await this.deps.confineExisting(authorityKey, found.project, found.relativePath) };
  }

  // a path of a project that cannot be opened there
  private unreachable(shown: string, reason: ConfineFailure): CliRefusal {
    const { t } = this.deps;
    switch (reason) {
      case 'missing':
        return new CliRefusal(t('damocles: {0} does not exist.', shown));
      case 'outside':
        return new CliRefusal(t('damocles: {0} leads outside its project.', shown));
      case 'failed':
        return new CliRefusal(t('damocles: {0} could not be opened.', shown));
    }
  }

  // target lies outside every project; the hint names its folder only when that folder is not a project or inside one, where
  // the path can lead out only through a link
  private async outside(authorityKey: string, shown: string, target: string): Promise<CliRefusal> {
    const { t } = this.deps;
    const local = authorityKey === 'local';
    const folder = pathFor({ os: this.deps.os(authorityKey) }).dirname(target);
    const inProject = (await this.deps.projectOfPath(authorityKey, this.deps.projects(authorityKey), folder)) !== undefined || (await this.deps.folderProject(authorityKey, folder)).listed;
    if (inProject) {
      return new CliRefusal(local ? t('damocles: {0} leads outside the projects open on this computer.', shown) : t('damocles: {0} leads outside the projects open on {1}.', shown, this.deps.hostName(authorityKey)));
    }
    return new CliRefusal(local
      ? t('damocles: {0} is outside the projects open on this computer. Open its folder with: damocles {1}', shown, folder)
      : t('damocles: {0} is outside the projects open on {1}. Open its folder with: damocles {2}', shown, this.deps.hostName(authorityKey), folder));
  }

  private async diff(authorityKey: string, left: string, right: string): Promise<Opened> {
    const flavor = pathFor({ os: this.deps.os(authorityKey) });
    const side = async (target: string): Promise<PatchSide & { readonly text: string | 'binary' | 'tooLarge' }> => {
      const file = await this.projectFile(authorityKey, target);
      if (!file) throw await this.outside(authorityKey, target, target);
      if (!file.real.ok) throw this.unreachable(target, file.real.reason);
      const read = await this.deps.read(authorityKey, file.real.path);
      const named = { path: target, name: flavor.basename(target), folder: flavor.dirname(target) };
      if (read.kind === 'tooLarge') return { ...named, text: 'tooLarge' };
      if (read.kind !== 'bytes') throw new CliRefusal(this.deps.t('damocles: {0} is not a file.', target));
      const decoded = decodeDocument(read.bytes);
      return { ...named, text: decoded ? decoded.text : 'binary' };
    };
    const [a, b] = [await side(this.clean(authorityKey, left, left)), await side(this.clean(authorityKey, right, right))];
    const content = await (async (): Promise<PatchContent> => {
      if (a.text === 'tooLarge' || b.text === 'tooLarge') return { kind: 'tooLarge' };
      if (a.text === 'binary' || b.text === 'binary') return { kind: 'binary' };
      const aText = a.text;
      const bText = b.text;
      // the callback form yields to main's other work between steps, and gives up past the time bound
      const patch = await new Promise<string | undefined>((resolve) => {
        createTwoFilesPatch(a.path, b.path, aText, bText, undefined, undefined, { timeout: this.deps.diffTimeoutMs ?? DIFF_TIMEOUT_MS, callback: resolve });
      });
      return patch === undefined || Buffer.byteLength(patch) > EDITOR_MAX_DOCUMENT_BYTES ? { kind: 'tooLarge' } : { kind: 'patch', patch };
    })();
    if (this.disposed) throw new CliRefusal(this.deps.t('damocles: Damocles is quitting, so nothing was opened.'));
    this.deps.showWindow();
    return { tabs: [this.deps.showPatch({ left: { name: a.name, folder: a.folder, path: a.path }, right: { name: b.name, folder: b.folder, path: b.path }, content })] };
  }
}

const hostKey = (value: string): string => normalizeHostName(value).toLocaleLowerCase('en');

/**
 * Where `--remote` sends a request: wsl+<distro> names a distro (its saved spelling when one matches), ssh+<host> a saved SSH
 * host by its name, then its ssh alias, then its user@host[:port], ignoring case, and loopback the loopback daemon where it
 * runs. A host no saved record matches is unsaved, and nothing connects to it.
 */
export function resolveRemoteSpec(spec: string, hosts: readonly HostRecord[], loopback: boolean): RemoteTarget {
  if (spec === 'loopback') return loopback ? { kind: 'authority', authorityKey: 'loopback' } : { kind: 'loopbackOff' };
  if (spec.startsWith('wsl+')) {
    const distro = spec.slice('wsl+'.length);
    const saved = hosts.find((host): host is WslHostRecord => host.kind === 'wsl' && host.distro.toLowerCase() === distro.toLowerCase());
    return { kind: 'wsl', distro: saved?.distro ?? distro };
  }
  if (!spec.startsWith('ssh+')) throw new Error(`${spec} is no --remote form`);
  const value = spec.slice('ssh+'.length);
  const key = hostKey(value);
  const ssh = hosts.filter((host): host is SshHostRecord => host.kind === 'ssh');
  const found = ssh.find((host) => hostKey(host.name) === key)
    ?? ssh.find((host) => host.destination.kind === 'alias' && hostKey(host.destination.alias) === key)
    ?? ssh.find((host) => host.destination.kind === 'address' && hostKey(destinationLabel(host.destination)) === key);
  return found ? { kind: 'authority', authorityKey: authorityKeyOfHost(found), hostId: found.id } : { kind: 'unsaved', query: value };
}

// Any program can start the app with a marker path, so main touches only a file named as cli.js names one, directly in the
// markers' folder (waitMarkerFolder).
async function checkMarkerPlace(marker: string, waitDir: string, platform: NodeJS.Platform): Promise<void> {
  if (!WAIT_MARKER_NAME.test(path.basename(marker))) throw new Error(`${marker} is not a damocles-wait marker`);
  const [folder, markers] = await Promise.all([fs.realpath(path.dirname(marker)), fs.realpath(waitDir)]);
  const same = platform === 'win32' || platform === 'darwin' ? folder.toLowerCase() === markers.toLowerCase() : folder === markers;
  if (!same) throw new Error(`${marker} is not in the wait markers' folder ${markers}`);
}

// the marker's lstat; undefined once the command removed it
async function markerStat(marker: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(marker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Writes pid into a --wait marker, which tells dist/cli.js which process to watch until the marker is gone; false when the
 * command already removed it. Only a regular file is written, never through a link.
 */
export async function claimWaitMarker(marker: string, waitDir: string, pid: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  await checkMarkerPlace(marker, waitDir, platform);
  const stat = await markerStat(marker);
  if (!stat) return false;
  if (!stat.isFile()) throw new Error(`${marker} is not a file`);
  let handle: fs.FileHandle;
  try {
    // Windows has no O_NOFOLLOW; there the lstat above refused a link
    handle = await fs.open(marker, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  try {
    await handle.truncate(0);
    await handle.write(String(pid), 0);
  } finally {
    await handle.close();
  }
  return true;
}

/** Deletes a --wait marker, which ends dist/cli.js's wait: only a regular file of the markers' folder. */
export async function deleteWaitMarker(marker: string, waitDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  await checkMarkerPlace(marker, waitDir, platform);
  const stat = await markerStat(marker);
  // the command was ended and its marker removed with it
  if (!stat) return;
  if (!stat.isFile()) throw new Error(`${marker} is not a file`);
  await fs.rm(marker);
}
