import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import type { MemoryService } from '../../memory';
import type { CompassService } from '../../compass';
import { BrowserService } from '../../browser';
import {
  TOOL_EDIT,
  TOOL_POWERSHELL,
  TOOL_TASK_CREATE,
  TOOL_TASK_UPDATE,
  TOOL_TASK_LIST,
  TOOL_TASK_GET,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
  TOOL_ASK_USER_QUESTION,
  TOOL_AGENT,
  TOOL_GET_SUBAGENT_RESULT,
  TOOL_STEER_SUBAGENT,
} from '../../../shared/tool-names';
import { createEditTool } from './edit-tool';
import { createPowerShellTool } from './powershell-tool';
import { createTaskTools } from './task-tools';
import { createPlanModeTools } from './plan-mode-tools';
import { createAskUserQuestionTool } from './ask-user-question-tool';
import { buildMemoryPiTools, MEMORY_PI_TOOL_NAMES } from './memory-tools';
import { buildCompassPiTools, COMPASS_PI_TOOL_NAMES } from './compass-tools';
import { buildBrowserPiTools, abortableTool, BROWSER_PI_TOOL_NAMES } from './browser-tools';
import { createBrowserRequestInputTool } from './browser-request-input-tool';
import { buildWebPiTools } from '../web-access';
import { buildSubagentTools } from './subagent-tools';
import { buildTeamMainPiTools, type TeamServiceRef } from './team-tools';
import type { AgentManager } from '../subagents/agent-manager';

/**
 * The inputs `buildCustomTools` needs. Note what is NOT here: MCP tool definitions. A nested agent's
 * `mcp__*` definitions come from its per-spawn `NestedMcpToolset` (`tools/mcp-tools.ts`) and are
 * APPENDED by the caller to this function's result — the same shape the `team_*` tools use. Keeping
 * them out is deliberate: the MCP set is per-SPAWN (frozen at spawn, minus that agent's
 * `disallowed_tools`), while these deps describe the panel-level services, so folding MCP in here would
 * either take a second descriptor read or force every caller to pass the snapshot through.
 */
export interface CustomToolDeps {
  pi: PiCodingAgentModule;
  cwd: string;
  permissionHandler: PermissionHandler;
  /** Wired only when the panel's memory service is present (enabled-check is applied here). */
  memoryService?: MemoryService;
  /** Wired only when the panel's compass service is present. */
  compassService?: CompassService;
  /** Wired only when the integrated browser is enabled (the service has no `isEnabled` flag — its
   * presence in `SessionOptions` already means enabled). */
  browserService?: BrowserService;
  /** The browser scope id this agent's browser tools bind to: the primary scope (main agent + human)
   *  when omitted, or a subagent/team-agent id for per-agent tab isolation. */
  browserScopeId?: string;
  /** The current session id, for the memory tools (mirrors the SDK factory's `getSessionId`). */
  getSessionId: () => string;
  /** The session's deterministic plan path, named in the EnterPlanMode result so a model that enters
   *  plan mode mid-turn (when the system prompt doesn't yet carry the path) knows where to write its
   *  plan. Read at execute time. Wired only for the primary panel (subagents omit it). */
  getPlanFilePath?: () => string;
  /**
   * The per-PiSession subagent manager (Phase 5). When present, the three subagent tools
   * (Agent/GetSubagentResult/SteerSubagent) are appended. A NESTED subagent's customTools are built
   * WITHOUT this — that omission, plus resolveAgentToolset stripping the names, is what prevents
   * subagent recursion (FR-11).
   */
  subagentManager?: AgentManager;
  /**
   * The panel's team service (US-024d). When present AND `damocles.team.enabled`, the 3 main team tools
   * (create_team/get_team_status/cancel_team) are appended. A NESTED subagent's and a TEAM AGENT's
   * customTools are built WITHOUT this, so they never get the main team tools (no nested-team recursion).
   */
  teamService?: TeamServiceRef;
  /** Whether the multi-agent Team feature is live (`teamService` present AND `damocles.team.enabled`).
   *  Shapes the EnterPlanMode plan-mode guidance (team-per-slice vs sequential slices). */
  isTeamEnabled?: () => boolean;
}

/**
 * Inputs needed to enumerate the ACTIVE in-process MCP module tool names (the active-set helper).
 * Each subsystem's membership is its live enabled-state, NOT mere service presence — the services are
 * always wired (so their inert tools are built once), but only an enabled subsystem is activated.
 */
export interface ModuleToolNameDeps {
  memoryService?: MemoryService;
  compassService?: CompassService;
  /** The live `damocles.browser.enabled` read, computed by the caller (PiSession). */
  browserEnabled: boolean;
}

/**
 * Names of the Damocles custom tools, in active-set order. Every name MUST also be passed in the
 * session's `tools` list to be callable (US-003).
 */
export const CUSTOM_TOOL_NAMES: readonly string[] = [
  TOOL_EDIT,
  TOOL_POWERSHELL,
  TOOL_TASK_CREATE,
  TOOL_TASK_UPDATE,
  TOOL_TASK_LIST,
  TOOL_TASK_GET,
  TOOL_ENTER_PLAN_MODE,
  TOOL_EXIT_PLAN_MODE,
  TOOL_ASK_USER_QUESTION,
  TOOL_AGENT,
  TOOL_GET_SUBAGENT_RESULT,
  TOOL_STEER_SUBAGENT,
];

/**
 * Build the per-session Damocles custom tool definitions, each closing over this panel's `cwd` and
 * `permissionHandler`. Replaces the CC tools pi lacks (Edit, PowerShell, the Task list tools, plan,
 * question). The native `read/bash/write/grep/find/ls` come from pi directly.
 */
export function buildCustomTools(deps: CustomToolDeps): ToolDefinition[] {
  const { pi, cwd, permissionHandler, memoryService, compassService, browserService, browserScopeId, getSessionId, getPlanFilePath, subagentManager, teamService, isTeamEnabled } = deps;
  const [taskCreate, taskUpdate, taskList, taskGet] = createTaskTools(pi);
  const [enterPlan, exitPlan] = createPlanModeTools(pi, permissionHandler, getPlanFilePath, isTeamEnabled);
  const tools: ToolDefinition[] = [
    createEditTool(pi, cwd),
    createPowerShellTool(pi, cwd),
    taskCreate,
    taskUpdate,
    taskList,
    taskGet,
    enterPlan,
    exitPlan,
    createAskUserQuestionTool(pi, permissionHandler),
  ];

  // Build module tools whenever their service object is present — NOT gated by `.isEnabled`. Built-but-
  // inactive tools cost nothing (pi sends only ACTIVE tools to the model), and building them up front is
  // what lets a subsystem toggled ON mid-conversation activate live (it has tools ready to activate).
  if (memoryService) {
    tools.push(...buildMemoryPiTools({ pi, memoryService, getSessionId, workspace: cwd }));
  }
  if (compassService) {
    tools.push(...buildCompassPiTools({ pi, compassService }));
  }
  if (browserService) {
    // Per-agent scope binding at closure-construction time: the main agent (no scope id) shares the
    // primary scope with the human; each subagent/team agent passes its own id for tab isolation.
    // createAgentScope is idempotent, so a rebuild (per session / per spawn) reuses the scope.
    const scope = browserService.createAgentScope(browserScopeId ?? BrowserService.PRIMARY_SCOPE_ID);
    tools.push(...buildBrowserPiTools({ pi, scope }));
    // The interactive form-fill tool (Slice 4) mirrors AskUserQuestion: it drives the permission handler
    // (FormManager) directly through `canUseTool`. It is built HERE (a leaf module) rather than inside
    // `buildBrowserPiTools` to avoid an eval-time import cycle via permission-gate → tool-catalog →
    // browser-tools. `abortableTool` gives it the same turn-abort boundary as the other browser tools.
    tools.push(abortableTool(createBrowserRequestInputTool(pi, scope, permissionHandler)));
  }

  // Subagent tools only when a manager is wired (the primary session). Nested subagents build their
  // customTools WITHOUT a manager, so they never receive these — no recursion (FR-11).
  if (subagentManager) {
    tools.push(...buildSubagentTools(pi, subagentManager));
  }

  // The 3 main team tools only when a team service is wired (the primary session) — subagents and team
  // agents build customTools WITHOUT it. Built even when team is currently disabled (cheap, inert when
  // not in the active set), so a mid-conversation enable activates them live. The per-turn active-set
  // gate (`isTeamEnabled()` in fullActiveToolNames) controls availability.
  if (teamService) {
    tools.push(...buildTeamMainPiTools(pi, teamService));
  }

  // Web tools are built unconditionally (cheap, inert when not active — same rationale as the module
  // tools). The active-set gate (`isWebSearchEnabled()`) controls availability per turn, and building
  // them up front lets `tools:*` subagents inherit them and the live toggle take effect with no reload.
  tools.push(...buildWebPiTools({ pi }));

  return tools;
}

/**
 * The names of the ACTIVE in-process MCP module tools, so the active tool set can include them. Each
 * subsystem contributes its names only when LIVE-enabled: memory/compass via their `isEnabled` getter,
 * browser via the `damocles.browser.enabled` read the caller passes in. The per-tool disabled set is
 * subtracted by the caller (`PiSession.fullActiveToolNames`).
 */
export function moduleToolNames(deps: ModuleToolNameDeps): string[] {
  const names: string[] = [];
  if (deps.memoryService?.isEnabled) names.push(...MEMORY_PI_TOOL_NAMES);
  if (deps.compassService?.isEnabled) names.push(...COMPASS_PI_TOOL_NAMES);
  if (deps.browserEnabled) names.push(...BROWSER_PI_TOOL_NAMES);
  return names;
}
