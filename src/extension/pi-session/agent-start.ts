import * as vscode from 'vscode';
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { buildSystemPrompt, TONE_REMINDER_SECTION } from './system-prompt';
import { MEMORY_SYSTEM_PROMPT } from '../memory/system-prompt';
import { log } from '../logger';
import { getPiCodingAgent } from './pi-loader';
import { findSessionPlanFiles } from '../paths';
import { buildPlanModeGuidance } from './plan-mode-guidance';
import { isWebSearchEnabled } from './web-access';
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
    'as the create_team `brief` argument (per that tool\'s description). If you genuinely believe a step should not be ' +
    'a team run, raise it with the user and get agreement before proceeding solo; never silently substitute ' +
    'solo work for a team run the plan specifies.'
  );
}

/**
 * Render pi's discovered project-context files into the body of the `project_context` section, so
 * dropping pi's boilerplate doesn't drop CLAUDE.md/AGENTS.md (US-007). Must stay byte-identical to pi's
 * own `renderProjectContext`, and must not carry a `<project_context>` wrapper: pi wraps every section.
 */
function renderContextFiles(contextFiles: BuildSystemPromptOptions['contextFiles']): string {
  if (!contextFiles || contextFiles.length === 0) return '';
  return [
    'Project-specific instructions and guidelines:',
    ...contextFiles.map(({ path: filePath, content }) => `<project_instructions path="${filePath}">\n${content}\n</project_instructions>`),
  ].join('\n\n');
}

/** The tool pi's skills prose tells the model to load a skill file with. */
export type SkillFileReadTool = 'read' | 'bash';

/** Resolve the skills prose's tool with pi's own precedence: `read` when it is selected, else `bash`,
 *  else undefined, which is also pi's gate for emitting the section at all. The formatter writes
 *  "Use the read tool" or "Use bash" from this, so a bash-only session must resolve `bash` or the
 *  prose names a tool the session does not have. */
export function resolveSkillFileReadTool(selectedTools: readonly string[]): SkillFileReadTool | undefined {
  return (['read', 'bash'] as const).find((tool) => selectedTools.includes(tool));
}

/** Render pi's discovered skills via pi's own formatter, trimmed as pi trims it, so the Damocles
 *  `skills` section is byte-identical to the one it overwrites (US-007). */
function renderSkills(skills: BuildSystemPromptOptions['skills'], fileReadTool: SkillFileReadTool | undefined): string {
  const list = skills ?? [];
  if (list.length === 0 || !fileReadTool) return '';
  const format = getPiCodingAgent()?.formatSkillsForPrompt;
  return format ? format(list, fileReadTool).trim() : '';
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
  /** Whether the native web tools are enabled (`damocles.pi.webSearch.enabled`, off by default). While
   *  off they are not in the session's eligible set at all, so both the version-verification bullet in
   *  the main prompt and the plan-mode research clause are suppressed rather than pointing the model at
   *  a `ToolSearch` group that answers "Not available in this session". Required, not optional: an
   *  omitted flag would silently render the `/context` preview web-off while the live turn renders it
   *  web-on, and this interface exists precisely to keep those two paths from drifting. */
  webSearchEnabled: boolean;
  /** The write-target path named in plan-mode guidance (used only when `planMode`). */
  planFilePath: string;
  /** The existing on-disk plan file to name in the non-plan-mode reminder, or undefined when none. */
  existingPlanFile: string | undefined;
  contextFiles: BuildSystemPromptOptions['contextFiles'];
  skills: BuildSystemPromptOptions['skills'];
  /** The tool the skills prose names, or undefined when the session has neither `read` nor `bash` and
   *  pi emits no skills section. Produce it with `resolveSkillFileReadTool`, never by hand. */
  skillFileReadTool: SkillFileReadTool | undefined;
}

/** The Damocles-owned pieces of the system prompt. `preamble` becomes pi's `customPrompt`, which pi
 *  emits untagged and which suppresses its identity, tool-prose, rules and docs blocks. */
export interface DamoclesPromptSections {
  preamble: string;
  /** Insertion-ordered. A key whose content would be empty is absent, never present with an empty value. */
  sections: Record<string, string>;
}

/**
 * Assemble the Damocles system prompt (US-007), the single source of truth for both the turn path and
 * the `/context` preview/estimate: `buildSystemPrompt` (model-aware, per session) as the preamble, then
 * one named section per independently toggleable piece, so flipping one input repatches one section.
 * `project_context` and `skills` reuse pi's own section names, which makes the Damocles entry overwrite
 * pi's natively built one instead of the prompt carrying that content twice.
 */
export function assembleDamoclesSystemPrompt(i: DamoclesSystemPromptInputs): DamoclesPromptSections {
  const preamble = buildSystemPrompt({ ...i.env, webSearchEnabled: i.webSearchEnabled });
  const sections: Record<string, string> = {};
  if (i.memoryEnabled) sections['damocles_memory'] = MEMORY_SYSTEM_PROMPT;
  if (i.planMode) {
    // Plan mode names the write-target path (the model may not have written the file yet).
    sections['damocles_plan_mode'] = buildPlanModeGuidance(i.planFilePath, { teamEnabled: i.teamEnabled, webSearchEnabled: i.webSearchEnabled });
  } else if (i.existingPlanFile) {
    sections['damocles_plan_file'] = planFileReminder(i.existingPlanFile);
    if (i.teamEnabled) sections['damocles_team_directive'] = teamPlanDirective();
  }
  const projectContext = renderContextFiles(i.contextFiles);
  if (projectContext) sections['project_context'] = projectContext;
  const skills = renderSkills(i.skills, i.skillFileReadTool);
  if (skills) sections['skills'] = skills;
  // Inserted last so it stays the final section of the assembled prompt.
  sections['damocles_tone'] = TONE_REMINDER_SECTION;
  return { preamble, sections };
}

/** Flatten the section map the way pi renders the same pieces (preamble untagged, every other section
 *  wrapped in a tag of its own name, joined by a blank line). Two pieces of the live prompt are pi's
 *  own and absent here: the `cwd` section pi always emits, and the `addendum` section it emits for a
 *  loader append-prompt, so the `/context` estimate under-counts by both. Order differs too: pi holds
 *  `project_context` and `skills` in their native slots ahead of `cwd` and appends the `damocles_*`
 *  keys after it, while this renders the map in insertion order. */
export function renderSections(p: DamoclesPromptSections): string {
  const parts = [p.preamble, ...Object.entries(p.sections).map(([name, content]) => `<${name}>\n${content}\n</${name}>`)];
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/** Assemble the Damocles system prompt for this turn from the `before_agent_start` event + panel. */
async function buildDamoclesSystemPrompt(
  event: BeforeAgentStartEvent,
  panel: PanelGateContext,
  sessionId: string,
): Promise<DamoclesPromptSections> {
  const planMode = panel.isPlanMode();
  return assembleDamoclesSystemPrompt({
    env: panel.getSystemPromptEnv(),
    memoryEnabled: !!panel.memoryService?.isEnabled,
    planMode,
    teamEnabled: panel.isTeamEnabled?.() ?? false,
    webSearchEnabled: isWebSearchEnabled(),
    planFilePath: panel.getPlanFilePath(),
    existingPlanFile: planMode ? undefined : (await findSessionPlanFiles(sessionId))[0],
    contextFiles: event.systemPromptOptions.contextFiles,
    skills: event.systemPromptOptions.skills,
    skillFileReadTool: resolveSkillFileReadTool(event.systemPromptOptions.selectedTools),
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
    return `${xmlTag}\nCompass is ready (${status.nodeCount} entities).`;
  } catch {
    return '';
  }
}

/**
 * The single `before_agent_start` handler for the pi path (US-005 + US-007). Writes the Damocles
 * prompt into `event.systemPromptOptions` (replacing pi's boilerplate, preserving project context) and
 * returns the dynamic memory catalog + compass status for this prompt as a NON-displayed custom
 * message. Dynamic context goes in the message, never a section, so the cached prefix stays stable.
 */
export async function buildAgentStartResult(
  event: BeforeAgentStartEvent,
  panel: PanelGateContext,
  sessionId: string,
): Promise<BeforeAgentStartEventResult | undefined> {
  const prompt = await buildDamoclesSystemPrompt(event, panel, sessionId);
  const options = event.systemPromptOptions;
  // Returning `systemPrompt` from this handler would set pi's `forceSystemPrompt` and kill every section.
  options.customPrompt = prompt.preamble;
  // pi removes a section by its absence and drops empty values instead of removing them, so a key this
  // build did not produce must be deleted. Rewriting the whole map also keeps the built order, and
  // discards any section an earlier handler wrote, which `extensionsOverride` in `pi-runtime.ts` makes
  // safe by leaving the Damocles extension as the only one pi dispatches events to.
  for (const name of Object.keys(options.sections)) delete options.sections[name];
  Object.assign(options.sections, prompt.sections);

  const dynamicParts = [await buildMemoryContext(panel, sessionId, event.prompt), buildCompassContext(panel)].filter(
    (part) => part.length > 0,
  );

  const result: BeforeAgentStartEventResult = {};
  if (dynamicParts.length > 0) {
    result.message = { customType: CONTEXT_INJECTION_CUSTOM_TYPE, content: dynamicParts.join('\n\n'), display: false };
  }
  return result;
}
