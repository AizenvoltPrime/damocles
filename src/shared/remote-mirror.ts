import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isWorktreeId } from './worktree-id';

// Files at the root of a host's session mirror (<userData>/remote/<hostId>/mirror/), beside its project folders, whose
// names are 32 hex digits, so neither name can be a project's.

/** The folder of one project's mirror: its target folder key hashed into a single segment. */
export function projectMirrorFolder(root: string, folderKey: string): string {
  return path.join(root, createHash('sha256').update(folderKey).digest('hex').slice(0, 32));
}

// the target's sub-call usage ledger (~/.damocles/usage/subcalls.jsonl on the target)
export const MIRROR_SUBCALLS_FILE = 'subcalls.jsonl';
// MirrorClock as JSON; a sync over a connection that measured the skew records it before it brings any bytes
export const MIRROR_CLOCK_FILE = 'clock.json';

// A project's worktree chats (mirror.syncProject) sit in its mirror folder under `worktree.<worktree id>/` for a chat worktree
// and `adopted.<worktree id>/` for an adopted one (rule 18), laid out as their working folder's session folder; session ids
// are UUIDs, and the daemon lists no such name from the project's own folder. The kind decides which sessions there are the
// project's (docs/invariants.md "Worktree chats", Ownership).
const FOLDER_PREFIXES = { chat: 'worktree.', adopted: 'adopted.' } as const;

export type MirrorWorktreeKind = keyof typeof FOLDER_PREFIXES;

export function mirrorWorktreeFolder(worktreeId: string, kind: MirrorWorktreeKind): string {
  return `${FOLDER_PREFIXES[kind]}${worktreeId}`;
}

/** The kind of worktree a mirror folder name holds the session folder of; undefined for any other name. */
export function mirrorWorktreeKind(name: string): MirrorWorktreeKind | undefined {
  return (Object.keys(FOLDER_PREFIXES) as MirrorWorktreeKind[]).find((kind) => name.startsWith(FOLDER_PREFIXES[kind]) && isWorktreeId(name.slice(FOLDER_PREFIXES[kind].length)));
}

export function isMirrorWorktreeFolder(name: string): boolean {
  return mirrorWorktreeKind(name) !== undefined;
}

/** skewMs: the host's clock minus this computer's, an integer, as the handshake measured it for the connection that synced. */
export interface MirrorClock {
  readonly skewMs: number;
}

/** The skew a mirror's clock file holds, or undefined when its text is not a MirrorClock. */
export function parseMirrorClock(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { skewMs } = parsed as Record<string, unknown>;
    return typeof skewMs === 'number' && Number.isSafeInteger(skewMs) ? skewMs : undefined;
  } catch {
    return undefined;
  }
}
