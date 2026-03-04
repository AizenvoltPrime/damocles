import { extractSlashCommandDisplay } from "../../shared/utils";
import { loadSkillDescription } from "../skills/utils";
import {
  readSessionEntriesPaginated,
  readActiveBranchEntries,
  readSessionEntries,
  readAgentData,
  findUserTextBlock,
  findUserImageBlocks,
  type AgentData,
  type JsonlContentBlock,
  type ClaudeSessionEntry,
} from "../session";
import { TOOL_SKILL, TOOL_EDIT, TOOL_WRITE, TOOL_READ } from '../../shared/tool-names';
import { FEEDBACK_MARKER } from "../../shared/types/constants";
import { normalizeToolResult, extractReadMetadata, enrichResultWithDownloadedFiles, type ReadMetadata } from "../claude-session/utils";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { HistoryMessage, HistoryToolCall, ContentBlock } from "../../shared/types/content";
import type { RewindHistoryItem } from "../../shared/types/session";
import { HISTORY_PAGE_SIZE, type WebviewHost } from "./types";

export interface HistoryManagerConfig {
  workspacePath: string;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
}

interface ToolResultData {
  result: string;
  agentId?: string;
  isError?: boolean;
  feedback?: string;
  editLineNumber?: number;
  readMetadata?: ReadMetadata;
}

interface ExtractedContent {
  textContent: string;
  thinkingContent: string;
  tools: HistoryToolCall[];
  contentBlocks: ContentBlock[];
}

type ValidMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const VALID_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isValidMediaType(mediaType: string): mediaType is ValidMediaType {
  return VALID_MEDIA_TYPES.has(mediaType);
}

function extractDisplayableUserContent(msgContent: unknown): string | null {
  let content = "";

  if (typeof msgContent === "string") {
    content = msgContent;
  } else if (Array.isArray(msgContent)) {
    const textBlock = findUserTextBlock(msgContent as JsonlContentBlock[]);
    content = textBlock?.text ?? "";
  }

  if (!content || content.startsWith("<local-command-")) {
    return null;
  }

  if (content.startsWith("<command-")) {
    const displayContent = extractSlashCommandDisplay(content);
    return displayContent?.toLowerCase().startsWith("/compact") ? null : displayContent;
  }

  return content.toLowerCase().startsWith("/compact") ? null : content;
}

export class HistoryManager {
  private readonly workspacePath: string;
  private readonly postMessage: HistoryManagerConfig["postMessage"];

  constructor(config: HistoryManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
  }

  async loadSessionHistory(sessionId: string, host: WebviewHost): Promise<void> {
    this.postMessage(host, { type: "sessionCleared" });

    const result = await readSessionEntriesPaginated(this.workspacePath, sessionId, 0, HISTORY_PAGE_SIZE);

    if (result.compactInfo) {
      this.postMessage(host, {
        type: "compactBoundary",
        preTokens: result.compactInfo.preTokens,
        trigger: result.compactInfo.trigger,
        ...(result.compactInfo.summary !== undefined ? { summary: result.compactInfo.summary } : {}),
        timestamp: result.compactInfo.timestamp,
        isHistorical: true,
      });
    }

    const messages = await this.convertEntriesToMessages(result.entries, result.injectedUuids, result.subagentCorrelations);

    for (const msg of messages) {
      if (msg.type === "user") {
        this.postMessage(host, {
          type: "userReplay",
          content: msg.content,
          ...(msg.contentBlocks !== undefined ? { contentBlocks: msg.contentBlocks } : {}),
          isSynthetic: false,
          ...(msg.sdkMessageId !== undefined ? { sdkMessageId: msg.sdkMessageId } : {}),
          ...(msg.isInjected !== undefined ? { isInjected: msg.isInjected } : {}),
        });
      } else if (msg.type === "error") {
        this.postMessage(host, {
          type: "errorReplay",
          content: msg.content,
        });
      } else {
        this.postMessage(host, {
          type: "assistantReplay",
          content: msg.content,
          ...(msg.thinking !== undefined ? { thinking: msg.thinking } : {}),
          ...(msg.tools !== undefined ? { tools: msg.tools } : {}),
          ...(msg.contentBlocks !== undefined ? { contentBlocks: msg.contentBlocks } : {}),
        });
      }
    }

    if (result.stats) {
      this.postMessage(host, {
        type: "tokenUsageUpdate",
        inputTokens: result.stats.totalInputTokens,
        cacheCreationTokens: result.stats.cacheCreationTokens,
        cacheReadTokens: result.stats.cacheReadTokens,
      });
      this.postMessage(host, {
        type: "done",
        data: {
          type: "result",
          session_id: sessionId,
          is_done: true,
          total_output_tokens: result.stats.totalOutputTokens,
          num_turns: result.stats.numTurns,
          context_window_size: result.stats.contextWindowSize,
        },
      });
    }

    this.postMessage(host, {
      type: "historyChunk",
      messages: [],
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
      promptIndexOffset: result.promptIndexOffset,
    });
  }

  async loadMoreHistory(sessionId: string, offset: number, host: WebviewHost): Promise<void> {
    const result = await readSessionEntriesPaginated(this.workspacePath, sessionId, offset, HISTORY_PAGE_SIZE);
    const messages = await this.convertEntriesToMessages(result.entries, result.injectedUuids, result.subagentCorrelations);

    this.postMessage(host, {
      type: "historyChunk",
      messages,
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
      promptIndexOffset: result.promptIndexOffset,
    });
  }

  async extractRewindHistory(sessionId: string, conversationHead?: string | null): Promise<RewindHistoryItem[]> {
    // Read ALL entries for file change data (captures changes from any branch)
    const allEntries = await readSessionEntries(this.workspacePath, sessionId);
    // Read BRANCH entries for user messages (shows messages on current branch only)
    const branchEntries = await readActiveBranchEntries(this.workspacePath, sessionId, conversationHead ?? undefined);

    // First pass: collect ALL file changes with timestamps from entire session
    // This ensures we count files from forked-off branches too
    const fileChangesByTimestamp: Array<{ timestamp: number; file: string }> = [];
    for (const entry of allEntries) {
      const result = entry.toolUseResult;
      if (result && !Array.isArray(result) && result.filePath && this.isFileOperation(result.type)) {
        const displayName = this.getFileDisplayName(result.filePath);
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        fileChangesByTimestamp.push({ timestamp, file: displayName });
      }
    }

    // Second pass: collect user messages from CURRENT BRANCH with timestamps
    const userMessages: Array<{ entry: ClaudeSessionEntry; timestamp: number }> = [];
    for (const entry of branchEntries) {
      if (entry.type !== "user" || !entry.uuid || entry.isMeta || entry.isCompactSummary) continue;
      if (entry.toolUseResult) continue; // Skip tool result messages

      const content = extractDisplayableUserContent(entry.message?.content);
      if (!content) continue;

      if (entry.isInterrupt || content.startsWith("[Request interrupted by user")) {
        continue;
      }

      const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      userMessages.push({ entry, timestamp });
    }

    // Third pass: for each user message, count unique files changed after its timestamp
    // This correctly counts files from ALL branches (including forked-off ones)
    const history: RewindHistoryItem[] = [];
    for (const { entry, timestamp } of userMessages) {
      const filesAfter = new Set<string>();
      for (const change of fileChangesByTimestamp) {
        if (change.timestamp > timestamp) {
          filesAfter.add(change.file);
        }
      }

      const content = extractDisplayableUserContent(entry.message?.content);
      const filesArray = Array.from(filesAfter).sort();
      history.push({
        messageId: entry.uuid!,
        content: (content || "").slice(0, 200),
        timestamp,
        filesAffected: filesArray.length,
        ...(filesArray.length > 0 ? { files: filesArray } : {}),
      });
    }

    return history.reverse();
  }

  private isFileOperation(type: string | undefined): boolean {
    if (!type) return false;
    // Known file operation types from Write/Edit/NotebookEdit tools
    return ["create", "edit", "modify", "replace", "delete"].includes(type.toLowerCase());
  }

  private getFileDisplayName(filePath: string): string {
    // Extract relative path from workspace if possible, otherwise use basename
    const normalizedPath = filePath.replace(/\\/g, "/");
    const normalizedWorkspace = this.workspacePath.replace(/\\/g, "/");

    if (normalizedPath.toLowerCase().startsWith(normalizedWorkspace.toLowerCase())) {
      // Return path relative to workspace (without leading slash)
      let relative = normalizedPath.slice(normalizedWorkspace.length);
      if (relative.startsWith("/")) relative = relative.slice(1);
      return relative || normalizedPath.split("/").pop() || filePath;
    }

    // Fallback to basename
    return normalizedPath.split("/").pop() || filePath;
  }

  async convertEntriesToMessages(
    entries: ClaudeSessionEntry[],
    injectedUuids?: Set<string>,
    subagentCorrelations?: Map<string, string>
  ): Promise<HistoryMessage[]> {
    const toolResults = this.collectToolResults(entries);
    // Use pre-extracted correlations from readSessionEntriesPaginated (single file read)
    const taskToolAgents = subagentCorrelations ?? new Map<string, string>();

    const skillToolNames = this.collectSkillToolNames(entries);
    const agentDataMap = await this.loadAgentDataForTools(taskToolAgents);
    const skillDescriptions = await this.loadSkillDescriptions(skillToolNames);

    const messages = this.buildMessages(entries, toolResults, taskToolAgents, agentDataMap, skillDescriptions, injectedUuids);
    await this.enrichMcpToolResults(messages);
    return messages;
  }

  private async enrichMcpToolResults(messages: HistoryMessage[]): Promise<void> {
    const enrichTool = async (tool: HistoryToolCall): Promise<void> => {
      if (tool.result && tool.name.startsWith('mcp__')) {
        tool.result = await enrichResultWithDownloadedFiles(tool.result);
      }
      if (tool.agentToolCalls) {
        await Promise.all(tool.agentToolCalls.map(enrichTool));
      }
    };

    const promises: Promise<void>[] = [];
    for (const msg of messages) {
      if (msg.tools) {
        for (const tool of msg.tools) {
          promises.push(enrichTool(tool));
        }
      }
    }
    await Promise.all(promises);
  }

  private collectToolResults(entries: ClaudeSessionEntry[]): Map<string, ToolResultData> {
    const toolResults = new Map<string, ToolResultData>();

    for (const entry of entries) {
      if (entry.type === "user" && entry.message && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content as JsonlContentBlock[]) {
          if (block.type === "tool_result") {
            const isError = block.is_error === true;
            const editLineNumber = this.extractEditLineNumber(entry.toolUseResult);
            const readMetadata = entry.toolUseResult && !Array.isArray(entry.toolUseResult)
              ? extractReadMetadata(entry.toolUseResult) ?? undefined
              : undefined;

            if (this.shouldUseToolUseResultAsDisplay(entry.toolUseResult)) {
              const agentId = entry.toolUseResult && !Array.isArray(entry.toolUseResult)
                ? entry.toolUseResult.agentId
                : undefined;
              toolResults.set(block.tool_use_id, {
                result: JSON.stringify(entry.toolUseResult),
                ...(agentId !== undefined ? { agentId } : {}),
                isError,
                ...(editLineNumber !== undefined ? { editLineNumber } : {}),
                ...(readMetadata !== undefined ? { readMetadata } : {}),
              });
            } else {
              const result = typeof block.content === "string" ? block.content : JSON.stringify(block.content);

              let feedback: string | undefined;
              if (isError && result.includes(FEEDBACK_MARKER)) {
                const markerIndex = result.indexOf(FEEDBACK_MARKER);
                feedback = result.slice(markerIndex + FEEDBACK_MARKER.length).trim();
              }

              toolResults.set(block.tool_use_id, {
                result,
                isError,
                ...(feedback !== undefined ? { feedback } : {}),
                ...(editLineNumber !== undefined ? { editLineNumber } : {}),
                ...(readMetadata !== undefined ? { readMetadata } : {}),
              });
            }
          }
        }
      }
    }

    return toolResults;
  }

  private extractEditLineNumber(toolUseResult: ClaudeSessionEntry["toolUseResult"]): number | undefined {
    if (!toolUseResult || Array.isArray(toolUseResult)) return undefined;
    if (!toolUseResult.structuredPatch?.length) return undefined;
    const firstPatch = toolUseResult.structuredPatch[0];
    if (!firstPatch) return undefined;
    return firstPatch.oldStart;
  }

  private shouldUseToolUseResultAsDisplay(
    toolUseResult: ClaudeSessionEntry["toolUseResult"]
  ): boolean {
    if (!toolUseResult) return false;
    if (Array.isArray(toolUseResult)) {
      const firstBlock = toolUseResult[0];
      return Boolean(firstBlock && typeof firstBlock === "object" && "type" in firstBlock);
    }
    return toolUseResult.totalDurationMs !== undefined || toolUseResult.answers !== undefined;
  }

  private async loadAgentDataForTools(taskToolAgents: Map<string, string>): Promise<Map<string, AgentData>> {
    const agentDataMap = new Map<string, AgentData>();

    await Promise.all(
      Array.from(taskToolAgents.entries()).map(async ([toolUseId, agentId]) => {
        const agentData = await readAgentData(this.workspacePath, agentId);
        agentDataMap.set(toolUseId, agentData);
      })
    );

    return agentDataMap;
  }

  private collectSkillToolNames(entries: ClaudeSessionEntry[]): Set<string> {
    const skillNames = new Set<string>();

    for (const entry of entries) {
      if (entry.type === "assistant" && entry.message && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content as JsonlContentBlock[]) {
          if (block.type === "tool_use" && block.name === TOOL_SKILL) {
            const skillName = typeof block.input?.["skill"] === "string" ? block.input["skill"] : null;
            if (skillName) {
              skillNames.add(skillName);
            }
          }
        }
      }
    }

    return skillNames;
  }

  private async loadSkillDescriptions(skillNames: Set<string>): Promise<Map<string, string>> {
    const descriptions = new Map<string, string>();

    await Promise.all(
      Array.from(skillNames).map(async (skillName) => {
        const description = await loadSkillDescription(skillName);
        if (description) {
          descriptions.set(skillName, description);
        }
      })
    );

    return descriptions;
  }

  private extractContentFromEntry(
    entry: ClaudeSessionEntry,
    toolResults: Map<string, ToolResultData>,
    taskToolAgents: Map<string, string>,
    agentDataMap: Map<string, AgentData>,
    skillDescriptions: Map<string, string>
  ): ExtractedContent {
    const msgContent = entry.message?.content;
    let textContent = "";
    let thinkingContent = "";
    const tools: HistoryToolCall[] = [];
    const contentBlocks: ContentBlock[] = [];

    if (typeof msgContent === "string") {
      textContent = msgContent;
      if (msgContent) contentBlocks.push({ type: "text", text: msgContent });
    } else if (Array.isArray(msgContent)) {
      const blocks = msgContent as JsonlContentBlock[];

      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          textContent += block.text;
          contentBlocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          thinkingContent = thinkingContent ? thinkingContent + "\n\n" + block.thinking : block.thinking;
        } else if (block.type === "tool_use") {
          const tool: HistoryToolCall = {
            id: block.id,
            name: block.name,
            input: block.input,
          };

          const resultData = toolResults.get(block.id);
          if (resultData) {
            tool.result = normalizeToolResult(block.name, resultData.result);
            if (resultData.isError !== undefined) {
              tool.isError = resultData.isError;
            }
            if (resultData.feedback !== undefined) {
              tool.feedback = resultData.feedback;
            }

            if (resultData.editLineNumber && (block.name === TOOL_EDIT || block.name === TOOL_WRITE)) {
              tool.metadata = { ...tool.metadata, editLineNumber: resultData.editLineNumber };
            }

            if (resultData.readMetadata && block.name === TOOL_READ) {
              tool.metadata = { ...tool.metadata, ...resultData.readMetadata };
            }
          }

          const agentId = taskToolAgents.get(block.id);
          if (agentId) {
            tool.sdkAgentId = agentId;
            const agentData = agentDataMap.get(block.id);
            if (agentData) {
              if (agentData.toolCalls.length > 0) {
                tool.agentToolCalls = agentData.toolCalls;
              }
              if (agentData.model) {
                tool.agentModel = agentData.model;
              }
              if (agentData.messages.length > 0) {
                tool.agentMessages = agentData.messages;
              }
              if (agentData.startTimestamp) {
                tool.agentStartTimestamp = agentData.startTimestamp;
              }
              if (agentData.endTimestamp) {
                tool.agentEndTimestamp = agentData.endTimestamp;
              }
              tool.agentToolCount = agentData.totalToolUseCount;
            }
          }

          if (block.name === TOOL_SKILL) {
            const skillName = typeof block.input?.["skill"] === "string" ? block.input["skill"] : null;
            if (skillName) {
              const description = skillDescriptions.get(skillName);
              if (description) {
                tool.metadata = { skillDescription: description };
              }
            }
          }

          tools.push(tool);
          contentBlocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
        }
      }
    }

    return { textContent, thinkingContent, tools, contentBlocks };
  }

  private buildMessages(
    entries: ClaudeSessionEntry[],
    toolResults: Map<string, ToolResultData>,
    taskToolAgents: Map<string, string>,
    agentDataMap: Map<string, AgentData>,
    skillDescriptions: Map<string, string>,
    injectedUuids?: Set<string>
  ): HistoryMessage[] {
    const messages: HistoryMessage[] = [];
    let lastAssistantMsgId: string | null = null;

    for (const entry of entries) {
      if (entry.type === "user" && entry.message && !entry.isMeta && !entry.isCompactSummary && !entry.isVisibleInTranscriptOnly) {
        const isInjectedFromBranch = entry.uuid ? injectedUuids?.has(entry.uuid) : false;
        const isInjected = entry.isInjected || isInjectedFromBranch;
        const userMessage = this.buildUserMessage(entry, isInjected);
        if (userMessage) {
          lastAssistantMsgId = null;
          messages.push(userMessage);
        }
      } else if (entry.type === "assistant" && entry.message) {
        const sdkMsgId = entry.message.id;
        const extracted = this.extractContentFromEntry(entry, toolResults, taskToolAgents, agentDataMap, skillDescriptions);

        if (sdkMsgId && sdkMsgId === lastAssistantMsgId) {
          const prev = messages[messages.length - 1];
          if (prev && prev.type === "assistant") {
            this.mergeExtractedIntoMessage(prev, extracted);
            continue;
          }
        }

        const assistantMessage = this.buildAssistantFromExtracted(extracted);
        if (assistantMessage) {
          messages.push(assistantMessage);
          lastAssistantMsgId = sdkMsgId ?? null;
        }
      }
    }

    return messages;
  }

  private buildUserMessage(entry: ClaudeSessionEntry, isInjected?: boolean): HistoryMessage | null {
    const content = extractDisplayableUserContent(entry.message?.content);
    if (!content) return null;

    if (content.startsWith("Unknown slash command:") || content.startsWith("Caveat:")) {
      return null;
    }

    if (entry.isInterrupt || content.startsWith("[Request interrupted by user")) {
      return null;
    }

    const sdkMessageId = entry.uuid;

    let contentBlocks: ContentBlock[] | undefined;
    const msgContent = entry.message?.content;
    if (Array.isArray(msgContent)) {
      const imageBlocks = findUserImageBlocks(msgContent as JsonlContentBlock[]);
      if (imageBlocks.length > 0) {
        const textBlock = findUserTextBlock(msgContent as JsonlContentBlock[]);
        const validImages = imageBlocks.filter(img => isValidMediaType(img.source.media_type));
        contentBlocks = [
          ...validImages.map(img => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.source.media_type as ValidMediaType,
              data: img.source.data,
            },
          })),
          ...(textBlock ? [{ type: "text" as const, text: textBlock.text }] : []),
        ];
      }
    }

    return {
      type: "user",
      content,
      ...(contentBlocks !== undefined ? { contentBlocks } : {}),
      ...(sdkMessageId !== undefined ? { sdkMessageId } : {}),
      ...(isInjected !== undefined ? { isInjected } : {}),
    };
  }

  private buildAssistantFromExtracted(extracted: ExtractedContent): HistoryMessage | null {
    const { textContent, thinkingContent, tools, contentBlocks } = extracted;

    if (!textContent && !thinkingContent && tools.length === 0) {
      return null;
    }

    if (textContent === "No response requested." && tools.length === 0) {
      return null;
    }

    return {
      type: "assistant",
      content: textContent,
      ...(thinkingContent ? { thinking: thinkingContent } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
    };
  }

  private mergeExtractedIntoMessage(target: HistoryMessage, extracted: ExtractedContent): void {
    if (extracted.textContent) {
      target.content = target.content ? target.content + extracted.textContent : extracted.textContent;
    }
    if (extracted.thinkingContent) {
      target.thinking = target.thinking
        ? target.thinking + "\n\n" + extracted.thinkingContent
        : extracted.thinkingContent;
    }
    if (extracted.tools.length > 0) {
      target.tools = [...(target.tools || []), ...extracted.tools];
    }
    if (extracted.contentBlocks.length > 0) {
      target.contentBlocks = [...(target.contentBlocks || []), ...extracted.contentBlocks];
    }
  }
}
