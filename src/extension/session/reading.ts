import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import type {
  ClaudeSessionEntry,
  JsonlContentBlock,
  StoredSession,
  AgentData,
  AgentToolCall,
  AgentContentBlock,
  AgentMessage,
  ExtractedSessionStats,
  CompactInfo,
  PaginatedSessionResult,
} from './types';
import { TOOL_RESULT_PREVIEW_LENGTH, COMPACT_SUMMARY_SEARCH_DEPTH, isContentBlockArray, isSubagentCorrelationEntry } from './types';
import { getSessionDir, getSessionFilePath, getAgentFilePath, buildSessionFilePath, isValidSessionId } from './paths';
import {
  readSessionFileLines,
  parseSessionEntry,
  parseAllSessionEntries,
  findUserTextBlock,
  isDisplayableMessage,
  extractPreviewText,
  extractTextFromSlashCommand,
} from './parsing';
import { getActiveBranchUuids } from './branches';

interface MinimalEntry {
  type?: string;
  slug?: string;
  customTitle?: string;
  isMeta?: boolean;
  message?: { content?: unknown };
}

async function parseSessionFile(filePath: string): Promise<{
  preview: string;
  slug?: string;
  customTitle?: string;
  messageCount: number;
}> {
  const lines = await readSessionFileLines(filePath);

  let preview = '';
  let slug: string | undefined;
  let customTitle: string | undefined;
  let messageCount = 0;
  let hasAssistantMessage = false;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as MinimalEntry;
      const entryType = entry.type;

      if (entryType === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
        continue;
      }

      if (!slug && entry.slug) {
        slug = entry.slug;
      }

      if (entryType === 'user' && !entry.isMeta && entry.message) {
        messageCount++;
        if (!preview) {
          const msgContent = entry.message.content;
          if (typeof msgContent === 'string') {
            const textToPreview = extractTextFromSlashCommand(msgContent);
            preview = extractPreviewText(textToPreview);
          } else if (isContentBlockArray(msgContent)) {
            const textBlock = findUserTextBlock(msgContent);
            if (textBlock) {
              const textToPreview = extractTextFromSlashCommand(textBlock.text);
              preview = extractPreviewText(textToPreview);
            }
          }
        }
      } else if (entryType === 'assistant' && entry.message) {
        messageCount++;
        hasAssistantMessage = true;
      }
    } catch {
      continue;
    }
  }

  if (!hasAssistantMessage) {
    messageCount = 0;
  }

  return { preview, slug, customTitle, messageCount };
}

export async function listSessions(workspacePath: string): Promise<StoredSession[]> {
  const sessionDir = await getSessionDir(workspacePath);

  try {
    const files = await fs.promises.readdir(sessionDir);

    const sessionFiles = files.filter(file =>
      file.endsWith('.jsonl') && !file.startsWith('agent-')
    );

    const sessionPromises = sessionFiles.map(async (file): Promise<StoredSession | null> => {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(sessionDir, file);

      try {
        const stat = await fs.promises.stat(filePath);

        if (stat.size === 0) {
          return null;
        }

        const sessionData = await parseSessionFile(filePath);

        if (sessionData.messageCount === 0) {
          return null;
        }

        return {
          id: sessionId,
          timestamp: stat.mtime.getTime(),
          preview: sessionData.preview || 'Session started...',
          slug: sessionData.slug,
          customTitle: sessionData.customTitle,
          messageCount: sessionData.messageCount,
        };
      } catch {
        return null;
      }
    });

    const results = await Promise.all(sessionPromises);
    const sessions = results.filter((s): s is StoredSession => s !== null);

    sessions.sort((a, b) => b.timestamp - a.timestamp);

    return sessions;
  } catch {
    return [];
  }
}

export async function getSessionMetadata(workspacePath: string, sessionId: string): Promise<StoredSession | null> {
  if (!isValidSessionId(sessionId)) {
    return null;
  }

  const sessionDir = await getSessionDir(workspacePath);
  const filePath = buildSessionFilePath(sessionDir, sessionId);

  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0) {
      return null;
    }

    const sessionData = await parseSessionFile(filePath);
    if (sessionData.messageCount === 0) {
      return null;
    }

    return {
      id: sessionId,
      timestamp: stat.mtime.getTime(),
      preview: sessionData.preview || 'Session started...',
      slug: sessionData.slug,
      customTitle: sessionData.customTitle,
      messageCount: sessionData.messageCount,
    };
  } catch {
    return null;
  }
}

export async function sessionExists(workspacePath: string, sessionId: string): Promise<boolean> {
  const filePath = await getSessionFilePath(workspacePath, sessionId);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readSessionEntries(workspacePath: string, sessionId: string): Promise<ClaudeSessionEntry[]> {
  const filePath = await getSessionFilePath(workspacePath, sessionId);

  try {
    const lines = await readSessionFileLines(filePath);
    return parseAllSessionEntries(lines);
  } catch {
    return [];
  }
}

export async function readActiveBranchEntries(
  workspacePath: string,
  sessionId: string,
  customLeaf?: string
): Promise<ClaudeSessionEntry[]> {
  const allEntries = await readSessionEntries(workspacePath, sessionId);
  const activeUuids = getActiveBranchUuids(allEntries, { customLeaf });
  return allEntries.filter(entry => entry.uuid && activeUuids.has(entry.uuid));
}

export async function readAgentData(workspacePath: string, agentId: string): Promise<AgentData> {
  const filePath = await getAgentFilePath(workspacePath, agentId);

  try {
    const lines = await readSessionFileLines(filePath);

    const allToolCalls: AgentToolCall[] = [];
    const toolResults = new Map<string, { result: string; editLineNumber?: number }>();
    const messages: AgentMessage[] = [];
    const assistantMessagesByMsgId = new Map<string, AgentMessage>();
    const messageOrder: string[] = [];
    let model: string | undefined;
    let startTimestamp: number | undefined;
    let endTimestamp: number | undefined;

    for (const line of lines) {
      try {
        const entry = parseSessionEntry(line);

        if (entry.timestamp) {
          const ts = new Date(entry.timestamp).getTime();
          if (!startTimestamp || ts < startTimestamp) startTimestamp = ts;
          if (!endTimestamp || ts > endTimestamp) endTimestamp = ts;
        }

        if (entry.type === 'user' && entry.message && isContentBlockArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_result') {
              const resultContent = typeof block.content === 'string'
                ? block.content.slice(0, TOOL_RESULT_PREVIEW_LENGTH)
                : JSON.stringify(block.content).slice(0, TOOL_RESULT_PREVIEW_LENGTH);

              let editLineNumber: number | undefined;
              if (entry.toolUseResult && !Array.isArray(entry.toolUseResult)) {
                const patch = entry.toolUseResult.structuredPatch;
                if (Array.isArray(patch) && patch.length > 0 && typeof patch[0].oldStart === 'number') {
                  editLineNumber = patch[0].oldStart;
                }
              }

              toolResults.set(block.tool_use_id, { result: resultContent, editLineNumber });
            }
          }
        }

        if (entry.type === 'assistant' && entry.message) {
          if (!model && entry.message.model) {
            model = entry.message.model as string;
          }

          const msgId = entry.message.id;
          if (msgId && isContentBlockArray(entry.message.content)) {
            let existingMsg = assistantMessagesByMsgId.get(msgId);
            if (!existingMsg) {
              existingMsg = { role: 'assistant', contentBlocks: [] };
              assistantMessagesByMsgId.set(msgId, existingMsg);
              messageOrder.push(msgId);
            }

            for (const block of entry.message.content) {
              if (block.type === 'tool_use') {
                const toolBlock: AgentContentBlock = {
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input,
                };
                existingMsg.contentBlocks.push(toolBlock);
                allToolCalls.push({ id: block.id, name: block.name, input: block.input });
              } else if (block.type === 'text' && block.text) {
                existingMsg.contentBlocks.push({ type: 'text', text: block.text });
              } else if (block.type === 'thinking' && block.thinking) {
                existingMsg.contentBlocks.push({ type: 'thinking', thinking: block.thinking });
              }
            }
          }
        }
      } catch {
        continue;
      }
    }

    for (const msgId of messageOrder) {
      const msg = assistantMessagesByMsgId.get(msgId);
      if (msg && msg.contentBlocks.length > 0) {
        for (const block of msg.contentBlocks) {
          if (block.type === 'tool_use') {
            const resultData = toolResults.get(block.id);
            if (resultData) {
              block.result = resultData.result;
              if (resultData.editLineNumber !== undefined) {
                block.metadata = { editLineNumber: resultData.editLineNumber };
              }
            }
          }
        }
        messages.push(msg);
      }
    }

    for (const tool of allToolCalls) {
      const resultData = toolResults.get(tool.id);
      if (resultData) {
        tool.result = resultData.result;
      }
    }

    return {
      toolCalls: allToolCalls,
      model,
      messages,
      startTimestamp,
      endTimestamp,
      totalToolUseCount: allToolCalls.length,
    };
  } catch {
    return { toolCalls: [], messages: [], totalToolUseCount: 0 };
  }
}

interface SinglePassResult {
  entryByUuid: Map<string, ClaudeSessionEntry>;
  leafUuid: string | null;
  subagentCorrelations: Map<string, string>;
  statsMessageData: Map<string, { usage: NonNullable<ClaudeSessionEntry['message']>['usage'] }>;
  lastCompactEntry: ClaudeSessionEntry | undefined;
  lastCompactIndex: number;
  injectedCandidates: Array<{ entry: ClaudeSessionEntry; parentUuid: string }>;
}

function processEntriesSinglePass(allEntries: ClaudeSessionEntry[]): SinglePassResult {
  const entryByUuid = new Map<string, ClaudeSessionEntry>();
  let leafUuid: string | null = null;
  const subagentCorrelations = new Map<string, string>();
  const statsMessageData = new Map<string, { usage: NonNullable<ClaudeSessionEntry['message']>['usage'] }>();
  let lastCompactEntry: ClaudeSessionEntry | undefined;
  let lastCompactIndex = -1;
  const injectedCandidates: Array<{ entry: ClaudeSessionEntry; parentUuid: string }> = [];

  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];

    if (entry.uuid) {
      entryByUuid.set(entry.uuid, entry);
    }

    if ((entry.type === 'user' || entry.type === 'assistant') && entry.uuid) {
      leafUuid = entry.uuid;
    }

    if (isSubagentCorrelationEntry(entry)) {
      subagentCorrelations.set(entry.toolUseId, entry.agentId);
    }
    if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content as JsonlContentBlock[]) {
        const toolResult = entry.toolUseResult;
        if (block.type === 'tool_result' && toolResult && !Array.isArray(toolResult) && toolResult.agentId) {
          subagentCorrelations.set(block.tool_use_id, toolResult.agentId);
        }
      }
    }

    if (entry.type === 'assistant' && entry.message?.usage && !entry.isSidechain) {
      const usage = entry.message.usage;
      const messageId = entry.message.id;
      if (usage && messageId) {
        statsMessageData.set(messageId, { usage });
      }
    }

    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.uuid) {
      lastCompactEntry = entry;
      lastCompactIndex = i;
    }

    if (entry.type === 'user' && entry.uuid && entry.isInjected && entry.parentUuid) {
      injectedCandidates.push({ entry, parentUuid: entry.parentUuid });
    }
  }

  return {
    entryByUuid,
    leafUuid,
    subagentCorrelations,
    statsMessageData,
    lastCompactEntry,
    lastCompactIndex,
    injectedCandidates,
  };
}

function computeStatsFromMessageData(
  statsMessageData: Map<string, { usage: NonNullable<ClaudeSessionEntry['message']>['usage'] }>
): ExtractedSessionStats | undefined {
  if (statsMessageData.size === 0) return undefined;

  let totalOutputTokens = 0;
  for (const data of statsMessageData.values()) {
    totalOutputTokens += data.usage?.output_tokens ?? 0;
  }

  const lastEntry = Array.from(statsMessageData.values()).pop();
  if (!lastEntry) return undefined;

  const { usage } = lastEntry;

  return {
    totalCostUsd: 0,
    totalInputTokens: usage?.input_tokens ?? 0,
    totalOutputTokens,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    numTurns: statsMessageData.size,
    contextWindowSize: 200000,
  };
}

function filterDisplayableEntries(
  allEntries: ClaudeSessionEntry[],
  activeUuids: Set<string>,
  injectedUuids: Set<string>,
  compactTimestamp: number | undefined
): ClaudeSessionEntry[] {
  return allEntries.filter(entry => {
    if (!isDisplayableMessage(entry)) return false;
    if (!entry.uuid) return false;

    if (!activeUuids.has(entry.uuid) && !injectedUuids.has(entry.uuid)) return false;
    if (entry.isCompactSummary) return false;
    if (compactTimestamp !== undefined) {
      const entryTime = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      return entryTime >= compactTimestamp;
    }
    return true;
  });
}

function paginateEntries(
  entries: ClaudeSessionEntry[],
  offset: number,
  limit: number,
  compactInfo?: CompactInfo,
  injectedUuids?: Set<string>,
  subagentCorrelations?: Map<string, string>,
  stats?: ExtractedSessionStats
): PaginatedSessionResult {
  const totalCount = entries.length;
  const endIndex = totalCount - offset;
  const startIndex = Math.max(0, endIndex - limit);
  const paginatedEntries = entries.slice(startIndex, endIndex);
  const hasMore = startIndex > 0;
  const nextOffset = offset + paginatedEntries.length;

  return { entries: paginatedEntries, totalCount, hasMore, nextOffset, compactInfo, injectedUuids, subagentCorrelations, stats };
}

export async function readSessionEntriesPaginated(
  workspacePath: string,
  sessionId: string,
  offset: number = 0,
  limit: number = 50
): Promise<PaginatedSessionResult> {
  const filePath = await getSessionFilePath(workspacePath, sessionId);

  try {
    const lines = await readSessionFileLines(filePath);
    const allEntries = parseAllSessionEntries(lines);

    const {
      entryByUuid,
      leafUuid,
      subagentCorrelations,
      statsMessageData,
      lastCompactEntry,
      lastCompactIndex,
      injectedCandidates,
    } = processEntriesSinglePass(allEntries);

    const activeUuids = getActiveBranchUuids(allEntries, {
      prebuiltUuidMap: entryByUuid,
      prebuiltLeafUuid: leafUuid,
    });

    const injectedUuids = new Set<string>();
    for (const { entry, parentUuid } of injectedCandidates) {
      if (!activeUuids.has(entry.uuid!) && activeUuids.has(parentUuid)) {
        injectedUuids.add(entry.uuid!);
      }
    }

    let compactInfo: CompactInfo | undefined;
    if (lastCompactEntry && lastCompactEntry.uuid && activeUuids.has(lastCompactEntry.uuid)) {
      const metadata = lastCompactEntry.compactMetadata;
      if (metadata) {
        const timestamp = lastCompactEntry.timestamp ? new Date(lastCompactEntry.timestamp).getTime() : Date.now();

        let summary: string | undefined;
        for (let i = lastCompactIndex + 1; i < allEntries.length; i++) {
          const entry = allEntries[i];
          if (entry.isCompactSummary && entry.message?.content) {
            summary = typeof entry.message.content === 'string' ? entry.message.content : '';
            break;
          }
        }

        compactInfo = {
          trigger: metadata.trigger,
          preTokens: metadata.preTokens,
          summary,
          timestamp,
        };
      }
    }
    const displayableEntries = filterDisplayableEntries(
      allEntries,
      activeUuids,
      injectedUuids,
      compactInfo?.timestamp
    );
    const stats = computeStatsFromMessageData(statsMessageData);

    return paginateEntries(displayableEntries, offset, limit, compactInfo, injectedUuids, subagentCorrelations, stats);
  } catch {
    return { entries: [], totalCount: 0, hasMore: false, nextOffset: 0 };
  }
}

export async function readLatestCompactSummary(
  workspacePath: string,
  sessionId: string,
  maxRetries = 3,
  retryDelayMs = 200
): Promise<string | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }

    try {
      const filePath = await getSessionFilePath(workspacePath, sessionId);
      const lines = await readSessionFileLines(filePath);
      const reversedLines = [...lines].reverse();

      for (let i = 0; i < Math.min(reversedLines.length, COMPACT_SUMMARY_SEARCH_DEPTH); i++) {
        try {
          const entry = JSON.parse(reversedLines[i]) as ClaudeSessionEntry;
          if (entry.isCompactSummary && entry.message?.content) {
            const summary = typeof entry.message.content === 'string'
              ? entry.message.content
              : '';
            if (summary) {
              log('[SessionStorage] readLatestCompactSummary: found summary at offset %d, length=%d', i, summary.length);
              return summary;
            }
          }
        } catch {
          continue;
        }
      }

      log('[SessionStorage] readLatestCompactSummary: no summary found (attempt %d)', attempt + 1);
    } catch (error) {
      log('[SessionStorage] readLatestCompactSummary error: %s', error);
    }
  }

  return null;
}
