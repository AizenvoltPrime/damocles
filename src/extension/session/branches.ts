import type { ClaudeSessionEntry } from './types';
import { INTERRUPT_MARKER } from './types';
import { getSessionDir, buildSessionFilePath } from './paths';
import { readSessionFileLines, readSessionFileTail, parseSessionEntry } from './parsing';

export interface ActiveBranchOptions {
  customLeaf?: string;
  prebuiltUuidMap?: Map<string, ClaudeSessionEntry>;
  prebuiltLeafUuid?: string | null;
}

export function getActiveBranchUuids(
  allEntries: ClaudeSessionEntry[],
  options: ActiveBranchOptions = {}
): Set<string> {
  const { customLeaf, prebuiltUuidMap, prebuiltLeafUuid } = options;

  const entryByUuid = prebuiltUuidMap ?? new Map<string, ClaudeSessionEntry>();
  if (!prebuiltUuidMap) {
    for (const entry of allEntries) {
      if (entry.uuid) {
        entryByUuid.set(entry.uuid, entry);
      }
    }
  }

  let leafUuid: string | null = null;
  if (prebuiltLeafUuid !== undefined) {
    leafUuid = prebuiltLeafUuid;
  } else if (customLeaf && entryByUuid.has(customLeaf)) {
    leafUuid = customLeaf;
  } else {
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const entry = allEntries[i];
      if (!entry) continue;
      if ((entry.type === 'user' || entry.type === 'assistant') && entry.uuid) {
        leafUuid = entry.uuid;
        break;
      }
    }
  }

  if (!leafUuid) {
    return new Set();
  }

  const activeUuids = new Set<string>();
  let currentUuid: string | null = leafUuid;

  while (currentUuid) {
    activeUuids.add(currentUuid);
    const entry = entryByUuid.get(currentUuid);
    if (!entry) break;
    currentUuid = entry.parentUuid ?? null;
  }

  return activeUuids;
}

export function findLastQueueOperationIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const entry = parseSessionEntry(line);
      if (entry.type === 'queue-operation' && entry.operation === 'dequeue') {
        return i;
      }
    } catch {
      continue;
    }
  }
  return -1;
}

export async function getLastMessageUuid(workspacePath: string, sessionId: string): Promise<string | null> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  try {
    const lines = await readSessionFileTail(filePath);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        const entry = parseSessionEntry(line);
        if ((entry.type === 'user' || entry.type === 'assistant') && entry.uuid) {
          return entry.uuid;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function getMessageParentUuid(
  workspacePath: string,
  sessionId: string,
  messageUuid: string
): Promise<string | null> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  try {
    const lines = await readSessionFileLines(filePath);

    for (const line of lines) {
      try {
        const entry = parseSessionEntry(line);
        if (entry.uuid === messageUuid) {
          return entry.parentUuid ?? null;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function findUserMessageInCurrentTurn(
  workspacePath: string,
  sessionId: string,
  matchContent?: string
): Promise<{ uuid: string; content: string } | null> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  try {
    const lines = await readSessionFileLines(filePath);

    const startIndex = matchContent !== undefined
      ? 0
      : findLastQueueOperationIndex(lines) + 1;

    let lastUserMessage: { uuid: string; content: string } | null = null;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        const entry = parseSessionEntry(line);

        if (entry.type === 'user' && entry.uuid) {
          const rawContent = entry.message?.content;
          const messageContent = typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent
                  .filter((c): c is { type: 'text'; text: string } =>
                    typeof c === 'object' && c !== null && 'type' in c && c.type === 'text')
                  .map(c => c.text)
                  .join('\n')
              : '';

          if (messageContent === INTERRUPT_MARKER) {
            continue;
          }

          const contentMatches = matchContent === undefined || messageContent.trim() === matchContent.trim();
          if (contentMatches) {
            lastUserMessage = { uuid: entry.uuid, content: messageContent };
          }
        }
      } catch {
        continue;
      }
    }

    return lastUserMessage;
  } catch {
    return null;
  }
}

export async function findLastMessageInCurrentTurn(
  workspacePath: string,
  sessionId: string
): Promise<string | null> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  try {
    const lines = await readSessionFileLines(filePath);
    const lastQueueOpIndex = findLastQueueOperationIndex(lines);

    for (let i = lines.length - 1; i > lastQueueOpIndex; i--) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        const entry = parseSessionEntry(line);
        if ((entry.type === 'user' || entry.type === 'assistant') && entry.uuid) {
          return entry.uuid;
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}
