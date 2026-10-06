import type { Agent, AgentMessage, PrepareNextTurnContext } from '@earendil-works/pi-agent-core';
import type { BeforeAgentStartEvent, CustomMessageEntryDraft } from '@earendil-works/pi-coding-agent';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { log } from '../logger';
import { TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE } from '../../shared/tool-names';
import { PLAN_MODE_SECTION } from './plan-mode-guidance';

// A plan-mode change the model has not been told about is appended as a hidden message, never written
// into a past message or a system-prompt section, so the cached prefix survives.

export const PLAN_MODE_CHANGE_CUSTOM_TYPE = 'damocles-plan-mode-change';

export interface PlanModeChangeDetails {
  planMode: boolean;
}

export const PLAN_MODE_ENDED_TEXT: string =
  'The user switched this chat out of plan mode. Plan mode has ended and its restrictions no longer apply: ' +
  'you can edit files, run commands and take actions as the current permission mode allows.';

/** Prefixed to the plan-mode instructions when the user switches into plan mode. */
export const PLAN_MODE_STARTED_PREFIX: string = 'The user switched this chat to plan mode.';

/** How one agent's system prompt states plan mode, and what that agent is told when plan mode starts. */
export interface PlanModeStatement {
  /** The system-prompt section pi records the statement in. */
  section: string;
  /** Whether the section's text puts the agent in plan mode. */
  statesPlanMode: (text: string) => boolean;
  /** This prompt's text for the section, from the options pi builds the prompt from. */
  upcoming: (options: BeforeAgentStartEvent['systemPromptOptions']) => string | undefined;
  /** The plan-mode instructions the agent gets when plan mode starts. */
  guidance: () => string;
}

/** The main agent's statement: the `damocles_plan_mode` section, present only in plan mode. */
export function mainPlanModeStatement(guidance: () => string): PlanModeStatement {
  return {
    section: PLAN_MODE_SECTION,
    statesPlanMode: () => true,
    upcoming: (options) => options.sections[PLAN_MODE_SECTION],
    guidance,
  };
}

/**
 * What the model was last told about plan mode: the latest statement in the transcript it reads, which
 * is a system message patching the statement's section, a plan-mode change notice, or a successful
 * EnterPlanMode or ExitPlanMode result. With none, plan mode is off, because the first system message
 * carries every section and a compaction keeps the replayed one.
 */
export function planModeToldToModel(messages: readonly AgentMessage[], statement: PlanModeStatement): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const told = statementIn(messages[i], statement);
    if (told !== undefined) return told;
  }
  return false;
}

function statementIn(message: AgentMessage | undefined, statement: PlanModeStatement): boolean | undefined {
  const m = message as { role?: string; customType?: string; details?: unknown; sections?: Record<string, string | null> } | undefined;
  if (m?.role === 'system') return sectionStatement(m.sections, statement);
  if (m?.role === 'custom' && m.customType === PLAN_MODE_CHANGE_CUSTOM_TYPE) {
    const planMode = (m.details as Partial<PlanModeChangeDetails> | undefined)?.planMode;
    return typeof planMode === 'boolean' ? planMode : undefined;
  }
  if (m?.role !== 'toolResult') return undefined;
  const result = m as Partial<ToolResultMessage>;
  if (result.isError === true) return undefined;
  if (result.toolName === TOOL_ENTER_PLAN_MODE) return true;
  if (result.toolName === TOOL_EXIT_PLAN_MODE) return false;
  return undefined;
}

function sectionStatement(sections: Record<string, string | null> | undefined, statement: PlanModeStatement): boolean | undefined {
  if (!sections || !(statement.section in sections)) return undefined;
  const text = sections[statement.section];
  return typeof text === 'string' && statement.statesPlanMode(text);
}

type PlanModeChangeNotice = Pick<CustomMessageEntryDraft, 'customType' | 'content' | 'display' | 'details'>;

/** The notice for a plan-mode state the model has not been told, or undefined when it knows. */
export function planModeChangeNotice(
  messages: readonly AgentMessage[],
  planMode: boolean,
  statement: PlanModeStatement,
): PlanModeChangeNotice | undefined {
  if (planModeToldToModel(messages, statement) === planMode) return undefined;
  const details: PlanModeChangeDetails = { planMode };
  return {
    customType: PLAN_MODE_CHANGE_CUSTOM_TYPE,
    content: planMode ? `${PLAN_MODE_STARTED_PREFIX} ${statement.guidance()}` : PLAN_MODE_ENDED_TEXT,
    display: false,
    details,
  };
}

/**
 * The notice for a prompt about to start. pi patches the statement's section after `before_agent_start`
 * only when it changed, so a section state that differs from the transcript's counts as already told.
 */
export function planModeNoticeAtPromptStart(
  history: readonly AgentMessage[],
  options: BeforeAgentStartEvent['systemPromptOptions'],
  planMode: boolean,
  statement: PlanModeStatement,
): PlanModeChangeNotice | undefined {
  const text = statement.upcoming(options) ?? null;
  const upcoming = text !== null && statement.statesPlanMode(text);
  const patch = { role: 'system', content: '', sections: { [statement.section]: text }, timestamp: 0 } as unknown as AgentMessage;
  const pending = upcoming === currentSectionState(history, statement) ? [] : [patch];
  return planModeChangeNotice([...history, ...pending], planMode, statement);
}

function currentSectionState(messages: readonly AgentMessage[], statement: PlanModeStatement): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; sections?: Record<string, string | null> } | undefined;
    if (m?.role !== 'system') continue;
    const state = sectionStatement(m.sections, statement);
    if (state !== undefined) return state;
  }
  return false;
}

const installed = new WeakMap<Agent, { planMode: () => boolean; statement: PlanModeStatement }>();

/**
 * Append the notice to the messages pi adds before each later step of a run. Wraps pi's own
 * `prepareNextTurnWithContext`, which pi assigns in the session constructor, so it is installed after it;
 * a second install on the same agent replaces the inputs without stacking another layer.
 */
export function installPlanModeChangeNotice(agent: Agent, planMode: () => boolean, statement: PlanModeStatement): void {
  const existing = installed.get(agent);
  if (existing) {
    existing.planMode = planMode;
    existing.statement = statement;
    return;
  }
  const entry = { planMode, statement };
  installed.set(agent, entry);
  const prior = agent.prepareNextTurnWithContext ??
    (agent.prepareNextTurn ? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await agent.prepareNextTurn?.(signal) : undefined);
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const snapshot = await prior?.(turn, signal);
    const prepared = snapshot?.messages ?? [];
    let notice: PlanModeChangeNotice | undefined;
    // A throw here would end the run without its normal events, so a failed notice is skipped instead.
    try {
      notice = planModeChangeNotice([...(snapshot?.context ?? turn.context).messages, ...prepared], entry.planMode(), entry.statement);
    } catch (err) {
      log('[PlanModeChange] building the notice failed: %O', err);
    }
    if (!notice) return snapshot;
    const message = { role: 'custom', ...notice, timestamp: Date.now() } as AgentMessage;
    return { ...snapshot, messages: [...prepared, message] };
  };
}
