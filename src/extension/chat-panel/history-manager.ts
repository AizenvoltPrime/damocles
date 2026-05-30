import { extractSlashCommandDisplay, unwrapToolUseError } from "../../shared/utils";
import { loadSkillDescription } from "../skills/utils";
import {
  readSessionForDisplay,
  compactCancelledTurns,
  readActiveBranchEntries,
  readSessionEntries,
  readAgentData,
  findUserTextBlock,
  findUserImageBlocks,
  type AgentData,
  type JsonlContentBlock,
  type ClaudeSessionEntry,
} from "../session";
import { TOOL_SKILL, TOOL_WORKFLOW } from '../../shared/tool-names';
import { FEEDBACK_MARKER } from "../../shared/types/constants";
import { normalizeToolResult, TOOL_METADATA_REGISTRY, enrichResultWithDownloadedFiles } from "../claude-session/utils";
import { parseTaskNotification } from "../claude-session/task-notification-parser";
import { readWorkflowOutput } from "../claude-session/workflow-output";
import { parseWorkflowLaunch } from "../../shared/workflow-launch";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { HistoryMessage, HistoryToolCall, ContentBlock } from "../../shared/types/content";
import type { RewindHistoryItem } from "../../shared/types/session";
import { log } from "../logger";
import type { WebviewHost } from "./types";
import { stampReplayMessage } from "./replay-stamp";

export interface HistoryManagerConfig {
  workspacePath: string;
  postMessage: (host: WebviewHost, message: ExtensionToWebviewMessage) => void;
  loadTeamData?: (teamId: string, sessionId: string) => Promise<import('../../shared/types/team').TeamState | null>;
}

interface ToolResultData {
  result: string;
  rawResult?: unknown;
  agentId?: string;
  isError?: boolean;
  feedback?: string;
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
    const blocks = msgContent as JsonlContentBlock[];
    if (blocks.some(b => b.type === "tool_result")) return null;
    const textBlock = findUserTextBlock(blocks);
    content = textBlock?.text ?? "";
  }

  if (!content || content.startsWith("<local-command-") || content.startsWith("<task-notification")) {
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
  private readonly loadTeamData?: HistoryManagerConfig["loadTeamData"];
  private readonly inflight = new Map<WebviewHost, AbortController>();
  private readonly wiredHosts = new WeakSet<WebviewHost>();

  constructor(config: HistoryManagerConfig) {
    this.workspacePath = config.workspacePath;
    this.postMessage = config.postMessage;
    this.loadTeamData = config.loadTeamData;
  }

  /**
   * Register a fresh AbortController for `host`, aborting any prior in-flight
   * load on the same host and wiring `onDidDispose` to abort on disposal.
   * Shared between full-session and fork-prefix replay paths so both correctly
   * cancel mid-replay when the host goes away.
   */
  private beginReplay(host: WebviewHost): AbortController {
    const prior = this.inflight.get(host);
    if (prior) prior.abort();

    const ctrl = new AbortController();
    this.inflight.set(host, ctrl);

    if (!this.wiredHosts.has(host)) {
      this.wiredHosts.add(host);
      host.onDidDispose(() => {
        const c = this.inflight.get(host);
        if (c) {
          c.abort();
          this.inflight.delete(host);
        }
      });
    }

    return ctrl;
  }

  /**
   * Replay session history into a new (forked) host, stopping just before the entry
   * whose `uuid === untilUuid`. If `untilUuid` is null, replays nothing. If the
   * UUID is not found, replays the full session as a defensive fallback.
   */
  async loadSessionHistoryUntil(sessionId: string, host: WebviewHost, untilUuid: string | null): Promise<void> {
    const ctrl = this.beginReplay(host);

    if (untilUuid === null) {
      this.postMessage(host, { type: "sessionCleared" });
      if (this.inflight.get(host) === ctrl) this.inflight.delete(host);
      return;
    }

    this.postMessage(host, { type: "sessionCleared" });

    await compactCancelledTurns(this.workspacePath, sessionId).catch(err =>
      log(`[history] compactCancelledTurns failed for ${sessionId}: ${err}`));
    const result = await readSessionForDisplay(this.workspacePath, sessionId);
    ctrl.signal.throwIfAborted();

    const cutoffIndex = result.entries.findIndex(e => e.uuid === untilUuid);
    if (cutoffIndex === -1) {
      log(`[history] loadSessionHistoryUntil: untilUuid ${untilUuid} not found in session ${sessionId}, replaying full session`);
    }
    const truncatedEntries = cutoffIndex === -1 ? result.entries : result.entries.slice(0, cutoffIndex);

    const messages = await this.convertEntriesToMessages(truncatedEntries, result.injectedUuids, result.subagentCorrelations, result.toolResults);
    ctrl.signal.throwIfAborted();

    const nodeTurnRefs = result.nodeTurnRefs ?? new Map<string, { promptIndex: number; nodeId: string }>();
    let syntheticPromptIndex = 0;

    for (const msg of messages) {
      if (msg.type === "user") {
        const { stamp, advance } = stampReplayMessage(msg, syntheticPromptIndex, nodeTurnRefs);
        if (advance) syntheticPromptIndex++;

        this.postMessage(host, {
          type: "userReplay",
          content: msg.content,
          ...(msg.contentBlocks !== undefined ? { contentBlocks: msg.contentBlocks } : {}),
          isSynthetic: false,
          ...(msg.sdkMessageId !== undefined ? { sdkMessageId: msg.sdkMessageId } : {}),
          ...(msg.isInjected !== undefined ? { isInjected: msg.isInjected } : {}),
          promptIndex: stamp.promptIndex,
          nodeId: stamp.nodeId,
        });
      } else if (msg.type === "error") {
        this.postMessage(host, { type: "errorReplay", content: msg.content });
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

    await this.emitWorkflowResults(truncatedEntries, host, ctrl.signal, sessionId);

    if (this.inflight.get(host) === ctrl) this.inflight.delete(host);
  }

  async loadSessionHistory(sessionId: string, host: WebviewHost): Promise<void> {
    const ctrl = this.beginReplay(host);
    const t0 = Date.now();

    this.postMessage(host, { type: "sessionCleared" });

    await compactCancelledTurns(this.workspacePath, sessionId).catch(err =>
      log(`[history] compactCancelledTurns failed for ${sessionId}: ${err}`));
    const result = await readSessionForDisplay(this.workspacePath, sessionId);
    ctrl.signal.throwIfAborted();

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

    await this.emitTeamCorrelations(result.teamCorrelations, host, sessionId);

    const messages = await this.convertEntriesToMessages(result.entries, result.injectedUuids, result.subagentCorrelations, result.toolResults);
    ctrl.signal.throwIfAborted();

    const nodeTurnRefs = result.nodeTurnRefs ?? new Map<string, { promptIndex: number; nodeId: string }>();
    let syntheticPromptIndex = 0;

    for (const msg of messages) {
      if (msg.type === "user") {
        const { stamp, advance } = stampReplayMessage(msg, syntheticPromptIndex, nodeTurnRefs);
        if (advance) syntheticPromptIndex++;

        this.postMessage(host, {
          type: "userReplay",
          content: msg.content,
          ...(msg.contentBlocks !== undefined ? { contentBlocks: msg.contentBlocks } : {}),
          isSynthetic: false,
          ...(msg.sdkMessageId !== undefined ? { sdkMessageId: msg.sdkMessageId } : {}),
          ...(msg.isInjected !== undefined ? { isInjected: msg.isInjected } : {}),
          promptIndex: stamp.promptIndex,
          nodeId: stamp.nodeId,
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

    await this.emitWorkflowResults(result.entries, host, ctrl.signal, sessionId);

    if (result.stats) {
      this.postMessage(host, {
        type: "tokenUsageUpdate",
        inputTokens: result.stats.totalInputTokens,
        cacheCreationTokens: result.stats.cacheCreationTokens,
        cacheReadTokens: result.stats.cacheReadTokens,
        outputTokens: result.stats.totalOutputTokens,
      });
      this.postMessage(host, {
        type: "done",
        data: {
          type: "result",
          session_id: sessionId,
          is_done: true,
          total_output_tokens: result.stats.totalOutputTokens,
          num_turns: result.stats.numTurns,
        },
      });
    }

    if (this.inflight.get(host) === ctrl) {
      this.inflight.delete(host);
    }
    log(`[history] full-load ${result.entries.length} entries in ${Date.now() - t0}ms`);
  }

  private async emitTeamCorrelations(teamCorrelations: Map<string, string> | undefined, host: WebviewHost, sessionId: string): Promise<void> {
    if (!teamCorrelations || teamCorrelations.size === 0 || !this.loadTeamData) return;
    const teamIds = new Set(teamCorrelations.values());
    const teamLoads = await Promise.all(
      [...teamIds].map(async (teamId) => {
        const team = await this.loadTeamData!(teamId, sessionId);
        return team ? { teamId, team } : null;
      })
    );
    for (const load of teamLoads) {
      if (load) {
        this.postMessage(host, { type: 'teamStarted', team: load.team });
      }
    }
  }

  /**
   * Replay `Workflow` tool completions: the live `<task-notification>` is filtered from the
   * displayable transcript, so re-derive each workflow's status/usage/result from the persisted
   * notification (keyed by the Workflow tool's tool-use-id) and post a `workflowResult` so the
   * card and overlay populate on history load.
   */
  private async emitWorkflowResults(entries: ClaudeSessionEntry[], host: WebviewHost, signal: AbortSignal, sessionId: string): Promise<void> {
    const workflowToolUseIds = new Set<string>();
    for (const entry of entries) {
      if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content as JsonlContentBlock[]) {
          if (block.type === "tool_use" && block.name === TOOL_WORKFLOW && block.id) {
            workflowToolUseIds.add(block.id);
          }
        }
      }
    }
    if (workflowToolUseIds.size === 0) return;

    // The transcript dir is only in the Workflow tool's launch result, not the task-notification.
    // Re-derive it from the persisted launch result so the run carries it on history load and the
    // Agents tab can fetch transcripts even when the workflow card never mounted.
    const transcriptDirByTool = new Map<string, string>();
    const errorByTool = new Map<string, string>();
    for (const entry of entries) {
      if (entry.type !== "user" || !Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content as JsonlContentBlock[]) {
        if (block.type === "tool_result" && block.tool_use_id && workflowToolUseIds.has(block.tool_use_id)) {
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          const dir = parseWorkflowLaunch(text).transcriptDir;
          if (dir) transcriptDirByTool.set(block.tool_use_id, dir);
          if (block.is_error === true) errorByTool.set(block.tool_use_id, unwrapToolUseError(text));
        }
      }
    }

    // Collect each workflow's terminal `<task-notification>` body, deduped by tool-use-id. It is
    // persisted in one of two shapes depending on when the workflow settled:
    //   • a standalone user message (settled while idle) — present in the displayable `entries`;
    //   • a `queued_command` attachment (settled fast/mid-turn, e.g. a synchronous script
    //     failure) — non-displayable, so absent from `entries` and read from raw entries below.
    // The user-message form wins when both somehow exist.
    const notificationByTool = new Map<string, string>();
    const collect = (body: string): void => {
      if (!body.startsWith("<task-notification")) return;
      const parsed = parseTaskNotification(body);
      if (parsed && workflowToolUseIds.has(parsed.toolUseId) && !notificationByTool.has(parsed.toolUseId)) {
        notificationByTool.set(parsed.toolUseId, body);
      }
    };

    for (const entry of entries) {
      if (entry.type !== "user") continue;
      const msgContent = entry.message?.content;
      collect(typeof msgContent === "string"
        ? msgContent
        : Array.isArray(msgContent)
          ? findUserTextBlock(msgContent as JsonlContentBlock[])?.text ?? ""
          : "");
    }

    const rawEntries = await readSessionEntries(this.workspacePath, sessionId);
    if (signal.aborted) return;
    for (const entry of rawEntries) {
      const attachment = entry.attachment;
      if (attachment?.commandMode === "task-notification" && typeof attachment.prompt === "string") {
        collect(attachment.prompt);
      }
    }

    for (const body of notificationByTool.values()) {
      const parsed = parseTaskNotification(body);
      if (!parsed) continue;

      // The persisted <result> is SDK-truncated for the transcript; the task output file holds
      // the complete result. Prefer it, falling back to the persisted result if it's gone.
      const out = await readWorkflowOutput(parsed.outputFile);

      // The file read suspends this loop; a rapid session switch aborts the controller and
      // resets the workflow store in between. Bail before posting so a prior session's result
      // can't leak into the now-current one.
      if (signal.aborted) return;

      const transcriptDir = transcriptDirByTool.get(parsed.toolUseId);
      this.postMessage(host, {
        type: "workflowResult",
        toolUseId: parsed.toolUseId,
        taskId: parsed.taskId,
        status: parsed.status,
        summary: parsed.summary,
        result: (out && out.result) || parsed.result,
        outputFile: parsed.outputFile,
        ...(transcriptDir ? { transcriptDir } : {}),
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      });
    }

    if (signal.aborted) return;
    for (const [toolUseId, reason] of errorByTool) {
      if (notificationByTool.has(toolUseId)) continue;
      this.postMessage(host, {
        type: "workflowResult",
        toolUseId,
        taskId: "",
        status: "failed",
        summary: reason,
        result: "",
        outputFile: null,
      });
    }
  }

  async extractRewindableUserIds(sessionId: string, conversationHead?: string | null): Promise<string[]> {
    const branchEntries = await readActiveBranchEntries(this.workspacePath, sessionId, conversationHead ?? undefined);
    const ids: string[] = [];
    for (const entry of branchEntries) {
      if (entry.type !== "user" || !entry.uuid || entry.isMeta || entry.isCompactSummary) continue;
      if (entry.toolUseResult) continue;
      const content = extractDisplayableUserContent(entry.message?.content);
      if (!content) continue;
      if (entry.isInterrupt || content.startsWith("[Request interrupted by user")) continue;
      ids.push(entry.uuid);
    }
    return ids;
  }

  async extractRewindHistory(sessionId: string, conversationHead?: string | null): Promise<RewindHistoryItem[]> {
    const branchEntries = await readActiveBranchEntries(this.workspacePath, sessionId, conversationHead ?? undefined);

    const fileChangesByTimestamp: Array<{ timestamp: number; path: string; displayName: string }> = [];
    for (const entry of branchEntries) {
      const result = entry.toolUseResult;
      if (result && !Array.isArray(result) && result.filePath && this.isFileModifyingResult(result)) {
        const { path: absolutePath, displayName } = this.buildFileEntry(result.filePath);
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        fileChangesByTimestamp.push({ timestamp, path: absolutePath, displayName });
      }
    }

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

    const history: RewindHistoryItem[] = [];
    for (const { entry, timestamp } of userMessages) {
      const filesAfter = new Map<string, string>();
      for (const change of fileChangesByTimestamp) {
        if (change.timestamp > timestamp && !filesAfter.has(change.path)) {
          filesAfter.set(change.path, change.displayName);
        }
      }

      const content = extractDisplayableUserContent(entry.message?.content);
      const filesArray = Array.from(filesAfter, ([path, displayName]) => ({ path, displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
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

  private isFileModifyingResult(result: { type?: string; structuredPatch?: unknown }): boolean {
    const t = result.type?.toLowerCase();
    if (t && ["create", "edit", "modify", "replace", "delete"].includes(t)) return true;
    return Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0;
  }

  async getFileCheckpointContent(
    sessionId: string,
    userMessageId: string,
    filePath: string,
    conversationHead?: string | null,
  ): Promise<string | null> {
    const entries = await readActiveBranchEntries(this.workspacePath, sessionId, conversationHead ?? undefined);
    const userEntry = entries.find((e) => e.uuid === userMessageId && e.type === "user");
    if (!userEntry || !userEntry.timestamp) return null;
    const userTs = new Date(userEntry.timestamp).getTime();

    const targetKey = filePath.replace(/\\/g, "/").toLowerCase();
    for (const entry of entries) {
      const result = entry.toolUseResult;
      if (!result || Array.isArray(result) || !result.filePath) continue;
      if (!this.isFileModifyingResult(result)) continue;
      const entryTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      if (entryTs <= userTs) continue;
      const resultKey = result.filePath.replace(/\\/g, "/").toLowerCase();
      if (resultKey !== targetKey) continue;
      if (typeof result.originalFile === "string") return result.originalFile;
      if (result.type?.toLowerCase() === "create") return "";
      return null;
    }
    return null;
  }

  private buildFileEntry(filePath: string): { path: string; displayName: string } {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const normalizedWorkspace = this.workspacePath.replace(/\\/g, "/");

    if (normalizedPath.toLowerCase().startsWith(normalizedWorkspace.toLowerCase())) {
      let relative = normalizedPath.slice(normalizedWorkspace.length);
      if (relative.startsWith("/")) relative = relative.slice(1);
      const displayName = relative || normalizedPath.split("/").pop() || filePath;
      return { path: normalizedPath, displayName };
    }

    const basename = normalizedPath.split("/").pop() || filePath;
    return { path: normalizedPath, displayName: basename };
  }

  async convertEntriesToMessages(
    entries: ClaudeSessionEntry[],
    injectedUuids?: Set<string>,
    subagentCorrelations?: Map<string, string>,
    globalToolResults?: Map<string, ToolResultData>
  ): Promise<HistoryMessage[]> {
    const toolResults = globalToolResults ?? this.collectToolResults(entries);
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
            const rawResult = entry.toolUseResult && !Array.isArray(entry.toolUseResult)
              ? entry.toolUseResult
              : undefined;

            if (this.shouldUseToolUseResultAsDisplay(entry.toolUseResult)) {
              const agentId = rawResult?.agentId;
              toolResults.set(block.tool_use_id, {
                result: JSON.stringify(entry.toolUseResult),
                ...(agentId !== undefined ? { agentId } : {}),
                isError,
                ...(rawResult ? { rawResult } : {}),
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
                ...(rawResult ? { rawResult } : {}),
              });
            }
          }
        }
      }
    }

    return toolResults;
  }

  private shouldUseToolUseResultAsDisplay(
    toolUseResult: ClaudeSessionEntry["toolUseResult"]
  ): boolean {
    if (!toolUseResult) return false;
    if (Array.isArray(toolUseResult)) {
      const firstBlock = toolUseResult[0];
      return Boolean(firstBlock && typeof firstBlock === "object" && "type" in firstBlock);
    }
    if (toolUseResult.totalDurationMs !== undefined) return true;
    if (toolUseResult.answers !== undefined) return true;
    for (const config of TOOL_METADATA_REGISTRY.values()) {
      if (config.hasStructuredResult?.(toolUseResult)) return true;
    }
    return false;
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

            if (resultData.rawResult) {
              const config = TOOL_METADATA_REGISTRY.get(block.name);
              if (config?.extract) {
                const metadata = config.extract(resultData.rawResult);
                if (metadata) {
                  tool.metadata = { ...tool.metadata, ...metadata };
                }
              }
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
                tool.metadata = { ...tool.metadata, skillDescription: description };
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
    const assistantByMsgId = new Map<string, HistoryMessage>();

    for (const entry of entries) {
      if (entry.type === "user" && entry.message && !entry.isMeta && !entry.isCompactSummary && !entry.isVisibleInTranscriptOnly) {
        const isInjectedFromBranch = entry.uuid ? injectedUuids?.has(entry.uuid) : false;
        const isInjected = entry.isInjected || isInjectedFromBranch;
        const userMessage = this.buildUserMessage(entry, isInjected);
        if (userMessage) {
          messages.push(userMessage);
        }
      } else if (entry.type === "assistant" && entry.message) {
        const sdkMsgId = entry.message.id;
        const extracted = this.extractContentFromEntry(entry, toolResults, taskToolAgents, agentDataMap, skillDescriptions);

        if (sdkMsgId && assistantByMsgId.has(sdkMsgId)) {
          this.mergeExtractedIntoMessage(assistantByMsgId.get(sdkMsgId)!, extracted);
          continue;
        }

        const assistantMessage = this.buildAssistantFromExtracted(extracted);
        if (assistantMessage) {
          messages.push(assistantMessage);
          if (sdkMsgId) {
            assistantByMsgId.set(sdkMsgId, assistantMessage);
          }
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
