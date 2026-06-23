import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TOOL_EXIT_PLAN_MODE } from '../../../shared/tool-names';
import {
  lastAssistant,
  turnHasNonErrorExitPlanModeResult,
  PLAN_MODE_NUDGE_CUSTOM_TYPE,
  PLAN_MODE_NUDGE_TEXT,
} from '../plan-mode-hold';

/**
 * The plan-mode turn-end predicates extracted from pi-session.ts. Fabricated `agent_end` message
 * arrays drive each predicate directly.
 */

const assistant = (stopReason: string) => ({ role: 'assistant', stopReason, content: [] }) as unknown as AgentMessage;
const exitResult = (isError?: boolean) =>
  ({ role: 'toolResult', toolName: TOOL_EXIT_PLAN_MODE, ...(isError !== undefined ? { isError } : {}) }) as unknown as AgentMessage;
const otherResult = () => ({ role: 'toolResult', toolName: 'read', isError: false }) as unknown as AgentMessage;

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
});
