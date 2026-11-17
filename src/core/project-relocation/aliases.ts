// The folder moves of the relocation journal, and where a recorded path is now (docs/invariants.md "Project relocation", the
// alias rule). Pure and safe in a worker thread: it imports only path rules.
import * as path from 'node:path';
import { folderKey } from '../workspace-folders/folder-key';

export interface AliasSource {
  readonly seq: number;
  /** Epoch ms; absent on an entry this version cannot read, whose moves then apply to every recorded time. */
  readonly startedAt?: number;
  readonly folders: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/**
 * A remote host's project folder moved on that host, as this computer's journal records it; paths as the host spells them,
 * startedAt the host relocation's start on the host's clock (absent: the move applies to every recorded time).
 */
export interface HostAlias {
  readonly hostId: string;
  readonly from: string;
  readonly to: string;
  readonly seq: number;
  readonly startedAt?: number;
}

/** One folder one relocation moved. */
export interface FolderMove {
  readonly seq: number;
  readonly startedAt?: number;
  readonly from: string;
  readonly to: string;
}

export interface HostFolderMove extends FolderMove {
  readonly hostId: string;
}

/**
 * Every move of the journal in seq order, a folder that stays where it is left out; plain data, so it can be posted to a worker.
 * hosts: each remote host's moves, compared as the host wrote them, which only the usage indexer and the session mirror read.
 */
export interface RelocationAliases {
  readonly moves: readonly FolderMove[];
  readonly hosts: readonly HostFolderMove[];
  /** The highest seq of the journal's relocations, those whose moves the alias rule leaves out included; absent: the moves' highest. */
  readonly localSeq?: number;
  /** The journal's id: a journal written anew after its file was deleted has its own, and its seqs, local and host, restart. */
  readonly journal?: string;
}

export const NO_ALIASES: RelocationAliases = { moves: [], hosts: [] };

export function foldAliases(sources: readonly AliasSource[], hostAliases: readonly HostAlias[] = [], journal?: string): RelocationAliases {
  const moves = sources.flatMap((source) => source.folders
    .filter((folder) => folderKey(folder.from) !== folderKey(folder.to))
    .map((folder) => ({ seq: source.seq, ...(source.startedAt !== undefined ? { startedAt: source.startedAt } : {}), from: folder.from, to: folder.to })));
  const hosts = hostAliases.filter((alias) => alias.from !== alias.to).map((alias) => ({ ...alias }));
  return { moves: moves.sort((a, b) => a.seq - b.seq), hosts: hosts.sort((a, b) => a.seq - b.seq), localSeq: Math.max(0, ...sources.map((source) => source.seq)), ...(journal !== undefined ? { journal } : {}) };
}

// A move reaches what was recorded strictly before it started; a record or a move without a time is reached by every move.
function reaches(move: FolderMove, recordedAt: number | undefined): boolean {
  return recordedAt === undefined || move.startedAt === undefined || recordedAt < move.startedAt;
}

/** Where `folder` is now: in seq order, each move of the folder it is in at that point that reaches `recordedAt`. */
export function currentPathOf(aliases: RelocationAliases, folder: string, recordedAt?: number): string {
  let now = folder;
  for (const move of aliases.moves) {
    if (reaches(move, recordedAt) && folderKey(move.from) === folderKey(now)) now = move.to;
  }
  return now;
}

/** Where a host's `folder` is now on that host, as currentPathOf walks this computer's moves. */
export function currentHostPathOf(aliases: RelocationAliases, hostId: string, folder: string, recordedAt?: number): string {
  let now = folder;
  for (const move of aliases.hosts) {
    if (move.hostId === hostId && reaches(move, recordedAt) && move.from === now) now = move.to;
  }
  return now;
}

/**
 * `anyPath` re-rooted as currentPathOf walks its folder, within one relocation under the deepest moved folder holding it;
 * undefined when no move reached it.
 */
export function relocatedPath(aliases: RelocationAliases, anyPath: string, recordedAt?: number): string | undefined {
  let now = path.resolve(anyPath);
  let moved = false;
  const { moves } = aliases;
  for (let i = 0; i < moves.length;) {
    const seq = moves[i]!.seq;
    const key = folderKey(now);
    let best: { move: FolderMove; length: number } | undefined;
    for (; i < moves.length && moves[i]!.seq === seq; i++) {
      const move = moves[i]!;
      const fromKey = folderKey(move.from);
      if (!reaches(move, recordedAt) || (key !== fromKey && !key.startsWith(fromKey.endsWith(path.sep) ? fromKey : fromKey + path.sep))) continue;
      if (!best || fromKey.length > best.length) best = { move, length: fromKey.length };
    }
    if (!best) continue;
    const rest = path.relative(path.resolve(best.move.from), now);
    now = rest === '' ? path.resolve(best.move.to) : path.join(best.move.to, rest);
    moved = true;
  }
  return moved ? now : undefined;
}
