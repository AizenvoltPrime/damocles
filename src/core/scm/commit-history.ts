// Commit message history per repository root (B5), kept in global KeyValueState under COMMIT_HISTORY_KEY as
// { [folderKey(root)]: messages, newest first }. The dedupe and the limit follow VS Code's SCM input history
// (HistoryNavigator2 in src/vs/base/common/history.ts, capacity 100 in scmService.ts).
import type { Memento } from '../../platform/key-value-state';
import { folderKey } from '../workspace-folders/folder-key';
import { updateSerially } from './serial-update';

export const COMMIT_HISTORY_KEY = 'damocles.scm.commitHistory';
export const COMMIT_HISTORY_LIMIT = 100;
// Roots kept; the root committed to longest ago goes first, so the stored value stays bounded.
export const COMMIT_HISTORY_ROOTS = 100;
// JSON bytes one root's entry may take, its key included; past it the oldest messages go, and a message that alone exceeds
// it is not kept.
export const COMMIT_HISTORY_ROOT_BYTES = 20_000;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function messagesOf(all: Record<string, unknown>, key: string): string[] {
  const list = Object.hasOwn(all, key) ? all[key] : undefined;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string').slice(0, COMMIT_HISTORY_LIMIT) : [];
}

const jsonBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** The root's committed messages, newest first. */
export function commitHistory(state: Memento, root: string): string[] {
  return messagesOf(recordOf(state.get<unknown>(COMMIT_HISTORY_KEY, {})), folderKey(root));
}

/** Puts a committed message first; an equal earlier entry moves up rather than repeating. A blank message is not kept. */
export function recordCommitMessage(state: Memento, root: string, message: string): Promise<void> {
  const key = folderKey(root);
  if (message.trim() === '' || jsonBytes(key) + jsonBytes(message) > COMMIT_HISTORY_ROOT_BYTES) return Promise.resolve();
  return updateSerially(state, COMMIT_HISTORY_KEY, (current) => {
    const all = recordOf(current);
    const messages: string[] = [];
    let bytes = jsonBytes(key);
    for (const entry of [message, ...messagesOf(all, key).filter((candidate) => candidate !== message)].slice(0, COMMIT_HISTORY_LIMIT)) {
      bytes += jsonBytes(entry) + 1;
      if (bytes > COMMIT_HISTORY_ROOT_BYTES) break;
      messages.push(entry);
    }
    const others = Object.entries(all).filter(([candidate]) => candidate !== key);
    // insertion order is recency: the root just written goes last, and the oldest roots fall off the front
    return Object.fromEntries([...others.slice(Math.max(0, others.length - COMMIT_HISTORY_ROOTS + 1)), [key, messages]]);
  });
}
