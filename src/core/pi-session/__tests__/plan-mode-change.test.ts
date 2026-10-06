import { describe, it, expect } from 'vitest';
import type { Agent, AgentMessage, AgentLoopTurnUpdate, PrepareNextTurnContext } from '@earendil-works/pi-agent-core';
import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';
import { TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE } from '../../../shared/tool-names';
import { PLAN_MODE_SECTION } from '../plan-mode-guidance';
import { teamPlanModeStatement } from '../../team/prompts';
import {
  installPlanModeChangeNotice,
  mainPlanModeStatement,
  planModeChangeNotice,
  planModeNoticeAtPromptStart,
  planModeToldToModel,
  PLAN_MODE_CHANGE_CUSTOM_TYPE,
  PLAN_MODE_ENDED_TEXT,
  PLAN_MODE_STARTED_PREFIX,
} from '../plan-mode-change';

const as = (m: object) => m as unknown as AgentMessage;
const system = (sections: Record<string, string | null>) => as({ role: 'system', content: '', sections });
const toolResult = (toolName: string, isError = false) => as({ role: 'toolResult', toolName, isError });
const notice = (planMode: boolean) => as({ role: 'custom', customType: PLAN_MODE_CHANGE_CUSTOM_TYPE, details: { planMode } });
const user = as({ role: 'user', content: [] });
const reply = as({ role: 'assistant', content: [], stopReason: 'stop' });

const main = mainPlanModeStatement(() => 'Plan mode is active.');
const planOn = system({ preamble: 'You are Damocles.', [PLAN_MODE_SECTION]: 'Plan mode is active.' });
const planOff = system({ preamble: 'You are Damocles.' });
const options = (sections: Record<string, string>, customPrompt?: string) =>
  ({ sections, customPrompt }) as unknown as BeforeAgentStartEvent['systemPromptOptions'];

describe('planModeToldToModel', () => {
  it('reads the plan-mode section of the system prompt when nothing later states the mode', () => {
    expect(planModeToldToModel([planOn, user], main)).toBe(true);
    expect(planModeToldToModel([planOff, user], main)).toBe(false);
    expect(planModeToldToModel([planOn, user, system({ [PLAN_MODE_SECTION]: null })], main)).toBe(false);
    // A patch that leaves the section alone says nothing about plan mode.
    expect(planModeToldToModel([planOn, user, system({ damocles_tone: 'x' })], main)).toBe(true);
    expect(planModeToldToModel([user], main)).toBe(false);
  });

  it('takes the latest statement by position: the plan-mode tools, a notice and a section patch', () => {
    expect(planModeToldToModel([planOff, user, toolResult(TOOL_ENTER_PLAN_MODE)], main)).toBe(true);
    expect(planModeToldToModel([planOff, user, toolResult(TOOL_ENTER_PLAN_MODE), toolResult(TOOL_EXIT_PLAN_MODE)], main)).toBe(false);
    expect(planModeToldToModel([planOff, user, notice(true)], main)).toBe(true);
    expect(planModeToldToModel([planOff, user, notice(true), reply, system({ [PLAN_MODE_SECTION]: null }), user], main)).toBe(false);
  });

  it('ignores a rejected ExitPlanMode', () => {
    expect(planModeToldToModel([planOn, user, toolResult(TOOL_EXIT_PLAN_MODE, true)], main)).toBe(true);
  });

  it('reads a notice from an earlier prompt that no section patch has corrected', () => {
    expect(planModeToldToModel([planOff, user, notice(true), reply, user], main)).toBe(true);
  });
});

describe('planModeChangeNotice', () => {
  it('says nothing when the model already knows the mode', () => {
    expect(planModeChangeNotice([planOff, user], false, main)).toBeUndefined();
    expect(planModeChangeNotice([planOff, user, toolResult(TOOL_ENTER_PLAN_MODE)], true, main)).toBeUndefined();
  });

  it('carries the plan-mode guidance when plan mode started, and the end of it when it ended', () => {
    expect(planModeChangeNotice([planOff, user], true, main)).toEqual({
      customType: PLAN_MODE_CHANGE_CUSTOM_TYPE,
      content: `${PLAN_MODE_STARTED_PREFIX} Plan mode is active.`,
      display: false,
      details: { planMode: true },
    });
    expect(planModeChangeNotice([planOff, user, notice(true)], false, main)).toMatchObject({
      details: { planMode: false },
      content: PLAN_MODE_ENDED_TEXT,
    });
  });

  it('reads the model state from a compaction, which keeps the replayed system message', () => {
    const summary = as({ role: 'compactionSummary', summary: 'earlier work' });
    expect(planModeChangeNotice([planOn, summary, user], true, main)).toBeUndefined();
    expect(planModeChangeNotice([planOn, summary, user], false, main)).toMatchObject({ details: { planMode: false } });
  });
});

describe('planModeNoticeAtPromptStart', () => {
  it('corrects a notice left by the previous prompt when this prompt sends no section patch', () => {
    // default, then plan from the composer mid-run (notice), then default again before the next prompt.
    const history = [planOff, user, notice(true), reply];
    expect(planModeNoticeAtPromptStart(history, options({}), false, main)).toMatchObject({
      details: { planMode: false },
      content: PLAN_MODE_ENDED_TEXT,
    });
    expect(planModeNoticeAtPromptStart([planOn, user, notice(false), reply], options({ [PLAN_MODE_SECTION]: 'Plan mode is active.' }), true, main))
      .toMatchObject({ details: { planMode: true } });
  });

  it('says nothing when the section patch this prompt sends states the mode', () => {
    expect(planModeNoticeAtPromptStart([planOff, user, reply], options({ [PLAN_MODE_SECTION]: 'Plan mode is active.' }), true, main)).toBeUndefined();
    expect(planModeNoticeAtPromptStart([planOn, user, notice(true), reply], options({}), false, main)).toBeUndefined();
    expect(planModeNoticeAtPromptStart([planOff, user, reply], options({}), false, main)).toBeUndefined();
  });
});

describe('team agents', () => {
  const specialist = teamPlanModeStatement('specialist');
  const directive = specialist.guidance();
  const inPlan = system({ preamble: `You are Ada.\n\n${directive}` });
  const notInPlan = system({ preamble: 'You are Ada.' });

  it('reads the plan directive in the system prompt, and a later notice over it', () => {
    expect(planModeToldToModel([inPlan, user], specialist)).toBe(true);
    expect(planModeToldToModel([notInPlan, user], specialist)).toBe(false);
    expect(planModeToldToModel([inPlan, user, notice(false)], specialist)).toBe(false);
  });

  it('tells a team agent its role directive when plan mode starts, and that it ended when it ends', () => {
    const lead = teamPlanModeStatement('lead');
    expect(lead.guidance()).not.toBe(directive);
    expect(planModeChangeNotice([notInPlan, user], true, lead)?.content).toBe(`${PLAN_MODE_STARTED_PREFIX} ${lead.guidance()}`);
    expect(planModeChangeNotice([inPlan, user], false, specialist)?.content).toBe(PLAN_MODE_ENDED_TEXT);
  });

  it('tells a specialist spawned after the mode changed at its first request', () => {
    // The team's prompts carry the mode the team started in.
    expect(planModeNoticeAtPromptStart([], options({}, `You are Ada.\n\n${directive}`), false, specialist))
      .toMatchObject({ details: { planMode: false } });
    expect(planModeNoticeAtPromptStart([], options({}, 'You are Ada.'), true, specialist)).toMatchObject({ details: { planMode: true } });
    expect(planModeNoticeAtPromptStart([], options({}, 'You are Ada.'), false, specialist)).toBeUndefined();
  });
});

describe('installPlanModeChangeNotice', () => {
  const fakeAgent = (prior?: Agent['prepareNextTurnWithContext']) => ({ prepareNextTurnWithContext: prior }) as unknown as Agent;
  const turn = (newMessages: AgentMessage[], history: AgentMessage[] = []): PrepareNextTurnContext =>
    ({ newMessages, context: { messages: [...history, ...newMessages] } }) as unknown as PrepareNextTurnContext;

  it("appends the notice after pi's own prepared messages and keeps the rest of pi's snapshot", async () => {
    const piUpdate = system({ damocles_tone: 'x' });
    const piContext = { messages: [planOff, user] };
    const agent = fakeAgent(async () => ({ context: piContext, messages: [piUpdate] }) as unknown as AgentLoopTurnUpdate);
    installPlanModeChangeNotice(agent, () => true, main);

    const update = await agent.prepareNextTurnWithContext?.(turn([user], [planOff]));

    expect(update).toMatchObject({
      context: piContext,
      messages: [piUpdate, { role: 'custom', customType: PLAN_MODE_CHANGE_CUSTOM_TYPE, details: { planMode: true } }],
    });
  });

  it('reads the whole transcript, so a continued prompt does not repeat what an earlier run of it said', async () => {
    // pi continues a prompt (plan-mode hold, keep-alive, retry) with a run whose newMessages start empty.
    const agent = fakeAgent(async () => undefined);
    installPlanModeChangeNotice(agent, () => true, main);
    const history = [planOff, user, toolResult(TOOL_ENTER_PLAN_MODE), reply, as({ role: 'custom', customType: 'damocles-plan-mode-nudge' })];

    expect(await agent.prepareNextTurnWithContext?.(turn([reply], history))).toBeUndefined();
  });

  it("returns pi's snapshot untouched when there is nothing to tell, and when building the notice throws", async () => {
    const snapshot = { messages: [] } as unknown as AgentLoopTurnUpdate;
    const agent = fakeAgent(async () => snapshot);
    installPlanModeChangeNotice(agent, () => false, main);
    expect(await agent.prepareNextTurnWithContext?.(turn([user]))).toBe(snapshot);

    installPlanModeChangeNotice(agent, () => {
      throw new Error('no session tree');
    }, main);
    expect(await agent.prepareNextTurnWithContext?.(turn([user]))).toBe(snapshot);
  });

  it('wraps once per agent, so a rebind replaces the inputs instead of stacking a second notice', async () => {
    const agent = fakeAgent(async () => undefined);
    installPlanModeChangeNotice(agent, () => false, main);
    installPlanModeChangeNotice(agent, () => true, main);

    expect((await agent.prepareNextTurnWithContext?.(turn([user])))?.messages).toHaveLength(1);
  });
});
