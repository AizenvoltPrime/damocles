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
import type { PanelGateContext } from './permission-gate';

/** customType marking the per-prompt context injection so the webview adapter can suppress it. */
export const CONTEXT_INJECTION_CUSTOM_TYPE = 'damocles-context-injection';

const PLAN_MODE_INSTRUCTION = [
  'IMPORTANT: Plan mode is active. You MUST NOT make any edits, run any non-read-only commands, or',
  'otherwise modify the system. Research and design only, then present your plan and call ExitPlanMode',
  'to request approval before taking any action.',
].join(' ');

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
function renderSkills(options: BuildSystemPromptOptions): string {
  const skills = options.skills ?? [];
  if (skills.length === 0) return '';
  const hasRead = !options.selectedTools || options.selectedTools.includes('read');
  if (!hasRead) return '';
  const format = getPiCodingAgent()?.formatSkillsForPrompt;
  return format ? format(skills) : '';
}

/**
 * Assemble the Damocles system prompt for this turn (US-007): `buildSystemPrompt` (model-aware, per
 * session) + the static memory instructions (when memory is enabled) + the plan-mode instruction
 * (when plan mode is active), then re-append pi's discovered project-context files and skills.
 * pi's identity / tool-prose / pi-docs / guidelines are dropped. The result is stable across turns for
 * a given model, so the prompt cache holds.
 */
function buildDamoclesSystemPrompt(event: BeforeAgentStartEvent, panel: PanelGateContext): string {
  const env = panel.getSystemPromptEnv();
  const parts: string[] = [buildSystemPrompt(env)];
  if (panel.memoryService?.isEnabled) parts.push(MEMORY_SYSTEM_PROMPT);
  if (panel.isPlanMode()) parts.push(PLAN_MODE_INSTRUCTION);
  return parts.join('\n\n') + renderContextFiles(event.systemPromptOptions.contextFiles) + renderSkills(event.systemPromptOptions);
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
  const systemPrompt = buildDamoclesSystemPrompt(event, panel);

  const dynamicParts = [await buildMemoryContext(panel, sessionId, event.prompt), buildCompassContext(panel)].filter(
    (part) => part.length > 0,
  );

  const result: BeforeAgentStartEventResult = { systemPrompt };
  if (dynamicParts.length > 0) {
    result.message = { customType: CONTEXT_INJECTION_CUSTOM_TYPE, content: dynamicParts.join('\n\n'), display: false };
  }
  return result;
}
