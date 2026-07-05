import * as vscode from 'vscode';
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { buildSystemPrompt } from './system-prompt';
import { MEMORY_SYSTEM_PROMPT } from '../memory/system-prompt';
import { log } from '../logger';
import { getPiCodingAgent } from './pi-loader';
import { findSessionPlanFiles } from '../paths';
import { buildPlanModeGuidance } from './plan-mode-guidance';
import type { PanelGateContext, SystemPromptEnv } from './permission-gate';

/** customType marking the per-prompt context injection so the webview adapter can suppress it. */
export const CONTEXT_INJECTION_CUSTOM_TYPE = 'damocles-context-injection';

/**
 * Outside plan mode, name the session's existing plan file every turn so the model never has to hunt for
 * it when the user refers to "the plan" (read/update/follow). Resolved by the session's stable plan-id
 * suffix (`findSessionPlanFiles`) — the SAME lookup view/delete use — so it survives the first-message
 * slug evolving and names the real on-disk file rather than a recomputed path that may have drifted. Only
 * emitted when a file exists (a session that never planned gets nothing); the path is stable per session,
 * so the system-prompt prefix stays cache-stable across turns.
 */
function planFileReminder(planFilePath: string): string {
  return (
    `This session has a plan file at ${planFilePath}. When the user refers to "the plan" — to read, ` +
    `update, or follow it — use that exact file; do not search for it.`
  );
}

/**
 * Execution-time team directive (gated on `teamEnabled && !planMode && existingPlanFile`). When a bound
 * plan specifies team runs, the solo/surgical default would otherwise let the agent rationalize doing the
 * work itself ("not parallelizable → skip team"). This makes the plan's orchestration directives binding
 * and self-gates in its wording, so it is harmless for plans that specify no team run.
 */
function teamPlanDirective(): string {
  return (
    'When following this plan, treat its orchestration directives as binding: if the plan specifies that ' +
    'a step or slice runs as a team (the create_team tool) with specialists, you MUST start that team with ' +
    'create_team rather than doing the work yourself. Teams add value for collaboration and independent ' +
    'review — including sequential, high-stakes work, not only parallelizable tasks — so do not skip a team ' +
    'run on the grounds that the work "isn\'t parallelizable." Pass the slice\'s spec / acceptance criteria ' +
    'as the create_team `brief` argument — that is the team\'s authoritative source of truth; keep `title` a ' +
    'short label and never cram the detailed intent into `title`. If you genuinely believe a step should not be ' +
    'a team run, raise it with the user and get agreement before proceeding solo; never silently substitute ' +
    'solo work for a team run the plan specifies.'
  );
}

/**
 * Render pi's discovered project-context files into the `<project_context>` block, byte-identical to
 * pi's own `buildSystemPrompt`, so dropping pi's boilerplate doesn't drop CLAUDE.md/AGENTS.md (US-007).
 */
function renderContextFiles(contextFiles: BuildSystemPromptOptions['contextFiles']): string {
  if (!contextFiles || contextFiles.length === 0) return '';
  let out = '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n';
  for (const { path: filePath, content } of contextFiles) {
    out += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
  }
  out += '</project_context>\n';
  return out;
}

/** Render pi's discovered skills via pi's own formatter (kept identical, no format drift — US-007). */
function renderSkills(skills: BuildSystemPromptOptions['skills'], hasReadTool: boolean): string {
  const list = skills ?? [];
  if (list.length === 0) return '';
  if (!hasReadTool) return '';
  const format = getPiCodingAgent()?.formatSkillsForPrompt;
  return format ? format(list) : '';
}

/** The inputs the Damocles system prompt is a pure function of — all available outside a running turn,
 *  so the turn path and the `/context` preview can share one assembly function (no drift). */
export interface DamoclesSystemPromptInputs {
  env: SystemPromptEnv;
  memoryEnabled: boolean;
  planMode: boolean;
  /** Whether the multi-agent Team feature is enabled. In plan mode it shapes the implementation-phase
   *  directive (team-per-slice when on, sequential slices when off); outside plan mode with a bound plan
   *  file it gates the execution-time team directive that makes the plan's team runs binding. */
  teamEnabled: boolean;
  /** The write-target path named in plan-mode guidance (used only when `planMode`). */
  planFilePath: string;
  /** The existing on-disk plan file to name in the non-plan-mode reminder, or undefined when none. */
  existingPlanFile: string | undefined;
  contextFiles: BuildSystemPromptOptions['contextFiles'];
  skills: BuildSystemPromptOptions['skills'];
  hasReadTool: boolean;
}

/**
 * Assemble the Damocles system prompt (US-007), the single source of truth for both the turn path and
 * the `/context` preview/estimate: `buildSystemPrompt` (model-aware, per session) + the static memory
 * instructions (when memory is enabled) + the plan-mode instruction (when plan mode is active) or the
 * one-line plan reminder (outside plan mode, when a plan file exists), then re-append pi's discovered
 * project-context files and skills. pi's identity / tool-prose / pi-docs / guidelines are dropped. The
 * result is stable across turns for a given model, so the prompt cache holds.
 */
export function assembleDamoclesSystemPrompt(i: DamoclesSystemPromptInputs): string {
  const parts: string[] = [buildSystemPrompt(i.env)];
  if (i.memoryEnabled) parts.push(MEMORY_SYSTEM_PROMPT);
  if (i.planMode) {
    // Plan mode names the write-target path (the model may not have written the file yet).
    parts.push(buildPlanModeGuidance(i.planFilePath, { teamEnabled: i.teamEnabled }));
  } else if (i.existingPlanFile) {
    parts.push(planFileReminder(i.existingPlanFile));
    if (i.teamEnabled) parts.push(teamPlanDirective());
  }
  return parts.join('\n\n') + renderContextFiles(i.contextFiles) + renderSkills(i.skills, i.hasReadTool);
}

/** Assemble the Damocles system prompt for this turn from the `before_agent_start` event + panel. */
async function buildDamoclesSystemPrompt(
  event: BeforeAgentStartEvent,
  panel: PanelGateContext,
  sessionId: string,
): Promise<string> {
  const planMode = panel.isPlanMode();
  const selectedTools = event.systemPromptOptions.selectedTools;
  return assembleDamoclesSystemPrompt({
    env: panel.getSystemPromptEnv(),
    memoryEnabled: !!panel.memoryService?.isEnabled,
    planMode,
    teamEnabled: panel.isTeamEnabled?.() ?? false,
    planFilePath: panel.getPlanFilePath(),
    existingPlanFile: planMode ? undefined : (await findSessionPlanFiles(sessionId))[0],
    contextFiles: event.systemPromptOptions.contextFiles,
    skills: event.systemPromptOptions.skills,
    hasReadTool: !selectedTools || selectedTools.includes('read'),
  });
}

/**
 * The dynamic memory catalog for this prompt (US-005): builds the catalog (incl. first-message profile
 * + handoff), emits the `contextInjectionStarted`/`memoryInjectionUpdate`/`contextInjectionComplete`
 * webview lifecycle messages keyed by prompt index, persists the injection record, and marks the
 * session's first message sent. The `contextInjectionStarted` emit seeds the store's
 * `executionPromptIndex`, without which the store drops the subsequent `memoryInjectionUpdate`. Returns
 * the catalog text to inject as a custom message; empty string when memory is disabled or yields nothing.
 */
async function buildMemoryContext(panel: PanelGateContext, sessionId: string, prompt: string): Promise<string> {
  const memory = panel.memoryService;
  if (!memory?.isEnabled) return '';
  const promptIndex = panel.currentPromptIndex();
  panel.postMessage({ type: 'contextInjectionStarted', promptIndex });
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? null;
  try {
    await memory.ensureInitialized();
    const result = await memory.buildInjectionContext(sessionId || null, panel.getSystemPromptEnv().cwd, activeFile, prompt);
    if (result.metadata) {
      panel.postMessage({ type: 'memoryInjectionUpdate', promptIndex, data: result.metadata });
      if (sessionId) await memory.persistMemoryInjection(sessionId, promptIndex, result.metadata);
    }
    // Profile + handoff are already folded into `result.context` on the first message; mark it sent so
    // later turns inject fresh catalog only (no duplicated profile/handoff).
    if (sessionId) memory.markFirstMessageSent(sessionId);
    return result.context ?? '';
  } catch (err) {
    log('[PiAgentStart] memory injection failed: %O', err);
    return '';
  } finally {
    panel.postMessage({ type: 'contextInjectionComplete', promptIndex });
  }
}

/** The dynamic compass status tag for this prompt (US-005), mirroring the SDK path's `getCompassContext`. */
function buildCompassContext(panel: PanelGateContext): string {
  const compass = panel.compassService;
  if (!compass?.isEnabled) return '';
  try {
    const status = compass.getStatus();
    const lastMs = status.lastIndexedAt;
    let indexedAgo = 'never';
    if (lastMs) {
      const diffMin = Math.floor((Date.now() - lastMs) / 60_000);
      indexedAgo = diffMin < 1 ? 'just now' : diffMin < 60 ? `${diffMin}m ago` : `${Math.floor(diffMin / 60)}h ago`;
    }
    const isStale = lastMs ? Date.now() - lastMs > 30 * 60_000 : false;
    const staleAttr = isStale ? ' stale="true"' : '';
    const errorAttr =
      (status.state === 'error' || status.state === 'failed') && status.error
        ? ` error="${status.error.replace(/"/g, '&quot;')}"`
        : '';
    const xmlTag = `<damocles_compass state="${status.state}" nodes="${status.nodeCount}" edges="${status.edgeCount}" indexed="${indexedAgo}"${staleAttr}${errorAttr}/>`;
    if (status.state === 'error' || status.state === 'failed') return `${xmlTag}\nCompass is unavailable. Use Glob/Grep for code search.`;
    if (isStale) return `${xmlTag}\nCompass graph is stale (indexed ${indexedAgo}). Verify Compass results with file reads.`;
    return `${xmlTag}\nCompass is ready (${status.nodeCount} entities). Use compass_search before Glob/Grep for entity lookup; compass_query for callers/importers/children (file names with extension for importers_of). compass_query's first line shows what the target resolved to — verify unexpected "none" results with one Grep.`;
  } catch {
    return '';
  }
}

/**
 * The single `before_agent_start` handler for the pi path (US-005 + US-007). Returns the Damocles
 * system prompt (replacing pi's boilerplate, preserving project context) plus — as a NON-displayed
 * custom message — the dynamic memory catalog + compass status for this prompt. Dynamic context goes
 * in the message, never the system prompt, so the cached system prefix stays stable per model.
 */
export async function buildAgentStartResult(
  event: BeforeAgentStartEvent,
  panel: PanelGateContext,
  sessionId: string,
): Promise<BeforeAgentStartEventResult | undefined> {
  const systemPrompt = await buildDamoclesSystemPrompt(event, panel, sessionId);

  const dynamicParts = [await buildMemoryContext(panel, sessionId, event.prompt), buildCompassContext(panel)].filter(
    (part) => part.length > 0,
  );

  const result: BeforeAgentStartEventResult = { systemPrompt };
  if (dynamicParts.length > 0) {
    result.message = { customType: CONTEXT_INJECTION_CUSTOM_TYPE, content: dynamicParts.join('\n\n'), display: false };
  }
  return result;
}
