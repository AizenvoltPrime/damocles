import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { log } from '../logger';
import type { PersistUserMessageOptions, PersistPartialAssistantOptions, PersistInterruptOptions } from './types';
import { EXTENSION_VERSION, INTERRUPT_MARKER } from './types';
import { getSessionDir, getSessionFilePath, isValidSessionId, buildSessionFilePath, buildNodeFilePath } from './paths';
import { parseSessionEntry } from './parsing';
import type { UserContentBlock } from '../../shared/types/content';

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
      model: model ?? 'claude-opus-4-6',
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: 'interrupted',
    },
    uuid: messageUuid,
    timestamp,
  };

  await fs.promises.appendFile(filePath, JSON.stringify(assistantEntry) + '\n');

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

  return messageUuid;
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
  await fs.promises.writeFile(filePath, JSON.stringify(entry) + '\n');
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
}
