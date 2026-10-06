import { randomUUID } from "crypto";
import { existsSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentSession, AgentSessionRuntime, BuildSystemPromptOptions, CreateAgentSessionRuntimeFactory, ToolDefinition, AgentBeforeSettleEvent, CustomMessageEntryDraft, SessionEntry, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { Model, Api, ImageContent } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatSession } from "../chat-session";
import type { SessionOptions, ContentInput, McpScope, RewindOption } from "../session-types";
import type { Disposable } from "../../platform/disposable";
import type { ExtensionToWebviewMessage } from "../../shared/types/messages";
import type { ModelInfo, PermissionMode, AutoCompactConfig, EffortLevel } from "../../shared/types/settings";
import type { SlashCommandInfo } from "../../shared/types/commands";
import type { McpRenamedToolRuleNotice, McpServerStatusInfo } from "../../shared/types/mcp";
import type { MemoryInjectionDisplay } from "../../shared/types/context-injection";
import type { SteerTargetInfo } from "../../shared/types/subagents";
import type { TeamService } from "../team";
import {
  isImageBlock,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGES_PER_MESSAGE,
  type ImageBlock,
  type UserContentBlock,
} from "../../shared/types/content";
import { DEFAULT_CONTEXT_WINDOW, MODEL_SUBSTITUTES, migrateLegacyModelValue, migrateLegacyEffortValue, parseEffortLevel } from "../../shared/types/constants";
import { PLAN_MODE_TOOLS } from "../../shared/tool-names";
import { log } from "../logger";
import { t } from "../l10n";
import { perfSpan, timed } from "../perf";
import { PiRuntime } from "./pi-runtime";
import { ownSessionUsage } from "./session-usage";
import type { FolderRuntime } from "./folder-runtime";
import { getPiCodingAgent, type PiCodingAgentModule } from "./pi-loader";
import { cacheWarmingSetting, PI_AGENT_DIR } from "./agent-dir";
import { installTurnDecider, BUDGET_STOP_HOOK } from "./finish-turn";
import { installPlanModeChangeNotice, mainPlanModeStatement, planModeChangeNotice, planModeNoticeAtPromptStart, type PlanModeStatement } from "./plan-mode-change";
import { buildPlanModeGuidance } from "./plan-mode-guidance";
import { dispatchObserveOnly } from "./hooks/dispatch";
import { buildPermissionRequiredPayload, buildForkPayload } from "./hooks/payload";
import { PiStreamAdapter, isNothingToCompact } from "./pi-stream-adapter";
import { deriveSessionState, turnOutcomeOfError, type ChatActivity, type PendingPrompt, type RaisedPrompt, type SessionState, type TurnChange, type TurnOutcome, type TurnState } from "./session-state";
import { pendingPromptDescriber, pendingPromptOwners, promptOwnerOf, type PromptOwners } from "./pending-prompts";
import type { SubscriptionProvider, UsageMonitor } from "./usage-thresholds";
import {
  piSupportedModels,
  resolvePiModel,
  providerDisplayName,
  piModelToModelInfo,
  effortToThinkingLevel,
  PI_EXCLUDED_TOOLS,
  PLAN_MODE_EXCLUDED_TOOLS,
} from "./pi-models";
import { buildCustomTools } from "./tools";
import { ShellCancelStore } from "./tools/shell-cancel-registry";
import { createShellSessionJob } from "./tools/process-tree";
import { UnpersistedToolImages } from "./unpersisted-tool-images";
import { sessionNoteDelivery, subagentNoteDelivery, teamAgentNoteDelivery } from "./note-delivery";
import type { ShellOptions } from "./tools/bash-tool";
import { buildTeamAgentPiTools, TEAM_MAIN_PI_TOOL_NAMES, teamAgentPiToolNames } from "./tools/team-tools";
import { mapPiToolName, toolCategory } from "./tool-normalization";
import { createSubagentExtensionFactory } from "./subagents/subagent-extension-factory";
import {
  resolveRoleModel,
  type TeamModelDeps,
  type TeamRole,
  type TeamRoleSetting,
} from "./team-model-resolution";
import type { TeamEngine, ResolvedTeamModel, AgentMcpContext } from "../team/types";
import {
  AgentManager,
  resolveEnabledModels,
  readEnabledModels,
  isModelInScope,
  type SubagentEngine,
  type ResolvedSubagentModel,
  type AgentConfig,
} from "./subagents";
import type { AgentRegistry } from "./subagents/agent-types";
import { AGENT_SCOPE_BY_SOURCE } from "./subagents/types";
import { resolveCheapModelFor } from "./subagents/cheap-model";
import { backgroundResultsDetails, formatBackgroundResults, SUBAGENT_RESULTS_CUSTOM_TYPE } from "./subagents/background-results";
import { reconcileInterruptions } from "./interruption-notice";
import { collectUndeliveredFromFiles, deliverUndeliveredResults, type UndeliveredFileResult } from "./undelivered-results";
import { copyForkAgentData } from "./fork-agent-data";
import {
  deliveredBackgroundResults,
  subagentBranchIndex,
  subagentsDir,
  type AgentInvocationData,
} from "./agent-records";
import { TeamPersistence } from "../team/persistence";
import { teamPlanModeStatement } from "../team/prompts";
import { resolveExploreSectionModel } from "./custom-providers";
import type { CustomAgentInfo } from "../../shared/types/commands";
import {
  ensurePiSessionDir,
  resolvePiSessionFile,
  piSessionIdFromFile,
  extractFirstUserMessage,
  sessionFileMeta,
  type SessionFileMeta,
  DAMOCLES_CHECKPOINT_ENTRY,
  DAMOCLES_USER_RENAMED_ENTRY,
  DAMOCLES_TAG_ENTRY,
  DAMOCLES_ORIGINAL_INPUT_ENTRY,
  DAMOCLES_MID_STREAM_ENTRY,
  DAMOCLES_STEER_ENTRY,
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  DAMOCLES_TURN_STOPPED_ENTRY,
  turnStoppedRecord,
  stripIdeContext,
  nextPromptIndex,
} from "./session-store";
import { acquireSessionLease, refreshSessionLeaseOwners, releaseSessionLease, sessionLeasesOf, type SessionLeaseHolder } from "./session-store/session-lease";
import { computePlanFilePath, findSessionPlanFiles } from "../paths";
import { CheckpointService, RESTORE_WAIT_MS, checkpointBaselineWaitMs, checkpointMaxFileSizeBytes, type ServiceRestoreResult } from "./checkpoint-service";
import type { CheckpointRecord, NotRewindableRecord, StoredCheckpointRecord } from "./checkpoints";
import {
  getCheckpointEntries,
  getCheckpointRecords,
  getNotRewindableEntries,
  getPreRewindEntries,
  getRepoDir,
  getGitDir,
  copyCheckpointRefs,
  markForkCopyPending,
  RepoManager,
  type CheckpointEntryV3,
} from "./checkpoints";
import { SUBAGENT_PI_TOOL_NAMES } from "./tools/tool-catalog";
import { IMAGE_ENABLED_SETTING, IMAGE_MODEL_SETTING, IMAGE_PI_TOOL_NAMES } from "./tools/image-tool-specs";
import { imageAvailability, type ImageRuntime } from "./tools/image-tools";
import { assembleDamoclesSystemPrompt, renderSections, resolveSkillFileReadTool, type DamoclesPromptSections } from "./agent-start";
import type { McpToolSource } from "./mcp/tool-source";
import { isMcpToolName } from "./mcp/naming";
import { buildNestedMcpToolset, type NestedMcpToolset } from "./tools/mcp-tools";
import { isWebSearchEnabled } from "./web-access";
import { WebviewExtensionUIContext, type AgentUiAttribution } from "./extension-ui-context";
import type { CheckpointBaselineGate, PanelGateContext, SystemPromptEnv } from "./permission-gate";
import type { ToolsSnapshot } from "../../shared/types/tools";
import {
  extractText,
  extractImages,
  piMessageText,
  turnExchangeFrom,
  firstExchangeForTitle,
} from "./branch-text";
import { watchPromptEntry, type PromptDisposition, type PromptEntry, type PromptEntryWatch } from "./prompt-entry";
import {
  PLAN_MODE_NUDGE_CUSTOM_TYPE,
  selectPlanModeNudgeText,
  lastAssistant,
  turnHasNonErrorExitPlanModeResult,
} from "./plan-mode-hold";
import { BTW_SYSTEM_PROMPT, buildBtwContextBlock } from "./btw-context";
import { registerTurnEndImagePruning, registerAgentStartImageReconcile } from "./context-image-pruning";
import { buildContextUsage } from "./context-usage";
import { resolveCompactionBudget } from "./compaction-budget";
import { generateSessionTitle } from "./session-title";
import { appendSubCallUsage } from "../usage-stats/subcall-ledger";
import {
  buildAccountInfo as buildAccountInfoFrom,
  dollarBilled as dollarBilledFrom,
  modelDollarBilled,
  piModelDollarBilled,
  resolvedProviderOf,
  subscriptionProvider,
  type AccountBillingDeps,
  type ModelBillingDeps,
} from "./account-billing";
import {
  fullActiveToolNames as fullActiveToolNamesFrom,
  activeToolNamesWithDeferral,
  buildToolStatus as buildToolStatusFrom,
  type ToolStatusDeps,
} from "./tool-status";
import { deferredToolNames } from "./tools/deferred-tools";
import { waitForPendingDirectServers } from "./mcp/startup-wait";
import { mcpGroupsOf, mcpToolSearchGroup, type DeferrableSnapshot, type McpToolMenuEntry } from "./tools/tool-search-tool";

/** Runtimes whose provider-fallback warning has already been shown (see `warnCustomProviderFallback`).
 *  Module scope because the dedupe spans PiSession instances; weak so a disposed runtime is collectable. */
const fallbackWarnedRuntimes = new WeakSet<PiRuntime>();

/** How long a session delete or resume switch waits for the agents it aborted to stop writing. Aborted runs settle in
 *  milliseconds; this only caps a run whose tool ignores the abort signal, and not a parent turn held open waiting on one. */
const ABORTED_AGENTS_SETTLE_TIMEOUT_MS = 10_000;

/** How long a switch or close waits for queued checkpoint work, so a finalize that is nearly done still
 *  records the last turn; a first baseline of a large folder can take longer and is dropped. */
const CHECKPOINT_DRAIN_MS = 2_000;

/** Rebuilds each image from its validated fields so no extra property is persisted or forwarded; null when any image is invalid. */
function parseSteerImages(images: unknown): ImageBlock[] | null {
  if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_MESSAGE) return null;
  const parsed: ImageBlock[] = [];
  for (const image of images) {
    if (!isImageBlock(image) || image.source.data.length > MAX_IMAGE_BASE64_LENGTH) return null;
    parsed.push({ type: 'image', source: { type: 'base64', media_type: image.source.media_type, data: image.source.data } });
  }
  return parsed;
}

/** The user's text for a file rewind or undo in a chat with no project folder. */
function noProjectRewindMessage(): string {
  return t("This chat has no project folder, so its files have no checkpoints to restore.");
}

/** The user's text for a rewind of a turn that has no usable checkpoint. */
function notRewindableMessage(record: NotRewindableRecord): string {
  return record.reason === "baseline-timeout"
    ? t("This turn cannot be rewound: a file-changing tool ran before its checkpoint was ready.")
    : t("This turn cannot be rewound: its checkpoint could not be taken.");
}

/** The user's text for a restore or undo that did not complete. */
function restoreErrorMessage(result: Exclude<ServiceRestoreResult, { ok: true }>): string {
  switch (result.reason) {
    case "service-unavailable":
      return t("File rewind is unavailable because checkpoints are not active for this conversation in this panel.");
    case "git-unavailable":
      return t("File rewind is unavailable because git was not found.");
    case "aborted":
      return t("Checkpoint work in this folder is still running, so no files were changed. Try again in a moment.");
    case "snapshot-failed":
      return t("No files were changed: the current files could not be saved before the restore ({0}).", result.error);
    case "unavailable":
      return t("No files were changed: the checkpoint storage for this folder is not available ({0}).", result.error);
    case "checkout-failed":
      return result.rollbackError
        ? t("File restore failed and could not be rolled back, so the folder may be partly restored. Your files from before the rewind are kept. Use Undo rewind in the rewind list to bring them back. Restore error: {0}. Rollback error: {1}", result.error, result.rollbackError)
        : t("File restore failed and no files were changed: {0}", result.error);
    case "failed":
      return t("File restore failed: {0}", result.error);
  }
}

/** Whether `prompt(text)` runs a registered extension command, which commits no user entry. Mirrors the
 *  parse in pi's `_tryExecuteExtensionCommand`, which `prompt()` reaches with template expansion on. */
function isExtensionCommand(session: AgentSession, text: string): boolean {
  if (!text.startsWith("/")) return false;
  const space = text.indexOf(" ");
  return session.extensionRunner.getCommand(text.slice(1, space === -1 ? undefined : space)) !== undefined;
}

/** A message the user queued mid-run, carrying its webview chip id. */
interface QueuedInput {
  id: string;
  text: string;
  images: ImageContent[];
  content: ContentInput;
}

/** Refuses the run pi was about to open for a queued batch a stop withdrew. */
class WithdrawnSteerError extends Error {}

/** Refuses the run pi was about to open for a prompt that a stop or a session replacement overtook. */
class StoppedBeforeRunError extends Error {}

/** A cancel note handed to pi; `echoed` once pi accepted it and the transcript says the agent was told. */
interface ListedNote {
  text: string;
  echoed: boolean;
}

/** The process usage monitor and the subscription a chat's model bills. */
interface SubscriptionUsage {
  readonly usage: UsageMonitor;
  readonly provider: SubscriptionProvider;
}

/**
 * `ChatSession` implementation backed by the pi harness (US-P1-4). Owns one `AgentSessionRuntime`
 * whose factory reuses its folder's `FolderRuntime.services` and a `PiStreamAdapter` that
 * reproduces the existing webview message contract. Deferred subsystems degrade gracefully — no
 * method reachable from a live handler throws (FR-10).
 */
export class PiSession implements ChatSession {
  private readonly options: SessionOptions;
  private readonly cwd: string;
  private readonly adapter: PiStreamAdapter;
  /** Per-PiSession webview-bridged extension UI context (US-026), re-bound on each (re)bind. */
  private readonly uiContext: WebviewExtensionUIContext;

  private runtime: AgentSessionRuntime | null = null;
  /** This panel folder's pi services, resolved by `start()`; null until then. */
  private folder: FolderRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  /** In-flight session replacement (reset/clear → newSession); a following sendMessage awaits it. */
  private resetPromise: Promise<void> | null = null;
  /** In-flight abort (interrupt/cancel → session.abort() → waitForIdle); a following sendMessage awaits
   * it so a new turn never races a still-winding-down one ("Agent is already processing"). */
  private abortPromise: Promise<void> | null = null;
  /** In-flight MCP-driven `session.reload()` (orphan recovery); serialized with reset/newSession. */
  private mcpReloadPromise: Promise<void> | null = null;
  /** A tools-changed arrived mid-reload: single-flight coalescing (one trailing reload, not N). */
  private mcpReloadRerunRequested = false;
  /** A tools-changed arrived while busy: reload deferred, flushed at the next turn (`sendMessage`). */
  private mcpReloadPendingAfterTurn = false;
  /** The pi sessionId currently registered in the folder runtime's panel registry (cleared/replaced on rebind). */
  private registeredSessionId: string | null = null;
  /** The exact gate context and tool refresher registered under `registeredSessionId`; unregistering
   *  hands them back so a late release cannot evict another panel's entry for the same id. */
  private registeredGate: PanelGateContext | null = null;
  private registeredToolRefresher: (() => void) | null = null;
  private registeredRuleNoticePoster: ((notices: McpRenamedToolRuleNotice[]) => void) | null = null;
  /** Debounce key for `permission_required` (US-009): one notification per (sessionId, turn). */
  private _lastPermissionNotifyKey: string | null = null;
  /** The latest MCP scope fed to this panel; applied once the folder runtime exists. */
  private mcpScope: McpScope | undefined;
  /** Pushes fresh MCP runtime status to this panel's webview on every connect/disconnect (no manual refresh). */
  private _mcpStatusListener: (() => void) | null = null;
  /** Per-session checkpoint engine driver, registered alongside the panel gate context (US-013b). */
  private checkpointService: CheckpointService | null = null;
  /** User entry ids with a rewind control, pushed via `checkpointInfo`: those with a checkpoint, or every prompt when the chat takes no checkpoints. */
  private readonly checkpointUserIds = new Set<string>();
  /** Size of the last `checkpointInfo` broadcast, to suppress no-op re-emits. */
  private lastCheckpointBroadcast = -1;
  /** The last `sessionStateChanged` sent, as its state, session id and pending prompt ids, so a
   *  re-derivation that changed nothing sends nothing. Only an identical message is ever dropped. */
  private lastSessionState: string | null = null;
  /** The turn's own lifecycle, the single value `publishSessionState` derives from. Written only by
   *  `setTurnState`, never inferred from another flag: `processingFlag` is cleared a tick later than the
   *  adapter reports idle, so reading it here republishes `running` after `idle` and latches the bar. */
  private turnState: TurnState = "idle";
  /** When the running turn started (epoch ms), for a completed outcome's duration. */
  private turnStartedAt = 0;
  /** The session last announced with `stored`, so its file's first write is announced once. */
  private announcedStoredId: string | null = null;
  private activityListener: ((activity: ChatActivity) => void) | null = null;
  private turnSettledListener: ((outcome: TurnOutcome) => void) | null = null;
  /** The last activity reported, keyed with the stored session id, so a change to that id reports too. */
  private lastActivityKey: string | null = null;
  private readonly describePrompts: (raised: readonly RaisedPrompt[]) => PendingPrompt[];

  private desiredModel: Model<Api> | undefined;
  private modelValue: string;
  // The catalog is static, so it is populated before start(): a resumed panel defers start() and still
  // has to resolve its model's billing.
  private supportedModelsCache: ModelInfo[] = piSupportedModels();
  private permissionMode: PermissionMode;
  private processingFlag = false;
  /** Set while a manual compaction runs. Distinct from `processingFlag` so it gates a concurrent
   * sendMessage without arming the budget-abort / context-busy behavior keyed off processingFlag. */
  private compacting = false;
  /** Set while interrupt()/cancel() tears down the in-flight turn, so the prompt() rejection it
   * triggers doesn't surface an error card on top of the sessionCancelled already emitted. */
  private _aborting = false;
  /** Bumped by every ESC, reset and resume switch, so a send still waiting to start its turn can tell it was cancelled. */
  private abortEpoch = 0;
  /** Set when the hard budget limit is crossed mid-turn, so the turn finishes gracefully at the next
   * model round-trip boundary (the `finishTurn` decider) instead of being torn mid-stream by an abort. */
  private _budgetStopRequested = false;
  /** Set once dispose() begins, so a late hook callback draining during teardown emits nothing. */
  private _disposed = false;
  /** Set while `retireAgents` stops the turn of a session about to be replaced, so nothing extends that turn. */
  private retiringAgents = false;
  /** Set whenever an agent may have stopped unfinished since the last check, so the next prompt first
   *  tells the model which agents were interrupted (`reconcileInterruptions`). */
  private interruptionCheckPending = false;
  /** Set when a stored session is bound, so the next prompt scans its agent files once for background
   *  results no turn delivered. Cleared only by a scan that succeeded. */
  private undeliveredScanPending = false;
  /** The index `sendMessage` stamped on the prompt it is running; null between turns. */
  private inFlightPromptIndex: number | null = null;
  /** A stored session id to resume on next start(), or to switch the live runtime to (US-010b). */
  private resumeSessionId: string | null = null;
  /** Sessions whose lease another process took; this panel is detaching from them and never re-leases them. */
  private readonly lostLeases = new Set<string>();
  /** The panel's `ready.panelToken`, named in the owner record of every lease this session holds. */
  private panelToken: string | null = null;
  /** The teardown `dispose()` started; a handover waits for it before letting the lease go. */
  private disposal: Promise<void> | null = null;
  /** Guards the one-shot AI title generation after the first assistant turn (US-012). */
  private titleGenerationAttempted = false;
  /** The first real (non-internal, non-`<…>`) user message of this session, captured in `sendMessage`.
   *  Used by `getPlanFilePath` as a fallback before the message is committed to the branch — on the first
   *  turn `before_agent_start` builds the plan-mode prompt before the user message lands in the branch,
   *  so reading the branch alone would slug to `plan`. Matches `StoredSession.preview`. Reset on clear. */
  private _firstUserMessage: string | null = null;
  private thinkingDisabledNextQuery = false;
  /** Messages the user queued during the current turn, held until they are injected as ONE combined
   * steer at the next agent boundary. Each carries its webview chip id so the chips collapse into the
   * single combined message on delivery. Cleared on delivery, abort, and session replacement. */
  private queuedInputs: QueuedInput[] = [];
  /** Messages queued after every one in `queuedInputs`, still waiting on pi's input handlers, oldest first. */
  private screeningInputs: QueuedInput[] = [];
  private screeningRunning = false;
  /** How many leading `queuedInputs` the batch pi holds carries, so its delivery consumes exactly those; null counts them all. */
  private steeredCount: number | null = null;
  /** Set while `resteerQueuedInputs` runs; a request meanwhile sets `resteerRequested` for one more pass. */
  private resteerRunning = false;
  private resteerRequested = false;
  /** Cancel notes handed to pi and not yet delivered. Their delivery event is not a queued batch. */
  private injectedNotes: ListedNote[] = [];
  /** The watch on the entry the running `sendMessage` prompt commits. */
  private promptEntry: PromptEntryWatch | null = null;
  /** The native subagent engine (Phase 5): the shared workspace registry + a per-PiSession manager. */
  private agentRegistry: AgentRegistry | null = null;
  private subagentManager: AgentManager | null = null;
  /** Unsubscribe from the shared workspace registry's change notifications (re-emits availability). */
  private _agentsUnsub: (() => void) | null = null;
  /** `SettingsStore` listener that re-applies the subagent concurrency cap when it changes mid-session. */
  private _configUnsub: Disposable | null = null;
  /** Live `/btw` aside sessions keyed by btwId, so `cancelBtw` can abort one mid-stream (US-025). */
  private readonly btwSessions = new Map<string, { session: AgentSession; ac: AbortController }>();
  /** Browser tab scopes this session handed to its subagents / team agents. The BrowserService is shared
   *  by every panel, so the session that minted a scope is the only thing that may reclaim its tabs: an
   *  agent that failed keeps its tab for inspection and drops its scope entry, leaving nobody else able
   *  to close it once the conversation ends. */
  private readonly ownedBrowserScopes = new Set<string>();
  /** Deferred tools `ToolSearch` has loaded, durable for the life of the session. Every recompute path
   *  funnels through `applyActiveToolsForMode`, so re-applying this union there is what stops a settings
   *  toggle / MCP change / permission-mode change from silently deactivating a mid-conversation load. */
  private readonly toolSearchActivated = new Set<string>();
  /** The session whose first prompt already ran the Always-loaded MCP wait; keyed by id so a replacement session waits again. */
  private mcpStartupWaitedSessionId: string | null = null;
  /** Ends the running Always-loaded MCP wait when the user stops the turn, the session is replaced or the panel closes. */
  private mcpStartupWaitAbort: AbortController | null = null;
  /** A field, not a per-session local, so a live call's entry survives session replacement. Each entry
   *  carries the delivery of the context that opened it, so a note still reaches the conversation
   *  that ran the command and not the one that replaced it. */
  private readonly shellCancel = new ShellCancelStore();
  // Panel-scoped, not conversation-scoped: reset() and clear() swap the pi session but keep this instance, so a
  // process the user deliberately backgrounded survives a /clear and dies only when the panel is disposed.
  private readonly shellJob = createShellSessionJob();
  private readonly unpersistedImages = new UnpersistedToolImages();

  /** True when the turn must not be EXTENDED — ESC (`_aborting`) or the budget limit. For the
   * turn-holding paths only; those meaning "the user aborted" (the slash-command release and the
   * `prompt()` catch) deliberately keep testing `_aborting` alone. */
  private stopRequested(): boolean {
    return this._aborting || this._budgetStopRequested || this.retiringAgents;
  }

  constructor(options: SessionOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.mcpScope = options.mcpScope;
    this.modelValue = options.model ?? "";
    this.permissionMode = "default";
    this.adapter = new PiStreamAdapter({
      onMessage: options.onMessage,
      cwd: options.cwd,
      sessionId: () => this.runtime?.session.sessionId ?? "",
      modelValue: () => this.modelValue,
      defaultModelValue: () => options.getDefaultModel?.() ?? this.modelValue,
      contextWindow: () => this.contextWindowForCurrentModel(),
      supportedModels: () => this.supportedModelsCache,
      permissionMode: () => this.permissionMode,
      budgetLimit: () => this.budgetLimitForEnforcement(),
      showCacheMissNotices: () =>
        options.platform.settings.get<boolean>('damocles.showCacheMissNotices', false, options.settingsFolder),
      showThinkingDroppedNotices: () =>
        options.platform.settings.get<boolean>('damocles.showThinkingDroppedNotices', true, options.settingsFolder),
      sessionCost: () => this.ownSessionCost(),
      onBudgetStop: () => this.stopForBudget(),
      onUserMessageDelivered: (deliveredText) => this.onQueuedInputsDelivered(deliveredText),
      onMidStreamEntryCommitted: (userEntryId) => this.recordMidStreamMarker(userEntryId),
      promptEntryId: () => this.promptEntry?.entry()?.id ?? null,
      onTurnStateChanged: (...change) => this.setTurnState(...change),
      ...(options.onAssistantTextFinal ? { onAssistantTextFinal: options.onAssistantTextFinal } : {}),
    });
    this.uiContext = new WebviewExtensionUIContext(options.onMessage, () => this.runtime?.session.sessionId ?? "");
    this.describePrompts = pendingPromptDescriber(options.cwd);
    const owners = this.promptOwners();
    options.permissionHandler.setPromptOwnerResolver((parentToolUseId) => promptOwnerOf(parentToolUseId, owners));
    // Wired here and not at bind time: a prompt outranks the turn lifecycle even before start().
    this.uiContext.setPendingChangedListener(() => this.publishSessionState());
    options.permissionHandler.setPendingPromptsListener(() => this.publishSessionState());
    options.teamService?.setRunListener(() => this.publishSessionState());
  }

  // ---- lifecycle ----------------------------------------------------------

  private ensureStarted(): Promise<void> {
    // A panel replaces a disposed session rather than reviving it, so a stale caller must fail here.
    if (this._disposed) return Promise.reject(new Error("PiSession: session was disposed"));
    if (!this.startPromise)
      this.startPromise = timed("start.total", () => this.start()).catch((err) => {
        this.startPromise = null;
        throw err;
      });
    return this.startPromise;
  }

  /** The folder runtime, for paths that only run once `start()` has resolved it. */
  private requireFolder(): FolderRuntime {
    if (this.folder === null) throw new Error("PiSession: folder runtime used before start()");
    return this.folder;
  }

  /** A folder switch disposes a session while its webview stays live, so a start that outlived its
   *  session must not bind, register or announce anything. */
  private throwIfDisposedDuringStart(): void {
    if (this._disposed) throw new Error("PiSession: session was disposed during start");
  }

  private async start(): Promise<void> {
    const piRuntime = PiRuntime.get();
    const folder = await piRuntime.folder(this.cwd);
    this.throwIfDisposedDuringStart();
    this.folder = folder;
    const pi = getPiCodingAgent();
    if (!pi) throw new Error("PiSession.start: pi runtime not initialized");

    // Wire native custom providers (StepFun/DeepSeek/OpenRouter/Gemini) from secrets so subagents AND a
    // saved StepFun/DeepSeek default model can resolve (Phase 5, US-018.8). Deliberately still AWAITED
    // before resolveInitialModel: fire-and-forget would race the user's first prompt and route turn 1 to
    // the wrong provider. Safe to await because the sync is bounded, cancellable and fail-soft — and if
    // it does give up, the resulting model downgrade is surfaced below rather than applied silently.
    let syncTimedOut = false;
    let notWiredProviders: string[] = [];
    if (this.options.secrets) {
      const secrets = this.options.secrets;
      const syncSpan = perfSpan("start.syncProviders");
      ({ notWired: notWiredProviders, timedOut: syncTimedOut } = await piRuntime.syncCustomProviders((key) => secrets.get(key)));
      syncSpan.end({ timedOut: syncTimedOut });
      this.throwIfDisposedDuringStart();
    }

    const requestedModel = this.modelValue;
    this.resolveInitialModel(piRuntime);
    if (syncTimedOut) this.warnCustomProviderFallback(piRuntime, requestedModel, notWiredProviders);

    // Native subagent engine (Phase 5): a cross-turn per-PiSession registry + manager, created before the
    // factory so the primary session's customTools include the three subagent tools.
    this.ensureSubagentEngine(pi, folder);

    const factory: CreateAgentSessionRuntimeFactory = async (opts) => {
      // Refresh the folder's extension runtime so each session binds to its own fresh runtime — a
      // disposed session marks its runtime stale, and reload() (verified) only swaps the loader's
      // current runtime without invalidating other panels' already-bound live sessions, so this also
      // isolates concurrent panels. Skipped only for the folder's first session (which uses the
      // pristine creation runtime); every later session on the same folder reloads.
      await folder.prepareSessionExtensions();
      const shared = folder.services;
      // Filled in below, once this factory call's session exists. The tools are built before it does, so
      // the note delivery reads it through a thunk; binding it here and not to `this.runtime` is what
      // keeps a leftover shell call's note in the conversation that ran the command.
      const bound: { session?: AgentSession } = {};
      // Built per session so per-session tool state (the task list) resets on reset/newSession.
      const customTools = buildCustomTools({
        pi,
        cwd: this.cwd,
        permissionHandler: this.options.permissionHandler,
        ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
        ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
        ...(this.options.browserService ? { browserService: this.options.browserService } : {}),
        ...(this.options.browserChat ? { browserChat: this.options.browserChat } : {}),
        getSessionId: () => this.memorySessionId,
        getPlanFilePath: () => this.getPlanFilePath(),
        ...(this.subagentManager ? { subagentManager: this.subagentManager } : {}),
        ...(this.options.teamService ? { teamService: this.options.teamService } : {}),
        imageGeneration: {
          getRuntime: () => this.imageRuntime(),
          getModelId: (toolCallId) => this.options.permissionHandler.takeApprovedImageModel(toolCallId) ?? this.imageModelId(),
        },
        isTeamEnabled: () => !!this.options.teamService && this.isTeamEnabled(),
        getShellOptions: () => this.shellOptions(),
        shellCancel: this.shellCancel,
        deliverUserNote: this.noteDeliveryForMain(() => bound.session),
        shellJob: this.shellJob,
      });
      // No `tools:` on purpose. pi freezes `options.tools` into an `_allowedToolNames` filter; since the
      // factory runs before `setMcpServers`, a frozen list would permanently exclude later-registered
      // mcp__ tools (the first-connect bug). Omitting it admits every non-excluded tool into the registry;
      // the active set is governed by `applyActiveToolsForMode`. `excludeTools` still drops pi's `edit`.
      const result = await pi.createAgentSessionFromServices({
        services: shared,
        sessionManager: opts.sessionManager,
        ...(this.desiredModel ? { model: this.desiredModel } : {}),
        excludeTools: [...PI_EXCLUDED_TOOLS],
        customTools,
        thinkingLevel: this.resolveThinkingLevel(),
      });
      bound.session = result.session;
      return { ...result, services: shared, diagnostics: shared.diagnostics ?? [] };
    };

    // Pin sessions to the Damocles-owned pi tree dir (~/.damocles/pi/agent/sessions/<cwd>/), isolated
    // from the user's ~/.pi store (FR-1). `create(cwd)` alone would default to ~/.pi/agent.
    const sessionDir = ensurePiSessionDir(this.cwd);
    // Resume target set before first start (e.g. ready-with-savedSessionId): open the stored session
    // file instead of creating fresh, so the live conversation continues it (US-010b). A forked panel
    // resumes its branched session file (US-013c).
    const fork = this.options.forkContext;
    const forkResumeId = fork && !fork.consumed ? fork.piBranchedSessionId : undefined;
    const resumeTargetId = this.resumeSessionId ?? forkResumeId ?? null;
    const resumePath = resumeTargetId ? await resolvePiSessionFile(this.cwd, resumeTargetId) : null;
    this.throwIfDisposedDuringStart();
    // Opening can rewrite the file (a format migration), so a session whose lease was lost meanwhile is not opened; the pending detach resets this panel.
    if (resumeTargetId && this.lostLeases.has(resumeTargetId)) throw new Error("PiSession: the session's lease was lost during start");
    if (resumePath && forkResumeId && fork) fork.consumed = true;
    const sessionManager = resumePath ? pi.SessionManager.open(resumePath, sessionDir) : pi.SessionManager.create(this.cwd, sessionDir);
    const runtime = await timed("start.createRuntime", () =>
      pi.createAgentSessionRuntime(factory, { cwd: this.cwd, agentDir: PI_AGENT_DIR, sessionManager }), { resumed: resumePath !== null });
    if (this._disposed) {
      // dispose() already ran with no runtime to tear down, so this one is ours to release.
      await runtime.dispose();
      this.throwIfDisposedDuringStart();
    }
    this.runtime = runtime;

    this.bindSession(this.runtime.session);
    // Continue the token/budget meter from the resumed session's loaded total rather than zero.
    if (resumePath) {
      this.seedResumedUsage();
      this.interruptionCheckPending = true;
      this.undeliveredScanPending = true;
    }
    // Sync the active tool set to the panel's current permission mode (a forked panel may already be
    // in plan mode at session-creation time; the factory `tools` only sets the full default set).
    this.permissionMode = this.options.permissionHandler.getPermissionMode();
    this.applyActiveToolsForMode(this.permissionMode);

    this.runtime.setBeforeSessionInvalidate(() => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    });
    this.runtime.setRebindSession(async (session) => {
      this.bindSession(session);
      // No factory `tools:` means a replacement session starts with pi's bare default set — re-apply the
      // panel's real active set (mirrors start()), else reset/clear would strip every non-default tool.
      this.applyActiveToolsForMode(this.permissionMode);
      // A replacement session (reset/clear → newSession) carries a fresh sessionId; the consumer
      // re-arms the watcher and re-registers the session off this callback, so it must fire here too.
      this.announceSessionId(session.sessionId);
      // Both paths that reach here, a reset/clear and a resume switch, make the webview reset its own
      // store, so the cached key describes a state nothing on screen is showing any more.
      this.lastSessionState = null;
      this.publishSessionState();
    });

    this.announceSessionId(this.runtime.session.sessionId);
    // resolveInitialModel may have moved the model off the requested one, and the panel has had no
    // account state before this point.
    this.publishAccountInfo();
    // A resume that landed while the runtime was being built found no runtime to switch.
    if (this.resumeSessionId && this.resumeSessionId !== resumeTargetId) this.setResumeSession(this.resumeSessionId);
  }

  /**
   * Subscribe the adapter, re-apply the B3 compaction-off invariant, register this panel in the
   * shared gate registry (keyed by the session's id), and bind the webview extension-UI context.
   * Called on initial start and on every session replacement (reset/clear → newSession).
   */
  private bindSession(session: AgentSession): void {
    // A lease lost while start() or a resume switch was opening this session: nothing may append for it.
    this.muteIfLeaseLost(session);
    const adapterUnsubscribe = this.adapter.subscribe(session);
    this.unpersistedImages.track(session);
    this.unsubscribe = () => {
      adapterUnsubscribe();
      this.unpersistedImages.untrack(session);
    };
    // Graceful budget stop (US-008): pi consults this once per model round-trip, so `end` finishes the
    // turn at the next boundary with the in-flight message and its tool results intact, unlike an
    // abort. Installed here because start() and setRebindSession both funnel through bindSession, and a
    // REPLACEMENT session brings a new Agent needing it re-installed (as `applyActiveToolsForMode` does).
    // Must read the field at call time — pi snapshots the function reference at run start, so a captured
    // boolean would freeze at that run's starting value.
    installTurnDecider(session.agent, BUDGET_STOP_HOOK, () =>
      this._budgetStopRequested ? { action: 'end' } : undefined,
    );
    // A user's mode change while the run streams reaches the model at its next step; see plan-mode-change.ts.
    installPlanModeChangeNotice(session.agent, () => this.isPlanMode(), this.planModeStatement);
    // The main panel session honors `damocles.autoCompact` (US-030); pi's compaction flag lives on the
    // shared settings manager, so subagent/team/btw sessions isolate it via their own in-memory manager
    // (see FolderRuntime.createSubagentSession) — they never auto-compact regardless of this toggle.
    this.applyCompactionConfig();
    this.applyCacheWarmingConfig();

    const folder = this.requireFolder();
    const sessionId = session.sessionId;
    if (this.registeredSessionId && this.registeredSessionId !== sessionId) {
      // Gate on the id ACTUALLY changing: a rebind onto the same session (refresh, mode change) must
      // keep whatever ToolSearch loaded, while a replacement session starts from the deferred baseline.
      this.toolSearchActivated.clear();
      this.unregisterFromRuntime(folder, this.registeredSessionId);
      // A replacement session gets a fresh checkpoint driver + rewindable set.
      this.checkpointService?.dispose();
      this.checkpointService = null;
      this.checkpointUserIds.clear();
      this.lastCheckpointBroadcast = -1;
    }
    const gate: PanelGateContext = {
      permissionHandler: this.options.permissionHandler,
      isPlanMode: () => this.options.permissionHandler.getPermissionMode() === "plan",
      ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
      ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
      getSessionModel: () => this.modelValue,
      getSystemPromptEnv: () => this.systemPromptEnv(),
      getPlanFilePath: () => this.getPlanFilePath(),
      isTeamEnabled: () => !!this.options.teamService && this.isTeamEnabled(),
      postMessage: (message) => this.emit(message),
      budgetStopRequested: () => this._budgetStopRequested,
      onBeforeSettle: (event) => this.onBeforeSettle(event),
      isMcpReadOnly: (name) => this.mcpClientManager()?.isMcpReadOnly(name) ?? false,
      mcpToolIdentity: (name) => {
        const descriptor = this.mcpClientManager()?.getToolDescriptor(name);
        return descriptor ? { server: descriptor.serverName, tool: descriptor.rawToolName } : undefined;
      },
      deferrableTools: () => this.deferrableToolsSnapshot(),
      activateDeferredTools: (names) => this.activateDeferredTools(names),
      waitForAlwaysLoadedMcp: (id) => this.waitForAlwaysLoadedMcp(id),
      ...this.checkpointBaselineField(),
      shellCancel: this.shellCancel.forContext(this.noteDeliveryForMain(() => session)),
    };
    folder.registerPanel(sessionId, gate);
    this.registeredGate = gate;
    // Register the live rename/tag surface so a mutation from any panel routes here, not to a
    // second file-writer that would fork this session's branch (US-012, cross-panel).
    PiRuntime.get().registerSessionMutator(sessionId, this);
    // On MCP tools-changed, re-apply this session's active set and push fresh MCP status (no manual
    // refresh). `reloadForMcpToolChange` also rebuilds an orphaned-runtime session whose registry never
    // got the new tools (its extension instance is no longer attached); it's a plain refresh otherwise.
    const refreshTools = (): void => {
      this.reloadForMcpToolChange();
      this._mcpStatusListener?.();
    };
    folder.registerActiveToolRefresher(sessionId, refreshTools);
    this.registeredToolRefresher = refreshTools;
    const postRuleNotices = (notices: McpRenamedToolRuleNotice[]): void => {
      this.options.onMessage({ type: "mcpRenamedToolRules", notices });
    };
    folder.registerRuleNoticePoster(sessionId, postRuleNotices);
    this.registeredRuleNoticePoster = postRuleNotices;
    this.registeredSessionId = sessionId;

    // permission_required notifier (US-009): lazy + debounced-per-turn. Fires only when a hook is
    // configured and only at the two genuine approval waits (file/shell), mapping onto the synthetic
    // `permission_required` hook. Re-set per rebind so the captured session's transcript stays current.
    // For a SUBAGENT approval, `info.parentToolUseId` is set but `session_id`/`transcript_path` (and the
    // debounce key) are the primary panel's — the approval surfaces on the primary, and the parent tool-use
    // id identifies the subagent. This is an observe-only notification, so the primary identity is benign.
    this.options.permissionHandler.setPermissionRequiredNotifier((info) => {
      const deps = folder.getHooksDispatchDeps();
      if (!deps.config.hasEntries("permission_required")) return;
      const turnKey = `${sessionId}:${this.currentPromptIndex}`;
      if (this._lastPermissionNotifyKey === turnKey) return;
      this._lastPermissionNotifyKey = turnKey;
      const payload = buildPermissionRequiredPayload(
        { session_id: sessionId, transcript_path: session.sessionManager.getSessionFile() ?? "", cwd: this.cwd },
        {
          message: info.message,
          tool_name: info.toolName,
          input: info.toolInput,
          ...(info.filePath !== undefined ? { file_path: info.filePath } : {}),
          ...(info.command !== undefined ? { command: info.command } : {}),
          ...(info.parentToolUseId !== undefined ? { parentToolUseId: info.parentToolUseId } : {}),
        },
      );
      void dispatchObserveOnly(deps, "permission_required", this.cwd, payload).catch((err) =>
        log("[PiSession] permission_required hook failed: %O", err),
      );
    });

    // Canonical plan reader for the permission layer (ExitPlanMode approval reads the file, not a summary).
    this.options.permissionHandler.setPlanContentResolver(() => this.getPlanContent());

    // Registered before the first turn's message_start. A rebind onto the same session keeps its driver,
    // whose pending turn and queued records belong to that session. `hydrate` re-surfaces the checkpoints
    // already in a resumed/forked tree so they are immediately rewindable. A chat with no project folder
    // has no service: its baseline would snapshot the whole home folder (docs/invariants.md, "Checkpoints").
    if (this.fileCheckpoints) {
      let checkpointService = this.checkpointService;
      if (checkpointService?.sessionId !== sessionId) {
        checkpointService?.dispose();
        checkpointService = this.createCheckpointService(sessionId);
        this.checkpointService = checkpointService;
      }
      folder.registerCheckpointService(sessionId, checkpointService);
      checkpointService.hydrate(session.sessionManager);
    }

    // Cancel any dialogs left pending by the previous session, then bind the UI context (US-026).
    this.uiContext.cancelAll();
    void session.bindExtensions({ uiContext: this.uiContext, mode: "rpc" }).catch((err) => log("[PiSession] bindExtensions failed: %O", err));

    // The latest scope, never the creation-time one: a live feed may have arrived before the folder existed.
    if (this.mcpScope) this.applyMcpScope(this.mcpScope);
    // The status source is now this folder; servers already connected under an unchanged scope fire no tools-changed event.
    this._mcpStatusListener?.();
    // A fresh session has no file until pi's first write; its lease is taken here, on the path pi will write.
    this.syncSessionLeases();
  }

  /**
   * Hold the cross-process lease of every stored session this panel holds (`holdsSession`) and release
   * the rest. Stored sessions are leased by `claimStoredSession` before they are bound; this adds the
   * sessions this panel creates (a fresh session, a fork's branch) and drops what a switch, reset or
   * dispose let go of.
   */
  private syncSessionLeases(): void {
    const held = new Set<string>();
    if (!this._disposed) for (const id of [this.currentSessionId, this.resumeSessionId]) if (id) held.add(id);
    for (const id of sessionLeasesOf(this)) if (!held.has(id)) releaseSessionLease(id, this);
    for (const id of this.lostLeases) if (!held.has(id)) this.lostLeases.delete(id);
    for (const id of held) if (!this.lostLeases.has(id) && !acquireSessionLease(id, this)) this.onSessionLeaseLost(id);
  }

  onSessionLeaseLost(sessionId: string): void {
    if (!this.holdsSession(sessionId) || this.lostLeases.has(sessionId)) return;
    this.lostLeases.add(sessionId);
    const session = this.runtime?.session;
    if (session) this.muteIfLeaseLost(session);
    // A panel being disposed is already letting go of the session; a detach would re-register it.
    if (this._disposed) return;
    log("[PiSession] lease on session %s lost; detaching", sessionId);
    void this.options.platform.notifications.warn(t("This conversation was opened in another Damocles window, so this panel closed it."));
    this.detachSession().catch((err) => log("[PiSession] detaching after a lost lease failed: %O", err));
  }

  /**
   * The graceful opposite of a lost lease: this process still holds the lease, so the turn is stopped and
   * every write lands before the lease goes. A detach that fails leaves the old session installed, and this
   * panel's own hold keeps the lease.
   */
  async onSessionReleaseRequested(sessionId: string): Promise<void> {
    // A panel being disposed releases the lease itself, after its teardown appended the last entry.
    if (this._disposed || !this.holdsSession(sessionId) || this.lostLeases.has(sessionId)) return;
    // Joined before anything rebinds, since the reset releases this panel's own hold while the old session can still append.
    const handover: SessionLeaseHolder = {
      // After the reset the panel no longer holds the session, so its own loss handler would not mute the old manager.
      onSessionLeaseLost: (id) => {
        this.lostLeases.add(id);
        const session = this.runtime?.session;
        if (session) this.muteIfLeaseLost(session);
      },
    };
    if (!acquireSessionLease(sessionId, handover, { writer: true })) return;
    log("[PiSession] another process asked for session %s; handing it over", sessionId);
    try {
      await this.startPromise?.catch(() => undefined);
      if (this._disposed || this.lostLeases.has(sessionId)) return;
      // The Stop path, so the stop marker lands in the file while the lease is still held.
      if (this.processingFlag || this.runtime?.session.isStreaming) await this.interrupt();
      else await this.abortPromise;
      if (this._disposed || this.lostLeases.has(sessionId)) return;
      await this.detachSession();
      if (!this.lostLeases.has(sessionId)) {
        void this.options.platform.notifications.warn(t("This conversation was opened in another Damocles window, so this panel closed it."));
      }
    } finally {
      // A dispose under way still appends the aborted turn in its teardown.
      if (this._disposed) await this.disposal?.catch(() => undefined);
      releaseSessionLease(sessionId, handover);
    }
  }

  setPanelToken(token: string | null): void {
    if (this.panelToken === token) return;
    this.panelToken = token;
    refreshSessionLeaseOwners(this);
  }

  sessionLeasePanelToken(): string | null {
    return this.panelToken;
  }

  /** Stop `session`'s manager writing when its lease was lost; pi's SessionManager has no close, so replacing its file writer is the only synchronous way. */
  private muteIfLeaseLost(session: AgentSession): void {
    if (this.lostLeases.has(session.sessionId)) session.sessionManager._persist = () => undefined;
  }

  /** Release every runtime registry entry this panel registered under `sessionId`. */
  private unregisterFromRuntime(folder: FolderRuntime, sessionId: string): void {
    if (this.registeredGate) folder.unregisterPanel(sessionId, this.registeredGate);
    if (this.checkpointService) folder.unregisterCheckpointService(sessionId, this.checkpointService);
    PiRuntime.get().unregisterSessionMutator(sessionId, this);
    if (this.registeredToolRefresher) folder.unregisterActiveToolRefresher(sessionId, this.registeredToolRefresher);
    if (this.registeredRuleNoticePoster) folder.unregisterRuleNoticePoster(sessionId, this.registeredRuleNoticePoster);
    this.registeredGate = null;
    this.registeredToolRefresher = null;
    this.registeredRuleNoticePoster = null;
  }

  /**
   * Pick the starting model: the saved value if its canonical provider is authed, otherwise the
   * first curated model the user is actually signed in for (so a codex-only user defaults to a GPT
   * model rather than an unusable Claude/gateway one). Leaves the model unset if nothing is authed.
   */
  private resolveInitialModel(piRuntime: PiRuntime): void {
    const registry = piRuntime.modelRuntime;
    if (!registry) return;
    const openai = piRuntime.getOpenAIAuthStatus();

    const preferApiKey = this.preferOpenAIApiKey();
    const isCurated = (value: string): boolean => this.supportedModelsCache.some((m) => m.value === value);
    const trySet = (value: string): boolean => {
      const res = resolvePiModel(value, registry, openai, preferApiKey);
      if (res.model && res.authed) {
        this.desiredModel = res.model;
        this.modelValue = value;
        return true;
      }
      return false;
    };

    // Honor the saved model only if it's a curated value AND authed; else fall back to the first
    // curated model the user is signed in for (keeps the active model in sync with the dropdown).
    if (this.modelValue && isCurated(this.modelValue) && trySet(this.modelValue)) return;
    // Before that generic walk, try the requested model's declared substitutes. `supportedModelsCache`
    // is ordered by capability rather than price, so a model missing from pi's catalog (a fresh install
    // that is offline or has not refreshed it yet) would otherwise land on the top entry — costlier than
    // what the user actually asked for.
    for (const substitute of MODEL_SUBSTITUTES[this.modelValue] ?? []) {
      if (isCurated(substitute) && trySet(substitute)) return;
    }
    for (const m of this.supportedModelsCache) {
      if (trySet(m.value)) return;
    }
  }

  /**
   * Surface the model downgrade a timed-out provider sync causes: with the saved default not live,
   * `resolveInitialModel` falls back to a curated Claude/GPT model — a different provider with different
   * cost and capabilities than the user picked, which must not happen quietly. Fire-and-forget, so the
   * notification never gates startup on an answer.
   *
   * Keyed off `notWired` (configured but not live), never off the absence from `wired`: a provider whose
   * secret the user deleted is deauthenticated and appears in NEITHER list, and telling that user we
   * "could not reach" their provider — then offering a reload that cannot help — is a wrong diagnosis.
   */
  private warnCustomProviderFallback(piRuntime: PiRuntime, requested: string, notWired: string[]): void {
    const info = this.supportedModelsCache.find((m) => m.value === requested);
    if (!info?.piProvider || !notWired.includes(info.piProvider)) return;
    // A resolved substitute means a downgrade; no `desiredModel` at all means nothing was authed, which
    // leaves `modelValue` equal to `requested` and is the MORE broken case, not a reason to stay silent.
    const fallback = this.modelValue === requested ? null : this.modelValue;
    if (fallback === null && this.desiredModel) return;
    // One modal per runtime: every open panel starts its own PiSession against the same PiRuntime, and
    // persistent lock contention would otherwise stack one identical modal per panel.
    if (fallbackWarnedRuntimes.has(piRuntime)) return;
    fallbackWarnedRuntimes.add(piRuntime);

    const providerName = providerDisplayName(info);
    const requestedName = info.displayName;
    const fallbackName = fallback === null ? null : (this.supportedModelsCache.find((m) => m.value === fallback)?.displayName ?? fallback);
    const message =
      fallbackName === null
        ? t(
            "Damocles could not reach {0} in time, so \"{1}\" is unavailable and no signed-in model could be selected.",
            providerName,
            requestedName,
          )
        : t(
            "Damocles could not reach {0} in time, so \"{1}\" is unavailable and \"{2}\" is being used instead.",
            providerName,
            requestedName,
            fallbackName,
          );
    const reload = t("Reload Window");
    void (async () => {
      const choice = await this.options.platform.notifications.warn(message, reload);
      if (choice === reload) await this.options.platform.lifecycle.reload();
    })().catch((err) => log("[PiSession] provider fallback notification failed: %O", err));
  }

  // ---- messaging ----------------------------------------------------------

  async sendMessage(
    prompt: ContentInput,
    _agentId?: string,
    correlationId?: string,
    userBroadcast?: { content: string; contentBlocks?: UserContentBlock[] },
  ): Promise<void> {
    if (this.processingFlag || this.compacting) {
      this.adapter.emitAlreadyInProgress();
      return;
    }
    const abortEpoch = this.abortEpoch;
    try {
      await this.ensureStarted();
    } catch (err) {
      this.emit({ type: "error", message: `pi failed to start: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    // Wait for any in-flight session replacement so we prompt the FRESH session, not the old one that
    // is still tearing down (else pi throws "Agent is already processing"). Drives the plan
    // "clear context & start fresh" flow, which calls clear() then sendMessage() synchronously.
    if (this.resetPromise) {
      const pending = this.resetPromise;
      await pending;
      if (this.resetPromise === pending) this.resetPromise = null;
    }
    // Likewise wait for an in-flight abort (interrupt/cancel) to fully wind the prior turn down before
    // starting a new one. ESC during a long tool (e.g. browser open) keeps pi streaming until the tool
    // returns; a sendMessage that arrived in that window would otherwise hit "Agent is already
    // processing". Tools honor the abort signal, so this resolves promptly rather than blocking.
    if (this.abortPromise) {
      await this.abortPromise;
    }
    // Flush a deferred MCP reload (a connect that arrived mid-turn on an orphaned session): the prior
    // turn has settled, so rebuild now — awaited so this turn prompts against the rebuilt session.
    if (this.mcpReloadPendingAfterTurn) {
      await this.runMcpReload();
    }
    const session = this.runtime?.session;
    if (!session) {
      this.emit({ type: "error", message: "Failed to initialize pi session" });
      return;
    }
    // Pre-prompt budget block (US-008): if the session already crossed the hard limit, refuse the next
    // turn rather than starting one that would immediately abort.
    const budgetLimit = this.budgetLimitForEnforcement();
    if (budgetLimit !== null && this.cumulativeCostUsd() >= budgetLimit) {
      this.emit({ type: "budgetExceeded", finalSpend: this.cumulativeCostUsd(), limit: budgetLimit });
      this.emit({ type: "processing", isProcessing: false });
      return;
    }

    const text = extractText(prompt);
    // An extension command commits no user entry, so its echo is injected like every other row that
    // names no prompt, and the next real prompt keeps the index it would have had.
    const isPrompt = !isExtensionCommand(session, text);
    // Before `beginTurn`: neither message's message_start may be read as this turn's user entry. Results
    // go first, so the notice skips every agent they delivered. Both introduce a user message, which a
    // refused prompt or an extension command never commits.
    if (isPrompt && (await this.deliverUndeliveredResults(session))) {
      await this.reconcileInterruptionsIfPending(session);
    }
    // No await may follow this check before `prompt()`: an ESC or a session replacement that lands in
    // one would be lost, and the message would run anyway.
    if (this.abortEpoch !== abortEpoch || this.runtime?.session !== session) {
      this.returnUnsentMessage(correlationId, userBroadcast);
      return;
    }
    // Capture the session's first real user message for the deterministic plan path. The
    // branch doesn't yet hold this prompt when `before_agent_start` builds the plan-mode system prompt on
    // the first turn, so `getPlanFilePath` falls back to this. Prefer the user's ORIGINAL typed text
    // (`userBroadcast.content`) over the expanded `prompt` so the slug matches the branch-derived value
    // `extractFirstUserMessage` later returns (which resolves the same original via the sidecar). Otherwise
    // a slash-command/skill first message would slug the expansion now and the original later, splitting
    // the session across two plan files. Drops `<…>`-prefixed synthetic prompts; being a pre-branch
    // fallback, it self-heals to the branch-derived value once a qualifying message lands.
    if (this._firstUserMessage === null) {
      const text = userBroadcast?.content ?? piMessageText(prompt);
      if (text && !text.trimStart().startsWith("<")) this._firstUserMessage = text;
    }

    if (isPrompt) {
      // Derived from the branch this prompt extends, by the rule the history loader stamps with, so the
      // live index and every record keyed by it match what a reload shows.
      this.inFlightPromptIndex = nextPromptIndex(session.sessionManager.getBranch());
    }

    if (userBroadcast && correlationId) {
      this.emit({
        type: "userMessage",
        content: userBroadcast.content,
        ...(userBroadcast.contentBlocks ? { contentBlocks: userBroadcast.contentBlocks } : {}),
        correlationId,
        promptIndex: this.currentPromptIndex,
        ...(isPrompt ? {} : { isInjected: true, isCommandEcho: true }),
      });
    }

    this.processingFlag = true;
    this._aborting = false;
    this._budgetStopRequested = false;
    session.setThinkingLevel(this.resolveThinkingLevel());
    // Refresh the auto-compaction reserve against the current model's window before the turn, so the
    // configured trigger percent holds even after a model switch or a settings save() (US-030).
    this.refreshCompactionReserve();
    this.adapter.beginTurn(correlationId);

    const images = extractImages(prompt);
    // Reaches the turn lifecycle only when no pi event already settled the turn.
    let outcome: TurnOutcome = { kind: "completed" };
    // The prompt's own entry is the earliest point its turn's checkpoint baseline can start.
    const committed = watchPromptEntry(session, (entry) => {
      const service = this.checkpointService;
      if (service?.sessionId === session.sessionId) service.startTurn(session.sessionManager, entry.id, entry.text);
      // With no file checkpoints the conversation can still be forked from any prompt.
      if (!this.fileCheckpoints && this.runtime?.session === session) this.addCheckpoint(entry.id);
      if (this.runtime?.session === session) this.announceIfNewlyStored();
    });
    this.promptEntry = committed;
    try {
      // Defense in depth: under 0.80.5 `isStreaming` stays true for the whole agent run, including
      // retry/auto-compaction windows. A prompt landing in one of those windows now queues as a
      // follow-up instead of hitting pi's "Agent is already processing" rejection — the message runs
      // as a continuation rather than being lost. Strictly better desync defense than before.
      await session.prompt(text, {
        ...(images.length > 0 ? { images } : {}),
        ...(session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
        // pi calls this synchronously right before `_runAgentPrompt`, after every `before_agent_start`
        // handler, and a throw rejects `prompt()` before the run exists. Its `abort()` before then is a no-op.
        preflightResult: (disposition) => {
          if (disposition === "started" && (this.abortEpoch !== abortEpoch || this.runtime?.session !== session)) {
            throw new StoppedBeforeRunError();
          }
          committed.preflightResult(disposition);
        },
      });
      // An extension slash command (e.g. `/todos`) is handled synchronously inside prompt() and starts
      // no agent run, so no terminal event settles the turn — the spinner would hang. Under 0.80.5
      // prompt() resolves only when the run is fully settled, so `isStreaming` is reliably false here
      // for a slash command that started no run. When prompt() resolved without an observed run and the
      // agent isn't streaming, release the turn ourselves.
      if (!this._aborting && !session.isStreaming && !this.adapter.observedAgentRun()) {
        this.adapter.endTurnWithoutAgentRun();
      }
      // A slash command was expanded to its body before persisting — pi expands prompt templates inside
      // prompt(), chat-handlers rewrites skills/`/init` before sendMessage — so the on-disk user message
      // no longer matches what the user typed. Record the original typed text as an inert sidecar keyed
      // to the pi user entry so reload/up-arrow/preview can restore it.
      const entry = committed.entry();
      if (userBroadcast && entry) this.recordOriginalInputIfDiverged(session, userBroadcast.content, entry);
      // The turn completed (prompt resolves once the run has settled). After the first real turn, auto-title the
      // session (US-012). Fire-and-forget so it never blocks the next interaction.
      void this.maybeGenerateTitle();
      // Record the completed exchange as a memory extraction candidate so the consolidation passes have
      // something to extract from (and the idle timer arms). Symmetric with the harvesters above.
      if (userBroadcast && entry) this.enqueueMemoryCandidate(session, entry.id);
    } catch (err) {
      if (err instanceof StoppedBeforeRunError) {
        outcome = { kind: "cancelled" };
        this.returnUnsentMessage(correlationId, userBroadcast);
      } else if (this._aborting) {
        // A user abort rejects prompt(); interrupt()/cancel() already emitted sessionCancelled + idle,
        // so swallow the rejection here rather than stacking a spurious error card on top of it.
        outcome = { kind: "cancelled" };
        log("[PiSession] prompt aborted by user");
      } else {
        log("[PiSession] prompt failed: %O", err);
        const message = err instanceof Error ? err.message : String(err);
        outcome = turnOutcomeOfError(message);
        this.emit({ type: "error", message });
        this.emit({ type: "processing", isProcessing: false });
      }
    } finally {
      committed.dispose();
      if (this.promptEntry === committed) this.promptEntry = null;
      this.processingFlag = false;
      this.inFlightPromptIndex = null;
      // The turn is over however it ended. A rejection that never reached an agent run emits no pi
      // event, so without this the lifecycle would stay `running` with nothing left to move it.
      this.setTurnState("idle", outcome);
      this._aborting = false;
      this._budgetStopRequested = false;
    }
  }

  /** A message cancelled or orphaned before its turn started never reached the model, so it goes back
   *  to the composer. */
  private returnUnsentMessage(correlationId: string | undefined, userBroadcast: { content: string } | undefined): void {
    log("[PiSession] message not sent: cancelled or session replaced before its turn started");
    this.emit({ type: "processing", isProcessing: false });
    if (correlationId && userBroadcast) this.emit({ type: "interruptRecovery", correlationId, promptContent: userBroadcast.content });
  }

  /**
   * Append one hidden results message for background results no turn delivered: live records on every
   * prompt, agent files after a stored session is bound until a scan reads every candidate. Never throws.
   * Resolves false when live results may still be owed, so the interruption notice must not run yet.
   */
  private async deliverUndeliveredResults(session: AgentSession): Promise<boolean> {
    const mgr = this.subagentManager;
    const scanFiles = this.undeliveredScanPending;
    const retryNotice = (): void =>
      this.emit({
        type: "notification",
        message: t("Could not deliver the results of finished background subagents; they will be retried with your next message."),
        notificationType: "warning",
      });
    let cold: UndeliveredFileResult[] = [];
    let scanComplete = false;
    if (scanFiles) {
      try {
        const scan = await collectUndeliveredFromFiles({
          branch: session.sessionManager.getBranch(),
          subagentDir: subagentsDir(ensurePiSessionDir(this.cwd), session.sessionId),
          isLive: (id) => mgr?.getRecord(id) !== undefined,
        });
        cold = scan.results;
        scanComplete = !scan.incomplete;
      } catch (err) {
        log("[PiSession] scanning agent files for undelivered subagent results failed: %O", err);
      }
      if (!scanComplete) retryNotice();
    }
    let refused = false;
    try {
      await deliverUndeliveredResults({
        live: mgr?.deliverableLive() ?? [],
        cold,
        delivered: () => deliveredBackgroundResults(subagentBranchIndex(session.sessionManager.getBranch())),
        send: async (message) => {
          // A replaced session's file may already be deleted, and an append would recreate it header-less.
          // A streaming session defers the message to its settle, after that settle's keep-alive read D.
          if (this.runtime?.session !== session || session.isStreaming) {
            refused = true;
            return false;
          }
          await session.sendCustomMessage(message, { triggerTurn: false });
          return true;
        },
      });
    } catch (err) {
      log("[PiSession] delivering undelivered subagent results failed: %O", err);
      retryNotice();
      return false;
    }
    if (refused) return false;
    if (scanComplete && this.runtime?.session === session) this.undeliveredScanPending = false;
    return true;
  }

  /** Append the hidden interruption notice when one is pending. Never throws. */
  private async reconcileInterruptionsIfPending(session: AgentSession): Promise<void> {
    if (!this.interruptionCheckPending) return;
    this.interruptionCheckPending = false;
    try {
      await reconcileInterruptions({
        branch: session.sessionManager.getBranch(),
        subagentDir: subagentsDir(ensurePiSessionDir(this.cwd), session.sessionId),
        liveSubagent: (id) => this.subagentManager?.liveStatus(id),
        teamStop: (teamId) => new TeamPersistence(this.cwd, session.sessionId).resumableStop(teamId),
        // A replaced session's file may already be deleted, and an append would recreate it header-less.
        send: async (message) => {
          if (this.runtime?.session !== session) return;
          await session.sendCustomMessage(message, { triggerTurn: false });
        },
      });
    } catch (err) {
      log("[PiSession] interruption notice failed: %O", err);
      this.emit({
        type: "notification",
        message: t("Could not record which agents were interrupted; the model will not be told it can resume them."),
        notificationType: "warning",
      });
    }
  }

  /**
   * Queue a mid-turn message. All messages queued before the next agent boundary are combined into ONE
   * steer (US): screened by pi's input handlers once (`screenQueuedInputs`), then held in
   * `queuedInputs` and re-steered as a single combined prompt each time one is admitted
   * (clearing the prior steer so pi holds exactly one). pi injects the combined prompt at its next turn
   * boundary, redirecting the agent mid-task. Returns 'queued' so the webview shows a pending chip per
   * message; the chips collapse into the combined message once the adapter sees pi deliver it.
   */
  queueInput(content: ContentInput, messageId?: string): "queued" | "flushed" | false {
    const session = this.runtime?.session;
    // Gate on pi's own streaming state, not `processingFlag`: the two can momentarily disagree. Under
    // 0.80.5 `isStreaming` also stays true across retry/compaction windows, so input is now accepted
    // during those (desirable — pi steers at the next boundary); the disagreement window is narrower.
    // A queue routed to a non-streaming session must still be refused so the caller can fall back.
    // Refused after a budget stop too, even though the run is still streaming: pi's settle boundary
    // continues on a non-empty queue whatever the decider answers, so accepting one bills a round trip
    // past a hard limit (the same hazard `stopForBudget` flushes the existing queue for).
    if (!session || !session.isStreaming || this._budgetStopRequested) return false;
    this.screeningInputs.push({
      id: messageId ?? `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text: extractText(content),
      images: extractImages(content),
      content,
    });
    this.screenQueuedInputs();
    return "queued";
  }

  /**
   * Run pi's input handlers, a UserPromptSubmit hook among them, on each queued message once, as it is
   * queued and oldest first, the way a typed prompt gets them. A message a handler consumes, which is
   * what a hook's block is, loses its chip, and the hook has already posted its reason; the rest join
   * `queuedInputs` with any rewrite applied. The combined re-steer is sent as `source: 'extension'`, so
   * no hook sees a message twice or judges one by the messages around it. With no input handler loaded
   * this admits synchronously, so the first re-steer still starts before `queueInput` returns.
   */
  private screenQueuedInputs(): void {
    if (this.screeningRunning) return;
    this.screeningRunning = true;
    void (async () => {
      try {
        for (let input = this.screeningInputs[0]; input; input = this.screeningInputs[0]) {
          const runner = this.runtime?.session.extensionRunner;
          let verdict: InputEventResult = { action: "continue" };
          if (runner?.hasHandlers("input")) {
            try {
              verdict = await runner.emitInput(input.text, input.images.length > 0 ? input.images : undefined, "interactive", "steer");
            } catch (err) {
              log("[PiSession] input handlers failed on a queued message: %O", err);
            }
          }
          // A stop or a session replacement took it back while the handlers ran.
          if (this.screeningInputs[0] !== input) continue;
          this.screeningInputs.shift();
          if (verdict.action === "handled") {
            this.emit({ type: "queueCancelled", messageId: input.id });
            continue;
          }
          if (verdict.action === "transform") {
            input.text = verdict.text;
            input.images = verdict.images ?? input.images;
          }
          this.queuedInputs.push(input);
          this.resteerQueuedInputs();
        }
      } finally {
        this.screeningRunning = false;
      }
    })();
  }

  /**
   * Re-steer the whole queued buffer as one combined message. Passes run one at a time, and a request
   * while one runs asks it for one more pass, which reads the buffer as it is then: a pass awaits pi's
   * input handlers, and two passes in flight at once would both land a batch in pi's queue.
   */
  private resteerQueuedInputs(): void {
    if (this.resteerRunning) {
      this.resteerRequested = true;
      return;
    }
    this.resteerRunning = true;
    void (async () => {
      do {
        this.resteerRequested = false;
        const session = this.runtime?.session;
        if (session) {
          await this.resteerOnce(session).catch((err) => {
            if (!(err instanceof WithdrawnSteerError)) log("[PiSession] steered prompt failed: %O", err);
          });
        }
      } while (this.resteerRequested);
      this.resteerRunning = false;
    })();
  }

  /**
   * One re-steer pass. `clearQueue()` drops the previously steered (not-yet-delivered) combination so pi
   * never holds stale copies, and every other queued message with it, so cancel notes and follow-ups
   * are put back. Routed through prompt() (not raw steer()) so slash-command/skill handling and images
   * survive — the raw queue methods throw on `/`-prefixed input and would drop it silently.
   *
   * Cancel notes go back first, in the order pi held them, then the batch, each awaited so pi's queue
   * holds exactly this order whatever its input handlers await. pi delivers every pending steer at the
   * next boundary (`withQueuePolicy`), so that request carries the annotated result, the note, then the batch.
   */
  private async resteerOnce(session: AgentSession): Promise<void> {
    if (this.queuedInputs.length === 0) return;
    const { steering, followUp } = session.clearQueue();
    this.steeredCount = null;
    const notes = this.heldNotes(steering);
    const batch = [...this.queuedInputs];
    const text = batch.map((q) => q.text).join("\n\n");
    const images = batch.flatMap((q) => q.images);
    // Re-queued the way they were queued, not through `followUp()` or `steer()`: those run the
    // extension-command check and the skill and template expansion, which would execute or rewrite
    // literal text.
    for (const queued of followUp) {
      void session
        .sendUserMessage(queued, { deliverAs: "followUp", expandPromptTemplates: false })
        .catch((err) => log("[PiSession] re-queueing a preserved follow-up failed: %O", err));
    }
    for (const note of notes) {
      if (this.batchWithdrawn(session, batch)) return;
      await session
        .sendUserMessage(note, { deliverAs: "steer", expandPromptTemplates: false })
        .catch((err) => log("[PiSession] re-queueing a cancel note failed: %O", err));
    }
    // A prompt made while pi settles the ended run is deferred into that settle, where a veto would throw.
    if (!session.isStreaming) await session.waitForIdle();
    if (this.batchWithdrawn(session, batch)) return;
    await session.prompt(text, {
      streamingBehavior: "steer",
      // Every message in it already passed the input handlers when it was queued.
      source: "extension",
      ...(images.length > 0 ? { images } : {}),
      preflightResult: (disposition) => this.admitSteer(session, batch, disposition),
    });
  }

  /**
   * pi's last word before a steered batch takes effect, after every input and `before_agent_start`
   * handler, whatever their order and whichever extension registered them: it calls `preflightResult`
   * synchronously right after queueing the batch into the running run (`queued`), right before opening
   * a run with it when the run ended while those handlers ran (`started`), or once an extension command
   * or input handler consumed it (`handled`), which queues and runs nothing. A batch a stop withdrew
   * meanwhile is taken back out of the queue, or refused by throwing, which `prompt()` propagates
   * before `_runAgentPrompt` starts the run.
   */
  private admitSteer(session: AgentSession, batch: readonly QueuedInput[], disposition: PromptDisposition): void {
    const opensRun = disposition === "started";
    if (this.batchWithdrawn(session, batch)) {
      if (opensRun || (disposition === "queued" && this.runStopped())) session.clearQueue();
      if (opensRun) throw new WithdrawnSteerError();
      return;
    }
    if (disposition === "handled") {
      this.queuedInputs.splice(0, batch.length);
      this.steeredCount = null;
      for (const { id } of batch) this.emit({ type: "queueCancelled", messageId: id });
      return;
    }
    this.steeredCount = batch.length;
    // No `sendMessage` opened this run, so nothing else marks the session working while it streams.
    if (opensRun) this.adapter.beginTurn();
  }

  /** Whether an ESC, a budget stop or a session replacement took `batch` back while it was being steered. */
  private batchWithdrawn(session: AgentSession, batch: readonly QueuedInput[]): boolean {
    return this.runtime?.session !== session || batch.some((queued, i) => this.queuedInputs[i] !== queued);
  }

  /** The cancel notes among pi's undelivered steers, matched one for one so a batch whose text equals a note stays a batch. */
  private heldNotes(steering: readonly string[]): string[] {
    const listed = this.injectedNotes.map((note) => note.text);
    return steering.filter((text) => {
      const index = listed.indexOf(text);
      if (index === -1) return false;
      listed.splice(index, 1);
      return true;
    });
  }

  /**
   * Called by the adapter for every user message pi delivers, a run's opening prompt included. When
   * it is the held buffer, collapse its chips into the single combined message and clear the buffer;
   * further queueing starts a fresh combination. Returns whether the delivery was Damocles's own, a
   * batch or a cancel note, and so is owed a mid-stream marker.
   */
  onQueuedInputsDelivered(deliveredText: string): boolean {
    // A cancel note is queued straight onto the pi session, so its delivery raises the same event a
    // steered batch does, and so does the opening prompt of a run a note started. Matching on the text
    // is exact because the note is sent with template expansion off, and it is order-independent, so a
    // batch delivered first cannot consume the note's signal.
    const injected = this.injectedNotes.findIndex((note) => note.text === deliveredText);
    if (injected !== -1) {
      this.injectedNotes.splice(injected, 1);
      return true;
    }
    if (this.queuedInputs.length === 0) return false;
    // Inputs queued after the delivered batch was steered stay held for the re-steer they requested.
    const delivered = this.queuedInputs.splice(0, this.steeredCount ?? this.queuedInputs.length);
    this.steeredCount = null;
    const messageIds = delivered.map((q) => q.id);
    const combinedContent = delivered.map((q) => q.text).join("\n\n");
    const blocks = delivered.flatMap((q) => (typeof q.content === "string" ? [] : q.content));
    this.emit({
      type: "queueBatchProcessed",
      messageIds,
      combinedContent,
      ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
    });
    // The adapter resolves the committed entry id at the next assistant message_start (the delivery
    // event fires before pi persists the entry) and calls back into recordMidStreamMarker.
    return true;
  }

  /**
   * Persist a mid-stream marker keyed to the committed pi user entry id of a delivered queued batch or
   * cancel note, so the entry consumes no prompt index and a reloaded session re-applies the amber
   * "sent mid-stream" styling. Called by the adapter at the next assistant message_start — the first
   * point the delivered entry is committed to the tree (keying it at delivery time mis-keys to the
   * previous turn's entry). Fail-soft: a write error never breaks the turn.
   */
  recordMidStreamMarker(userEntryId: string): void {
    const session = this.runtime?.session;
    if (!session) return;
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_MID_STREAM_ENTRY, { userEntryId });
    } catch (err) {
      log("[PiSession] recordMidStream failed: %O", err);
    }
  }

  /**
   * Take back everything queued for a run an ESC or the budget stopped, since that run delivers nothing
   * more and pi's next run starts by draining whatever its queue still holds: pi's queue is cleared,
   * every chip goes back to the composer, and each note pi held is dropped with its echo corrected.
   */
  private withdrawQueue(session: AgentSession | undefined, noteDropped: string): void {
    this.steeredCount = null;
    const withdrawn = [...this.queuedInputs, ...this.screeningInputs];
    this.queuedInputs = [];
    this.screeningInputs = [];
    for (const { id } of withdrawn) this.emit({ type: "queueCancelled", messageId: id, returnToInput: true });
    session?.clearQueue();
    this.dropEchoedNotes(noteDropped);
  }

  /** Correct the echo of every accepted cancel note the agent never received, once the queue that held it is dropped. */
  private dropEchoedNotes(message: string): void {
    for (const note of this.injectedNotes) {
      if (note.echoed) this.emit({ type: "notification", message, notificationType: "warning" });
    }
    this.injectedNotes = this.injectedNotes.filter((note) => !note.echoed);
  }

  async interrupt(): Promise<void> {
    await this.beginAbort("interrupt");
  }

  cancel(): void {
    void this.beginAbort("cancel");
  }

  /** Stops one running shell call. The turn continues, so this must never reach `beginAbort`. */
  cancelToolCall(toolUseId: string, note?: string): boolean {
    const cancelled = this.shellCancel.cancel(toolUseId, note);
    if (!cancelled) log("[PiSession] cancelToolCall: no live shell call for %s", toolUseId);
    return cancelled;
  }

  /**
   * The panel session's cancel-note delivery, bound at the main `buildCustomTools` call site to the
   * session that call created, which is why a cancel arriving after `reset()` still reaches the
   * conversation that ran the command rather than the one that replaced it.
   *
   * The echo waits for pi to accept the note, because a `prompt()` that rejects outright, which is
   * what a session being replaced or torn down under a leftover call does, would otherwise have already
   * told the user the agent was told. Acceptance is also where the subagent and team contexts echo, so
   * all three mean the same thing by an echo, and it is the last point that is still synchronous enough
   * to keep the note next to the tool card it belongs to. Returning before the echo keeps the cancel
   * path synchronous for its caller. `isInjected` is what keeps a note the user never typed into the
   * composer out of the webview's prompt filter, and the mid-stream marker its committed entry gets
   * keeps it out of the prompt count and styles it the same way on reload. Subagents and team agents
   * echo through `subagentSteered` and `teamAgentUserMessage`, so only this context emits `userMessage`.
   *
   * A note accepted into the running run is moved ahead of a held chip batch (`resteerQueuedInputs`).
   * One accepted with no run in progress starts a run, opened as a turn here since no `sendMessage` did.
   * A note for a run that a budget stop or an ESC has stopped is never left queued, since that run
   * delivers nothing more and the next one must not receive it; the user is told instead of shown an echo.
   */
  private noteDeliveryForMain(session: () => AgentSession | undefined): (text: string) => void {
    const deliver = sessionNoteDelivery(session);
    return (text) => {
      const refused = this.noteRefusal(session());
      if (refused) {
        this.emit({ type: "notification", message: refused, notificationType: "warning" });
        return;
      }
      const promptIndex = this.currentPromptIndex;
      // Listed before pi can deliver it, so that delivery's user message_end is never read as the chip batch.
      const note: ListedNote = { text, echoed: false };
      this.injectedNotes.push(note);
      const unlist = (): void => {
        const listed = this.injectedNotes.indexOf(note);
        if (listed !== -1) this.injectedNotes.splice(listed, 1);
      };
      let accepted = false;
      const onPreflight = (disposition: PromptDisposition): void => {
        accepted = true;
        // An input handler consumed it, so pi never received it and no echo is owed.
        if (disposition === "handled") {
          unlist();
          return;
        }
        const startsRun = disposition === "started";
        const target = session();
        // A stop can land while pi runs its input handlers, after the queue this note just joined was cleared.
        const withdrawn = startsRun ? null : this.noteRefusal(target);
        if (withdrawn) {
          target?.clearQueue();
          unlist();
          this.emit({ type: "notification", message: withdrawn, notificationType: "warning" });
          return;
        }
        note.echoed = true;
        this.emit({ type: "userMessage", content: text, correlationId: randomUUID(), promptIndex, isInjected: true });
        if (startsRun) {
          this.adapter.beginTurn();
          return;
        }
        if (target && target === this.runtime?.session) this.resteerQueuedInputs();
      };
      void deliver(text, onPreflight).catch((err) => {
        if (!accepted) unlist();
        log("[PiSession] cancel note delivery to the panel session failed: %O", err);
      });
    };
  }

  /** Why a cancel note for `target` can no longer reach the agent, or null when it can. */
  private noteRefusal(target: AgentSession | undefined): string | null {
    if (target === undefined || target !== this.runtime?.session || !this.runStopped()) return null;
    return this._budgetStopRequested
      ? t("Your cancel note was not sent: the budget limit stopped this turn.")
      : t("Your cancel note was not sent: the turn was stopped.");
  }

  /** Whether the live run was stopped by the budget or an ESC and so must deliver nothing more from pi's queue. */
  private runStopped(): boolean {
    return this._budgetStopRequested || this.abortPromise !== null;
  }

  /** One subagent's cancel-note delivery, bound at the subagent `buildCustomTools` call site. */
  private noteDeliveryForSubagent(agentId: string): (text: string) => void {
    return subagentNoteDelivery((id, message) => this.steerSubagent(id, message), agentId);
  }

  /** One team agent's cancel-note delivery, bound at the team `buildCustomTools` call site. */
  private noteDeliveryForTeamAgent(ctx: AgentMcpContext): (text: string) => void {
    return teamAgentNoteDelivery(ctx.deliverUserNote, ctx.agentName);
  }

  /**
   * Tear down the in-flight turn. Emits `sessionCancelled` + idle immediately, then drives
   * `session.abort()` (which aborts the agent and waits for it to go idle). The abort promise is
   * tracked so the next `sendMessage` awaits it — a turn started before pi finished winding down would
   * otherwise hit pi's "Agent is already processing" rejection.
   *
   * Queued input is not sent later (`withdrawQueue`); a note pi held annotates a command in the turn
   * the user just stopped.
   */
  private beginAbort(origin: "interrupt" | "cancel"): Promise<void> {
    this.stopPromptBeforeRun();
    this._aborting = true;
    this.processingFlag = false;
    // An abort during a long tool with no model stream open produces no aborted assistant event, so
    // this is the only thing that tells the webview the turn is over.
    this.setTurnState("idle", { kind: "cancelled" });
    this._budgetStopRequested = false;
    const session = this.runtime?.session;
    const leafAtStop = session?.sessionManager.getLeafId() ?? null;
    const abandoned = this.adapter.markAborted();
    // Abort-everything: ESC kills foreground AND background subagents (Phase 5, FR-12).
    this.subagentManager?.abortAll("user");
    this.interruptionCheckPending = true;
    // ESC during a team aborts it; its `create_team` tool then returns the partial synthesis (US-024d).
    this.options.teamService?.cancelActiveTeam("user");
    this.withdrawQueue(session, t("Stopping the turn discarded your cancel note before the agent read it."));
    this.emit({ type: "sessionCancelled" });
    this.emit({ type: "processing", isProcessing: false });
    const pending = (async () => {
      try {
        await session?.abort();
      } catch (err) {
        log("[PiSession] %s abort failed: %O", origin, err);
      }
      // A cancel note a re-steer was putting back can land while the run winds down.
      if (session && this.runtime?.session === session) session.clearQueue();
      if (session) this.persistTurnStopped(session.sessionId, leafAtStop, abandoned);
    })();
    this.abortPromise = pending;
    void pending.finally(() => {
      if (this.abortPromise === pending) this.abortPromise = null;
    });
    return pending;
  }

  /**
   * Keep a prompt that has not opened its run yet from ever reaching the model. pi's `abort()` does
   * nothing until the run exists, so a prompt held in `before_agent_start` (the Always-loaded MCP wait)
   * is released here and refused by its `preflightResult` when the epoch moved.
   */
  private stopPromptBeforeRun(): void {
    this.abortEpoch++;
    this.mcpStartupWaitAbort?.abort();
  }

  async cancelAutoCompact(): Promise<void> {
    this.runtime?.session.abortCompaction();
  }

  /**
   * Manually compact the conversation (US-030). Gated to idle: if a turn is in flight we refuse rather
   * than abort it mid-stream (pi's `compact()` would abort the current op first). The adapter translates
   * pi's `compaction_start`/`compaction_end` events into the existing webview compaction messages.
   */
  async compact(instructions?: string): Promise<void> {
    if (this.processingFlag || this.compacting) {
      this.emit({ type: "notification", message: "Finish or stop the current turn before compacting.", notificationType: "warning" });
      return;
    }
    // Hold `compacting` across the whole operation so a sendMessage arriving mid-compaction is rejected
    // with the normal "already in progress" notice instead of racing into pi's raw "Agent is already
    // processing" error on the shared session.
    this.compacting = true;
    try {
      try {
        await this.ensureStarted();
      } catch (err) {
        this.emit({ type: "error", message: `pi failed to start: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      if (this.resetPromise) await this.resetPromise;
      if (this.abortPromise) await this.abortPromise;
      const session = this.runtime?.session;
      if (!session) {
        this.emit({ type: "error", message: "Failed to initialize pi session" });
        return;
      }
      const trimmed = instructions?.trim();
      try {
        await session.compact(trimmed && trimmed.length > 0 ? trimmed : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // pi emits `compaction_end` and then rethrows the same failure, so the adapter has usually
        // already put a card on screen for it. Only what the adapter left unreported belongs here.
        if (this.adapter.takeCompactionReported()) {
          log("[PiSession] compact outcome already reported by the adapter: %s", message);
        } else if (isNothingToCompact(message)) {
          log("[PiSession] compact skipped: nothing to compact (session too small)");
          this.emit({ type: "notification", message: "Nothing to compact yet — the conversation is too small.", notificationType: "info" });
        } else {
          log("[PiSession] compact failed: %O", err);
          this.emit({ type: "error", message });
        }
      }
    } finally {
      this.compacting = false;
    }
  }

  /** The `damocles.autoCompact` config, read live so a mid-session change applies on the next call. */
  private autoCompactConfig(): AutoCompactConfig {
    return this.options.platform.settings.get<AutoCompactConfig>("damocles.autoCompact", { enabled: false, triggerPercent: 80 }, this.options.settingsFolder);
  }

  /**
   * Apply the panel's auto-compaction preference to the shared pi settings manager (US-030). `enabled`
   * is written durably via `setCompactionEnabled` (it survives the settings manager's frequent `save()`
   * rebuilds and defeats pi's default-on), and the model-dependent `reserveTokens` is refreshed from the
   * configured trigger percent. Called on bind and on the config-change handler.
   */
  private applyCompactionConfig(): void {
    if (this.folder === null) return;
    const sm = this.folder.services.settingsManager;
    const cfg = this.autoCompactConfig();
    sm.setCompactionEnabled(cfg.enabled);
    if (cfg.enabled) this.refreshCompactionReserve(cfg);
  }

  /**
   * Apply `damocles.cacheWarming` to the shared pi settings manager. pi's `CacheWarmer` reads the mode
   * through `getCacheWarmingMode()`, which reads `globalSettings.cacheWarming`. That is a different
   * field from the one `applyOverrides` writes, so only `setCacheWarmingMode` has any effect here.
   */
  private applyCacheWarmingConfig(): void {
    if (this.folder === null) return;
    const sm = this.folder.services.settingsManager;
    sm.setCacheWarmingMode(cacheWarmingSetting());
  }

  /**
   * Refresh pi's compaction `reserveTokens` for the current model. pi auto-compacts when
   * `contextTokens > contextWindow − reserveTokens`, so a trigger at N% means reserving the remaining
   * (100−N)% of the window. Applied via `applyOverrides` (effective-only); re-applied at each turn start
   * because the model — and thus the window — can change, and a settings `save()` can drop the override.
   * The settingsManager is process-wide, so panels on different models last-writer-win on this override;
   * that is intentional and harmless precisely because each panel re-asserts its own value at turn start.
   */
  private refreshCompactionReserve(cfg = this.autoCompactConfig()): void {
    if (!cfg.enabled || this.folder === null) return;
    const sm = this.folder.services.settingsManager;
    const budget = resolveCompactionBudget(cfg, this.modelValue, this.contextWindowForCurrentModel());
    sm.applyOverrides({
      compaction: {
        enabled: true,
        reserveTokens: budget.reserveTokens,
        // Omitted when unset so pi's own keepRecentTokens default stands.
        ...(budget.keepRecentTokens !== undefined ? { keepRecentTokens: budget.keepRecentTokens } : {}),
      },
    });
  }

  /** Read per call, never cached, so a settings edit lands without a reload. The shared manager is right
   *  in every context: the per-subagent one is seeded from the same settings and overrides `compaction`. */
  private shellOptions(): ShellOptions {
    const sm = this.folder?.services.settingsManager;
    const commandPrefix = sm?.getShellCommandPrefix();
    const shellPath = sm?.getShellPath();
    return {
      ...(commandPrefix !== undefined ? { commandPrefix } : {}),
      ...(shellPath !== undefined ? { shellPath } : {}),
    };
  }

  reset(): void {
    this.stopPromptBeforeRun();
    this.processingFlag = false;
    // The replacement session disposes the old one, which aborts whatever turn it was running.
    this.setTurnState("idle", { kind: "cancelled" });
    this._budgetStopRequested = false;
    this.queuedInputs = [];
    this.screeningInputs = [];
    this.steeredCount = null;
    // The replaced session takes its undelivered notes with it, so nothing here can shadow a later batch.
    this.injectedNotes = [];
    // Kill any in-flight subagents and drop their completed records so a fresh session starts clean.
    this.subagentManager?.abortAll("reset");
    this.subagentManager?.clearCompleted();
    // A context clear with a team running aborts it (its create_team tool returns the partial synthesis).
    this.options.teamService?.cancelActiveTeam("reset");
    // The aborted agents above never close their own tabs (only success does), and their scopes are
    // dropped as they settle — so reclaim every tab this conversation opened before starting the next.
    this.releaseBrowserScopes();
    // newSession() zeroes the parent session's cost; reset the adapter baselines to match so the budget
    // meter doesn't carry stale subagent/parent dollars across the context clear.
    this.adapter.resetCostBaseline();
    // A fresh session must not re-open a prior resume target, and is eligible for a new AI title. The
    // fork target is retired the same way — otherwise `pendingSessionId` keeps naming a branch this
    // panel has let go of, and after a detach that means reporting a session id whose file is gone.
    this.resumeSessionId = null;
    if (this.options.forkContext) this.options.forkContext.consumed = true;
    this.syncSessionLeases();
    this.titleGenerationAttempted = false;
    // The continuation session computes its own plan path from its own first message (clear-context).
    this._firstUserMessage = null;
    // A fresh session reads the now-current tool set on build, so any deferred MCP reload is moot.
    this.mcpReloadPendingAfterTurn = false;
    const runtime = this.runtime;
    if (!runtime) {
      // The dropped resume or fork target was the stored session id; with a runtime, the rebind republishes.
      this.publishSessionState();
      return;
    }
    // newSession() disposes the old AgentSession (which aborts any in-flight turn) and installs a
    // fresh idle one via setRebindSession. Track the promise so a sendMessage that follows
    // synchronously (plan "clear context & start fresh") waits for the fresh session.
    //
    // Chain off any in-flight replacement so two rapid reset()/clear() calls run newSession()
    // serially, not concurrently — concurrent replacements interleave the rebind callbacks and can
    // leave registeredSessionId on an intermediate session / double-register panels. Also chain off any
    // in-flight MCP reload so newSession() can't dispose the session under a live session.reload().
    const priorReload = this.mcpReloadPromise;
    // The turn is stopped before the drain, so no tool runs after the reset, and its settle queues the
    // turn's finalize, which lands only while the old session is still installed.
    const checkpoints = this.checkpointService;
    // Destructive work is sequenced off `whenReplaced()`, so this promise must report reality: a
    // replacement that threw, or that a `session_before_switch` handler cancelled, leaves the OLD
    // session installed and still able to write. Swallowing that here would let a caller delete the
    // file out from under a live writer. The prior attempt is chained off for serialization only —
    // `.catch` before it so one failure doesn't poison every later reset.
    const replacement = (this.resetPromise ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => (priorReload ? priorReload.catch(() => undefined) : undefined))
      .then(() => runtime.session.abort())
      .then(() => checkpoints?.drain(CHECKPOINT_DRAIN_MS))
      .then(() => runtime.newSession())
      .then(({ cancelled }) => {
        if (cancelled) throw new Error("session replacement was cancelled");
      });
    // Logging hangs off a SEPARATE handle, so the rejection stays observable to `whenReplaced()`
    // callers while never surfacing as an unhandled rejection when nobody awaits it.
    replacement.catch((err) => log("[PiSession] reset newSession failed: %O", err));
    this.resetPromise = replacement;
  }

  clear(): void {
    this.reset();
  }

  /** Resolve once any in-flight session replacement (reset/clear → newSession) has finished, so the
   *  old AgentSession is disposed and can no longer append. Resolved immediately when none is pending. */
  whenReplaced(): Promise<void> {
    return this.resetPromise ?? Promise.resolve();
  }

  dispose(): Promise<void> {
    const disposal = this.runDispose();
    this.disposal = disposal;
    return disposal;
  }

  private async runDispose(): Promise<void> {
    this._disposed = true;
    this.mcpStartupWaitAbort?.abort();
    // Closing the handle is what kills whatever this panel's shells left running: the job object's
    // kill-on-close on Windows, the EOF the sentinel is waiting for on POSIX.
    this.shellJob?.dispose();
    // After the job, so a still-registered call has already had its process killed; a tool whose promise
    // never settles would otherwise leave this session reachable through the entry's delivery closure.
    this.shellCancel.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unpersistedImages.clear();
    // The adapter outlives every session replacement, so its timers are released here and not in
    // bindSession's unsubscribe, which fires on a mere rebind.
    this.adapter.dispose();
    // Both listeners close over this session, so a prompt map outliving the panel (the handler is
    // supplied by the caller) would keep publishing into a webview that is gone.
    this.options.permissionHandler.setPendingPromptsListener(null);
    this.uiContext.setPendingChangedListener(null);
    this.options.permissionHandler.setPromptOwnerResolver(null);
    this.options.teamService?.setRunListener(null);
    this.activityListener = null;
    this.turnSettledListener = null;
    this.uiContext.cancelAll();
    // Tear down any active team (aborts its agents + resolves the create_team tool) — the service is
    // owned by the panel, so the panel disposes it.
    this.options.teamService?.dispose();
    // Tear down the subagent engine: abort + dispose all nested sessions; unsubscribe from the shared
    // folder registry (which is owned by FolderRuntime and shared across panels — never disposed here).
    this.subagentManager?.dispose();
    this.subagentManager = null;
    this.agentRegistry = null;
    this._agentsUnsub?.();
    this._agentsUnsub = null;
    this._configUnsub?.dispose();
    this._configUnsub = null;
    // Abort any in-flight `/btw` asides. They run as direct `createSubagentSession`s on the folder
    // runtime (not this.runtime, not the AgentManager), so nothing above reaches
    // them — without this they keep streaming their model call until full extension shutdown.
    if (this.btwSessions.size > 0) {
      const folder = this.requireFolder();
      for (const { session, ac } of this.btwSessions.values()) {
        ac.abort();
        void session.abort().catch(() => {});
        folder.forgetSubagentSession(session);
      }
      this.btwSessions.clear();
    }
    // Stopped while the panel is still registered, so a tool call the turn makes meanwhile reaches this
    // panel's gate instead of the unregistered fallback, and the turn's settle queues its finalize.
    try {
      await this.runtime?.session.abort();
    } catch (err) {
      log("[PiSession] aborting the turn on dispose failed: %O", err);
    }
    // The last turn's record lands only while the runtime is still up and the service registered.
    await this.checkpointService?.drain(CHECKPOINT_DRAIN_MS);
    // Unregistered before the runtime is disposed, so no new hook can look the checkpoint service up; the
    // runtime emits `session_shutdown` to the extension runner, and a handler on that still needs a live
    // checkpoint service, so the service is only torn down after.
    if (this.registeredSessionId) {
      this.unregisterFromRuntime(this.requireFolder(), this.registeredSessionId);
      this.registeredSessionId = null;
    }
    try {
      // The runtime owns the AgentSession it created via the factory and disposes it here; the
      // session was never registered with the folder runtime (createSession), so there is nothing to forget.
      await this.runtime?.dispose();
    } catch (err) {
      log("[PiSession] dispose failed: %O", err);
    }
    this.runtime = null;
    // After the runtime's teardown, which can still append the aborted turn to the file.
    this.syncSessionLeases();
    this.checkpointService?.dispose();
    this.checkpointService = null;
    this.releaseBrowserScopes();
  }

  /** Reclaim every browser tab scope this session handed out, closing the tabs failed agents left open
   *  for inspection. Runs when the conversation ends (dispose) or is replaced (reset/clear). */
  private releaseBrowserScopes(): void {
    const browser = this.options.browserService;
    for (const scopeId of this.ownedBrowserScopes) browser?.discardScope(scopeId);
    this.ownedBrowserScopes.clear();
  }

  /** The user's stop of one subagent, foreground or background; the turn goes on. The record's completion is
   *  the authoritative card and task outcome, so the caller posts none. It requests no interruption notice:
   *  the agent's result already carries the stop note and resume call. */
  stopSubagent(agentId: string): boolean {
    return this.subagentManager?.abort(agentId, "user") ?? false;
  }

  /** Running + queued subagents, then live team members, for the `/steer` second-stage picker. */
  listSteerTargets(): SteerTargetInfo[] {
    return [...(this.subagentManager?.listActive() ?? []), ...(this.options.teamService?.listSteerTargets() ?? [])];
  }

  /**
   * The user's `/steer` path: a subagent first, then a live team member. `steerSubagent` stays
   * subagent-only because the shell-cancel note path and the `SteerSubagent` tool rely on that.
   */
  async steerTarget(agentId: string, rawMessage: string, images: ImageBlock[] | undefined, requestId: string): Promise<void> {
    const message = rawMessage.trim();
    // `images` is unvalidated webview input: a malformed payload fails visibly and delivers nothing.
    const parsedImages = images === undefined ? undefined : parseSteerImages(images);
    if (parsedImages === null) {
      this.emit({ type: "subagentSteered", agentId, toolUseId: null, message, requestId, status: 'failed' });
      return;
    }
    const steerImages = parsedImages?.length ? parsedImages : undefined;
    if (!message && !steerImages) return;
    const outcome = this.subagentManager?.getRecord(agentId) ? null : this.options.teamService?.steerMember(agentId, message, steerImages);
    if (!outcome) {
      await this.steerSubagent(agentId, message, steerImages, requestId);
      return;
    }
    const description = `${outcome.teamTitle} · ${outcome.memberName}`;
    this.emit({
      type: "subagentSteered",
      agentId,
      toolUseId: null,
      description,
      message,
      requestId,
      ...(steerImages && outcome.status === 'steered' ? { images: steerImages } : {}),
      status: outcome.status,
      team: { teamId: outcome.teamId, teamTitle: outcome.teamTitle, memberName: outcome.memberName, role: outcome.role },
    });
    if (outcome.status !== 'steered') return;
    const session = this.runtime?.session;
    if (!session) return;
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_STEER_ENTRY, { agentId, description, message, ...(steerImages ? { images: steerImages } : {}) });
    } catch (err) {
      log("[PiSession] recordSteer failed: %O", err);
    }
  }

  /** Deliver a user-typed `/steer <id> [message]`, with any pasted images, directly to a running/queued subagent (no model turn).
   *  Emits `subagentSteered` so the webview can echo the amber chip + overlay user message. The emission
   *  lives here (not in AgentManager) because the chip is a USER-action echo — the model's SteerSubagent
   *  tool must never produce chips. On a delivered/queued steer, records it on the subagent's `userSteers`
   *  so the parent becomes aware when it consumes the result. */
  async steerSubagent(agentId: string, message: string, images?: ImageBlock[], requestId?: string): Promise<void> {
    // A steer with neither text nor images carries no instruction and would persist a marker `isSteerData`
    // rejects on reload; the webview already blocks it, so this is a boundary guard, not a user-facing error path.
    if (!message.trim() && !images?.length) return;
    const status = (await this.subagentManager?.steer(agentId, message, images)) ?? 'not-found';
    const record = this.subagentManager?.getRecord(agentId);
    const delivered = status === 'steered' || status === 'queued';
    const imageFields = delivered && images?.length ? { images } : {};
    this.emit({
      type: "subagentSteered",
      agentId,
      toolUseId: record?.toolCallId ?? null,
      ...(record?.type ? { agentType: record.type } : {}),
      ...(record?.description ? { description: record.description } : {}),
      message,
      ...imageFields,
      ...(requestId ? { requestId } : {}),
      status,
    });
    if (delivered && record) {
      (record.userSteers ??= []).push({ message, ...(images?.length ? { imageCount: images.length } : {}) });
      // Persist a standalone marker so a reloaded session replays the amber "You steered" chip in place.
      // Fail-soft, mirroring recordMidStreamMarker: a write error must never break the steer.
      const session = this.runtime?.session;
      if (session) {
        try {
          session.sessionManager.appendCustomEntry(DAMOCLES_STEER_ENTRY, {
            agentId,
            ...(record.type ? { agentType: record.type } : {}),
            ...(record.description ? { description: record.description } : {}),
            message,
            ...imageFields,
          });
        } catch (err) {
          log("[PiSession] recordSteer failed: %O", err);
        }
      }
    }
  }

  // ---- model --------------------------------------------------------------

  setModel(model?: string): void {
    if (!model) return;
    const piRuntime = PiRuntime.get();
    const modelRuntime = piRuntime.modelRuntime;
    if (!modelRuntime || !this.runtime) return;
    const resolution = resolvePiModel(model, modelRuntime, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
    if (resolution.authRequired) {
      this.emit({ type: "openaiAuthRequired", modelValue: model });
      return;
    }
    if (!resolution.model) {
      const info = this.getModelInfo(model);
      if (info?.piProvider) {  // catalog-known custom provider, just not keyed (StepFun pre-key)
        this.emit({ type: "notification", message: `Sign in to ${providerDisplayName(info)} to use ${model}`, notificationType: "warning" });
        return;
      }
      this.emit({ type: "notification", message: `Model ${model} is unavailable on the pi harness`, notificationType: "error" });
      return;
    }
    if (resolution.authed === false) {
      const info = this.getModelInfo(model);
      this.emit({ type: "notification", message: `Sign in to ${providerDisplayName(info)} to use ${model}`, notificationType: "warning" });
      return;
    }
    // Only commit the active model after the switch is known to succeed — every early return above
    // leaves `modelValue` (and everything derived from it) pointing at the still-current model.
    this.modelValue = model;
    this.desiredModel = resolution.model;
    // The account state is derived from the model, so it is stale until the new one is published.
    this.publishAccountInfo();
    void this.runtime.session.setModel(resolution.model).catch((err) => log("[PiSession] setModel failed: %O", err));
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    await this.ensureStarted().catch(() => undefined);
    return this.supportedModelsCache;
  }

  /**
   * Surface the agent-invocable slash commands the pi resource loader discovered (US-015/016): prompt
   * templates (incl. `.claude/commands` compat) and skills (as `skill:<name>`). pi's builtin TUI
   * commands are intentionally excluded — the webview already owns `BUILTIN_SLASH_COMMANDS`. Names are
   * de-duped, first wins, so a discovered command that shadows a builtin name doesn't double-list.
   */
  async getSupportedCommands(): Promise<SlashCommandInfo[]> {
    await this.ensureStarted().catch(() => undefined);
    const loader = this.folder?.services.resourceLoader;
    if (!loader) return [];

    const commands: SlashCommandInfo[] = [];
    const seen = new Set<string>();
    const add = (name: string, description?: string, argumentHint?: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      commands.push({ name, description: description ?? "", argumentHint: argumentHint ?? "" });
    };

    try {
      for (const prompt of loader.getPrompts().prompts) add(prompt.name, prompt.description, prompt.argumentHint);
    } catch (err) {
      log("[PiSession] getSupportedCommands: prompts read failed: %O", err);
    }
    try {
      for (const skill of loader.getSkills().skills) add(`skill:${skill.name}`, skill.description);
    } catch (err) {
      log("[PiSession] getSupportedCommands: skills read failed: %O", err);
    }
    return commands;
  }

  getModelInfo(model?: string): ModelInfo | undefined {
    const value = model ?? this.modelValue;
    return this.supportedModelsCache.find((m) => m.value === value);
  }

  get currentModel(): string | null {
    return this.modelValue || null;
  }

  // ---- session identity / state ------------------------------------------

  get currentSessionId(): string | null {
    // Before start() runs (a resumed or forked panel runs it after opening, not at once), report the
    // pending resume/fork target so session-scoped reads (rewind history, open-log, delete) resolve
    // the right session. After start() the live session id equals it.
    return this.runtime?.session.sessionId ?? this.pendingSessionId;
  }

  /** The resume/fork target a not-yet-started panel will open, or null. */
  private get pendingSessionId(): string | null {
    if (this.resumeSessionId) return this.resumeSessionId;
    const fork = this.options.forkContext;
    if (fork && !fork.consumed && fork.piBranchedSessionId) return fork.piBranchedSessionId;
    return null;
  }

  get persistenceSessionId(): string | null {
    return this.currentSessionId;
  }

  unpersistedToolResultImages(toolCallId: string): readonly ImageBlock[] | undefined {
    return this.unpersistedImages.get(toolCallId);
  }

  holdsSession(sessionId: string): boolean {
    // `resumeSessionId` also names the target of a switch still in flight, while `currentSessionId`
    // reports the session being left until the switch lands.
    return this.currentSessionId === sessionId || this.resumeSessionId === sessionId;
  }

  hasSessionFile(): boolean {
    const file = this.runtime?.session.sessionManager.getSessionFile();
    return file !== undefined && existsSync(file);
  }

  private announceSessionId(sessionId: string): void {
    const stored = this.hasSessionFile();
    this.announcedStoredId = stored ? sessionId : null;
    this.options.onSessionIdChange?.(sessionId, stored);
  }

  /** pi writes a new conversation's file when it commits the first prompt, which a turn ending always follows. */
  private announceIfNewlyStored(): void {
    const sessionId = this.runtime?.session.sessionId;
    if (!sessionId || this.announcedStoredId === sessionId || !this.hasSessionFile()) return;
    this.announcedStoredId = sessionId;
    this.emit({ type: "sessionStarted", sessionId, stored: true });
    this.publishSessionState();
  }

  get storedSessionId(): string | null {
    if (!this.runtime) return this.pendingSessionId;
    const sessionId = this.runtime.session.sessionId;
    return this.announcedStoredId === sessionId ? sessionId : null;
  }

  hasConversation(): boolean {
    const fork = this.options.forkContext;
    if (this.resumeSessionId !== null || (fork && !fork.consumed && fork.piBranchedSessionId)) return true;
    if (this.processingFlag) return true;
    return (this.runtime?.session.messages.length ?? 0) > 0;
  }

  get memorySessionId(): string {
    return this.currentSessionId ?? this.options.panelId ?? "";
  }

  get conversationHead(): string | null {
    return null;
  }

  get processing(): boolean {
    return this.processingFlag;
  }

  get currentPromptIndex(): number {
    if (this.inFlightPromptIndex !== null) return this.inFlightPromptIndex;
    const session = this.runtime?.session;
    return session ? Math.max(0, nextPromptIndex(session.sessionManager.getBranch()) - 1) : 0;
  }

  async initializeEarly(): Promise<void> {
    await this.ensureStarted().catch((err) => log("[PiSession.initializeEarly] start failed: %O", err));
  }

  /**
   * The webview restarted (view recreation / "Developer: Reload Webviews"): its dialog queue is a fresh
   * empty store, so every modal that was on screen is gone while the awaiters behind them are still
   * live. Cancelling them answers a question the user never saw. Posting them again puts the same
   * dialog back on screen, which is what the user expects a reload to do.
   *
   * `retainContextWhenHidden` means this is not routine hide/show, so it costs nothing in normal use.
   * Every re-post carries the exact message the prompt was first posted with, so nothing is rebuilt
   * and nothing can drift from what the awaiter is waiting on.
   */
  onWebviewReady(): void {
    this.options.permissionHandler.repostPendingPrompts();
    this.uiContext.repostPending();
    // The reloaded store starts at `idle`, so the cached key describes a webview that no longer exists
    // and would suppress the resync as a duplicate. Cleared before the republish, never after.
    this.lastSessionState = null;
    this.publishSessionState();
  }

  setResumeSession(sessionId: string | null): void {
    this.resumeSessionId = sessionId;
    this.syncSessionLeases();
    // Before start the target is the stored session id; a started panel republishes when its switch rebinds.
    if (!this.runtime) this.publishSessionState();
    // `start()` honors the target on a not-yet-started panel. If the runtime is already live on a
    // different session (the resumeSession message can land on a running panel), switch it to the
    // resume target now. Chained onto resetPromise so a following sendMessage awaits the switch.
    if (sessionId && this.runtime && this.currentSessionId !== sessionId) {
      // Synchronous, so a send made after this call is not taken for the prompt the switch replaces.
      this.stopPromptBeforeRun();
      this.resetPromise = (this.resetPromise ?? Promise.resolve())
        .then(() => this.switchToResumeTarget(sessionId))
        .then(() => undefined)
        .catch((err) => log("[PiSession] resume switch failed: %O", err));
    }
  }

  /** Switch the live runtime to a stored session file (resume on an already-started panel). */
  private async switchToResumeTarget(sessionId: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const filePath = await resolvePiSessionFile(this.cwd, sessionId);
    if (!filePath) {
      log("[PiSession] resume target %s not found on disk", sessionId);
      return;
    }
    // Opening can rewrite the file (a format migration); the detach the loss started resets this panel.
    if (this.lostLeases.has(sessionId)) return;
    await this.retireAgents(runtime.session);
    // Before the switch: a switch that fails leaves the old session bound, and the retired agents are known only from their files.
    this.interruptionCheckPending = true;
    this.undeliveredScanPending = true;
    const { cancelled } = await runtime.switchSession(filePath);
    // The rebind callback re-subscribed the adapter + re-registered the panel; seed the meter from
    // the now-current resumed session.
    if (!cancelled) {
      this.seedResumedUsage();
      // The switched-in session reads the current tool set on build, so a deferred reload is moot.
      this.mcpReloadPendingAfterTurn = false;
    }
  }

  /**
   * Retire the bound session's subagents and team before another session is bound, as a panel close
   * does: the manager caches only the bound session's agents, and a team's events belong to the panel
   * showing its session. Subagents are killed and the team is cancelled as a `shutdown`, so each stays
   * resumable or deliverable from its files at that session's next bind.
   */
  private async retireAgents(session: AgentSession): Promise<void> {
    this.retiringAgents = true;
    try {
      const mgr = this.subagentManager;
      mgr?.abortAll("shutdown");
      this.options.teamService?.cancelActiveTeam("shutdown");
      // Stopped before the wait, so the turn spawns nothing while the runs settle. Not raced against the
      // timeout: pi's switch awaits this same abort again before it tears the session down.
      await session.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ABORTED_AGENTS_SETTLE_TIMEOUT_MS);
      });
      const settled = Promise.all([mgr?.whenRunsSettled(), this.options.teamService?.whenRunSettled()]);
      if ((await Promise.race([settled, timedOut])) === "timeout") {
        log("[PiSession] retired agents still running after %dms; switching anyway", ABORTED_AGENTS_SETTLE_TIMEOUT_MS);
      }
      clearTimeout(timer);
      mgr?.clear();
    } finally {
      this.retiringAgents = false;
    }
  }

  /** Start the adapter's cost state for the resumed conversation now installed (US-010b). */
  private seedResumedUsage(): void {
    if (!this.runtime) return;
    this.adapter.seedResumedUsage(this.ownSessionCost());
  }

  /**
   * Auto-generate an AI session title after the first assistant turn (US-012). Runs once, only when the
   * session is unnamed (a user `/rename` outranks it), on the small/fast model via
   * `runStructuredCompletion`. Fails soft — no auth/error/empty title leaves the session untitled and
   * the turn unaffected. On success, refreshes the picker/header via the existing `onSessionPersisted`.
   */
  private async maybeGenerateTitle(): Promise<void> {
    if (this.titleGenerationAttempted) return;
    this.titleGenerationAttempted = true;
    // Fully fail-soft: this runs fire-and-forget, so any throw here must not surface as an unhandled
    // rejection or affect the turn.
    try {
      const session = this.runtime?.session;
      if (!session || session.sessionManager.getSessionName()) return;

      const exchange = firstExchangeForTitle(session);
      if (!exchange) return;

      const title = await generateSessionTitle(exchange, PiRuntime.get(), { cwd: this.cwd, sessionId: session.sessionId });
      // Re-check the name: a user /rename may have landed during the async completion (it outranks).
      if (!title || session.sessionManager.getSessionName()) return;
      // The completion is an unbounded async window in which a reset/clear/delete can replace or
      // dispose this session and rm its file. The captured manager still believes it flushed, so a
      // write here lands as a bare appendFileSync PAST the rm and resurrects the file holding nothing
      // but this one `session_info` line — a header-less file every reader then rejects forever.
      if (this._disposed || this.runtime?.session !== session) return;
      session.setSessionName(title.slice(0, 100));
      const sid = this.currentSessionId;
      if (sid) this.options.onSessionPersisted?.(sid);
    } catch (err) {
      log("[PiSession] title generation failed: %O", err);
    }
  }

  /** The file this panel's live session persists to; undefined before a session exists. */
  liveSessionFile(): string | undefined {
    return this.runtime?.session.sessionManager.getSessionFile();
  }

  /** The list metadata of `liveSessionFile()`, from the in-memory manager instead of a re-parse of the file. */
  storedMetadata(mtimeMs: number): SessionFileMeta | null {
    const sessionManager = this.runtime?.session.sessionManager;
    return sessionManager ? sessionFileMeta(sessionManager, mtimeMs) : null;
  }

  /**
   * Rename THIS panel's live session through its own SessionManager (US-012). When the panel owns the
   * target session the rename MUST go through the live manager: the file-based `renamePiSession` opens
   * a second writer that anchors its entry to the leaf as of open() time, so a concurrent live turn
   * would fork the branch and silently drop messages on the next reload. The marker entry makes the
   * store rank the name as a user rename (outranking an AI title).
   */
  async renameActiveSession(newName: string): Promise<void> {
    await this.ensureStarted();
    const session = this.runtime?.session;
    if (!session) throw new Error("No active session to rename");
    session.setSessionName(newName);
    session.sessionManager.appendCustomEntry(DAMOCLES_USER_RENAMED_ENTRY);
  }

  /**
   * Set/clear THIS panel's live session tag through its own SessionManager — same anti-fork reason as
   * `renameActiveSession`. `null` clears; latest wins.
   */
  async setActiveSessionTag(tag: string | null): Promise<void> {
    await this.ensureStarted();
    const session = this.runtime?.session;
    if (!session) throw new Error("No active session to tag");
    session.sessionManager.appendCustomEntry(DAMOCLES_TAG_ENTRY, { tag });
  }

  /**
   * Release this panel's live session so its file can be deleted — routed by session id like the
   * rename/tag mutators, so the panel that OWNS the session detaches even when the delete was issued
   * from another one. pi's SessionManager keeps `flushed = true` after its first write, so every later
   * append is a bare `appendFileSync`: a session still live when its file is removed recreates it as a
   * header-less one-entry file that no reader can parse and no picker can ever show again. Resolves
   * once the replacement session is installed, i.e. once the old manager can no longer write, and the
   * agents the reset aborted have stopped writing under the session's folder (bounded by
   * `ABORTED_AGENTS_SETTLE_TIMEOUT_MS`).
   */
  detachFromDeletedSession(): Promise<void> {
    return this.detachSession();
  }

  /**
   * Replace this panel's session with a fresh one and clear its webview, resolving once the old manager can no
   * longer write and the agents the reset aborted have settled (or the wait timed out). Rejects when the
   * replacement failed or was cancelled, which leaves the old session installed and writable.
   */
  private async detachSession(): Promise<void> {
    // A panel mid-`start()` has no `runtime` yet, so reset() would bail and whenReplaced() would
    // resolve instantly — while start() goes on to open a SessionManager on the very path about to be
    // removed. Let the start settle so there is a live session to actually replace. Its own failure is
    // not this method's concern (the panel then holds nothing that could write).
    await this.startPromise?.catch(() => undefined);
    // Captured before reset(), which drops the records of the subagents it aborts.
    const agentsSettled = Promise.all([this.subagentManager?.whenRunsSettled(), this.options.teamService?.whenRunSettled()]);
    this.reset();
    // Rejects when the replacement failed or was cancelled — i.e. the old session is still installed
    // and still writable. The caller MUST NOT go on to delete the file in that case.
    await this.whenReplaced();
    // The reset aborted whatever turn was running; tell this panel's own webview, which for a
    // cross-panel delete is not the one the user clicked in and would otherwise spin forever.
    this.emit({ type: "processing", isProcessing: false });
    this.emit({ type: "sessionCleared" });
    // The webview drops its stored state on that message, so the cached key now describes a store that
    // no longer holds it. Cleared before the republish, never after.
    this.lastSessionState = null;
    this.publishSessionState();
    // The aborted agents still append to files under the session's folder, which a delete removes next.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ABORTED_AGENTS_SETTLE_TIMEOUT_MS);
    });
    if ((await Promise.race([agentsSettled, timedOut])) === "timeout") {
      log("[PiSession] aborted agents still running after %dms; detaching anyway", ABORTED_AGENTS_SETTLE_TIMEOUT_MS);
    }
    clearTimeout(timer);
  }

  /**
   * Persist the user's ORIGINAL typed input when a slash-command expansion made the stored user message
   * diverge from it — pi expands prompt templates inside `prompt()`, chat-handlers rewrites skills/`/init`
   * before `sendMessage` — so a reloaded transcript, the up-arrow history, and the session-list preview
   * show what the user typed rather than the expanded body. Keyed to the pi user entry this `prompt()`
   * committed. The IDE-context prefix pi merges into the message is stripped before comparing so a plain
   * (un-expanded) message with attached context records nothing. Fail-soft: a write error never breaks
   * the turn.
   */
  private recordOriginalInputIfDiverged(session: AgentSession, original: string, entry: PromptEntry): void {
    // Same captured-across-an-await shape as `maybeGenerateTitle`: the session was captured before
    // `prompt()` and this runs after it resolved, so a delete in that window can have removed the file
    // while this manager still appends to it. Today pi's teardown awaits `abort()` before installing
    // the replacement, which happens to order the continuation first — an implementation detail of the
    // dependency, not a guarantee, so the liveness check is stated rather than relied upon.
    if (this._disposed || this.runtime?.session !== session) return;
    const typed = original.trim();
    if (!typed) return;
    const stored = stripIdeContext(entry.text).trim();
    if (stored === typed) return;
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_ORIGINAL_INPUT_ENTRY, { userEntryId: entry.id, original: typed });
    } catch (err) {
      log("[PiSession] recordOriginalInput failed: %O", err);
    }
  }

  /**
   * Record this completed turn, from the prompt entry `userEntryId` on, as a memory extraction
   * candidate (fail-soft). No-op when no memory service is wired or the turn ran no agent. Service-side
   * gates (memory disabled / auto-extract off / disposed) live in enqueueTurnCandidate.
   * Symmetric with recordOriginalInputIfDiverged.
   */
  private enqueueMemoryCandidate(session: AgentSession, userEntryId: string): void {
    const memory = this.options.memoryService;
    if (!memory) return;
    if (!this.adapter.observedAgentRun()) return; // extension command / no LLM run → not a real turn
    try {
      const exchange = turnExchangeFrom(session, userEntryId, this.cwd);
      if (!exchange || !exchange.userText.trim()) return;
      memory.enqueueTurnCandidate({
        sessionId: this.memorySessionId,
        promptIndex: this.currentPromptIndex,
        userText: exchange.userText,
        assistantText: exchange.assistantText,
        files: exchange.files,
        workspace: this.cwd,
      });
    } catch (err) {
      log("[PiSession] enqueueMemoryCandidate failed: %O", err);
    }
  }

  // ---- thinking (deferred) ------------------------------------------------

  disableThinkingForNextQuery(): void {
    this.thinkingDisabledNextQuery = true;
  }

  restoreThinkingConfig(): void {
    this.thinkingDisabledNextQuery = false;
  }

  // ---- permission / fast mode --------------------------------------------

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    // The shared `permissionHandler` mode is already updated by config-manager before this call;
    // here we enforce the matrix at the tool layer by toggling the active tool set (US-017).
    this.applyActiveToolsForMode(mode);
  }

  /**
   * Apply the mode's active tool set: the full live set, minus `PLAN_MODE_EXCLUDED_TOOLS` in plan mode
   * (US-017). SUBTRACTIVE by design — plan mode states what it BLOCKS, so a new tool subsystem is
   * available while planning without a code change (an inclusion list made MCP, then memory, then the
   * browser silently invisible until each was patched in reactively).
   *
   * The subtraction runs against the live full set, so a per-tool-disabled tool or a disabled subsystem
   * (compass, browser, web, MCP) is already absent — the setting is respected with no extra check.
   *
   * Plan mode's guarantee is no unapproved WORKSPACE WRITES and no unapproved SHELL — not "no side
   * effects anywhere", as the already-permitted MCP tools demonstrate. So Edit/Write stay active for the
   * plan file (the gate restricts them to it), bash/PowerShell stay active (the gate classifies each
   * command), memory/compass touch only extension-internal SQLite, and the browser tools stay available
   * because research frequently requires driving a running app or a live page.
   *
   * For Edit/Write/bash/PowerShell the gate is the enforcement layer and this subtraction is a second
   * one. For the gateable MODULE tools (memory/compass/browser/team) it is NOT: their gate branch
   * returns before the plan-mode branch, so this list is their only plan-mode control. See
   * `PLAN_MODE_EXCLUDED_TOOLS` for which risks that leaves accepted. Takes effect on pi's next turn.
   */
  private applyActiveToolsForMode(mode: PermissionMode): void {
    const session = this.runtime?.session;
    if (!session) return;
    const full = activeToolNamesWithDeferral(this.toolStatusDeps(), this.toolSearchActivated);
    if (mode === "plan") {
      const excluded = new Set<string>(PLAN_MODE_EXCLUDED_TOOLS);
      session.setActiveToolsByName(full.filter((name) => !excluded.has(name)));
      return;
    }
    session.setActiveToolsByName(full);
  }

  /** Snapshot the live flags/catalogs the tool-status pure functions consume. */
  private toolStatusDeps(): ToolStatusDeps {
    return {
      webEnabled: isWebSearchEnabled(),
      teamEnabled: this.isTeamEnabled(),
      teamAvailable: !!this.options.teamService,
      ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
      ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
      browserAvailable: !!this.options.browserService,
      browserEnabled: this.isBrowserEnabled(),
      imageEnabled: this.options.platform.settings.get<boolean>(IMAGE_ENABLED_SETTING, false),
      imageAvailability: imageAvailability(this.imageModelId(), this.imageRuntime()),
      mcpEnabled: this.isMcpEnabled(),
      mcpToolNames: this.mcpToolNames(),
      mcpDeferrableToolNames: this.mcpClientManager()?.deferrableToolNames() ?? [],
      disabled: this.disabledToolSet(),
    };
  }

  /**
   * The full active tool set: native pi tools + (web tools when enabled) + Damocles custom tools + the
   * live-enabled module tools, minus the per-tool disabled set. Membership is read live every call, so
   * `refreshActiveTools()` re-applies a master/per-tool toggle change on the next turn.
   */
  private fullActiveToolNames(): string[] {
    return fullActiveToolNamesFrom(this.toolStatusDeps());
  }

  /** This panel's folder MCP view, or null before `start()` resolves the folder. */
  private mcpClientManager(): McpToolSource | null {
    return this.folder?.mcp ?? null;
  }

  /** Master MCP switch — `damocles.mcp.enabled` (default true: "configured = active", Claude-Code parity). */
  private isMcpEnabled(): boolean {
    return this.options.platform.settings.get<boolean>("damocles.mcp.enabled", true);
  }

  /** The pi tool names for every enabled MCP server's tools/resources (live + cache fallback). */
  private mcpToolNames(): string[] {
    return this.mcpClientManager()?.allToolNames() ?? [];
  }

  /** Recompute + re-apply the active tool set for the current permission mode; effective next turn.
   *  Also re-publishes ToolSearch: its description is captured at wrap time, so without this a
   *  subsystem toggled off mid-session stays advertised in the inventory the model reads. */
  refreshActiveTools(): void {
    this.applyActiveToolsForMode(this.permissionMode);
    this.folder?.republishToolSearch();
  }

  /**
   * This session's deferrable universe for `ToolSearch`. MCP groups come from each descriptor's
   * `serverName` (`mcpToolSearchGroup`), never from parsing the tool name, so the group the model is
   * shown is the one the resolver accepts.
   */
  deferrableToolsSnapshot(): DeferrableSnapshot {
    const session = this.runtime?.session;
    const eligible = this.fullActiveToolNames();
    const names = deferredToolNames(eligible, this.isMcpEnabled() ? (this.mcpClientManager()?.deferrableToolNames() ?? []) : []);
    const pendingMcpServers = (this.mcpClientManager()?.getServerStatuses() ?? [])
      .filter((status) => status.enabled && status.status !== 'connected')
      .map((status) => status.name);
    // Menu facts come from the MCP client, never from pi's tool registry: reading that registry to
    // build the ToolSearch description re-enters ToolSearch's own description getter and recurses.
    const deferrable = new Set(names);
    const eligibleSet = new Set(eligible);
    const mcpDescriptions = new Map<string, McpToolMenuEntry>();
    const directMcpGroups = new Set<string>();
    for (const d of this.mcpClientManager()?.getAllToolDescriptors() ?? []) {
      if (d.exposure === "direct" && eligibleSet.has(d.piName)) directMcpGroups.add(mcpToolSearchGroup(d.serverName));
      if (!deferrable.has(d.piName)) continue;
      mcpDescriptions.set(d.piName, {
        description: d.description,
        group: mcpToolSearchGroup(d.serverName),
        ...(d.serverDescription ? { serverDescription: d.serverDescription } : {}),
      });
    }
    const mcpGroups = mcpGroupsOf(names, mcpDescriptions);
    return {
      names,
      loaded: new Set(session?.getActiveToolNames() ?? []),
      mcpGroups,
      ...(directMcpGroups.size ? { directMcpGroups } : {}),
      ...(pendingMcpServers.length ? { pendingMcpServers } : {}),
      ...(mcpDescriptions.size ? { mcpDescriptions } : {}),
    };
  }

  /**
   * The first prompt of each session waits, up to `MCP_STARTUP_WAIT_MS`, for enabled servers that have
   * Always-loaded tools and are still connecting, so those tools are declared in its first request.
   * Other servers never hold a prompt. A tool whose server connects later is active from the next turn.
   * The folder's own tools-changed listener registers and activates the tools before this wait sees
   * the change, because it subscribed to the view first.
   */
  async waitForAlwaysLoadedMcp(sessionId: string): Promise<void> {
    if (this.mcpStartupWaitedSessionId === sessionId) return;
    this.mcpStartupWaitedSessionId = sessionId;
    const source = this.mcpClientManager();
    if (!source || !this.isMcpEnabled()) return;
    const pending = source.pendingDirectServers();
    if (pending.length === 0) return;
    this.emit({
      type: "notification",
      notificationType: "info",
      message: pending.length === 1 ? t("Waiting for MCP server {0}", pending[0]!) : t("Waiting for MCP servers {0}", pending.join(", ")),
    });
    const abort = new AbortController();
    this.mcpStartupWaitAbort = abort;
    try {
      const outcome = await waitForPendingDirectServers(source, abort.signal);
      log("[PiSession] Always-loaded MCP wait ended: %s", outcome);
      const late = outcome === "timeout" ? source.pendingDirectServers() : [];
      if (late.length > 0) {
        this.emit({
          type: "notification",
          notificationType: "info",
          message: late.length === 1
            ? t("MCP server {0} is still connecting. Its Always-loaded tools join from the next turn after it connects.", late[0]!)
            : t("MCP servers {0} are still connecting. Their Always-loaded tools join from the next turn after they connect.", late.join(", ")),
        });
      }
    } finally {
      if (this.mcpStartupWaitAbort === abort) this.mcpStartupWaitAbort = null;
    }
  }

  /** Load deferred tools into the live active set. Synchronous, so pi's before/after active-set diff
   *  around the calling `ToolSearch.execute` observes the addition and stamps `addedToolNames`. */
  activateDeferredTools(names: string[]): void {
    for (const name of names) this.toolSearchActivated.add(name);
    this.applyActiveToolsForMode(this.permissionMode);
  }

  /**
   * Requested MCP tool names absent from the live session's registry — non-empty only when the session
   * is bound to an extension instance `FolderRuntime` no longer has attached, or pi rejected a tool.
   */
  private missingMcpRegistryNames(session: AgentSession): string[] {
    const requested = new Set(this.fullActiveToolNames().filter(isMcpToolName));
    if (requested.size === 0) return [];
    const present = new Set(session.getAllTools().map((t) => t.name).filter(isMcpToolName));
    return [...requested].filter((name) => !present.has(name));
  }

  /**
   * Handle an MCP tools-changed for THIS panel. Fast path (registry already current): just re-apply the
   * active set. Slow path (orphaned runtime missing the new tools): rebuild via `session.reload()`, then
   * re-apply. The reload is deferred while the session is busy and flushed at the next turn.
   */
  reloadForMcpToolChange(): void {
    const session = this.runtime?.session;
    if (!session) return;
    if (this.missingMcpRegistryNames(session).length === 0) {
      // Registry already current → cheap active-set re-apply, no runtime rebuild.
      this.refreshActiveTools();
      return;
    }
    // Orphaned. `session.reload()` rebuilds the runtime + resets API providers, so never run it under any
    // in-flight work — not just an agent run: manual `compact()` aborts first (`!isIdle` false, but
    // `isCompacting` true), and `processingFlag` is set a tick before `prompt()` flips isIdle. Defer to
    // next turn.
    if (this.isSessionBusy(session)) {
      this.mcpReloadPendingAfterTurn = true;
      return;
    }
    void this.runMcpReload();
  }

  /** Any turn-level work in flight, so a runtime-rebuilding `session.reload()` must be deferred. */
  private isSessionBusy(session: AgentSession): boolean {
    return this.processingFlag || this.compacting || !session.isIdle || session.isCompacting;
  }

  /**
   * Drive `session.reload()` for the orphaned-runtime case. Fail-soft (a reload error leaves the session
   * usable), serialized with reset/newSession, and single-flight (concurrent requests coalesce).
   */
  private runMcpReload(): Promise<void> {
    this.mcpReloadPendingAfterTurn = false;
    // Single-flight: a reload already running picks up the latest registry when it settles, so just flag
    // a re-run instead of stacking a second rebuild (a burst of connects → one trailing reload).
    if (this.mcpReloadPromise) {
      this.mcpReloadRerunRequested = true;
      return this.mcpReloadPromise;
    }
    // Capture the reset gate now (not late) so reload never runs concurrently with newSession().
    const priorReset = this.resetPromise;
    const chained = (async () => {
      if (priorReset) await priorReset.catch(() => undefined);
      // Loop honors a mid-reload re-run without stacking promises — at most one extra pass, only while
      // still orphaned. The under-lock re-check also no-ops a reload made moot by an interleaved reset.
      do {
        this.mcpReloadRerunRequested = false;
        const session = this.runtime?.session;
        if (!session || this._disposed) return;
        if (this.missingMcpRegistryNames(session).length === 0) {
          this.refreshActiveTools();
          return;
        }
        await session.reload();
        this.applyActiveToolsForMode(this.permissionMode);
      } while (this.mcpReloadRerunRequested && !this._disposed);
    })().catch((err) => log("[PiSession] MCP reload failed: %O", err));
    this.mcpReloadPromise = chained.finally(() => {
      if (this.mcpReloadPromise === chained) this.mcpReloadPromise = null;
    });
    return this.mcpReloadPromise;
  }

  /**
   * Build the Tools-panel snapshot (US): each subsystem's master + availability, and every tool's live
   * enabled state. Layered: Core is always on; a toggleable module/web tool is on iff its group master
   * is enabled AND it is not in the per-tool disabled set.
   */
  getToolStatus(): ToolsSnapshot {
    return buildToolStatusFrom(this.toolStatusDeps());
  }

  /**
   * The per-tool active-set names the user disabled, read live: `damocles.tools.disabled` plus the MCP
   * tools whose exposure is `off` in this folder.
   */
  private disabledToolSet(): Set<string> {
    const list = this.options.platform.settings.get<string[]>("damocles.tools.disabled", []);
    const disabled = new Set(Array.isArray(list) ? list : []);
    for (const name of this.mcpClientManager()?.offToolNames() ?? []) disabled.add(name);
    return disabled;
  }

  /** The live `damocles.browser.enabled` flag — the browser service is always wired; this gates it. */
  private isBrowserEnabled(): boolean {
    return this.options.platform.settings.get<boolean>("damocles.browser.enabled", false);
  }

  private imageModelId(): string {
    return this.options.platform.settings.get<string>(IMAGE_MODEL_SETTING, "");
  }

  private imageRuntime(): ImageRuntime | null {
    return PiRuntime.exists ? PiRuntime.get().modelRuntime : null;
  }

  /** The live `damocles.team.enabled` flag — Team is opt-in (disabled by default). */
  private isTeamEnabled(): boolean {
    return this.options.platform.settings.get<boolean>("damocles.team.enabled", false);
  }

  private isPlanMode(): boolean {
    return this.options.permissionHandler.getPermissionMode() === "plan";
  }

  /** The main agent's plan-mode statement, with the same guidance inputs as its system prompt (`agent-start.ts`). */
  private readonly planModeStatement: PlanModeStatement = mainPlanModeStatement(() =>
    buildPlanModeGuidance(this.getPlanFilePath(), {
      teamEnabled: !!this.options.teamService && this.isTeamEnabled(),
      webSearchEnabled: isWebSearchEnabled(),
    }),
  );

  // ---- subagents (Phase 5) ------------------------------------------------

  /** The background-subagent concurrency cap (`damocles.subagents.maxConcurrent`, default 4, clamped 1–16). */
  private maxConcurrentSetting(): number {
    const n = this.options.platform.settings.get<number>("damocles.subagents.maxConcurrent", 4, this.options.settingsFolder);
    return Math.min(16, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 4));
  }

  /** Whether project-scope agents/skills may load — gated on this folder's trust (US-022). */
  private projectScopeTrusted(): boolean {
    return this.options.platform.trust.isTrusted(this.cwd);
  }

  /**
   * Create the per-PiSession subagent manager once, bound to the folder's shared registry (one per
   * folder, owned by FolderRuntime). The manager holds the SAME registry instance, so a reload (which
   * mutates it via `register()`) is seen automatically. Subscribe so this panel re-emits availability + trust status when the shared
   * registry reloads (file change or workspace-trust grant).
   */
  private ensureSubagentEngine(pi: PiCodingAgentModule, folder: FolderRuntime): void {
    if (this.subagentManager) return;
    const wsAgents = folder.getWorkspaceAgentRegistry();
    this.agentRegistry = wsAgents.getRegistry();
    this.subagentManager = new AgentManager(this.buildSubagentEngine(pi, folder), this.maxConcurrentSetting());
    this.emitCustomAgents();
    this.emit({ type: "projectTrust", trusted: this.projectScopeTrusted() });
    this._agentsUnsub = wsAgents.onChange(() => {
      this.emitCustomAgents();
      this.emit({ type: "projectTrust", trusted: this.projectScopeTrusted() });
    });
    // Apply a live change to the concurrency cap (the value is otherwise only read at construction).
    this._configUnsub = this.options.platform.settings.onDidChange("damocles", (e) => {
      if (e.affects("damocles.subagents.maxConcurrent")) {
        this.subagentManager?.setMaxConcurrent(this.maxConcurrentSetting());
      }
      if (e.affects("damocles.autoCompact")) {
        this.applyCompactionConfig();
      }
      if (e.affects("damocles.cacheWarming")) {
        this.applyCacheWarmingConfig();
      }
    });
  }

  /** Emit the spawnable user/project agents (defaults are builtins, shown via AVAILABLE_AGENTS). */
  private emitCustomAgents(): void {
    if (!this.agentRegistry) return;
    const agents: CustomAgentInfo[] = this.agentRegistry
      .getAvailableConfigs()
      .filter((c) => c.isDefault !== true)
      .map((c) => ({
        name: c.name,
        description: c.description,
        source: AGENT_SCOPE_BY_SOURCE[c.source ?? "default"],
        ...(c.model ? { model: c.model } : {}),
        ...(c.builtinToolNames ? { tools: c.builtinToolNames } : {}),
      }));
    this.emit({ type: "customAgents", agents });
  }

  private trackedNestedSessions(folder: FolderRuntime): Pick<SubagentEngine, "createSession" | "forgetSession"> {
    return {
      createSession: async (opts) => {
        const session = await folder.createSubagentSession(opts);
        this.unpersistedImages.track(session);
        return session;
      },
      forgetSession: (session) => {
        this.unpersistedImages.untrack(session);
        folder.forgetSubagentSession(session);
      },
    };
  }

  /** Build the deps the AgentManager needs to run one subagent (model policy + budget owned here). */
  private buildSubagentEngine(pi: PiCodingAgentModule, folder: FolderRuntime): SubagentEngine {
    return {
      cwd: this.cwd,
      trust: this.options.platform.trust,
      registry: this.agentRegistry!,
      ...this.trackedNestedSessions(folder),
      permissionHandler: this.options.permissionHandler,
      isPlanMode: () => this.options.permissionHandler.getPermissionMode() === "plan",
      ...this.checkpointBaselineField(),
      shellCancelFor: (agentId) => this.shellCancel.forContext(this.noteDeliveryForSubagent(agentId)),
      postMessage: (m) => this.emit(m),
      getParentSystemPrompt: () => this.runtime?.session.systemPrompt ?? "",
      getParentSessionId: () => this.currentSessionId ?? this.memorySessionId,
      subagentStoreDir: () => subagentsDir(ensurePiSessionDir(this.cwd), this.liveSessionId()),
      recordInvocation: (data) => this.recordAgentInvocation(data),
      parentBranch: () => this.parentBranch(),
      assertResumableModel: (path, agentId) => this.assertResumableModel(path, agentId),
      parentFullToolNames: () => this.fullActiveToolNames(),
      // ONE call per spawn: the MCP definitions are APPENDED to this agent's customTools here, exactly
      // as `buildTeamAgentCustomTools` appends the `team_*` tools, and the caller derives `tools:`,
      // `mcpToolNames:`, the deferrable set and the gate classifier from the same returned snapshot.
      buildAgentToolset: (input) => {
        const mcp = this.buildNestedMcp(pi, {
          disallowed: input.mcpDisallowed,
          agent: { agentId: input.agentId, agentName: input.agentName },
        });
        return { customTools: [...this.buildSubagentCustomTools(pi, this.noteDeliveryForSubagent(input.agentId), input.agentId), ...mcp.tools], mcp };
      },
      disposeBrowserScope: (scopeId, closeTabs) => this.options.browserService?.disposeScope(scopeId, closeTabs),
      cancelAgentDialogs: (agentId) => this.uiContext.cancelAgentDialogs(agentId),
      resolveModel: (input) => this.resolveSubagentModel(input.agentConfig),
      modelDollarBilled: (model) => piModelDollarBilled(model, this.modelBillingDeps()),
      onSubagentCost: (delta) => this.adapter.addExternalCost(delta),
      onRunsChanged: () => this.publishSessionState(),
      getHooksDispatch: () => folder.getHooksDispatchDeps(),
    };
  }

  /** The live parent session's id; agent data is filed under it. */
  private liveSessionId(): string {
    const sessionId = this.runtime?.session.sessionId;
    if (!sessionId) throw new Error("No live session to file subagent data under");
    return sessionId;
  }

  /** The live session's current branch: the only index of the agents this conversation invoked. */
  parentBranch(): readonly SessionEntry[] {
    return this.runtime?.session.sessionManager.getBranch() ?? [];
  }

  /** Throw the resume error unless the model recorded in the agent session file at `path` is usable. */
  assertResumableModel(path: string, agentId: string): void {
    this.requireFolder().assertResumableModel(path, agentId);
  }

  /** Tell the model which agents were interrupted before the next user prompt. */
  requestInterruptionCheck(): void {
    this.interruptionCheckPending = true;
  }

  /** Index an agent invocation on the parent branch. The parent's assistant message holding the tool
   *  call is already flushed, so pi writes the entry to disk immediately. */
  recordAgentInvocation(data: AgentInvocationData): void {
    const session = this.runtime?.session;
    if (!session) {
      log("[PiSession] agent invocation %s not recorded: no live session", data.id);
      return;
    }
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, data);
    } catch (err) {
      log("[PiSession] recording agent invocation %s failed: %O", data.id, err);
      this.emit({
        type: "notification",
        message: data.kind === "team"
          ? t("Could not record a team in the session file; its card will not be restored after a reload.")
          : t("Could not record a subagent in the session file. After a reload its card will not be restored, and the model will not receive a result it has not received by then."),
        notificationType: "warning",
      });
    }
  }

  /**
   * Pre-settlement coordinator: two independent "keep the run going" mechanisms compose here. The
   * background keep-alive runs first; if it produces a draft the plan-mode hold is skipped, and pi
   * re-enters this boundary after the continuation round, where the background results are already
   * drained and the plan-mode hold gets its chance. Returns the entry to append, or undefined to let
   * the run settle.
   */
  private async onBeforeSettle(event: AgentBeforeSettleEvent): Promise<CustomMessageEntryDraft | undefined> {
    if (!this.runtime?.session || this.stopRequested()) return undefined;
    return (await this.tryBackgroundKeepAlive()) ?? this.tryPlanModeHold(event);
  }

  /**
   * Keep-alive: when a run is about to settle while background subagents are still running, await ALL of
   * them and carry their results into one more request as a `display:false` custom entry, so the model
   * finishes its answer using the results (the user's requirement: the parent must not finish until its
   * background subagents complete). ESC (`_aborting`, which `abortAll()`s the subagents) breaks the wait.
   */
  private async tryBackgroundKeepAlive(): Promise<CustomMessageEntryDraft | undefined> {
    const mgr = this.subagentManager;
    if (!mgr || this.stopRequested()) return undefined;
    if (mgr.hasPendingBackground()) {
      await mgr.waitForBackground();
      if (this.stopRequested()) return undefined;
    }
    // pi commits each settle's draft before the next settle runs, so D already holds this turn's earlier injections.
    const completed = mgr.deliverableLive();
    if (completed.length === 0) return undefined;

    return {
      type: "custom_message",
      customType: SUBAGENT_RESULTS_CUSTOM_TYPE,
      content: formatBackgroundResults(completed),
      display: false,
      details: backgroundResultsDetails(completed),
    };
  }

  /**
   * Plan-mode hold: deterministically funnel every plan-mode turn through `ExitPlanMode`. When a plan-mode
   * turn is about to settle WITHOUT the model having successfully exited plan mode, carry a hidden nudge
   * into one more request — the model must then call ExitPlanMode or AskUserQuestion (which keeps the turn
   * alive on its own); it can no longer silently stop with an unapproved plan. The prose guidance in
   * `plan-mode-guidance.ts` is the first line of defense; this is the deterministic backstop for when the
   * model ignores it.
   *
   * The funnel is deliberately unbounded, so convergence has to come from the nudge text rather than from
   * a retry cap: `selectPlanModeNudgeText` escalates once this turn has already produced a nudge. The
   * count selects which text goes out, never whether one does.
   *
   * Fires iff ALL hold: still in plan mode; no NON-error `ExitPlanMode` result in this turn (an approved
   * exit returns a normal result and suppresses the nudge; a rejected exit leaves only an isError result
   * and does not); the last assistant message stopped cleanly (`stopReason === 'stop'` — never on
   * error/aborted/length or an auto-retry); the user has nothing queued; and we are not aborting. The
   * mode is re-read live at every settle, so switching out of plan mode (via the UI) stops the funnel on
   * the very next turn — the user always has a non-Stop way out.
   */
  private tryPlanModeHold(event: AgentBeforeSettleEvent): CustomMessageEntryDraft | undefined {
    if (this.permissionMode !== "plan") return undefined;
    if (this.stopRequested()) return undefined;
    // Hold no opinion while the user has something queued: the nudge would land immediately ahead of
    // their own message, telling the model to exit plan mode just before a human instruction that may
    // say otherwise. It re-fires at the next settle if still needed. Reads the agent's own queue, not
    // `pendingMessageCount`: `sendCustomMessage` bypasses the mirror that one counts.
    if ((this.runtime?.session.agent.peekQueuedMessages().length ?? 0) > 0) return undefined;
    // The boundary event carries no per-turn message list, so both predicates read the session
    // projection. `turnHasNonErrorExitPlanModeResult` scopes itself to the current turn; `lastAssistant`
    // does not need to, because every run reaching this boundary has appended an assistant message, a
    // synthetic one even on hard failure (`agent.js:364-380` in pi-agent-core 0.99.2), so the last one is always this turn's.
    const messages = event.context.contextMessages;
    if (turnHasNonErrorExitPlanModeResult(messages)) return undefined;
    if (lastAssistant(messages)?.stopReason !== "stop") return undefined;
    // A model never told that plan mode started gets the plan-mode instructions before any nudge.
    const notice = planModeChangeNotice(messages, true, this.planModeStatement);
    if (notice) return { type: "custom_message", ...notice };

    return {
      type: "custom_message",
      customType: PLAN_MODE_NUDGE_CUSTOM_TYPE,
      content: selectPlanModeNudgeText(messages),
      display: false,
    };
  }

  /**
   * The frozen MCP snapshot for ONE nested spawn — the single source for that agent's `mcp__*` entries
   * in `tools:`, its MCP customTool definitions, its deferred baseline, its gate read-only classifier
   * and its ToolSearch blurbs.
   *
   * `eligible` is `fullActiveToolNames()`, read ONCE. That one read is what applies the
   * `damocles.mcp.enabled` master switch and the `damocles.tools.disabled` per-tool set to nested
   * agents — `fullActiveToolNamesFrom` already does `...(mcpEnabled ? mcpToolNames : [])` and already
   * subtracts the disabled set (`tool-status.ts:65`). There is deliberately NO second `isMcpEnabled()`
   * check here: a duplicated gate is a gate that drifts, and a nested agent silently keeping a tool the
   * panel dropped is exactly the divergence this slice removes.
   */
  private buildNestedMcp(
    pi: PiCodingAgentModule,
    opts: { disallowed?: ReadonlySet<string>; agent?: AgentUiAttribution },
  ): NestedMcpToolset {
    return buildNestedMcpToolset(pi, this.mcpClientManager(), {
      eligible: new Set(this.fullActiveToolNames()),
      ...(opts.disallowed ? { disallowed: opts.disallowed } : {}),
      // A nested session never binds this panel's `ExtensionUIContext`, so its MCP tools would resolve
      // pi's no-op UI and answer every `elicitation/create` with a silent cancel. Handing the per-agent
      // bridge in at spawn is what routes the prompt to the parent panel, attributed and cancellable.
      ...(opts.agent ? { elicitationUi: this.uiContext.forAgent(opts.agent) } : {}),
    });
  }

  /** Build a nested subagent's / team agent's customTools: the same set without the subagent tools (no
   *  manager → no recursion). `browserScopeId` (the subagent record id / team agent id) isolates this
   *  agent's browser tools to its own tab scope; omitted → the chat's human scope (only the main agent).
   *  `deliverUserNote` is the caller's: a subagent and a team agent are indistinguishable from
   *  `browserScopeId` alone, and each reaches its own conversation through a different channel. */
  private buildSubagentCustomTools(pi: PiCodingAgentModule, deliverUserNote: (text: string) => void, browserScopeId?: string): ToolDefinition[] {
    if (browserScopeId) this.ownedBrowserScopes.add(browserScopeId);
    return buildCustomTools({
      pi,
      cwd: this.cwd,
      permissionHandler: this.options.permissionHandler,
      ...(this.options.memoryService ? { memoryService: this.options.memoryService } : {}),
      ...(this.options.compassService ? { compassService: this.options.compassService } : {}),
      ...(this.options.browserService ? { browserService: this.options.browserService } : {}),
      ...(browserScopeId ? { browserScopeId } : {}),
      ...(this.options.browserChat ? { browserChat: this.options.browserChat } : {}),
      getSessionId: () => this.memorySessionId,
      getShellOptions: () => this.shellOptions(),
      shellCancel: this.shellCancel,
      deliverUserNote,
      shellJob: this.shellJob,
    });
  }

  /**
   * Resolve a spawn's model. Precedence: the agent template's `model:` > (Explore subagent only) the
   * Settings → Explore section selection (`damocles.explore.*`) / provider-matched cheap model >
   * inherit the panel's session model. The spawning LLM has NO say — there is no `model` param on the
   * `Agent` tool — so a subagent runs on the session model unless a template declares otherwise.
   * `enabledModels` scope is enforced (out-of-scope → fail soft).
   */
  private resolveSubagentModel(agentConfig: AgentConfig): ResolvedSubagentModel {
    const piRuntime = PiRuntime.get();
    const registry = piRuntime.modelRuntime;
    if (!registry) return { error: "pi runtime not initialized" };
    const openai = piRuntime.getOpenAIAuthStatus();
    const preferApiKey = this.preferOpenAIApiKey();
    const scope = resolveEnabledModels(readEnabledModels(this.cwd), registry);

    // Names the allowlist as the thing to edit: a configured `enabledModels` that resolves to nothing
    // denies every model (fail-closed by design), so one typo there fails every spawn — and a message
    // naming only the model sends the user hunting through templates instead.
    const scopeError = (model: Model<Api>): string | undefined =>
      scope && !isModelInScope(model, scope)
        ? `Model ${model.provider}/${model.id} is outside the \`enabledModels\` allowlist in pi's settings.json.`
        : undefined;
    const label = (model: Model<Api>): string => piModelToModelInfo(model).displayName;
    const thinking = agentConfig.thinking ? { thinkingLevel: agentConfig.thinking } : {};
    const billing = this.modelBillingDeps(openai, preferApiKey);
    const billed = (model: Model<Api>) => ({ dollarBilled: piModelDollarBilled(model, billing) });

    // 1. The agent template's `model:` — the only place a per-agent model requirement is declared.
    const explicit = agentConfig.model;
    if (explicit) {
      const curated = resolvePiModel(explicit, registry, openai, preferApiKey);
      // An unauthed model resolves to a `Model` but would die on its first request, so auth is required
      // on BOTH paths. The direct lookup is only tried when the curated one found nothing at all —
      // retrying a value that resolved and failed only on auth would hand back the model auth just
      // rejected, silently undoing the check for any `provider/modelId` template pin.
      let model = curated.authed ? curated.model : undefined;
      if (!model && !curated.model) {
        const slash = explicit.indexOf("/"); // custom-provider / direct provider/modelId
        const direct = slash !== -1 ? registry.getModel(explicit.slice(0, slash), explicit.slice(slash + 1)) : undefined;
        if (direct && registry.hasConfiguredAuth(direct.provider)) model = direct;
      }
      // A template naming an unusable model is a config error the user must fix in the template — it is
      // surfaced, never silently downgraded to the session model, which would hide the broken pin. The
      // cause is branched: an unknown id means edit the template, an unauthed one means sign in.
      if (!model) {
        const where = agentConfig.filePath ?? "the agent template";
        const cause = curated.model
          ? `its provider (${curated.model.provider}) is not signed in. Sign in to that provider, or change the \`model:\` field in ${where}.`
          : `that model is not available. Fix the \`model:\` field in ${where}, or remove it to use the session model.`;
        return { error: `Agent "${agentConfig.name}" declares model "${explicit}", but ${cause}` };
      }
      const err = scopeError(model);
      if (err) return { error: `Agent "${agentConfig.name}" declares model "${explicit}", but ${err[0]!.toLowerCase()}${err.slice(1)}` };
      return { model, modelLabel: label(model), ...billed(model), ...thinking };
    }

    // 2. The Explore subagent only: the Settings → Explore section selection (provider + model, shared
    //    with the explore UI), else the provider-matched cheap model of the panel's main model. Plan and
    //    general-purpose are NOT lightweight — they fall through to inherit the panel's main model (step 3).
    if (agentConfig.name.toLowerCase() === "explore") {
      const explore = resolveExploreSectionModel(registry, this.options.platform.settings);
      if (explore && !scopeError(explore.model)) {
        const { model, thinkingLevel } = explore;
        return { model, modelLabel: label(model), ...billed(model), ...(thinkingLevel ? { thinkingLevel } : {}) };
      }
      const cheap = resolveCheapModelFor(this.modelValue, registry, openai, preferApiKey);
      if (cheap.model && !scopeError(cheap.model)) return { model: cheap.model, modelLabel: label(cheap.model), ...billed(cheap.model) };
    }

    // 3. Inherit the panel's session model — the default for every agent without a template `model:`.
    //    Its effort comes with it, or pi falls back to whatever default it last persisted, which varies
    //    by machine. A template's own `thinking:` still wins. The spawning model never picks the level.
    if (this.desiredModel) {
      const err = scopeError(this.desiredModel);
      if (err) return { error: err };
      const thinkingLevel = agentConfig.thinking ?? effortToThinkingLevel(this.options.resolveThinking(this.modelValue));
      return { model: this.desiredModel, modelLabel: label(this.desiredModel), ...billed(this.desiredModel), thinkingLevel };
    }
    return { dollarBilled: modelDollarBilled(this.modelValue, billing) };
  }

  private modelBillingDeps(
    openai = PiRuntime.get().getOpenAIAuthStatus(),
    preferApiKey = this.preferOpenAIApiKey(),
  ): ModelBillingDeps {
    const piRuntime = PiRuntime.get();
    return {
      supportedModels: this.supportedModelsCache,
      claudeAuthMode: piRuntime.getClaudeAuthStatus().mode,
      openai,
      preferApiKey,
      registry: piRuntime.modelRuntime ?? undefined,
    };
  }

  /** Resolve a pending pi-extension `ctx.ui.*` dialog from a webview response (US-026 seam). */
  resolveExtensionUiResponse(requestId: string, value: string | boolean | null): void {
    this.uiContext.resolve(requestId, value);
  }

  // ---- mcp / plugins / provider / browser (deferred) ----------------------

  /** Live MCP runtime status for the enabled servers; McpManager overlays disabled/imported entries. */
  async getMcpServerStatus(): Promise<McpServerStatusInfo[]> {
    return this.mcpClientManager()?.getServerStatuses() ?? [];
  }

  /**
   * Feed this panel's MCP scope: user servers to the shared user manager, the folder partition to this
   * folder's manager. Both reconciles skip an unchanged set, so every panel may feed on every change.
   */
  setMcpServers(scope: McpScope): void {
    this.mcpScope = scope;
    if (this.folder) this.applyMcpScope(scope);
  }

  private applyMcpScope(scope: McpScope): void {
    const userMcp = PiRuntime.get().getUserMcp();
    const folder = this.folder;
    if (!userMcp || !folder) return;
    void userMcp.reconcile(scope.userUnion);
    void folder.reconcileFolder(scope.folder, scope.userVisible);
    this.refreshActiveTools();
  }

  setMcpStatusListener(listener: () => void): void {
    this._mcpStatusListener = listener;
  }

  /** Reconnect (or run the OAuth flow for a needs-auth server); refresh the active set on success. */
  async reconnectMcpServerLive(serverName: string): Promise<boolean> {
    const manager = this.mcpClientManager();
    if (!manager) return false;
    const connected = await manager.reconnectOrAuthenticate(serverName);
    this.refreshActiveTools();
    return connected;
  }

  /** Clear the stored token and start a fresh interactive login; refresh the active set on success. */
  async reauthenticateMcpServerLive(serverName: string): Promise<boolean> {
    const manager = this.mcpClientManager();
    if (!manager) return false;
    const connected = await manager.reauthenticate(serverName);
    this.refreshActiveTools();
    return connected;
  }

  /** Clear the stored token and disconnect (server drops to needs-auth). */
  async signOutMcpServerLive(serverName: string): Promise<void> {
    const manager = this.mcpClientManager();
    if (!manager) return;
    await manager.signOut(serverName);
    this.refreshActiveTools();
  }

  // ---- checkpoints / cost / rewind ----------------------------------------

  private createCheckpointService(sessionId: string): CheckpointService {
    const settings = this.options.platform.settings;
    return new CheckpointService({
      cwd: this.cwd,
      sessionId,
      onCheckpointReady: (id) => this.addCheckpoint(id),
      persist: (record) => this.persistCheckpointRecord(sessionId, record),
      onBaselineTimeout: (waitedMs) => this.emit({
        type: "notification",
        notificationType: "warning",
        message: t("A file change ran before this turn's checkpoint was ready (waited {0} s), so this turn cannot be rewound.", Math.round(waitedMs / 1000)),
      }),
      baselineWaitMs: () => checkpointBaselineWaitMs(settings),
      maxFileSizeBytes: () => checkpointMaxFileSizeBytes(settings),
    });
  }

  /**
   * Append a checkpoint record minted in the background. Only while this panel still holds `sessionId` as
   * its live session: a delete, switch, lost lease or dispose first moves the runtime off it, so a late
   * record never reaches a deleted file or another process's session. Lands at the leaf; readers match
   * records by `userEntryId`, never by position.
   */
  /**
   * Record what a Stop cut short once the aborted run has settled, so a reload shows it as the live view
   * did. Same liveness rule as `persistCheckpointRecord`: never after a delete, switch or lost lease.
   */
  private persistTurnStopped(sessionId: string, leafAtStop: string | null, abandoned: readonly string[]): void {
    const session = this.runtime?.session;
    if (!session || session.sessionId !== sessionId || this.lostLeases.has(sessionId)) return;
    const record = turnStoppedRecord(session.sessionManager.getBranch(), leafAtStop, abandoned);
    if (!record) return;
    try {
      session.sessionManager.appendCustomEntry(DAMOCLES_TURN_STOPPED_ENTRY, record);
    } catch (err) {
      log("[PiSession] recording the stopped turn failed: %O", err);
    }
  }

  private persistCheckpointRecord(sessionId: string, record: StoredCheckpointRecord): boolean {
    const session = this.runtime?.session;
    if (!session || session.sessionId !== sessionId || this.lostLeases.has(sessionId)) return false;
    session.sessionManager.appendCustomEntry(DAMOCLES_CHECKPOINT_ENTRY, record);
    return true;
  }

  /** The gate's checkpoint for this panel and every agent it spawned, which reads the live service at each wait; none when the chat takes no checkpoints. */
  private checkpointBaselineField(): { checkpointBaseline?: CheckpointBaselineGate } {
    if (!this.fileCheckpoints) return {};
    return {
      checkpointBaseline: {
        folder: this.cwd,
        wait: (signal, toolName) => this.checkpointService?.awaitBaseline(signal, toolName) ?? Promise.resolve(),
      },
    };
  }

  get fileCheckpoints(): boolean {
    return this.options.projectScope;
  }

  seedCheckpoints(userMessageIds: Iterable<string>): void {
    for (const id of userMessageIds) this.checkpointUserIds.add(id);
    this.broadcastCheckpointInfo();
  }

  /** Mark a turn's user entry id as rewindable and push the updated set to the webview (US-013b). */
  private addCheckpoint(userEntryId: string): void {
    this.checkpointUserIds.add(userEntryId);
    this.broadcastCheckpointInfo();
  }

  /** Push the authoritative rewindable user-entry-id set, suppressing no-op re-emits. */
  private broadcastCheckpointInfo(): void {
    const size = this.checkpointUserIds.size;
    if (size === this.lastCheckpointBroadcast) return;
    this.lastCheckpointBroadcast = size;
    this.emit({ type: "checkpointInfo", userMessageIds: [...this.checkpointUserIds] });
  }
  getAccumulatedCost(): number {
    return this.adapter.accumulatedCost;
  }

  /**
   * Rewind to an earlier turn (US-013c). `userMessageId` is the pi user entry id; it resolves to the
   * matching `damocles-checkpoint` entry, then:
   *  - `code-only`: full snapshot restore of the workspace to that turn's `beforeCommit`
   *    (`AutoCheckpointProducer.restore`), unconditionally; protected files are never touched and a
   *    failed restore rolls back. Conversation kept.
   *  - `fork-conversation`: branch the pi tree at the user message's parent → a new truncated session
   *    that owns refs to (or a clone of) the checkpoints it inherits, opened in a new panel with the
   *    prompt prefilled. No file restore.
   *  - `fork-and-rewind-code`: both — restore the files AND spawn the forked panel.
   * All failures fail soft to `rewindError` (FR-6).
   */
  async rewindFiles(userMessageId: string, option: RewindOption = "code-only", promptContent?: string): Promise<void> {
    const session = await this.sessionForRewind();
    if (!session) return;
    try {
      const sm = session.sessionManager;
      const checkpoints = getCheckpointEntries(sm.getBranch(sm.getLeafId() ?? undefined));
      const entry = [...checkpoints].reverse().find((c) => c.userEntryId === userMessageId) ?? null;
      const needsFileRewind = option === "code-only" || option === "fork-and-rewind-code";
      const needsFork = option === "fork-conversation" || option === "fork-and-rewind-code";

      if (needsFileRewind) {
        if (!this.fileCheckpoints) {
          this.emit({ type: "rewindError", message: noProjectRewindMessage() });
          return;
        }
        if (!entry) {
          const notRewindable = getNotRewindableEntries(sm.getEntries()).find((r) => r.userEntryId === userMessageId);
          this.emit({
            type: "rewindError",
            message: notRewindable ? notRewindableMessage(notRewindable) : t("No checkpoint exists for this message"),
          });
          return;
        }
        // Restore the workspace to the turn's pre-message state from the repo the entry names: recreate
        // files deleted since and drop files created after, unconditionally, while files over the size
        // cap, ignored, or skipped by that checkpoint are left exactly as they are.
        const service = this.checkpointService;
        const result: ServiceRestoreResult = service
          ? await service.restore(entry, sm, AbortSignal.timeout(RESTORE_WAIT_MS))
          : { ok: false, reason: "service-unavailable", preRewind: null };
        if (!result.ok) {
          this.emit({ type: "rewindError", message: restoreErrorMessage(result) });
          return;
        }
      }

      if (needsFork) {
        // The anchor may be any tree entry — a user message (message rewind) or a compaction entry
        // (rewind-to-before-compaction). Guard only a genuinely missing anchor (FR-7): a stale/unknown
        // id can't be resolved to a tree node. A null `parentId` is NOT an error — it means the anchor
        // is the root (forking the very first message), which spawnPiFork handles by forwarding
        // `forkAtUuid: null` (fresh panel, no branched file). A compaction entry always has a parent, so
        // it never hits the root case anyway.
        if (!sm.getEntry(userMessageId)) {
          this.emit({ type: "rewindError", message: t("This rewind point can't be resolved. The session may have changed.") });
          return;
        }
        await this.spawnPiFork(session, userMessageId, promptContent);
        return;
      }

      this.emit({
        type: "rewindComplete",
        rewindToMessageId: userMessageId,
        option,
        ...(promptContent ? { promptContent } : {}),
      });
    } catch (err) {
      this.emit({ type: "rewindError", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Undo a rewind: put back the files its pre-rewind snapshot `preRewindId` kept, through the same
   * protections as a rewind. Files only; the conversation tree is untouched. The undo keeps its own
   * pre-rewind snapshot, so it can be undone in turn.
   */
  async undoRewind(preRewindId: string): Promise<void> {
    const session = await this.sessionForRewind();
    if (!session) return;
    try {
      if (!this.fileCheckpoints) {
        this.emit({ type: "rewindError", message: noProjectRewindMessage() });
        return;
      }
      const sm = session.sessionManager;
      const record = getPreRewindEntries(sm.getEntries()).find((r) => r.id === preRewindId);
      if (!record) {
        this.emit({ type: "rewindError", message: t("This restore point no longer exists.") });
        return;
      }
      const service = this.checkpointService;
      const result: ServiceRestoreResult = service
        ? await service.restorePreRewind(record, sm, AbortSignal.timeout(RESTORE_WAIT_MS))
        : { ok: false, reason: "service-unavailable", preRewind: null };
      this.emit(result.ok ? { type: "rewindUndone" } : { type: "rewindError", message: restoreErrorMessage(result) });
    } catch (err) {
      this.emit({ type: "rewindError", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The live session a rewind or undo acts on, started if the panel was only resumed; null after telling the user why not. */
  private async sessionForRewind(): Promise<AgentSession | null> {
    // A resumed panel may not have run start() yet, so the live session (and its tree of checkpoint
    // entries) may not exist; start it (which opens the resumed file) before rewinding.
    try {
      await this.ensureStarted();
    } catch (err) {
      this.emit({ type: "rewindError", message: t("Failed to start the session: {0}", err instanceof Error ? err.message : String(err)) });
      return null;
    }
    const session = this.runtime?.session ?? null;
    if (!session) this.emit({ type: "rewindError", message: t("No active session to rewind.") });
    return session;
  }

  /** Copy the subagent and team data the fork's branch invoked into the fork's subtree. Never throws. */
  private async copyAgentDataToFork(pi: PiCodingAgentModule, sourceSm: AgentSession["sessionManager"], forkLeafId: string, targetSessionId: string): Promise<void> {
    let failures: Error[];
    try {
      // The fork point is the fork leaf's timestamp: the fork's conversation ends there, so its agents do too.
      const forkPointMs = Date.parse(sourceSm.getEntry(forkLeafId)?.timestamp ?? "");
      if (!Number.isFinite(forkPointMs)) throw new Error(`the fork entry ${forkLeafId} has no timestamp`);
      failures = await copyForkAgentData({
        SessionManager: pi.SessionManager,
        sessionDir: ensurePiSessionDir(this.cwd),
        sourceSessionId: sourceSm.getSessionId(),
        targetSessionId,
        branch: sourceSm.getBranch(forkLeafId),
        forkPointMs,
      });
    } catch (err) {
      failures = [err instanceof Error ? err : new Error(String(err))];
    }
    if (failures.length === 0) return;
    for (const failure of failures) log("[PiSession] copying agent data to the fork failed: %O", failure);
    this.emit({
      type: "notification",
      message: "Some subagent or team history could not be copied into the fork; those cards may be incomplete and cannot be resumed there.",
      notificationType: "warning",
    });
  }

  /**
   * Give the fork every checkpoint record of a turn it inherits, and its own refs to their folder-repo
   * commits. A record is appended after its turn settles, so it can sit past the fork point (after a
   * later prompt) in the source file; any such record is appended to the branched file. The pending copy
   * is recorded without the folder lock before this resolves, and the refs are copied after: the lock can
   * be held for minutes by another conversation's first baseline, and the copy checks every object under
   * that lock when it runs.
   */
  private async carryCheckpointsToFork(
    pi: PiCodingAgentModule,
    sourceSm: AgentSession["sessionManager"],
    forkLeafId: string,
    branchedPath: string,
    childSessionId: string,
  ): Promise<void> {
    const inherited = sourceSm.getBranch(forkLeafId);
    const anchorIds = new Set(inherited.map((e) => e.id));
    const recordKey = (r: CheckpointRecord): string => JSON.stringify(r);
    const present = new Set(getCheckpointRecords(inherited).map(recordKey));
    const missing = getCheckpointRecords(sourceSm.getEntries()).filter((r) => anchorIds.has(r.userEntryId) && !present.has(recordKey(r)));
    if (missing.length > 0) {
      const childSm = pi.SessionManager.open(branchedPath, ensurePiSessionDir(this.cwd));
      for (const record of missing) childSm.appendCustomEntry(DAMOCLES_CHECKPOINT_ENTRY, record);
    }
    const folderEntries = [...getCheckpointRecords(inherited), ...missing].filter((r): r is CheckpointEntryV3 => r.kind === "checkpoint" && r.v === 3);
    if (folderEntries.length > 0) {
      await markForkCopyPending(childSessionId, branchedPath, new Set(folderEntries.map((e) => e.folderId)))
        .catch((err: unknown) => log("[PiSession] recording the fork's pending checkpoint copy failed: %O", err));
      copyCheckpointRefs(this.cwd, childSessionId, branchedPath, folderEntries)
        .catch((err: unknown) => log("[PiSession] copying checkpoint refs into the fork failed: %O", err));
    }
  }

  /** Branch the pi conversation at the user message's parent and open it in a new forked panel. */
  private async spawnPiFork(session: AgentSession, userEntryId: string, promptContent?: string): Promise<void> {
    const onSpawnFork = this.options.onSpawnFork;
    if (!onSpawnFork) {
      this.emit({ type: "rewindError", message: "Fork is unavailable" });
      return;
    }
    const liveSm = session.sessionManager;
    const parentId = liveSm.getEntry(userEntryId)?.parentId ?? null;
    // Capture the source identity BEFORE branching: createBranchedSession reassigns sessionId/sessionFile
    // on whatever manager it runs on, so it must run on a throwaway manager opened on the source file —
    // never the live one (which would corrupt the source session and misdirect the checkpoint clone).
    const sourceFile = liveSm.getSessionFile();
    const sourceSessionId = this.currentSessionId ?? "";

    let piBranchedSessionId: string | undefined;
    if (parentId && sourceFile) {
      const pi = getPiCodingAgent();
      // A branch whose root→parent path holds no user or assistant message has nothing to replay, and
      // pi writes a branched file only once it holds one (`SessionManager._hasConversation`), so
      // resuming it would fail "file not found". This is the case when forking the very first user
      // message, whose only ancestors are the header + model/thinking-level metadata. Treat it as a
      // fresh-panel fork: leave `piBranchedSessionId` unset so `start()` creates a fresh session and
      // `showForked` skips history replay (the rewound prompt, if any, still prefills).
      // `getBranch(parentId)` returns the exact root→parent path pi would branch on.
      const branchHasConversation = pi
        ? liveSm.getBranch(parentId).some((e) => {
            const role = e.type === "message" ? (e as { message?: { role?: string } }).message?.role : undefined;
            return role === "user" || role === "assistant";
          })
        : false;
      if (pi && branchHasConversation) {
        // Branch on a fresh manager reading the source file so the live session is left intact (mirrors
        // pi's own AgentSessionRuntime.fork). Truncate at the parent so the prefilled prompt re-sends
        // the rewound message.
        const branchSm = pi.SessionManager.open(sourceFile, ensurePiSessionDir(this.cwd));
        const branchedPath = branchSm.createBranchedSession(parentId);
        if (branchedPath) {
          piBranchedSessionId = piSessionIdFromFile(branchedPath);
          if (this.fileCheckpoints) {
            try {
              const srcGit = getGitDir(getRepoDir(sourceFile));
              if (existsSync(srcGit)) await RepoManager.cloneFrom(srcGit, getGitDir(getRepoDir(branchedPath)));
            } catch (err) {
              log("[PiSession] checkpoint repo clone-on-fork failed: %O", err);
            }
            try {
              await this.carryCheckpointsToFork(pi, liveSm, parentId, branchedPath, piBranchedSessionId);
            } catch (err) {
              log("[PiSession] carrying checkpoints into the fork failed: %O", err);
            }
          }
          await this.copyAgentDataToFork(pi, liveSm, parentId, piBranchedSessionId);
          try {
            await this.options.memoryService?.copySessionInjections(
              liveSm.getSessionId(),
              piBranchedSessionId,
              nextPromptIndex(liveSm.getBranch(parentId)),
            );
          } catch (err) {
            log("[PiSession] copying injection records to the fork failed: %O", err);
            this.emit({
              type: "notification",
              message: "The injected context of the prompts the fork inherited could not be copied; View Context may be empty for them there.",
              notificationType: "warning",
            });
          }
        }
      }
    }
    this.emitForkHook(parentId, sourceSessionId, sourceFile, piBranchedSessionId);
    await onSpawnFork({
      sourceSdkSessionId: sourceSessionId,
      forkAtUuid: parentId,
      userMessageId: userEntryId,
      ...(promptContent ? { promptContent } : {}),
      sourcePanelId: this.options.panelId ?? "",
      ...(piBranchedSessionId ? { piBranchedSessionId } : {}),
    });
  }

  /**
   * Fire the Damocles-synthetic `session_before_fork` hook at the fork point. pi only emits this from its
   * in-place `ctx.fork()` command (a session switch), which Damocles never uses — it branches the session
   * file + opens a fresh panel — so Damocles supplies the event itself, like `permission_required` and
   * `subagent_end`. Observe-only, lazy (no cost unless a hook is configured), fail-soft.
   */
  private emitForkHook(entryId: string | null, parentSessionId: string, sourceFile: string | undefined, newSessionId: string | undefined): void {
    if (this.folder === null) return;
    const deps = this.folder.getHooksDispatchDeps();
    if (!deps.config.hasEntries("session_before_fork")) return;
    const payload = buildForkPayload(
      { session_id: parentSessionId, transcript_path: sourceFile ?? "", cwd: this.cwd },
      { parentSessionId, ...(entryId ? { entryId } : {}), ...(newSessionId ? { newSessionId } : {}) },
    );
    void dispatchObserveOnly(deps, "session_before_fork", this.cwd, payload).catch((err) =>
      log("[PiSession] session_before_fork hook failed: %O", err),
    );
  }

  // ---- context usage ------------------------------------------------------

  /**
   * Build the full `/context` breakdown for the pi path (US-CMD) so `ContextUsageOverlay.vue` renders
   * unchanged. Headline totals come from pi's `getContextUsage()` (fallback: the last assistant usage
   * snapshot); the per-message / per-tool breakdown, the system-prompt section, and the discovered
   * skills/commands/agents/MCP sections are estimated with pi's chars/4 heuristic. Sub-sections whose
   * data neither pi nor Damocles holds (memory injection, per-tool prompt snippets) are omitted rather
   * than fabricated. Mirrors the `{ reason: 'busy' }` / `{ reason: 'noQuery' }` early-returns.
   */
  async requestContextUsage(): Promise<void> {
    if (this.processingFlag) {
      this.emit({ type: "contextUsage", data: null, reason: "busy" });
      return;
    }
    try {
      await this.ensureStarted();
    } catch {
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
      return;
    }
    const session = this.runtime?.session;
    if (!session) {
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
      return;
    }
    try {
      const systemPrompt = await this.buildEffectiveSystemPrompt();
      this.emit({
        type: "contextUsage",
        data: buildContextUsage(session, systemPrompt, {
          maxTokens: this.contextWindowForCurrentModel(),
          modelValue: this.modelValue,
          autoCompact: this.autoCompactConfig(),
          resourceLoader: this.resourceLoader(),
          mcpEnabled: this.isMcpEnabled(),
          mcpClientManager: this.mcpClientManager(),
          agentRegistry: this.agentRegistry,
          eligibleToolNames: this.fullActiveToolNames(),
        }),
      });
    } catch (err) {
      log("[PiSession] requestContextUsage failed: %O", err);
      this.emit({ type: "contextUsage", data: null, reason: "noQuery" });
    }
  }

  /** The live effective system prompt, for the clickable `/context` system-prompt preview (US-021). */
  async getSystemPromptText(): Promise<string | undefined> {
    const sections = await this.buildEffectiveSystemPrompt();
    return sections ? renderSections(sections) || undefined : undefined;
  }

  /**
   * Reconstruct the effective Damocles system prompt from live state via the SAME assembly function the
   * `before_agent_start` turn path uses (US-021). pi holds the swapped prompt only in its per-turn
   * `_runSystemPromptOptions`, cleared when the run settles, so reading `session.systemPrompt` outside
   * a turn returns pi's boilerplate, so the `/context` preview/estimate must rebuild it instead of
   * reading that field.
   *
   * Lazily starts the session read-only first (mirrors `requestContextUsage`/`getSupportedCommands`) so
   * View Details on a never-started panel shows the real prompt; sends nothing to the model. Returns
   * undefined when the start failed (no live session), and also when a live-state read throws
   * (`getActiveToolNames`/`getPlanFilePath` reach into pi's session tree). Both callers rely on that
   * undefined arm: `getSystemPromptText`, which backs `openSystemPrompt` and has no local try/catch,
   * and the `/context` estimate. It NEVER falls back to `session.systemPrompt`: that would reintroduce
   * the pi-boilerplate bug this fixes. The loader reads and `findSessionPlanFiles` degrade to `[]`
   * internally; the outer guard covers the remaining throws.
   */
  private async buildEffectiveSystemPrompt(): Promise<DamoclesPromptSections | undefined> {
    await this.ensureStarted().catch(() => undefined);
    const session = this.runtime?.session;
    if (!session) return undefined;

    try {
      const planMode = this.options.permissionHandler.getPermissionMode() === "plan";
      const loader = this.resourceLoader();
      let contextFiles: BuildSystemPromptOptions["contextFiles"] = [];
      let skills: BuildSystemPromptOptions["skills"] = [];
      if (loader) {
        try {
          contextFiles = loader.getAgentsFiles().agentsFiles;
        } catch {
          contextFiles = [];
        }
        try {
          skills = loader.getSkills().skills;
        } catch {
          skills = [];
        }
      }
      // pi gates its own `<skills>` section on `read` OR `bash` and names the resolved tool in the
      // section's prose, so this preview must resolve it the same way the turn path does.
      const skillFileReadTool = resolveSkillFileReadTool(session.getActiveToolNames());

      return assembleDamoclesSystemPrompt({
        env: this.systemPromptEnv(),
        memoryEnabled: !!this.options.memoryService?.isEnabled,
        planMode,
        teamEnabled: !!this.options.teamService && this.isTeamEnabled(),
        webSearchEnabled: isWebSearchEnabled(),
        planFilePath: this.getPlanFilePath(),
        existingPlanFile: planMode ? undefined : (await findSessionPlanFiles(this.memorySessionId))[0],
        contextFiles,
        skills,
        skillFileReadTool,
      });
    } catch (err) {
      log("[PiSession] buildEffectiveSystemPrompt failed: %O", err);
      return undefined;
    }
  }

  /** Markdown for an MCP tool's info (name/server/description/schema), for the `/context` preview. */
  getMcpToolInfoMarkdown(piName: string): string | undefined {
    const d = this.mcpClientManager()?.getToolDescriptor(piName);
    if (!d) return undefined;
    const lines = [`# ${d.piName}`, "", `**Server:** ${d.serverName}`];
    if (d.readOnly !== undefined) lines.push(`**Read-only:** ${d.readOnly ? "yes" : "no"}`);
    if (d.description) lines.push("", d.description);
    if (d.inputSchema !== undefined) {
      lines.push("", "## Input schema", "", "```json", JSON.stringify(d.inputSchema, null, 2), "```");
    }
    return `${lines.join("\n")}\n`;
  }

  /** The resource loader, or null before the runtime initializes. */
  private resourceLoader(): import("@earendil-works/pi-coding-agent").ResourceLoader | null {
    return this.folder?.services.resourceLoader ?? null;
  }

  // ---- btw / team (deferred) ----------------------------------------------

  /**
   * Answer a `/btw` side question as an ephemeral, single-turn, tool-less aside on the panel's active
   * model (US-025). It shares the full current conversation branch (char-capped, oldest dropped first)
   * via the system prompt context, streams its answer, then disposes — nothing is persisted to the
   * session store or checkpoints. Runs as a nested `createSubagentSession` (own prompt + zero tools), not
   * a main session, so it never carries the Damocles toolset or writes to disk.
   */
  async sendBtw(btwId: string, question: string): Promise<void> {
    try {
      await this.ensureStarted();
    } catch (err) {
      this.emit({ type: "btwError", btwId, message: `pi failed to start: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const piRuntime = PiRuntime.get();
    const modelRuntime = piRuntime.modelRuntime;
    const folder = this.folder;
    if (!modelRuntime || !folder || !this.runtime) {
      this.emit({ type: "btwError", btwId, message: "Start a conversation first" });
      return;
    }
    const resolution = resolvePiModel(this.modelValue, modelRuntime, piRuntime.getOpenAIAuthStatus(), this.preferOpenAIApiKey());
    if (!resolution.model || resolution.authed === false) {
      this.emit({ type: "btwError", btwId, message: `Model ${this.modelValue} is unavailable for btw` });
      return;
    }

    const liveSession = this.runtime?.session;
    const contextBlock = liveSession ? buildBtwContextBlock(liveSession) : "";
    const prompt = contextBlock ? `<conversation_context>\n${contextBlock}\n</conversation_context>\n\n${question}` : question;

    const ac = new AbortController();
    let session: AgentSession;
    try {
      session = await folder.createSubagentSession({
        cwd: this.cwd,
        systemPrompt: BTW_SYSTEM_PROMPT,
        model: resolution.model,
        tools: [],
        customTools: [],
        excludeTools: [],
        extensionFactory: (pi) => { registerTurnEndImagePruning(pi); registerAgentStartImageReconcile(pi); },
        store: { kind: "memory" },
      });
    } catch (err) {
      this.emit({ type: "btwError", btwId, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.btwSessions.set(btwId, { session, ac });

    let streamed = "";
    const attribution = { cwd: this.cwd, ...(liveSession ? { sessionId: liveSession.sessionId } : {}) };
    const unsub = session.subscribe((event) => {
      // The aside runs on an in-memory session, so the ledger is the only record of what it billed.
      if (event.type === "message_end" && event.message.role === "assistant") appendSubCallUsage(event.message, "btw", attribution);
      if (event.type === "message_start" && event.message.role === "assistant") streamed = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        streamed += event.assistantMessageEvent.delta;
        if (!ac.signal.aborted) this.emit({ type: "btwStreaming", btwId, text: streamed });
      }
    });

    try {
      await session.prompt(prompt);
      if (!ac.signal.aborted) {
        const finalText = (streamed.trim() || session.getLastAssistantText() || "").trim();
        if (finalText) this.emit({ type: "btwComplete", btwId, text: finalText });
        else this.emit({ type: "btwError", btwId, message: "No response received" });
      }
    } catch (err) {
      if (!ac.signal.aborted) this.emit({ type: "btwError", btwId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      unsub();
      this.btwSessions.delete(btwId);
      folder.forgetSubagentSession(session);
    }
  }

  cancelBtw(btwId: string): void {
    const entry = this.btwSessions.get(btwId);
    if (!entry) return;
    entry.ac.abort();
    void entry.session.abort().catch(() => {});
  }

  async getMemoryInjection(promptIndex: number): Promise<MemoryInjectionDisplay | undefined> {
    const memory = this.options.memoryService;
    if (!memory?.isEnabled || !this.registeredSessionId) return undefined;
    await memory.ensureInitialized();
    return memory.getPersistedMemoryInjection(this.registeredSessionId, promptIndex);
  }

  get teamService(): TeamService | undefined {
    return this.options.teamService;
  }

  // ---- team (Phase 9, US-024) ---------------------------------------------

  /** The model-resolution inputs for the team role resolver (read live each call). Reads the six flat
   *  `damocles.team.*Model`/`*Effort` settings fresh; each model value goes through
   *  `migrateLegacyModelValue` so a stored value for a removed model does not permanently block a team,
   *  and each effort is parsed + run through `migrateLegacyEffortValue` so a renamed level (e.g. DeepSeek
   *  `xhigh → max`) migrates instead of silently coercing to null. */
  private teamModelDeps(): TeamModelDeps {
    const piRuntime = PiRuntime.get();
    const registry = piRuntime.modelRuntime;
    if (!registry) throw new Error("pi runtime not initialized");
    const settings = this.options.platform.settings;
    const activeModel = this.modelValue;
    const roleSetting = (role: TeamRole): TeamRoleSetting => {
      const model = migrateLegacyModelValue(settings.get<string>(`damocles.team.${role}Model`, '', this.options.settingsFolder));
      // Validate the stored effort (no unchecked cast) and apply the effective model's pi-metadata rename
      // (e.g. DeepSeek xhigh → max in 0.80.6) so a renamed level migrates instead of silently coercing to
      // null. The effort applies against the role's model if set, else the active panel model.
      const parsed = parseEffortLevel(settings.get<string>(`damocles.team.${role}Effort`, '', this.options.settingsFolder));
      const effort: EffortLevel | null =
        parsed === null ? null : migrateLegacyEffortValue(model !== '' ? model : activeModel, parsed);
      return { model, effort };
    };
    return {
      registry,
      openai: piRuntime.getOpenAIAuthStatus(),
      preferApiKey: this.preferOpenAIApiKey(),
      activeModel,
      claudeAuthMode: piRuntime.getClaudeAuthStatus().mode,
      supportedModels: this.supportedModelsCache,
      roleSettings: {
        lead: roleSetting('lead'),
        implementor: roleSetting('implementor'),
        reviewer: roleSetting('reviewer'),
      },
    };
  }

  /** Resolve a team role's model + reasoning depth from the user's per-role settings (Slice 1). A
   *  configured-but-unresolvable/unauthed slot returns `{ error }`; an unset slot fails soft to the
   *  active panel model. */
  resolveTeamRole(role: TeamRole): ResolvedTeamModel {
    return resolveRoleModel(role, this.teamModelDeps());
  }

  /**
   * Build the pi-native team engine (US-024d): how to create/dispose a nested team agent session, the
   * agent active-set tool names + customTools (built-ins + module tools + the `team_*` tools), the
   * gate-routing extension factory (inherit-parent-mode central gate), and the budget cost rollup.
   */
  buildTeamEngine(): TeamEngine {
    const pi = getPiCodingAgent();
    if (!pi) throw new Error("pi runtime not loaded");
    const folder = this.requireFolder();
    const nested = this.trackedNestedSessions(folder);
    return {
      ...nested,
      // A team agent's plan directive is frozen in its system prompt, while its gate reads the live mode.
      createSession: async (opts) => {
        const statement = teamPlanModeStatement(opts.role);
        const isPlanMode = (): boolean => this.isPlanMode();
        const session = await nested.createSession({
          ...opts,
          extensionFactory: async (pi) => {
            await opts.extensionFactory(pi);
            pi.on("before_agent_start", (event, ctx) => {
              const message = planModeNoticeAtPromptStart(ctx.sessionManager.buildSessionProjection().messages, event.systemPromptOptions, isPlanMode(), statement);
              return message ? { message } : undefined;
            });
          },
        });
        installPlanModeChangeNotice(session.agent, isPlanMode, statement);
        return session;
      },
      // ONE call per spawn for all three: the agent's names, its customTools (with the MCP definitions
      // appended, exactly as the `team_*` tools are) and the frozen snapshot everything else derives
      // from. `mcp.names` is NOT in `toolNames` — the caller concatenates them, so there is exactly one
      // source of MCP names per spawn.
      buildAgentToolset: (ctx) => {
        const mcp = this.buildNestedMcp(pi, {
          agent: { agentId: ctx.agentId, agentName: ctx.agentName, teamId: ctx.teamId },
        });
        const isWrite = (name: string): boolean => toolCategory(mapPiToolName(name)) === "write";
        const roleNames = this.teamAgentToolNames(ctx);
        const toolNames = ctx.kind === "reviewer" ? roleNames.filter((name) => !isWrite(name)) : roleNames;
        return {
          toolNames,
          customTools: [...this.buildTeamAgentCustomTools(pi, ctx), ...mcp.tools],
          mcp,
          // From the resolved names, never from `kind`, so no path pairs a write tool with an open shell.
          readOnly: !toolNames.some(isWrite),
        };
      },
      buildExtensionFactory: (agent, mcp, readOnly) => createSubagentExtensionFactory({
        permissionHandler: this.options.permissionHandler,
        isPlanMode: () => this.options.permissionHandler.getPermissionMode() === "plan",
        ...this.checkpointBaselineField(),
        shellCancel: this.shellCancel.forContext(this.noteDeliveryForTeamAgent(agent)),
        readOnlyShell: readOnly,
        parentToolUseId: agent.agentId,
        // `buildExtensionFactory` is invoked PER AGENT SPAWN, not once at buildTeamEngine() time, so
        // `teamAgentBaseToolNames()` must be called HERE to read live panel state at spawn. Hoisting it
        // to a buildTeamEngine local would freeze the deferrable set at team-construction time and
        // silently miss a subsystem the user toggled on mid-run.
        //
        // The base set, not the role-filtered one: `team_*` names are in no deferrable group, so they
        // are intersected away regardless of role and the factory needs no role to be correct.
        //
        // The MCP half comes from the `mcp` snapshot the SAME spawn already took, never from a second
        // read: the ToolSearch inventory a nested agent is shown must be exactly what its session can
        // load, and two reads is how those drift.
        //
        // `mcp.names` must be in the first argument and `mcp.deferrable` in the second.
        // `deferredToolNames(eligible, mcpNames)` builds `BUILTIN ∪ mcpNames` and then INTERSECTS it
        // with `eligible` — that intersection is the point (a tool the user disabled is absent from
        // `eligible` and so can never be resurrected by ToolSearch), but it also means a name missing
        // from `eligible` is dropped. Since `teamAgentBaseToolNames()` deliberately excludes every
        // `mcp__*`, passing it alone yields the built-in groups and ZERO MCP: the agent would hold
        // `mcp__*` in `tools:` with real definitions in `customTools`, held INACTIVE by the runtime
        // baseline, yet never advertised by its own ToolSearch and unreachable through it
        // (`resolveToolSearchEntries` → "Unknown entries"). This mirrors the
        // `tools: [...toolNames, ...mcp.names]` the caller builds from the same snapshot. Always-loaded
        // tools are in `mcp.names` but not `mcp.deferrable`, so they are active and never on the menu.
        deferrableToolNames: deferredToolNames([...this.teamAgentBaseToolNames(), ...mcp.names], mcp.deferrable),
        mcpDescriptions: mcp.descriptions,
        directMcpGroups: mcp.directGroups,
        isMcpReadOnly: mcp.isReadOnly,
        mcpToolIdentity: mcp.identity,
        hooks: folder.getHooksDispatchDeps(),
      }),
      onAgentCost: (delta) => this.adapter.addExternalCost(delta),
      disposeBrowserScope: (scopeId, closeTabs) => this.options.browserService?.disposeScope(scopeId, closeTabs),
      cancelAgentDialogs: (agentId) => this.uiContext.cancelAgentDialogs(agentId),
    };
  }

  /**
   * A team agent's tool names WITHOUT its `team_*` set: the panel's full active set MINUS the subagent
   * tools, the main team tools (a team agent never spawns subagents or nested teams, the recursion
   * block), the plan-mode tools (plan mode is a top-level panel concern, a team agent never enters or
   * exits it), `GenerateImage` (main session only), and every `mcp__*` name.
   *
   * MCP is excluded HERE and re-added by the caller from the spawn's frozen `NestedMcpToolset`, so the
   * `mcp__*` names in `tools:` and the definitions in `customTools` come from ONE read. Leaving them in
   * would mean two independent sources of MCP names in one spawn — which is how team agents used to
   * pass names the nested registry had no definition for, and pi drops those SILENTLY.
   */
  private teamAgentBaseToolNames(): string[] {
    const exclude = new Set<string>([
      ...SUBAGENT_PI_TOOL_NAMES,
      ...TEAM_MAIN_PI_TOOL_NAMES,
      ...PLAN_MODE_TOOLS,
      ...IMAGE_PI_TOOL_NAMES,
    ]);
    return this.fullActiveToolNames().filter((name) => !exclude.has(name) && !isMcpToolName(name));
  }

  /**
   * A team agent's active-set tool names: the base set plus the `team_*` tools its role and kind may
   * call. The definitions come from `buildTeamAgentPiTools`, which reads the same `teamAgentPiToolNames`,
   * so both halves of the spawn read one split. A name here with no matching definition is dropped
   * SILENTLY by pi, which is why the context reaches both and not just one.
   */
  private teamAgentToolNames(agent: Pick<AgentMcpContext, "role" | "kind">): string[] {
    return this.teamAgentBaseToolNames().concat(teamAgentPiToolNames(agent));
  }

  /** Build a team agent's customTools: the subagent custom set (no subagent tools) + its `team_*` tools.
   *  `ctx.browserScopeId` (per LAUNCH, not per agent) isolates this team agent's browser tools to its OWN
   *  tab scope, so a redispatched specialist never inherits the failed attempt's tabs. `cwd` reaches the
   *  team tools because `team_record_verification` fingerprints the working tree itself. */
  private buildTeamAgentCustomTools(pi: PiCodingAgentModule, ctx: AgentMcpContext): ToolDefinition[] {
    return [...this.buildSubagentCustomTools(pi, this.noteDeliveryForTeamAgent(ctx), ctx.browserScopeId), ...buildTeamAgentPiTools(pi, ctx, this.cwd)];
  }

  /**
   * The plan-file path this session WRITES to (FR-4): `computePlanFilePath(sessionId, firstMsg)`, where
   * `firstMsg` is this session's first non-synthetic user message as the user TYPED it — the readable
   * slug. `extractFirstUserMessage` resolves the original (sidecar text for an expanded slash command,
   * IDE-context-stripped stored text otherwise); the `_firstUserMessage` fallback captures the same
   * original typed text in `sendMessage`, so both agree and the slug is stable across the session's turns.
   * Consumers (view, delete) don't recompute the slug; they match on the stable `-<id8>` suffix via
   * `findSessionPlanFiles`, so a write that happened before the slug settled is still found. Falls back to
   * `panelId` before an id.
   */
  getPlanFilePath(): string {
    const sessionId = this.currentSessionId ?? this.options.panelId ?? "";
    const session = this.runtime?.session;
    let firstMessage = "";
    if (session) {
      const sm = session.sessionManager;
      firstMessage = extractFirstUserMessage(sm.getBranch(sm.getLeafId() ?? undefined));
    }
    // Before the first user message is committed to the branch (first-turn before_agent_start), fall
    // back to the message captured in sendMessage so the path matches the resolver's preview-based one.
    if (!firstMessage) firstMessage = this._firstUserMessage ?? "";
    return computePlanFilePath(sessionId, firstMessage);
  }

  /**
   * The canonical on-disk plan content for this session, located by the stable `-<id8>` suffix (same
   * lookup as view/delete, so it survives the first-message slug drifting). This is the single source of
   * truth for plan approval/handoff. Returns `null` ONLY when the session has no plan file. A read that
   * fails after the file was located (a transient EBUSY/EMFILE, a permission error) PROPAGATES rather
   * than being masked as `null` — so a present-but-unreadable plan never silently degrades into the
   * "no plan, re-run it" path while the file is sitting right there.
   */
  async getPlanContent(): Promise<string | null> {
    const sessionId = this.currentSessionId ?? this.options.panelId ?? "";
    const file = (await findSessionPlanFiles(sessionId))[0];
    if (!file) return null;
    return await fs.promises.readFile(file, "utf8");
  }

  /**
   * The session's EXISTING plan file on disk (newest by mtime, located by the stable `-<id8>` suffix —
   * the same resolver `getPlanContent` uses), or null when the session has never bound a plan. Bind-plan
   * writes to this path so it overwrites the in-use file in place instead of the recomputed slug path,
   * which would otherwise create an orphan sharing the same suffix.
   */
  async getActivePlanFilePath(): Promise<string | null> {
    const sessionId = this.currentSessionId ?? this.options.panelId ?? "";
    return (await findSessionPlanFiles(sessionId))[0] ?? null;
  }

  // ---- helpers ------------------------------------------------------------

  private emit(m: ExtensionToWebviewMessage): void {
    if (this._disposed) return;
    this.options.onMessage(m);
  }

  /** The pi thinking level for the next turn: forced off when bracketed by disableThinkingForNextQuery,
   * else mapped from the panel's resolved effort for the active model. */
  private resolveThinkingLevel(): ThinkingLevel {
    if (this.thinkingDisabledNextQuery) return "off";
    return effortToThinkingLevel(this.options.resolveThinking(this.modelValue));
  }

  private contextWindowForCurrentModel(): number {
    // Prefer the RESOLVED pi model's window: it is provider-accurate, whereas the curated catalog
    // carries one value per model id, and a GPT model is served by two providers (API key and Codex
    // subscription) whose windows pi has set differently before. Catalog value is the fallback for a
    // not-yet-resolved model (its 272k is the conservative floor).
    return this.desiredModel?.contextWindow ?? this.getModelInfo(this.modelValue)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * The hard budget limit to enforce on this turn (US-008), or `null` when no dollar enforcement
   * applies. pi has no `maxBudgetUsd` to pass through, so Damocles enforces it itself. Read live so a
   * mid-session settings change applies on the next check. Gated to dollar-metered billing modes —
   * subscription/allowance has no per-call dollar cost, so it shows token-based usage only.
   */
  private budgetLimitForEnforcement(): number | null {
    if (!this.dollarBilled()) return null;
    const max = this.options.platform.settings.get<number | null>("damocles.maxBudgetUsd", null, this.options.settingsFolder);
    return max && max > 0 ? max : null;
  }

  /** Whether the active credential is dollar-metered (API key or extra-usage), vs a flat subscription. */
  private dollarBilled(): boolean {
    return dollarBilledFrom(this.accountBillingDeps(PiRuntime.get()));
  }

  /** The conversation's own spend, without the entries a fork copied from its parent. */
  private ownSessionCost(): number {
    return this.runtime ? ownSessionUsage(this.runtime.session.sessionManager).cost : 0;
  }

  /**
   * The session's cumulative spend: the conversation's own cost PLUS the subagent cost rolled into the
   * adapter. This must stay the exact total `enforceBudgetInFlight` measures — a gate that measured less
   * than the enforcer would admit a turn the enforcer had already stopped. Resets with a new pi session.
   */
  private cumulativeCostUsd(): number {
    return this.ownSessionCost() + this.adapter.externalCost;
  }

  /**
   * Stop the in-flight turn because the hard budget limit was crossed (US-008 in-flight enforcement).
   * Graceful, not an abort: the flag makes the `finishTurn` decider end the turn at the next model
   * round-trip, so the assistant message and its tool results complete and the run settles normally
   * (which already emits done/result/processing:false/idle) — no torn stream and
   * no `sessionCancelled`. Background subagents are killed outright because they run outside the
   * parent's round-trip boundaries, so the decider never sees them.
   *
   * Overshoot is bounded to one round-trip OF THE PARENT LOOP, and that round-trip's own spend is not
   * bounded: enforcement fires at `message_end`, which pi emits BEFORE it executes the message's tool
   * calls, so those tools still run — including an `Agent`/`create_team` call that spawns agents this
   * `abortAll()` never saw. Auto-compaction does not add to that: pi reaches `prepareNextTurn` only at
   * the top of the next inner-loop iteration (`@earendil-works/pi-agent-core@^0.99.2`,
   * `agent-loop.ts:185-189`), and a decider answering `{ action: 'end' }` returns from the loop at
   * `:286-291` before it. So the bound is the tool calls of the message that tripped the limit and
   * nothing else.
   * And an in-flight TEAM keeps running to completion: unlike `beginAbort`, this
   * deliberately does not `cancelActiveTeam()` (product decision), so a team can exceed the limit without
   * a bound. The pre-prompt budget block refuses the NEXT turn.
   */
  private stopForBudget(): void {
    if (!this.processingFlag || this._budgetStopRequested) return;
    this._budgetStopRequested = true;
    this.subagentManager?.abortAll("budget");
    // A queued steer would force one more billed round trip past the limit: the loop itself ends the run
    // without polling, but `_runBeforeSettleBoundary` continues on `hasQueuedMessages()`
    // (`agent-session.ts:1833` in pi 0.99.2) whatever the decider answered. `queueInput` and the cancel-note delivery
    // refuse new ones from here on. Restoring a held note would let that continuation drain it and bill
    // past the limit, so its echo is corrected instead of honoured.
    this.withdrawQueue(
      this.runtime?.session,
      t("The budget stop discarded your cancel note before the agent read it. Send it again to have it applied."),
    );
    this.emit({
      type: "notification",
      message: t("Budget limit reached. This turn was stopped after the current step."),
      notificationType: "warning",
    });
  }

  /** Environment facts for the Damocles system prompt (US-007), mirroring the SDK path's source. */
  private systemPromptEnv(): SystemPromptEnv {
    return {
      cwd: this.cwd,
      model: this.modelValue,
      isGitRepo: existsSync(path.join(this.cwd, ".git")),
      platform: process.platform,
      shell: process.env["SHELL"] ?? "unknown",
      osVersion: `${os.type()} ${os.release()}`,
      compassEnabled: !!this.options.compassService?.isEnabled,
      thinkingDisabled: this.resolveThinkingLevel() === "off",
    };
  }

  /** Snapshot the live auth state the account/billing pure functions consume. */
  private accountBillingDeps(piRuntime: PiRuntime): AccountBillingDeps {
    const registry = piRuntime.modelRuntime;
    const openaiAuthStatus = piRuntime.getOpenAIAuthStatus();
    const preferApiKey = this.preferOpenAIApiKey();
    return {
      modelValue: this.modelValue,
      modelInfo: this.getModelInfo(this.modelValue),
      claudeAuthMode: piRuntime.getClaudeAuthStatus().mode,
      openaiAuthStatus,
      preferApiKey,
      resolvedProvider: resolvedProviderOf(this.modelValue, registry ?? undefined, openaiAuthStatus, preferApiKey),
    };
  }

  /**
   * Publish the account state to the webview. Its five auth inputs change independently of any turn, so
   * every mutation of one calls this and nothing else republishes. Rebuilt on each call, never cached. A
   * caller can run late in shutdown, so a disposed session or a retired runtime publishes nothing.
   */
  publishAccountInfo(): void {
    const runtime = this._disposed ? null : PiRuntime.unlessRetired();
    if (runtime) this.emit({ type: "accountInfo", data: buildAccountInfoFrom(this.accountBillingDeps(runtime)) });
  }

  /** The usage monitor and the subscription the chat's model bills; none for an API key, a custom provider, a disposed session or a retired runtime. */
  private subscriptionUsage(): SubscriptionUsage | undefined {
    const runtime = this._disposed ? null : PiRuntime.unlessRetired();
    const provider = runtime ? subscriptionProvider(this.accountBillingDeps(runtime)) : undefined;
    return runtime && provider ? { usage: runtime.usage, provider } : undefined;
  }

  /**
   * A rate limit's outcome names the full window a bounded usage refresh finds (D55), so only this report
   * waits: the session state went idle already. The listener is read after the wait, and dispose clears it,
   * so a session disposed meanwhile raises nothing.
   */
  private async settleOnRateLimit(outcome: Extract<TurnOutcome, { kind: "rateLimit" }>, subscription: SubscriptionUsage | undefined): Promise<void> {
    const window = subscription ? await subscription.usage.fullWindow(subscription.provider, this.modelValue) : undefined;
    this.turnSettledListener?.({ ...outcome, ...window });
  }

  /**
   * The only writer of the turn lifecycle. Every path that ends or starts a turn calls this, including
   * the ones no pi event reaches (an abort with no model stream open, a session replacement, a
   * `prompt()` that rejected before any agent run). `compacting` is deliberately not folded in: a
   * manual compaction opens no prompt and the adapter reports no turn lifecycle for it.
   */
  private setTurnState(...[turn, outcome]: TurnChange): void {
    const settled = this.turnState === "running" && turn === "idle";
    if (turn === "running" && this.turnState !== "running") this.turnStartedAt = Date.now();
    this.turnState = turn;
    this.publishSessionState();
    if (turn !== "idle") return;
    this.announceIfNewlyStored();
    if (!settled) return;
    const subscription = this.subscriptionUsage();
    if (outcome.kind === "rateLimit") {
      void this.settleOnRateLimit(outcome, subscription);
      return;
    }
    this.turnSettledListener?.(outcome.kind === "completed" ? { kind: "completed", durationMs: Date.now() - this.turnStartedAt } : outcome);
    subscription?.usage.refreshAfterTurn();
  }

  /** The prompts `PermissionState` and `WebviewExtensionUIContext` still hold, in that order. */
  private raisedPrompts(): RaisedPrompt[] {
    const dialogs = this.uiContext.pendingDialogs().map((request): RaisedPrompt => ({ id: request.requestId, kind: "input", request }));
    return [...this.options.permissionHandler.pendingPrompts(), ...dialogs];
  }

  private promptOwners(): PromptOwners {
    return {
      teamMember: (agentId) => this.options.teamService?.memberOf(agentId) ?? null,
      subagentOfToolCall: (toolCallId) => this.subagentManager?.agentIdOfToolCall(toolCallId),
    };
  }

  /** A subagent or team run that has not settled; their owners call the publisher as one starts or settles. */
  private backgroundRunning(): boolean {
    return (this.subagentManager?.hasUnsettledRuns() ?? false) || (this.options.teamService?.running ?? false);
  }

  /**
   * Publish the session state to the webview and the panel's activity. The inputs, the turn lifecycle,
   * the prompt maps owned by `PermissionState` and `WebviewExtensionUIContext`, the subagent and team
   * runs and the stored session id, change independently of each other, so every mutation of one calls
   * this and nothing else emits `sessionStateChanged` or reports activity. Rebuilt on each call; only a
   * pending prompt's summary is kept, for as long as that prompt is raised.
   */
  private publishSessionState(): void {
    const sessionId = this.runtime?.session.sessionId ?? "";
    // One read for both, so the kinds are exactly the kinds of the prompts reported.
    const raised = this.raisedPrompts();
    const pendingKinds = [...new Set(raised.map((prompt) => prompt.kind))].sort();
    const state: SessionState = deriveSessionState(this.turnState, pendingKinds.length > 0);
    // A prompt's owner never changes while it is pending, so its id stands for the whole entry.
    const key = `${state}:${sessionId}:${raised.map((prompt) => prompt.id).join(",")}`;
    if (this.lastSessionState !== key) {
      this.lastSessionState = key;
      this.emit({ type: "sessionStateChanged", state, sessionId, pendingPrompts: pendingPromptOwners(raised) });
    }
    const listener = this.activityListener;
    if (!listener) return;
    const background = this.backgroundRunning();
    // Keyed on the prompt ids, so a new prompt of a kind already pending still reports.
    const activityKey = `${state}:${raised.map((prompt) => prompt.id).join(",")}:${background}:${this.storedSessionId ?? ""}`;
    if (this.lastActivityKey === activityKey) return;
    this.lastActivityKey = activityKey;
    const pendingPrompts = this.describePrompts(raised);
    listener({ state, pendingKinds, pendingPrompts, background });
  }

  /** Reports the current activity at once, then every change; null stops the reports. */
  setActivityListener(listener: ((activity: ChatActivity) => void) | null): void {
    this.activityListener = listener;
    this.lastActivityKey = null;
    if (listener) this.publishSessionState();
  }

  setTurnSettledListener(listener: ((outcome: TurnOutcome) => void) | null): void {
    this.turnSettledListener = listener;
  }

  /** Whether the user opted to prefer the OpenAI API key over a ChatGPT or Codex sign-in when both are configured. */
  private preferOpenAIApiKey(): boolean {
    return this.options.getPreferOpenAIApiKey?.() ?? false;
  }
}
