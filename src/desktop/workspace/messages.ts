// WorkspaceContract: a ProjectWorkspace served over the `workspace` channel. The client allocates every watch and run id and
// the host checks each belongs to the connection that opened it; streams arrive as events keyed by that id.

import type { Call, Contract, Tables } from '../core-protocol/messages';
import { MAX_DATA_CHARS, MAX_ITEMS, MAX_KEY_CHARS, MAX_MESSAGE_CHARS, MAX_PATH_CHARS } from '../core-protocol/messages';
import { arr, bool, bytes, data, dict, either, int, INVALID, maybe, nonEmpty, none, num, obj, oneOf, opt, str, type Parser } from '../core-protocol/schema';
import type { Confined, Project } from '../local-services/confine';
import { isValidFileName } from '../preload/file-names';
import type { FileEntry } from '../preload/shell-channels';
import { MAX_EDITOR_TEXT_CHARS } from '../preload/shell-channels';
import { MAX_KEPT_SHELL_SEQUENCE_CHARS, MAX_TERMINAL_SCREEN_CHARS, TERMINAL_ICONS, type TerminalLinkKind } from '../preload/terminal-channels';
import { isTerminalId, parseHostMessage, parseHostRequest, parseTerminalView, type HostMessage, type HostRequest, type TerminalView } from '../pty-host/protocol';
import type { BrowseResult, DeleteResult, EntryResult, WatchEvent } from './file-system';
import type { FormatResolution } from './format/formatter';
import type { HostOutcome, HostRoot } from './format/formatter-hosts';
import type { RgEvent, SearchRunEnd } from './search/search-runner';
import type { ProjectFileLocation } from './search/types';
import type { ShellInjectionRequest } from './terminal/terminal-backend';
import type { TerminalProfile } from './terminal/profiles';
import type { LiveTerminal } from './terminal/terminal-backend';
import type { FolderListing } from './tree-listing';

// The largest message: a terminal screen of MAX_TERMINAL_SCREEN_CHARS UTF-16 units and its kept shell sequences'
// MAX_KEPT_SHELL_SEQUENCE_CHARS, at most 3 UTF-8 bytes each, plus its envelope.
export const WORKSPACE_MAX_MESSAGE_BYTES: number = 3 * (MAX_TERMINAL_SCREEN_CHARS + MAX_KEPT_SHELL_SEQUENCE_CHARS) + 1024 * 1024;

// EntryIdentity's bigints cross as decimal strings: the codec has no bigint tag.
export interface WireIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly birthtimeNs: string;
}

export type WireConfinedEntry =
  | { readonly ok: true; readonly path: string; readonly folder: boolean; readonly identity: WireIdentity }
  | { readonly ok: false; readonly reason: 'outside' | 'missing' | 'failed' };

// FileBytes with its bytes as the Uint8Array the codec decodes; the client wraps it in a Buffer.
export type WireFileBytes =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly mtimeMs: number; readonly dev: number; readonly ino: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'tooLarge'; readonly bytes: number }
  | { readonly kind: 'notAFile'; readonly folder: boolean }
  | { readonly kind: 'unreadable'; readonly error: string; readonly code?: string };

export interface WireHostSettingsRead {
  readonly path: string;
  readonly read: WireFileBytes | { readonly kind: 'outside' };
}

// The pty host requests a client posts; killAll and shutdown never cross, a client detaches instead.
export type TerminalPost = Exclude<HostRequest, { readonly type: 'killAll' | 'shutdown' }>;

export interface WatchLimits {
  readonly roots: readonly string[];
  readonly limit: number | null;
}

export interface PtyHostEnd {
  readonly code: number;
  readonly reason: string | null;
  readonly error: string | null;
}

export interface WorkspaceRequests {
  'files.confineExisting': Call<{ readonly project: Project; readonly relativePath: string }, Confined>;
  'files.confineMissing': Call<{ readonly project: Project; readonly relativePath: string }, Confined>;
  'files.entry': Call<{ readonly project: Project; readonly relativePath: string }, WireConfinedEntry>;
  'files.projectOfPath': Call<{ readonly projects: readonly Project[]; readonly target: string }, { readonly project: Project; readonly relativePath: string; readonly path: string } | undefined>;
  'files.realpath': Call<{ readonly target: string }, string | undefined>;
  // folderKey(path) on the host, for the project's key; reads no disk
  'files.folderKey': Call<{ readonly path: string }, string>;
  'files.read': Call<{ readonly path: string; readonly limitBytes?: number }, WireFileBytes>;
  'files.readText': Call<{ readonly path: string }, string | undefined>;
  // fails with WriteRefusedError by name, with its refusal
  'files.writeInPlace': Call<{ readonly project: Project; readonly location: ProjectFileLocation; readonly bytes: Uint8Array }, number>;
  // the host's own ~/.damocles/settings.json, which the host names itself; no other file outside a project is written
  'files.readHostSettings': Call<object, WireHostSettingsRead>;
  'files.writeHostSettings': Call<{ readonly bytes: Uint8Array }, number>;
  'files.createEntry': Call<{ readonly project: Project; readonly relativeDir: string; readonly name: string; readonly kind: 'file' | 'dir' }, EntryResult>;
  'files.renameEntry': Call<{ readonly project: Project; readonly relativePath: string; readonly newName: string }, EntryResult>;
  'files.deleteEntry': Call<{ readonly project: Project; readonly relativePath: string; readonly confirmed: WireIdentity }, DeleteResult>;
  'files.trash': Call<{ readonly path: string }, void>;
  'files.isDirectory': Call<{ readonly target: string }, boolean>;
  // each relative path's mtime under folder, joined on the host; undefined for one it cannot read
  'files.mtimes': Call<{ readonly folder: string; readonly relativePaths: readonly string[] }, ReadonlyArray<number | undefined>>;
  'files.browse': Call<{ readonly folder: string }, BrowseResult>;
  'files.watch': Call<{ readonly watchId: number; readonly base: string; readonly glob: string }, void>;
  'files.unwatch': Call<{ readonly watchId: number }, void>;
  // the watched folders whose tree ran out of inotify watches, and fs.inotify.max_user_watches (null when unreadable)
  'files.watchLimits': Call<object, WatchLimits>;
  'tree.list': Call<{ readonly project: Project; readonly relativeDir: string; readonly excludes: readonly string[] }, FolderListing>;
  'search.run': Call<{ readonly runId: number; readonly cwd: string; readonly args: readonly string[] }, void>;
  'search.kill': Call<{ readonly runId: number }, void>;
  'quickOpen.list': Call<{ readonly runId: number; readonly root: string; readonly ignoreArgs: readonly string[]; readonly excludes: readonly string[] }, void>;
  'quickOpen.kill': Call<{ readonly runId: number }, void>;
  'format.resolve': Call<{ readonly root: string; readonly file: string; readonly untrusted: readonly string[] }, FormatResolution>;
  'format.format': Call<{ readonly target: HostRoot; readonly request: { readonly prettier: string; readonly config: string | null; readonly file: string; readonly text: string } }, HostOutcome>;
  // the project keys this connection formats; the host keeps the union over its connections
  'format.retain': Call<{ readonly projectKeys: readonly string[] }, void>;
  'format.release': Call<{ readonly projectKey: string }, void>;
  'format.running': Call<{ readonly projectKey: string }, boolean>;
  'terminals.detectProfiles': Call<object, readonly TerminalProfile[]>;
  'terminals.environment': Call<{ readonly locale: string }, Readonly<Record<string, string>>>;
  'terminals.injection': Call<{ readonly request: ShellInjectionRequest }, { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } | undefined>;
  'terminals.linkKind': Call<{ readonly project: Project; readonly relativePath: string }, TerminalLinkKind | null>;
  // every terminal the host keeps; posting serialize for one attaches this connection to it
  'terminals.list': Call<object, readonly LiveTerminal[]>;
  // the host's Windows build, which its screens and its terminals' views give xterm; null off Windows
  'terminals.windowsBuild': Call<object, number | null>;
}

export interface WorkspaceClientEvents {
  // projectKey: the native key of the spawn's project, for control.listRuns
  'terminals.post': { readonly request: TerminalPost; readonly projectKey?: string };
  // this connection stops receiving every terminal; none is killed (a post's detach leaves one terminal)
  'terminals.detach': Record<string, never>;
}

export interface WorkspaceHostEvents {
  'files.watchEvent': { readonly watchId: number } & WatchEvent;
  // a watched folder's tree ran out of inotify watches: changes in some of its folders go unseen
  'files.watchLimit': { readonly root: string; readonly limit: number | null };
  'search.event': { readonly runId: number; readonly event: RgEvent };
  'search.dropped': { readonly runId: number };
  'search.end': { readonly runId: number; readonly end: SearchRunEnd };
  'quickOpen.data': { readonly runId: number; readonly chunk: Uint8Array };
  'quickOpen.end': { readonly runId: number; readonly error?: string };
  // a pty host message for a terminal this connection spawned or attached
  'terminals.message': { readonly message: HostMessage };
  // the host's pty host ended; every terminal it held is gone
  'terminals.hostExit': PtyHostEnd;
}

export interface ClientToWorkspace extends Contract {
  readonly requests: WorkspaceRequests;
  readonly events: WorkspaceClientEvents;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

export interface WorkspaceToClient extends Contract {
  readonly requests: Record<string, never>;
  readonly events: WorkspaceHostEvents;
  readonly mirrors: Record<string, never>;
  readonly panelOps: Record<string, never>;
}

const method = <P, R>(params: Parser<P>, result: Parser<R>): { readonly params: Parser<P>; readonly result: Parser<R> } => ({ params, result });

const filePath = nonEmpty(MAX_PATH_CHARS);
const relative = str(MAX_PATH_CHARS);
const key = nonEmpty(MAX_PATH_CHARS);
const message = str(MAX_MESSAGE_CHARS);
const runId = int(1, Number.MAX_SAFE_INTEGER);
const done = none;
const nothing = obj({});
const nul: Parser<null> = (raw) => (raw === null ? null : INVALID);
const lit = <const T extends string>(value: T): Parser<T> => oneOf([value] as const);
const confineFailure = oneOf(['outside', 'missing', 'failed'] as const);
const decimal: Parser<string> = (raw) => (typeof raw === 'string' && /^\d{1,40}$/.test(raw) ? raw : INVALID);
const env = dict(str(32_767), 32_767, 4096);
const args = arr(str(MAX_PATH_CHARS), MAX_ITEMS);
const globs = arr(str(MAX_PATH_CHARS), MAX_ITEMS);

// one entry name, checked against the platform of the host that joins it to a folder
const fileName: Parser<string> = (raw) => (isValidFileName(raw, process.platform) ? raw : INVALID);
const project: Parser<Project> = obj({ key, fsPath: filePath, name: str(MAX_PATH_CHARS) });
const okTrue: Parser<true> = (raw) => (raw === true ? true : INVALID);
const okFalse: Parser<false> = (raw) => (raw === false ? false : INVALID);
const confinedResult: Parser<Confined> = either(obj({ ok: okTrue, path: filePath }), obj({ ok: okFalse, reason: confineFailure }));
const identity: Parser<WireIdentity> = obj({ dev: decimal, ino: decimal, birthtimeNs: decimal });
const location: Parser<ProjectFileLocation> = obj({ path: filePath, projectKey: key, relativePath: relative });
const entryResult: Parser<EntryResult> = either(obj({ ok: okTrue }), obj({ ok: okFalse, reason: oneOf(['outside', 'missing', 'failed', 'exists'] as const), message: opt(message) }));
const deleteResult: Parser<DeleteResult> = either(obj({ ok: okTrue }), obj({ ok: okFalse, reason: oneOf(['outside', 'missing', 'failed', 'changed'] as const), message: opt(message) }));
const fileEntry: Parser<FileEntry> = obj({ name: nonEmpty(MAX_PATH_CHARS), kind: oneOf(['file', 'dir'] as const), ignored: opt(okTrue) });
const folderListing: Parser<FolderListing> = either(obj({ ok: okTrue, entries: arr(fileEntry, MAX_ITEMS) as Parser<FileEntry[]> }), obj({ ok: okFalse, reason: confineFailure }));
const fileBytes: Parser<WireFileBytes> = either(
  either(obj({ kind: lit('bytes'), bytes: bytes(MAX_DATA_CHARS), mtimeMs: num, dev: num, ino: num }), obj({ kind: lit('missing') })),
  either(obj({ kind: lit('tooLarge'), bytes: int(0, Number.MAX_SAFE_INTEGER) }), either(obj({ kind: lit('notAFile'), folder: bool }), obj({ kind: lit('unreadable'), error: message, code: opt(str(64)) }))),
);
const browseResult: Parser<BrowseResult> = either(obj({ ok: okTrue, path: filePath, folders: arr(nonEmpty(MAX_PATH_CHARS), MAX_ITEMS) }), obj({ ok: okFalse, reason: oneOf(['missing', 'failed'] as const) }));
const rgEvent: Parser<RgEvent> = obj({ type: nonEmpty(64), data: data(MAX_DATA_CHARS) as Parser<Record<string, unknown>> });
const searchEnd: Parser<SearchRunEnd> = either(obj({ code: either(int(-(2 ** 31), 2 ** 32), nul), stderr: message }), obj({ error: message }));
const hostRoot: Parser<HostRoot> = obj({ key, root: filePath });
const formatResolution: Parser<FormatResolution> = either(
  either(
    either(obj({ kind: oneOf(['missing', 'outsideRoot', 'notInstalled', 'none'] as const) }), obj({ kind: lit('nestedUntrusted'), fsPath: filePath })),
    either(obj({ kind: lit('prettierOutside'), packageDir: filePath }), obj({ kind: lit('unsupported'), version: str(256) })),
  ),
  either(
    obj({ kind: lit('configOutside'), path: filePath }),
    obj({ kind: lit('prettier'), root: filePath, file: filePath, entry: filePath, version: str(256), config: either(filePath, nul) }),
  ),
);
const hostOutcome: Parser<HostOutcome> = either(
  either(obj({ kind: lit('formatted'), text: str(MAX_EDITOR_TEXT_CHARS) }), obj({ kind: lit('ignored') })),
  either(either(obj({ kind: lit('refused'), path: filePath }), obj({ kind: lit('error'), message })), obj({ kind: lit('timeout'), starting: bool })),
);
const profile: Parser<TerminalProfile> = obj({ id: nonEmpty(MAX_KEY_CHARS), name: str(MAX_KEY_CHARS), file: filePath, args, icon: oneOf(TERMINAL_ICONS) });
const injectionRequest: Parser<ShellInjectionRequest> = obj({ file: filePath, args, nonce: nonEmpty(256), env });
const terminalView: Parser<TerminalView> = (raw) => parseTerminalView(raw) ?? INVALID;
const liveTerminal: Parser<LiveTerminal> = obj({ id: (raw: unknown) => (isTerminalId(raw) ? raw : INVALID), pid: int(0, 2 ** 32), cols: int(1, 100_000), rows: int(1, 100_000), view: opt(terminalView) });
const terminalPost: Parser<TerminalPost> = (raw) => {
  const request = parseHostRequest(raw);
  return request === undefined || request.type === 'killAll' || request.type === 'shutdown' ? INVALID : request;
};
const hostMessage: Parser<HostMessage> = (raw) => parseHostMessage(raw) ?? INVALID;
const exitCode = int(-(2 ** 31), 2 ** 32);

export const CLIENT_TO_WORKSPACE: Tables<ClientToWorkspace> = {
  requests: {
    'files.confineExisting': method(obj({ project, relativePath: relative }), confinedResult),
    'files.confineMissing': method(obj({ project, relativePath: relative }), confinedResult),
    'files.entry': method(
      obj({ project, relativePath: relative }),
      either(obj({ ok: okTrue, path: filePath, folder: bool, identity }), obj({ ok: okFalse, reason: confineFailure })),
    ),
    'files.projectOfPath': method(obj({ projects: arr(project, MAX_ITEMS), target: filePath }), maybe(obj({ project, relativePath: relative, path: filePath }))),
    'files.realpath': method(obj({ target: filePath }), maybe(filePath)),
    'files.folderKey': method(obj({ path: filePath }), filePath),
    'files.read': method(obj({ path: filePath, limitBytes: opt(int(0, MAX_DATA_CHARS)) }), fileBytes),
    'files.readText': method(obj({ path: filePath }), maybe(str(MAX_DATA_CHARS))),
    'files.writeInPlace': method(obj({ project, location, bytes: bytes(MAX_DATA_CHARS) }), num),
    'files.readHostSettings': method(nothing, obj({ path: filePath, read: either(fileBytes, obj({ kind: lit('outside') })) })),
    'files.writeHostSettings': method(obj({ bytes: bytes(MAX_DATA_CHARS) }), num),
    'files.createEntry': method(obj({ project, relativeDir: relative, name: fileName, kind: oneOf(['file', 'dir'] as const) }), entryResult),
    'files.renameEntry': method(obj({ project, relativePath: relative, newName: fileName }), entryResult),
    'files.deleteEntry': method(obj({ project, relativePath: relative, confirmed: identity }), deleteResult),
    'files.trash': method(obj({ path: filePath }), done),
    'files.isDirectory': method(obj({ target: filePath }), bool),
    'files.mtimes': method(obj({ folder: filePath, relativePaths: arr(relative, MAX_ITEMS) }), arr(maybe(num), MAX_ITEMS)),
    'files.browse': method(obj({ folder: filePath }), browseResult),
    'files.watch': method(obj({ watchId: runId, base: filePath, glob: nonEmpty(MAX_PATH_CHARS) }), done),
    'files.unwatch': method(obj({ watchId: runId }), done),
    'files.watchLimits': method(nothing, obj({ roots: arr(filePath, MAX_ITEMS), limit: either(int(0, 2 ** 32), nul) })),
    'tree.list': method(obj({ project, relativeDir: relative, excludes: globs }), folderListing),
    'search.run': method(obj({ runId, cwd: filePath, args }), done),
    'search.kill': method(obj({ runId }), done),
    'quickOpen.list': method(obj({ runId, root: filePath, ignoreArgs: args, excludes: globs }), done),
    'quickOpen.kill': method(obj({ runId }), done),
    'format.resolve': method(obj({ root: filePath, file: filePath, untrusted: arr(filePath, MAX_ITEMS) }), formatResolution),
    'format.format': method(
      obj({ target: hostRoot, request: obj({ prettier: filePath, config: either(filePath, nul), file: filePath, text: str(MAX_EDITOR_TEXT_CHARS) }) }),
      hostOutcome,
    ),
    'format.retain': method(obj({ projectKeys: arr(key, MAX_ITEMS) }), done),
    'format.release': method(obj({ projectKey: key }), done),
    'format.running': method(obj({ projectKey: key }), bool),
    'terminals.detectProfiles': method(nothing, arr(profile, MAX_ITEMS)),
    'terminals.environment': method(obj({ locale: str(256) }), env),
    'terminals.injection': method(obj({ request: injectionRequest }), maybe(obj({ args, env }))),
    'terminals.linkKind': method(obj({ project, relativePath: relative }), either(oneOf(['file', 'folder'] as const), nul)),
    'terminals.list': method(nothing, arr(liveTerminal, MAX_ITEMS)),
    'terminals.windowsBuild': method(nothing, either(int(0, Number.MAX_SAFE_INTEGER), nul)),
  },
  events: {
    'terminals.post': obj({ request: terminalPost, projectKey: opt(key) }),
    'terminals.detach': obj({}) as Parser<Record<string, never>>,
  },
  mirrors: {},
  panelOps: {},
};

export const WORKSPACE_TO_CLIENT: Tables<WorkspaceToClient> = {
  requests: {},
  events: {
    'files.watchEvent': obj({ watchId: runId, kind: oneOf(['create', 'change', 'delete'] as const), path: filePath }),
    'files.watchLimit': obj({ root: filePath, limit: either(int(0, 2 ** 32), nul) }),
    'search.event': obj({ runId, event: rgEvent }),
    'search.dropped': obj({ runId }),
    'search.end': obj({ runId, end: searchEnd }),
    'quickOpen.data': obj({ runId, chunk: bytes(MAX_DATA_CHARS) }),
    'quickOpen.end': obj({ runId, error: opt(message) }),
    'terminals.message': obj({ message: hostMessage }),
    'terminals.hostExit': obj({ code: exitCode, reason: either(message, nul), error: either(message, nul) }),
  },
  mirrors: {},
  panelOps: {},
};
