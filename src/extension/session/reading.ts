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
  SessionReadResult,
} from './types';
import { TOOL_RESULT_PREVIEW_LENGTH, COMPACT_SUMMARY_SEARCH_DEPTH, isContentBlockArray, isSubagentCorrelationEntry, isTeamCorrelationEntry } from './types';
import { getSessionDir, getSessionFilePath, getAgentFilePath, buildSessionFilePath, isValidSessionId } from './paths';
import {
  readSessionFileLines,
  readSessionFileTail,
  parseSessionEntry,
  parseAllSessionEntries,
  findUserTextBlock,
  isDisplayableMessage,
  extractPreviewText,
  extractTextFromSlashCommand,
} from './parsing';
import { loadIndex, getEntry, isFresh, updateEntry, saveIndex, isSDKStale } from './metadata-cache';
import { getSessionInfoFromSDK } from './sdk-operations';
import { getActiveBranchUuids } from './branches';
import { FEEDBACK_MARKER } from '../../shared/types/constants';
import { isRecallFromEntries, readNodeFileEntries, mergeEntriesByTimestamp, getNodeFilesMaxMtime } from '../recall/history-builder';

interface MinimalEntry {
  type?: string;
  slug?: string;
  planPath?: string;
  customTitle?: string;
  contextStrategy?: string;
  isMeta?: boolean;
  message?: { content?: unknown };
}

const PARSE_LINE_LIMIT = 200;

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
  let linesScanned = 0;
  let hasEssentials = false;

  for (const line of lines) {
    if (hasEssentials && linesScanned >= PARSE_LINE_LIMIT) break;
    linesScanned++;

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

      if (!hasEssentials && preview && messageCount >= 2) {
        hasEssentials = true;
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
    await loadIndex(sessionDir);
    const files = await fs.promises.readdir(sessionDir);
    const sessionFiles = files.filter(file =>
      file.endsWith('.jsonl') && !file.startsWith('agent-')
    );

    let indexDirty = false;

    const sessionPromises = sessionFiles.map(async (file): Promise<StoredSession | null> => {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(sessionDir, file);

      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size === 0) return null;

        const mtime = stat.mtime.getTime();
        const size = stat.size;
        const cached = getEntry(sessionId);

        if (cached && isFresh(cached, mtime, size)) {
          if (cached.messageCount === 0) return null;
          return {
            id: sessionId,
            timestamp: mtime,
            preview: cached.preview || 'Session started...',
            ...(cached.slug !== undefined && { slug: cached.slug }),
            ...(cached.planPath !== undefined && { planPath: cached.planPath }),
            ...(cached.customTitle !== undefined && { customTitle: cached.customTitle }),
            messageCount: cached.messageCount,
            ...(cached.isRecall && { isRecall: true }),
            ...(cached.tag && { tag: cached.tag }),
            ...(cached.createdAt && { createdAt: cached.createdAt }),
          };
        }

        const sessionData = await parseSessionFile(filePath);
        if (sessionData.messageCount === 0) {
          updateEntry(sessionId, { ...sessionData, mtime, size });
          indexDirty = true;
          return null;
        }

        updateEntry(sessionId, {
          preview: sessionData.preview,
          messageCount: sessionData.messageCount,
          isRecall: sessionData.isRecall,
          ...(sessionData.slug !== undefined && { slug: sessionData.slug }),
          ...(sessionData.planPath !== undefined && { planPath: sessionData.planPath }),
          ...(sessionData.customTitle !== undefined && { customTitle: sessionData.customTitle }),
          mtime,
          size,
        });
        indexDirty = true;

        return {
          id: sessionId,
          timestamp: mtime,
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

    if (indexDirty) {
      void saveIndex(sessionDir);
    }

    const staleIds: string[] = [];
    for (const session of sessions) {
      const cached = getEntry(session.id);
      if (cached?.tag && !isSDKStale(cached)) {
        session.tag = cached.tag;
        if (cached.createdAt) session.createdAt = cached.createdAt;
      } else {
        staleIds.push(session.id);
      }
    }

    if (staleIds.length > 0) {
      void fetchSDKMetadataInBackground(staleIds, sessionDir);
    }

    return sessions;
  } catch {
    return [];
  }
}

let sdkFetchInFlight = false;

async function fetchSDKMetadataInBackground(sessionIds: string[], sessionDir: string): Promise<void> {
  if (sdkFetchInFlight) return;
  sdkFetchInFlight = true;

  try {
    const BATCH_SIZE = 5;
    for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
      const batch = sessionIds.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async id => {
        try {
          const info = await getSessionInfoFromSDK(id, sessionDir);
          if (!info) return;
          const existing = getEntry(id);
          if (existing) {
            updateEntry(id, {
              mtime: existing.mtime,
              size: existing.size,
              ...(info.tag !== undefined && { tag: info.tag }),
              ...(info.createdAt !== undefined && { createdAt: info.createdAt }),
              sdkFetchedAt: Date.now(),
            });
          }
        } catch {}
      }));
    }
    void saveIndex(sessionDir);
  } finally {
    sdkFetchInFlight = false;
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

    const session: StoredSession = {
      id: sessionId,
      timestamp: stat.mtime.getTime(),
      preview: sessionData.preview || 'Session started...',
      ...(sessionData.slug !== undefined && { slug: sessionData.slug }),
      ...(sessionData.planPath !== undefined && { planPath: sessionData.planPath }),
      ...(sessionData.customTitle !== undefined && { customTitle: sessionData.customTitle }),
      messageCount: sessionData.messageCount,
      ...(sessionData.isRecall && { isRecall: true }),
    };

    try {
      const info = await getSessionInfoFromSDK(session.id, workspacePath);
      if (info?.tag) session.tag = info.tag;
      if (info?.createdAt) session.createdAt = info.createdAt;
    } catch { /* SDK metadata is best-effort */ }

    return session;
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

/** Sum output_tokens across deduplicated (by message.id) assistant entries to seed StreamingState.sessionTotalOutputTokens on resume. */
export async function readSessionOutputTokenTotal(workspacePath: string, sessionId: string): Promise<number> {
  const entries = await readSessionEntries(workspacePath, sessionId);
  const usageByMessageId = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const messageId = entry.message?.id;
    if (!messageId) continue;
    const outputTokens = entry.message?.usage?.output_tokens ?? 0;
    if (outputTokens > 0 && !usageByMessageId.has(messageId)) {
      usageByMessageId.set(messageId, outputTokens);
    }
  }
  let total = 0;
  for (const value of usageByMessageId.values()) total += value;
  return total;
}

export async function readActiveBranchEntries(
  workspacePath: string,
  sessionId: string,
  customLeaf?: string
): Promise<ClaudeSessionEntry[]> {
  let allEntries = await readSessionEntries(workspacePath, sessionId);
  const isRecall = isRecallFromEntries(allEntries);
  if (isRecall) {
    const nodeEntries = await readNodeFileEntries(workspacePath, sessionId);
    if (nodeEntries.length > 0) {
      allEntries = mergeEntriesByTimestamp(allEntries, nodeEntries);
    }
    stitchStatelessTurns(allEntries);
  }
  const entryByUuid = new Map<string, ClaudeSessionEntry>();
  for (const entry of allEntries) {
    if (entry.uuid) entryByUuid.set(entry.uuid, entry);
  }
  repairTaskNotificationBranching(allEntries, entryByUuid);

  const activeUuids = getActiveBranchUuids(allEntries, {
    ...(customLeaf !== undefined && { customLeaf }),
    prebuiltUuidMap: entryByUuid,
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

interface ToolResultData {
  result: string;
  rawResult?: unknown;
  agentId?: string;
  isError?: boolean;
  feedback?: string;
}

interface SinglePassResult {
  entryByUuid: Map<string, ClaudeSessionEntry>;
  leafUuid: string | null;
  subagentCorrelations: Map<string, string>;
  teamCorrelations: Map<string, string>;
  statsMessageData: Map<string, { usage: NonNullable<ClaudeSessionEntry['message']>['usage'] }>;
  lastCompactEntry: ClaudeSessionEntry | undefined;
  lastCompactIndex: number;
  injectedCandidates: Array<{ entry: ClaudeSessionEntry; parentUuid: string }>;
  toolResults: Map<string, ToolResultData>;
}

function hasStructuredToolUseResult(toolUseResult: ClaudeSessionEntry['toolUseResult']): boolean {
  if (!toolUseResult) return false;
  if (Array.isArray(toolUseResult)) {
    const firstBlock = toolUseResult[0];
    return Boolean(firstBlock && typeof firstBlock === 'object' && 'type' in firstBlock);
  }
  if (toolUseResult.totalDurationMs !== undefined) return true;
  if (toolUseResult.answers !== undefined) return true;
  if (toolUseResult.matches !== undefined && toolUseResult.total_deferred_tools !== undefined) return true;
  if (toolUseResult.humanSchedule !== undefined) return true;
  const jobs = toolUseResult.jobs;
  if (Array.isArray(jobs) && jobs.length > 0 && jobs[0]?.cron !== undefined) return true;
  return false;
}

function collectToolResultFromBlock(
  block: JsonlContentBlock,
  entry: ClaudeSessionEntry,
  toolResults: Map<string, ToolResultData>
): void {
  if (block.type !== 'tool_result') return;

  const isError = block.is_error === true;
  const rawResult = entry.toolUseResult && !Array.isArray(entry.toolUseResult)
    ? entry.toolUseResult
    : undefined;
  const agentId = rawResult?.agentId;

  if (hasStructuredToolUseResult(entry.toolUseResult)) {
    toolResults.set(block.tool_use_id, {
      result: JSON.stringify(entry.toolUseResult),
      ...(agentId !== undefined ? { agentId } : {}),
      isError,
      ...(rawResult ? { rawResult } : {}),
    });
    return;
  }

  const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);

  let feedback: string | undefined;
  if (isError && result.includes(FEEDBACK_MARKER)) {
    const markerIndex = result.indexOf(FEEDBACK_MARKER);
    feedback = result.slice(markerIndex + FEEDBACK_MARKER.length).trim();
  }

  toolResults.set(block.tool_use_id, {
    result,
    isError,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(feedback !== undefined ? { feedback } : {}),
    ...(rawResult ? { rawResult } : {}),
  });
}

function processEntriesSinglePass(allEntries: ClaudeSessionEntry[]): SinglePassResult {
  const entryByUuid = new Map<string, ClaudeSessionEntry>();
  let leafUuid: string | null = null;
  const subagentCorrelations = new Map<string, string>();
  const teamCorrelations = new Map<string, string>();
  const statsMessageData = new Map<string, { usage: NonNullable<ClaudeSessionEntry['message']>['usage'] }>();
  let lastCompactEntry: ClaudeSessionEntry | undefined;
  let lastCompactIndex = -1;
  const injectedCandidates: Array<{ entry: ClaudeSessionEntry; parentUuid: string }> = [];
  const toolResults = new Map<string, ToolResultData>();

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
    if (isTeamCorrelationEntry(entry)) {
      teamCorrelations.set(entry.toolUseId, entry.teamId);
    }
    if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content as JsonlContentBlock[]) {
        const toolResult = entry.toolUseResult;
        if (block.type === 'tool_result' && toolResult && !Array.isArray(toolResult) && toolResult.agentId) {
          subagentCorrelations.set(block.tool_use_id, toolResult.agentId);
        }
        collectToolResultFromBlock(block, entry, toolResults);
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
    teamCorrelations,
    statsMessageData,
    lastCompactEntry,
    lastCompactIndex,
    injectedCandidates,
    toolResults,
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

function buildSessionReadResult(
  entries: ClaudeSessionEntry[],
  compactInfo?: CompactInfo,
  injectedUuids?: Set<string>,
  subagentCorrelations?: Map<string, string>,
  stats?: ExtractedSessionStats,
  toolResults?: Map<string, { result: string; rawResult?: unknown; agentId?: string; isError?: boolean; feedback?: string }>,
  teamCorrelations?: Map<string, string>,
  nodeTurnRefs?: Map<string, { promptIndex: number; nodeId: string }>,
): SessionReadResult {
  return {
    entries,
    ...(compactInfo !== undefined && { compactInfo }),
    ...(injectedUuids !== undefined && { injectedUuids }),
    ...(subagentCorrelations !== undefined && { subagentCorrelations }),
    ...(teamCorrelations !== undefined && { teamCorrelations }),
    ...(stats !== undefined && { stats }),
    ...(toolResults !== undefined && { toolResults }),
    ...(nodeTurnRefs !== undefined && { nodeTurnRefs }),
  };
}

export function extractNodeTurnRefs(entries: ClaudeSessionEntry[]): Map<string, { promptIndex: number; nodeId: string }> {
  const refs = new Map<string, { promptIndex: number; nodeId: string }>();
  for (const entry of entries) {
    const raw = entry as unknown as Record<string, unknown>;
    if (raw['type'] === 'node-turn-ref') {
      const uuid = raw['uuid'];
      const nodeId = raw['nodeId'];
      const promptIndex = raw['promptIndex'];
      if (
        typeof uuid === 'string'
        && typeof nodeId === 'string'
        && typeof promptIndex === 'number'
        && Number.isInteger(promptIndex)
        && promptIndex >= 0
      ) {
        refs.set(uuid, { promptIndex, nodeId });
      }
    }
  }
  return refs;
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

function findDeepestConversationLeaf(
  startUuid: string,
  childrenMap: Map<string, string[]>,
  entryByUuid: Map<string, ClaudeSessionEntry>,
  excludeUuid: string
): string {
  let best = startUuid;
  let bestDepth = 0;
  const stack: Array<{ uuid: string; depth: number }> = [{ uuid: startUuid, depth: 0 }];

  while (stack.length > 0) {
    const { uuid, depth } = stack.pop()!;
    if (depth > bestDepth) {
      best = uuid;
      bestDepth = depth;
    }
    const children = childrenMap.get(uuid) ?? [];
    for (const childUuid of children) {
      if (childUuid === excludeUuid) continue;
      const child = entryByUuid.get(childUuid);
      if (child && (child.type === 'user' || child.type === 'assistant')) {
        stack.push({ uuid: childUuid, depth: depth + 1 });
      }
    }
  }

  return best;
}

function repairTaskNotificationBranching(
  allEntries: ClaudeSessionEntry[],
  entryByUuid: Map<string, ClaudeSessionEntry>
): void {
  const childrenMap = new Map<string, string[]>();
  for (const entry of allEntries) {
    if (entry.parentUuid && entry.uuid) {
      const children = childrenMap.get(entry.parentUuid) ?? [];
      children.push(entry.uuid);
      childrenMap.set(entry.parentUuid, children);
    }
  }

  for (const entry of allEntries) {
    if (entry.type !== 'user' || !entry.uuid || !entry.parentUuid) continue;

    const msgContent = entry.message?.content;
    let content = '';
    if (typeof msgContent === 'string') {
      content = msgContent;
    } else if (Array.isArray(msgContent)) {
      const textBlock = findUserTextBlock(msgContent as JsonlContentBlock[]);
      content = textBlock?.text ?? '';
    }
    if (!content.startsWith('<task-notification')) continue;

    const parent = entryByUuid.get(entry.parentUuid);
    if (!parent) continue;
    if (parent.type === 'user' || parent.type === 'assistant') continue;

    let forkPoint: ClaudeSessionEntry | undefined;
    let current: ClaudeSessionEntry | undefined = parent;
    while (current) {
      if (current.type === 'user' || current.type === 'assistant') {
        forkPoint = current;
        break;
      }
      current = current.parentUuid ? entryByUuid.get(current.parentUuid) : undefined;
    }

    if (!forkPoint?.uuid) continue;

    const leaf = findDeepestConversationLeaf(forkPoint.uuid, childrenMap, entryByUuid, entry.uuid);
    if (leaf !== forkPoint.uuid) {
      const originalParent = entry.parentUuid;
      entry.parentUuid = leaf;
      log('[repairTaskNotificationBranching] Re-parented %s from %s to %s (fork: %s)',
        entry.uuid, originalParent, leaf, forkPoint.uuid);
    }
  }
}

interface PaginatedCache {
  mainMtime: number;
  mainSize: number;
  nodesDirMtime: number;
  result: {
    displayableEntries: ClaudeSessionEntry[];
    compactInfo: CompactInfo | undefined;
    injectedUuids: Set<string>;
    subagentCorrelations: Map<string, string>;
    teamCorrelations: Map<string, string>;
    stats: ExtractedSessionStats | undefined;
    toolResults: Map<string, ToolResultData>;
    nodeTurnRefs: Map<string, { promptIndex: number; nodeId: string }>;
  };
}

const paginatedEntryCache = new Map<string, PaginatedCache>();
const PAGINATED_CACHE_MAX = 4;

export async function readSessionForDisplay(
  workspacePath: string,
  sessionId: string,
): Promise<SessionReadResult> {
  const filePath = await getSessionFilePath(workspacePath, sessionId);
  const sessionDir = await getSessionDir(workspacePath);

  try {
    const mainStat = await fs.promises.stat(filePath);
    const mainMtime = mainStat.mtimeMs;
    const mainSize = mainStat.size;

    const nodesDir = path.join(sessionDir, sessionId, 'nodes');
    const nodesDirMtime = await getNodeFilesMaxMtime(nodesDir);

    const cached = paginatedEntryCache.get(sessionId);
    if (cached && cached.mainMtime === mainMtime && cached.mainSize === mainSize && cached.nodesDirMtime === nodesDirMtime) {
      paginatedEntryCache.delete(sessionId);
      paginatedEntryCache.set(sessionId, cached);
      const { displayableEntries, compactInfo, injectedUuids, subagentCorrelations, teamCorrelations, stats, toolResults, nodeTurnRefs } = cached.result;
      return buildSessionReadResult(displayableEntries, compactInfo, injectedUuids, subagentCorrelations, stats, toolResults, teamCorrelations, nodeTurnRefs);
    }

    const lines = await readSessionFileLines(filePath);
    let allEntries = parseAllSessionEntries(lines);
    const nodeTurnRefsPreMerge = extractNodeTurnRefs(allEntries);

    const isRecall = isRecallFromEntries(allEntries);
    if (isRecall) {
      const nodeEntries = await readNodeFileEntries(workspacePath, sessionId);
      if (nodeEntries.length > 0) {
        allEntries = mergeEntriesByTimestamp(allEntries, nodeEntries);
      }
      stitchStatelessTurns(allEntries);
    }

    const {
      entryByUuid,
      leafUuid,
      subagentCorrelations,
      teamCorrelations,
      statsMessageData,
      lastCompactEntry,
      lastCompactIndex,
      injectedCandidates,
      toolResults,
    } = processEntriesSinglePass(allEntries);

    repairTaskNotificationBranching(allEntries, entryByUuid);

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

    if (paginatedEntryCache.size >= PAGINATED_CACHE_MAX) {
      const oldestKey = paginatedEntryCache.keys().next().value;
      if (oldestKey !== undefined) {
        paginatedEntryCache.delete(oldestKey);
      }
    }
    const nodeTurnRefs = nodeTurnRefsPreMerge;

    paginatedEntryCache.set(sessionId, {
      mainMtime,
      mainSize,
      nodesDirMtime,
      result: { displayableEntries, compactInfo, injectedUuids, subagentCorrelations, teamCorrelations, stats, toolResults, nodeTurnRefs },
    });

    return buildSessionReadResult(displayableEntries, compactInfo, injectedUuids, subagentCorrelations, stats, toolResults, teamCorrelations, nodeTurnRefs);
  } catch {
    return { entries: [] };
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
      const lines = await readSessionFileTail(filePath);
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
