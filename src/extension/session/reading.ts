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
import { extractSlashCommandDisplay } from '../../shared/utils';
import { getActiveBranchUuids } from './branches';
import { isRecallFromEntries } from '../recall/history-builder';

interface MinimalEntry {
  type?: string;
  slug?: string;
  planPath?: string;
  customTitle?: string;
  contextStrategy?: string;
  isMeta?: boolean;
  message?: { content?: unknown };
}

async function parseSessionFile(filePath: string): Promise<{
  preview: string;
  slug?: string;
  planPath?: string;
  customTitle?: string;
  messageCount: number;
  isRecall: boolean;
}> {
  const lines = await readSessionFileLines(filePath);

  let preview = '';
  let slug: string | undefined;
  let planPath: string | undefined;
  let customTitle: string | undefined;
  let messageCount = 0;
  let isRecall = false;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as MinimalEntry;
      const entryType = entry.type;

      if (entryType === 'context-strategy' && entry.contextStrategy === 'recall') {
        isRecall = true;
        continue;
      }

      if (entryType === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
        continue;
      }

      if (entryType === 'plan-path' && entry.planPath) {
        planPath = entry.planPath;
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
      }
    } catch {
      continue;
    }
  }

  return {
    preview,
    ...(slug !== undefined && { slug }),
    ...(planPath !== undefined && { planPath }),
    ...(customTitle !== undefined && { customTitle }),
    messageCount,
    isRecall,
  };
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
          ...(sessionData.slug !== undefined && { slug: sessionData.slug }),
          ...(sessionData.planPath !== undefined && { planPath: sessionData.planPath }),
          ...(sessionData.customTitle !== undefined && { customTitle: sessionData.customTitle }),
          messageCount: sessionData.messageCount,
          ...(sessionData.isRecall && { isRecall: true }),
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
      ...(sessionData.slug !== undefined && { slug: sessionData.slug }),
      ...(sessionData.planPath !== undefined && { planPath: sessionData.planPath }),
      ...(sessionData.customTitle !== undefined && { customTitle: sessionData.customTitle }),
      messageCount: sessionData.messageCount,
      ...(sessionData.isRecall && { isRecall: true }),
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
  if (isRecallFromEntries(allEntries)) {
    stitchStatelessTurns(allEntries);
  }
  const activeUuids = getActiveBranchUuids(allEntries, {
    ...(customLeaf !== undefined && { customLeaf }),
  });
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
    const seenToolUseIds = new Map<string, Set<string>>();
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
                const firstPatch = Array.isArray(patch) && patch.length > 0 ? patch[0] : undefined;
                if (firstPatch && typeof firstPatch.oldStart === 'number') {
                  editLineNumber = firstPatch.oldStart;
                }
              }

              toolResults.set(block.tool_use_id, {
                result: resultContent,
                ...(editLineNumber !== undefined && { editLineNumber }),
              });
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

            let toolIds = seenToolUseIds.get(msgId);
            if (!toolIds) {
              toolIds = new Set();
              seenToolUseIds.set(msgId, toolIds);
            }

            for (const block of entry.message.content) {
              if (block.type === 'tool_use') {
                if (toolIds.has(block.id)) continue;
                toolIds.add(block.id);
                const toolBlock: AgentContentBlock = {
                  type: 'tool_use',
                  id: block.id,
                  name: block.name,
                  input: block.input,
                };
                existingMsg.contentBlocks.push(toolBlock);
                allToolCalls.push({ id: block.id, name: block.name, input: block.input });
              } else if (block.type === 'thinking' && block.thinking) {
                if (existingMsg.contentBlocks.some(b => b.type === 'thinking')) continue;
                existingMsg.contentBlocks.push({ type: 'thinking', thinking: block.thinking });
              } else if (block.type === 'text' && block.text) {
                if (existingMsg.contentBlocks.some(b => b.type === 'text' && 'text' in b && b.text === block.text)) continue;
                existingMsg.contentBlocks.push({ type: 'text', text: block.text });
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

    log('[readAgentData] agentId=%s: messages=%d, toolCalls=%d, model=%s',
      agentId, messages.length, allToolCalls.length, model ?? 'unknown');

    return {
      toolCalls: allToolCalls,
      ...(model !== undefined && { model }),
      messages,
      ...(startTimestamp !== undefined && { startTimestamp }),
      ...(endTimestamp !== undefined && { endTimestamp }),
      totalToolUseCount: allToolCalls.length,
    };
  } catch {
    log('[readAgentData] agentId=%s: file not found or parse error', agentId);
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
    if (!entry) continue;

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

function reorderInjectedAfterParent(
  entries: ClaudeSessionEntry[],
  injectedUuids: Set<string>
): ClaudeSessionEntry[] {
  if (injectedUuids.size === 0) return entries;

  const injectedByParent = new Map<string, ClaudeSessionEntry[]>();
  for (const entry of entries) {
    if (entry.uuid && injectedUuids.has(entry.uuid) && entry.parentUuid) {
      const list = injectedByParent.get(entry.parentUuid) ?? [];
      list.push(entry);
      injectedByParent.set(entry.parentUuid, list);
    }
  }

  if (injectedByParent.size === 0) return entries;

  const result: ClaudeSessionEntry[] = [];

  const flushChain = (parentUuid: string): void => {
    const children = injectedByParent.get(parentUuid);
    if (!children) return;
    injectedByParent.delete(parentUuid);
    for (const child of children) {
      result.push(child);
      if (child.uuid) flushChain(child.uuid);
    }
  };

  for (const entry of entries) {
    if (entry.uuid && injectedUuids.has(entry.uuid)) continue;
    result.push(entry);
    if (entry.uuid) flushChain(entry.uuid);
  }

  return result;
}

function isCountableUserPrompt(entry: ClaudeSessionEntry, injectedUuids?: Set<string>): boolean {
  if (entry.type !== 'user' || !entry.message) return false;
  if (entry.isMeta || entry.isVisibleInTranscriptOnly) return false;

  const isInjectedFromBranch = entry.uuid ? injectedUuids?.has(entry.uuid) : false;
  if (entry.isInjected || isInjectedFromBranch) return false;

  const msgContent = entry.message.content;
  let text = '';
  if (typeof msgContent === 'string') {
    text = msgContent;
  } else if (Array.isArray(msgContent)) {
    const textBlock = findUserTextBlock(msgContent as JsonlContentBlock[]);
    text = textBlock?.text ?? '';
  }

  if (!text || text.startsWith('<local-command-')) return false;
  if (text.startsWith('<command-')) {
    const displayContent = extractSlashCommandDisplay(text);
    if (!displayContent || displayContent.toLowerCase().startsWith('/compact')) return false;
    text = displayContent;
  }
  if (text.toLowerCase().startsWith('/compact')) return false;
  if (text.startsWith('Unknown slash command:') || text.startsWith('Caveat:')) return false;
  if (entry.isInterrupt || text.startsWith('[Request interrupted by user')) return false;

  return true;
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

  let promptIndexOffset = 0;
  for (let i = 0; i < startIndex; i++) {
    const entry = entries[i];
    if (entry && isCountableUserPrompt(entry, injectedUuids)) promptIndexOffset++;
  }

  return {
    entries: paginatedEntries,
    totalCount,
    hasMore,
    nextOffset,
    promptIndexOffset,
    ...(compactInfo !== undefined && { compactInfo }),
    ...(injectedUuids !== undefined && { injectedUuids }),
    ...(subagentCorrelations !== undefined && { subagentCorrelations }),
    ...(stats !== undefined && { stats }),
  };
}

function stitchStatelessTurns(entries: ClaudeSessionEntry[]): void {
  let lastLeafUuid: string | null = null;
  let pendingStitch = false;

  for (const entry of entries) {
    if (entry.type === 'system' && entry.subtype === 'init') {
      if (lastLeafUuid !== null) {
        pendingStitch = true;
      }
    }

    if (pendingStitch && entry.type === 'user' && entry.uuid) {
      if (!entry.parentUuid) {
        entry.parentUuid = lastLeafUuid;
      }
      pendingStitch = false;
    }

    if ((entry.type === 'user' || entry.type === 'assistant') && entry.uuid) {
      lastLeafUuid = entry.uuid;
    }
  }
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

    if (isRecallFromEntries(allEntries)) {
      stitchStatelessTurns(allEntries);
    }

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
          if (!entry) continue;
          if (entry.isCompactSummary && entry.message?.content) {
            summary = typeof entry.message.content === 'string' ? entry.message.content : '';
            break;
          }
        }

        compactInfo = {
          trigger: metadata.trigger,
          preTokens: metadata.preTokens,
          ...(summary !== undefined && { summary }),
          timestamp,
        };
      }
    }
    const filteredEntries = filterDisplayableEntries(
      allEntries,
      activeUuids,
      injectedUuids,
      compactInfo?.timestamp
    );
    const displayableEntries = reorderInjectedAfterParent(filteredEntries, injectedUuids);
    const stats = computeStatsFromMessageData(statsMessageData);

    return paginateEntries(displayableEntries, offset, limit, compactInfo, injectedUuids, subagentCorrelations, stats);
  } catch {
    return { entries: [], totalCount: 0, hasMore: false, nextOffset: 0, promptIndexOffset: 0 };
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
        const rawLine = reversedLines[i];
        if (!rawLine) continue;
        try {
          const entry = JSON.parse(rawLine) as ClaudeSessionEntry;
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
