// A file dragged from the desktop shell (Files tree, editor tabs) to a chat composer. The shell sets it, the chat webview
// reads it; core resolves and confines the path, so the payload names a project and a relative path, never a filesystem path.

import { isRelativeFilePath } from './relative-path';

export const FILE_DRAG_MIME = 'application/x-damocles-file';

// Must stay equal to MAX_ID_LENGTH in src/desktop/preload/shell-channels.ts.
const MAX_PROJECT_KEY_LENGTH = 200;
// The DataTransfer string holds two bounded fields and their JSON escaping.
const MAX_PAYLOAD_CHARS = 16 * 1024;

export interface FileDragPayload {
  readonly projectKey: string;
  // '/' separated, relative to the project folder
  readonly relativePath: string;
}

export function serializeFileDragPayload(payload: FileDragPayload): string {
  return JSON.stringify({ projectKey: payload.projectKey, relativePath: payload.relativePath });
}

/** The payload of a drop, or undefined when the string is not exactly a valid payload. */
export function parseFileDragPayload(raw: unknown): FileDragPayload | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PAYLOAD_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  return parseFileDragTarget(Object.hasOwn(record, 'projectKey') ? record['projectKey'] : undefined, Object.hasOwn(record, 'relativePath') ? record['relativePath'] : undefined);
}

/** A project key and relative path as a drop names them, or undefined when either is not a valid one. */
export function parseFileDragTarget(projectKey: unknown, relativePath: unknown): FileDragPayload | undefined {
  if (typeof projectKey !== 'string' || projectKey.length === 0 || projectKey.length > MAX_PROJECT_KEY_LENGTH) return undefined;
  if (!isRelativeFilePath(relativePath)) return undefined;
  return { projectKey, relativePath };
}
