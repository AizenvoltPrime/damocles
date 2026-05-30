import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log } from '../logger';
import type { PersistUserMessageOptions, PersistPartialAssistantOptions, PersistInterruptOptions, ClaudeSessionEntry } from './types';
import { EXTENSION_VERSION, INTERRUPT_MARKER } from './types';
import { getSessionDir, getSessionFilePath, isValidSessionId, buildSessionFilePath, buildNodeFilePath } from './paths';
import { parseSessionEntry, invalidateSessionFileCache } from './parsing';
import type { UserContentBlock } from '../../shared/types/content';
import { updateEntry, removeEntry, saveIndex } from './metadata-cache';
import { DEFAULT_FALLBACK_MODEL } from '../../shared/types/constants';

export async function initializeSession(workspacePath: string, sessionId: string): Promise<void> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  await fs.promises.mkdir(sessionDir, { recursive: true });

  const queueEntry = {
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: new Date().toISOString(),
    sessionId,
  };

  await fs.promises.writeFile(filePath, JSON.stringify(queueEntry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { preview: '', messageCount: 0, isRecall: false, mtime: st.mtime.getTime(), size: st.size });
  } catch {}
}

export async function persistQueuedMessage(
  workspacePath: string,
  sessionId: string,
  content: string
): Promise<string> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);
  const messageUuid = crypto.randomUUID();

  const queueEntry = {
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: new Date().toISOString(),
    sessionId,
    content,
    uuid: messageUuid,
  };

  await fs.promises.appendFile(filePath, JSON.stringify(queueEntry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}

  return messageUuid;
}

export async function persistUserMessage(options: PersistUserMessageOptions): Promise<string> {
  const { workspacePath, sessionId, content, parentUuid, gitBranch, targetFilePath } = options;
  const messageUuid = crypto.randomUUID();
  const normalizedContent = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;
  const timestamp = new Date().toISOString();

  let filePath: string;
  if (targetFilePath) {
    filePath = targetFilePath;
  } else {
    const sessionDir = await getSessionDir(workspacePath);
    filePath = buildSessionFilePath(sessionDir, sessionId);
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  const snapshotEntry = {
    type: 'file-history-snapshot',
    messageId: messageUuid,
    snapshot: {
      messageId: messageUuid,
      trackedFileBackups: {},
      timestamp,
    },
    isSnapshotUpdate: false,
  };

  const userEntry = {
    parentUuid: parentUuid ?? null,
    isSidechain: false,
    userType: 'external',
    cwd: workspacePath,
    sessionId,
    version: EXTENSION_VERSION,
    gitBranch: gitBranch ?? 'main',
    type: 'user',
    message: {
      role: 'user',
      content: normalizedContent,
    },
    uuid: messageUuid,
    timestamp,
    thinkingMetadata: { level: 'high', disabled: false, triggers: [] },
    tasks: [],
  };

  const lines = [JSON.stringify(snapshotEntry), JSON.stringify(userEntry)].join('\n') + '\n';
  await fs.promises.appendFile(filePath, lines);

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}

  return messageUuid;
}

export interface PersistInjectedMessageOptions {
  workspacePath: string;
  sessionId: string;
  content: string | UserContentBlock[];
  parentUuid: string | null;
  gitBranch?: string;
  uuid?: string;
}

export async function persistInjectedMessage(options: PersistInjectedMessageOptions): Promise<string> {
  const { workspacePath, sessionId, content, parentUuid, gitBranch, uuid } = options;
  const messageUuid = uuid ?? crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  const contentBlocks = typeof content === 'string'
    ? [{ type: 'text' as const, text: content }]
    : content;

  const userEntry = {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: workspacePath,
    sessionId,
    version: EXTENSION_VERSION,
    gitBranch: gitBranch ?? 'main',
    type: 'user',
    isInjected: true,
    message: {
      role: 'user',
      content: contentBlocks,
    },
    uuid: messageUuid,
    timestamp,
  };

  await fs.promises.appendFile(filePath, JSON.stringify(userEntry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}

  return messageUuid;
}

export async function persistPartialAssistant(options: PersistPartialAssistantOptions): Promise<string> {
  const { workspacePath, sessionId, parentUuid, thinking, text, model, gitBranch } = options;

  if (!thinking && !text) {
    return parentUuid;
  }

  const messageUuid = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  const content: Array<{ type: string; text?: string; thinking?: string }> = [];
  if (thinking) {
    content.push({ type: 'thinking', thinking });
  }
  if (text) {
    content.push({ type: 'text', text });
  }

  const assistantEntry = {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: workspacePath,
    sessionId,
    version: EXTENSION_VERSION,
    gitBranch: gitBranch ?? 'main',
    type: 'assistant',
    message: {
      id: `partial-${messageUuid}`,
      model: model ?? DEFAULT_FALLBACK_MODEL,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: 'interrupted',
    },
    uuid: messageUuid,
    timestamp,
  };

  await fs.promises.appendFile(filePath, JSON.stringify(assistantEntry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}

  return messageUuid;
}

export async function persistInterruptMarker(options: PersistInterruptOptions): Promise<string> {
  const { workspacePath, sessionId, parentUuid, gitBranch } = options;
  const messageUuid = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  const interruptEntry = {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: workspacePath,
    sessionId,
    version: EXTENSION_VERSION,
    gitBranch: gitBranch ?? 'main',
    type: 'user',
    isInterrupt: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: INTERRUPT_MARKER }],
    },
    uuid: messageUuid,
    timestamp,
  };

  await fs.promises.appendFile(filePath, JSON.stringify(interruptEntry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}

  return messageUuid;
}

/**
 * Append a `cancelled-prompt` marker naming the SDK user message for a prompt the user interrupted
 * before any output streamed (removed from the live UI, but the SDK already persisted it). The
 * marker is durable and survives the async write race where the SDK finishes a fast turn and
 * persists an answer after the abort. `compactCancelledTurns` later reads these markers to physically
 * delete the cancelled turn from the log. Non-chain metadata: no uuid/parentUuid.
 */
export async function persistCancelledPrompt(
  workspacePath: string,
  sessionId: string,
  cancelledUuid: string
): Promise<void> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  const entry = {
    type: 'cancelled-prompt',
    cancelledUuid,
    sessionId,
    timestamp: new Date().toISOString(),
  };

  await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}
}

/**
 * True for a user entry that begins a visible turn (a real prompt) — bounds a cancelled turn so the
 * walk stops at the next genuine prompt. Excludes meta/interrupt markers and tool_result carriers.
 */
function isRealUserPromptEntry(entry: ClaudeSessionEntry): boolean {
  if (entry.type !== 'user' || entry.isMeta || entry.isInterrupt || !entry.message) {
    return false;
  }
  const content = entry.message.content;
  if (typeof content === 'string') return content.length > 0;
  if (Array.isArray(content)) return !content.some(block => block.type === 'tool_result');
  return false;
}

/** Outcome of a compaction pass. `markersRemain` lets the caller retry on a later (quiescent) pass:
 * true means a `cancelled-prompt` marker is still on disk (it was skipped as unsettled, or the pass
 * bailed on a concurrent writer), false means none remain and the pending-compaction flag can clear. */
export interface CompactCancelledResult {
  rewrote: boolean;
  markersRemain: boolean;
}

/**
 * Physically delete cancelled turns from the session JSONL. Each `cancelled-prompt` marker names a
 * prompt the user interrupted before output; this removes that prompt, everything the SDK chained
 * under it (attachments, plus any answer it finished persisting after the abort — found by walking
 * children until the next real prompt), and the marker itself. A surviving entry whose parent fell
 * inside the removed subtree (the re-sent prompt the SDK chained onto the cancelled turn's "Continue"
 * synthetic) is re-parented to the nearest surviving ancestor, so deleting a middle turn never severs
 * the chain and orphans everything before it.
 *
 * With `onlySettled` (used before a resume, when the just-cancelled turn may still be mid-write), a
 * turn is removed only once it has provably finished: it has a persisted assistant answer, or a later
 * real prompt already follows it. An unsettled turn is left intact (marker kept) so a still-arriving
 * answer can't be orphaned; a later compaction clears it.
 *
 * Re-checks the file's size/mtime just before the rewrite and skips if it changed, which avoids
 * clobbering concurrent SDK appends in the common case (e.g. a cancelled turn's late answer streaming
 * in while the user re-sends). A small TOCTOU window remains between that check and the rename, so
 * this is best-effort, not a hard guarantee. When it skips for either reason the markers survive, so
 * `markersRemain` stays true and the caller retries on the next quiescent pass.
 */
export async function compactCancelledTurns(
  workspacePath: string,
  sessionId: string,
  options?: { onlySettled?: boolean }
): Promise<CompactCancelledResult> {
  if (!isValidSessionId(sessionId)) return { rewrote: false, markersRemain: false };
  const onlySettled = options?.onlySettled === true;
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  let raw: string;
  let statBefore: fs.Stats;
  try {
    statBefore = await fs.promises.stat(filePath);
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return { rewrote: false, markersRemain: false };
  }

  const rawLines = raw.split('\n');
  const parsed = rawLines.map((line): ClaudeSessionEntry | null => {
    if (!line.trim()) return null;
    try {
      return parseSessionEntry(line);
    } catch {
      return null;
    }
  });

  const cancelledUuids = new Set<string>();
  let lastRealPromptIndex = -1;
  const indexByUuid = new Map<string, number>();
  const entryByUuid = new Map<string, ClaudeSessionEntry>();
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry) continue;
    if (entry.uuid) {
      indexByUuid.set(entry.uuid, i);
      entryByUuid.set(entry.uuid, entry);
    }
    if (isRealUserPromptEntry(entry)) lastRealPromptIndex = i;
    if (entry.type === 'cancelled-prompt' && entry.cancelledUuid) {
      cancelledUuids.add(entry.cancelledUuid);
    }
  }
  if (cancelledUuids.size === 0) return { rewrote: false, markersRemain: false };

  const childrenByParent = new Map<string, ClaudeSessionEntry[]>();
  for (const entry of parsed) {
    if (entry?.parentUuid) {
      const siblings = childrenByParent.get(entry.parentUuid) ?? [];
      siblings.push(entry);
      childrenByParent.set(entry.parentUuid, siblings);
    }
  }

  const removedUuids = new Set<string>();
  const removedCancelled = new Set<string>();
  for (const cancelledUuid of cancelledUuids) {
    const turn = new Set<string>([cancelledUuid]);
    let hasAssistant = false;
    const queue = [cancelledUuid];
    while (queue.length > 0) {
      const uuid = queue.pop()!;
      for (const child of childrenByParent.get(uuid) ?? []) {
        if (!child.uuid || turn.has(child.uuid) || isRealUserPromptEntry(child)) continue;
        turn.add(child.uuid);
        if (child.type === 'assistant') hasAssistant = true;
        queue.push(child.uuid);
      }
    }

    if (onlySettled) {
      const cancelledIndex = indexByUuid.get(cancelledUuid) ?? -1;
      const hasSubsequentPrompt = lastRealPromptIndex > cancelledIndex;
      if (!hasAssistant && !hasSubsequentPrompt) continue;
    }

    for (const uuid of turn) removedUuids.add(uuid);
    removedCancelled.add(cancelledUuid);
  }
  if (removedCancelled.size === 0) return { rewrote: false, markersRemain: true };

  // Nearest surviving ancestor of a removed uuid — used to re-parent a survivor whose parent was
  // deleted, so removing a middle (cancelled) turn doesn't sever the chain. The SDK chains the
  // re-sent prompt onto the cancelled turn's "Continue from where you left off" synthetic, which is
  // inside the removed subtree; without re-parenting it would dangle and orphan everything before it.
  const survivorParentUuid = (parentUuid: string | null | undefined): string | null => {
    let cur: string | null = parentUuid ?? null;
    while (cur && removedUuids.has(cur)) {
      cur = entryByUuid.get(cur)?.parentUuid ?? null;
    }
    return cur;
  };

  const keptLines: string[] = [];
  let removedAny = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line === undefined || !line.trim()) continue;
    const entry = parsed[i] as
      | (ClaudeSessionEntry & { messageId?: string; leafUuid?: string; snapshot?: { messageId?: string } })
      | null;

    if (entry) {
      const snapshotMessageId = entry.snapshot?.messageId ?? entry.messageId;
      const shouldRemove =
        (entry.type === 'cancelled-prompt' && !!entry.cancelledUuid && removedCancelled.has(entry.cancelledUuid)) ||
        (!!entry.uuid && removedUuids.has(entry.uuid)) ||
        (entry.type === 'file-history-snapshot' && !!snapshotMessageId && removedUuids.has(snapshotMessageId)) ||
        (entry.type === 'last-prompt' && !!entry.leafUuid && removedUuids.has(entry.leafUuid));

      if (shouldRemove) {
        removedAny = true;
        continue;
      }

      if (entry.parentUuid && removedUuids.has(entry.parentUuid)) {
        try {
          const reparented = JSON.parse(line) as Record<string, unknown>;
          reparented['parentUuid'] = survivorParentUuid(entry.parentUuid);
          keptLines.push(JSON.stringify(reparented));
          removedAny = true;
          continue;
        } catch {
          // Unparseable line — keep it verbatim rather than risk corrupting it.
        }
      }
    }
    keptLines.push(line);
  }

  if (!removedAny) return { rewrote: false, markersRemain: true };

  // Abort if a writer touched the file while we computed — never clobber concurrent SDK appends.
  // The markers survive on disk, so markersRemain stays true and the caller retries when quiescent.
  try {
    const statAfter = await fs.promises.stat(filePath);
    if (statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs) {
      return { rewrote: false, markersRemain: true };
    }
  } catch {
    return { rewrote: false, markersRemain: true };
  }

  const tmpPath = `${filePath}.compact-${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, keptLines.length > 0 ? keptLines.join('\n') + '\n' : '');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
  invalidateSessionFileCache(filePath);

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}

  return { rewrote: true, markersRemain: cancelledUuids.size > removedCancelled.size };
}

export async function persistSubagentCorrelation(
  workspacePath: string,
  sessionId: string,
  toolUseId: string,
  agentId: string
): Promise<void> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  const correlationEntry = {
    type: 'subagent-correlation',
    toolUseId,
    agentId,
    sessionId,
    timestamp: new Date().toISOString(),
  };

  await fs.promises.appendFile(filePath, JSON.stringify(correlationEntry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { mtime: st.mtime.getTime(), size: st.size });
  } catch {}
}

export async function initSubagentFile(
  workspacePath: string,
  persistenceSessionId: string,
  agentId: string
): Promise<void> {
  const sessionDir = await getSessionDir(workspacePath);
  const subagentsDir = path.join(sessionDir, persistenceSessionId, 'subagents');
  await fs.promises.mkdir(subagentsDir, { recursive: true });

  const filePath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const queueEntry = {
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: new Date().toISOString(),
    sessionId: persistenceSessionId,
  };

  await fs.promises.writeFile(filePath, JSON.stringify(queueEntry) + '\n');
}

export async function initNodeFile(
  workspacePath: string,
  sessionId: string,
  nodeId: string
): Promise<string> {
  const sessionDir = await getSessionDir(workspacePath);
  const nodesDir = path.join(sessionDir, sessionId, 'nodes');
  await fs.promises.mkdir(nodesDir, { recursive: true });
  const filePath = buildNodeFilePath(sessionDir, sessionId, nodeId);
  const entry = {
    type: 'queue-operation',
    operation: 'dequeue',
    timestamp: new Date().toISOString(),
    sessionId,
    nodeId,
  };
  try {
    await fs.promises.access(filePath);
    log('[initNodeFile] Node file already exists, skipping init: %s', nodeId);
    return filePath;
  } catch {
    await fs.promises.writeFile(filePath, JSON.stringify(entry) + '\n');
  }
  return filePath;
}

export async function persistSubagentEntry(
  workspacePath: string,
  persistenceSessionId: string,
  agentId: string,
  entry: Record<string, unknown>
): Promise<void> {
  const sessionDir = await getSessionDir(workspacePath);
  const filePath = path.join(sessionDir, persistenceSessionId, 'subagents', `agent-${agentId}.jsonl`);
  await fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n');
}

export async function appendSessionTitle(workspacePath: string, sessionId: string, title: string): Promise<void> {
  const sanitizedTitle = title.trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (!sanitizedTitle) return;

  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  const customTitleEntry = {
    type: 'custom-title',
    customTitle: sanitizedTitle,
    sessionId,
  };

  await fs.promises.appendFile(filePath, JSON.stringify(customTitleEntry) + '\n');

  try {
    const st = await fs.promises.stat(filePath);
    updateEntry(sessionId, { customTitle: sanitizedTitle, mtime: st.mtime.getTime(), size: st.size });
  } catch {}
}

export async function renameSession(workspacePath: string, sessionId: string, newName: string): Promise<void> {
  const filePath = await getSessionFilePath(workspacePath, sessionId);

  if (!newName.trim()) {
    throw new Error('Session name cannot be empty');
  }

  const sanitizedName = newName.trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (!sanitizedName) {
    throw new Error('Session name cannot contain only control characters');
  }

  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  const otherLines: string[] = [];
  for (const line of lines) {
    try {
      const entry = parseSessionEntry(line);
      if (entry.type !== 'custom-title') {
        otherLines.push(line);
      }
    } catch {
      otherLines.push(line);
    }
  }

  const customTitleEntry = {
    type: 'custom-title',
    customTitle: sanitizedName,
    sessionId: sessionId,
  };

  const newContent = [...otherLines, JSON.stringify(customTitleEntry)].join('\n') + '\n';
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  try {
    await fs.promises.writeFile(tempPath, newContent);
    await fs.promises.rename(tempPath, filePath);
    invalidateSessionFileCache(filePath);

    try {
      const st = await fs.promises.stat(filePath);
      updateEntry(sessionId, { customTitle: sanitizedName, mtime: st.mtime.getTime(), size: st.size });
    } catch {}
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
    }
    throw err;
  }
}

async function findAgentFilesForSession(sessionDir: string, sessionId: string): Promise<string[]> {
  const agentFiles: string[] = [];

  try {
    const files = await fs.promises.readdir(sessionDir);
    const agentFileNames = files.filter(file => file.startsWith('agent-') && file.endsWith('.jsonl'));

    const results = await Promise.all(
      agentFileNames.map(async (file): Promise<string | null> => {
        const filePath = path.join(sessionDir, file);
        try {
          const handle = await fs.promises.open(filePath, 'r');
          try {
            const buffer = Buffer.alloc(4096);
            const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
            const firstLine = buffer.toString('utf-8', 0, bytesRead).split('\n')[0];
            if (!firstLine) return null;
            const entry = JSON.parse(firstLine);
            return entry.sessionId === sessionId ? filePath : null;
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
      })
    );

    agentFiles.push(...results.filter((f): f is string => f !== null));
  } catch {
  }

  const nestedSubagentsDir = path.join(sessionDir, sessionId, 'subagents');
  try {
    const nestedFiles = await fs.promises.readdir(nestedSubagentsDir);
    const nestedAgentFiles = nestedFiles
      .filter(file => file.startsWith('agent-') && file.endsWith('.jsonl'))
      .map(file => path.join(nestedSubagentsDir, file));
    agentFiles.push(...nestedAgentFiles);
  } catch {
  }

  return agentFiles;
}

export async function deleteSession(workspacePath: string, sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID format');
  }

  const sessionDir = await getSessionDir(workspacePath);

  const agentFiles = await findAgentFilesForSession(sessionDir, sessionId);
  const deleteResults = await Promise.allSettled(
    agentFiles.map(filePath => fs.promises.unlink(filePath))
  );

  for (let i = 0; i < deleteResults.length; i++) {
    const result = deleteResults[i];
    const file = agentFiles[i];
    if (!result || !file) continue;
    if (result.status === 'rejected' && (result.reason as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`Warning: Failed to delete agent file ${file}: ${result.reason}`);
    }
  }

  const nestedSessionDir = path.join(sessionDir, sessionId);
  try {
    await fs.promises.rm(nestedSessionDir, { recursive: true, force: true });
  } catch {
  }

  const filePath = buildSessionFilePath(sessionDir, sessionId);
  try {
    await fs.promises.unlink(filePath);
    invalidateSessionFileCache(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      removeEntry(sessionId);
      void saveIndex(sessionDir);
      return;
    }
    throw err;
  }

  removeEntry(sessionId);
  void saveIndex(sessionDir);
}
