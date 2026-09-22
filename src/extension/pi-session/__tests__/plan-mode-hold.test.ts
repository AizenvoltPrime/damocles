import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TOOL_EXIT_PLAN_MODE } from '../../../shared/tool-names';
import {
  lastAssistant,
  selectPlanModeNudgeText,
  turnHasNonErrorExitPlanModeResult,
  PLAN_MODE_NUDGE_CUSTOM_TYPE,
  PLAN_MODE_NUDGE_ESCALATED_TEXT,
  PLAN_MODE_NUDGE_TEXT,
} from '../plan-mode-hold';

/**
 * The plan-mode settle-time predicates extracted from pi-session.ts. Fabricated session-projection
 * message arrays drive each predicate directly.
 */

const assistant = (stopReason: string) => ({ role: 'assistant', stopReason, content: [] }) as unknown as AgentMessage;
const exitResult = (isError?: boolean) =>
  ({ role: 'toolResult', toolName: TOOL_EXIT_PLAN_MODE, ...(isError !== undefined ? { isError } : {}) }) as unknown as AgentMessage;
const otherResult = () => ({ role: 'toolResult', toolName: 'read', isError: false }) as unknown as AgentMessage;
const user = () => ({ role: 'user', content: [] }) as unknown as AgentMessage;
/** An injected nudge as the session projection holds it: role 'custom', never role 'user'. */
const nudge = () =>
  ({ role: 'custom', customType: PLAN_MODE_NUDGE_CUSTOM_TYPE, content: 'x', display: false }) as unknown as AgentMessage;

describe('turnHasNonErrorExitPlanModeResult', () => {
  it('true when an approved (non-error) ExitPlanMode result is present', () => {
    expect(turnHasNonErrorExitPlanModeResult([assistant('stop'), exitResult(false)])).toBe(true);
  });

  it('true when the ExitPlanMode result has no isError field', () => {
    expect(turnHasNonErrorExitPlanModeResult([exitResult()])).toBe(true);
  });

  it('false when the ExitPlanMode result is an error (rejected exit)', () => {
    expect(turnHasNonErrorExitPlanModeResult([exitResult(true)])).toBe(false);
  });

  it('false when no ExitPlanMode result is present', () => {
    expect(turnHasNonErrorExitPlanModeResult([assistant('stop'), otherResult()])).toBe(false);
  });

  it('false for an empty message list', () => {
    expect(turnHasNonErrorExitPlanModeResult([])).toBe(false);
  });

  it('stops at the last user message, so an approved exit in an earlier turn does not count', () => {
    // The caller passes the whole session projection. Without the turn scope, one approved exit would
    // silence the plan-mode nudge for every later turn in the session.
    expect(turnHasNonErrorExitPlanModeResult([user(), exitResult(false), user(), assistant('stop')])).toBe(false);
  });

  it('still sees an approved exit that belongs to the current turn', () => {
    expect(turnHasNonErrorExitPlanModeResult([user(), exitResult(true), user(), exitResult(false)])).toBe(true);
  });
});

describe('lastAssistant', () => {
  it('returns the last assistant message by reverse scan', () => {
    const a1 = assistant('stop');
    const a2 = assistant('length');
    expect(lastAssistant([a1, otherResult(), a2])).toBe(a2);
  });

  it('returns null when there is no assistant message', () => {
    expect(lastAssistant([otherResult()])).toBeNull();
    expect(lastAssistant([])).toBeNull();
  });
});

describe('plan-mode nudge constants', () => {
  it('expose the hidden custom-message type and nudge text', () => {
    expect(PLAN_MODE_NUDGE_CUSTOM_TYPE).toBe('damocles-plan-mode-nudge');
    expect(PLAN_MODE_NUDGE_TEXT).toContain('ExitPlanMode');
    expect(PLAN_MODE_NUDGE_TEXT).toContain('AskUserQuestion');
  });

  /**
   * The funnel has no retry cap by design, so every clause the model can satisfy without calling a tool
   * is a self-sustaining loop. The original text ended "Otherwise, keep planning." and a real session
   * answered "Holding." fifteen times, each reply obeying the nudge exactly as written.
   *
   * A tripwire against that one regression, not a proof of the general property: a new permissive clause
   * worded outside this list passes.
   */
  it.each([
    ['base', PLAN_MODE_NUDGE_TEXT],
    ['escalated', PLAN_MODE_NUDGE_ESCALATED_TEXT],
  ])('the %s text permits no reply that skips a tool call', (_label, text) => {
    for (const permission of ['keep planning', 'continue planning', 'keep thinking', 'wait', 'stand by', 'do nothing']) {
      expect(text.toLowerCase()).not.toContain(permission);
    }
  });

  it('the base text still directs the denied-because-no-plan-file loop', () => {
    expect(PLAN_MODE_NUDGE_TEXT).toContain('plan file');
  });

  it('the escalated text carries the plan-file remedy too, so the two cannot drift apart', () => {
    // A denied-for-no-plan-file exit is exactly the case that reaches a second nudge. Without the
    // remedy here the model re-calls ExitPlanMode and is denied again for the same reason.
    expect(PLAN_MODE_NUDGE_ESCALATED_TEXT).toContain('no plan file exists');
    expect(PLAN_MODE_NUDGE_ESCALATED_TEXT).toContain('write your full plan to the plan file');
  });

  it('the escalated text names the user-instruction conflict and routes it to AskUserQuestion', () => {
    // The looping session was one where the user had said "Do not call ExitPlanMode". Without naming
    // that case the model treats the conflict as a reason to idle rather than a question to ask.
    expect(PLAN_MODE_NUDGE_ESCALATED_TEXT).toContain('told you not to call ExitPlanMode');
    expect(PLAN_MODE_NUDGE_ESCALATED_TEXT).toContain('AskUserQuestion');
  });

  it('the escalated text reads as a second contact, not a first', () => {
    // It only ships after a nudge in the same turn already went out, so it may refer back to that one
    // but must not claim the model is seeing this same text again.
    expect(PLAN_MODE_NUDGE_ESCALATED_TEXT).toContain('A previous message in this turn already told you');
    expect(PLAN_MODE_NUDGE_ESCALATED_TEXT).not.toContain('seeing this message again');
  });
});

/**
 * The escalation axis is how many nudges this turn has already produced, counted off the session
 * projection so it needs no extra state and survives resume, fork and branch navigation.
 */
describe('selectPlanModeNudgeText', () => {
  const textOnly = () =>
    ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Holding.' }] }) as unknown as AgentMessage;
  const otherCustom = (customType: string) =>
    ({ role: 'custom', customType, content: 'x', display: false }) as unknown as AgentMessage;

  it('uses the base text for the first nudge of a turn', () => {
    expect(selectPlanModeNudgeText([user(), textOnly()])).toBe(PLAN_MODE_NUDGE_TEXT);
  });

  it('escalates once the turn already carries one nudge', () => {
    expect(selectPlanModeNudgeText([user(), textOnly(), nudge(), textOnly()])).toBe(PLAN_MODE_NUDGE_ESCALATED_TEXT);
  });

  it('stays escalated once the turn already carries several nudges', () => {
    const messages = [user(), textOnly(), nudge(), textOnly(), nudge(), textOnly(), nudge(), textOnly()];
    expect(selectPlanModeNudgeText(messages)).toBe(PLAN_MODE_NUDGE_ESCALATED_TEXT);
  });

  it('restarts at the base text in a new turn after an earlier turn nudged', () => {
    // The count is turn-scoped. Without the boundary, one nudged turn would escalate every later turn
    // in the session, and the user would never see the first-contact text again.
    const priorTurn = [user(), textOnly(), nudge(), textOnly()];
    expect(selectPlanModeNudgeText([...priorTurn, user(), textOnly()])).toBe(PLAN_MODE_NUDGE_TEXT);
  });

  it.each(['damocles-subagent-results', 'damocles-context-injection'])(
    'a custom message of type %s does not count as a nudge',
    (customType) => {
      expect(selectPlanModeNudgeText([user(), otherCustom(customType), textOnly()])).toBe(PLAN_MODE_NUDGE_TEXT);
    },
  );

  it('uses the base text when there are no messages at all', () => {
    expect(selectPlanModeNudgeText([])).toBe(PLAN_MODE_NUDGE_TEXT);
  });

  it('ignores the last assistant message shape, which at nudge time never holds a tool call', () => {
    // pi reports an assistant message carrying tool calls as stopReason 'toolUse', and the caller only
    // nudges on 'stop', so selecting on content would leave one of the two texts unreachable.
    const withToolCall = {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'text', text: 'exiting' }, { type: 'toolCall', id: 'tc1', name: TOOL_EXIT_PLAN_MODE, arguments: {} }],
    } as unknown as AgentMessage;
    expect(selectPlanModeNudgeText([user(), withToolCall, exitResult(true), textOnly()])).toBe(PLAN_MODE_NUDGE_TEXT);
    expect(selectPlanModeNudgeText([user(), nudge(), withToolCall, exitResult(true), textOnly()])).toBe(
      PLAN_MODE_NUDGE_ESCALATED_TEXT,
    );
  });
});
