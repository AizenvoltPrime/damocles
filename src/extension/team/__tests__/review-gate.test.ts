import { describe, it, expect } from 'vitest';
import { Scratchpad } from '../scratchpad';
import {
  checkApprovalReadGate,
  checkReviewActionPrecondition,
  checkSynthesisReadGate,
  classifyStrandedStandby,
  formatReviewRoundReadyNotification,
  isSpecialistSettled,
} from '../review-gate';
import type { TeamAgent } from '../types';

function makeAgent(partial: Partial<TeamAgent> & { name: string; role: TeamAgent['role'] }): TeamAgent {
  return {
    agentId: `id-${partial.name}`,
    teamId: 'team-1',
    name: partial.name,
    role: partial.role,
    specialization: '',
    status: 'awaiting-review',
    model: 'test',
    profileId: null,
    startTime: null,
    endTime: null,
    toolCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    finalResponse: null,
    error: null,
    logFilePath: null,
    ...partial,
  };
}

describe('checkApprovalReadGate', () => {
  it('passes when the lead has read the specialist\'s current section', () => {
    const sp = new Scratchpad();
    sp.set('frontend-findings', 'v1', 'Frontend');
    sp.markRead('Lead', 'frontend-findings');
    expect(checkApprovalReadGate('Frontend', sp, 'Lead').ok).toBe(true);
  });

  it('fails with a specific error when the specialist has revised since the lead read', () => {
    const sp = new Scratchpad();
    sp.set('frontend-findings', 'v1', 'Frontend');
    sp.markRead('Lead', 'frontend-findings');
    sp.set('frontend-findings', 'v2', 'Frontend');
    const decision = checkApprovalReadGate('Frontend', sp, 'Lead');
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('Cannot approve "Frontend"');
    expect(decision.error).toContain('"frontend-findings" is v2');
    expect(decision.error).toContain('you last read v1');
  });

  it('fails when the lead has never read the specialist\'s section', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const decision = checkApprovalReadGate('S', sp, 'Lead');
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('never read');
  });

  it('passes when the specialist has authored no sections', () => {
    const sp = new Scratchpad();
    expect(checkApprovalReadGate('Ghost', sp, 'Lead').ok).toBe(true);
  });

  it('reports every stale section authored by the specialist', () => {
    const sp = new Scratchpad();
    sp.set('findings-a', 'v1', 'S');
    sp.set('findings-b', 'v1', 'S');
    sp.markRead('Lead', 'findings-a');
    sp.markRead('Lead', 'findings-b');
    sp.set('findings-a', 'v2', 'S');
    sp.set('findings-b', 'v2', 'S');
    const decision = checkApprovalReadGate('S', sp, 'Lead');
    expect(decision.ok).toBe(false);
    expect(decision.stale.map(s => s.section).sort()).toEqual(['findings-a', 'findings-b']);
  });
});

describe('checkSynthesisReadGate', () => {
  it('passes when the lead has read every specialist section at the current version', () => {
    const sp = new Scratchpad();
    sp.set('frontend-findings', 'body', 'Frontend');
    sp.set('backend-findings', 'body', 'Backend');
    sp.markRead('Lead', 'frontend-findings');
    sp.markRead('Lead', 'backend-findings');
    expect(checkSynthesisReadGate(['Frontend', 'Backend'], sp, 'Lead').ok).toBe(true);
  });

  it('fails when any specialist section is newer than the lead\'s last read', () => {
    const sp = new Scratchpad();
    sp.set('frontend-findings', 'v1', 'Frontend');
    sp.markRead('Lead', 'frontend-findings');
    sp.set('frontend-findings', 'v2', 'Frontend');
    const decision = checkSynthesisReadGate(['Frontend'], sp, 'Lead');
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('Cannot synthesize');
    expect(decision.error).toContain('"frontend-findings" is v2');
  });

  it('ignores sections the caller never includes (lead-authored sections are out of scope)', () => {
    const sp = new Scratchpad();
    sp.set('mission', 'v1', 'Lead');
    sp.set('mission', 'v2', 'Lead');
    expect(checkSynthesisReadGate([], sp, 'Lead').ok).toBe(true);
  });

  it('aggregates stale sections across multiple specialists', () => {
    const sp = new Scratchpad();
    sp.set('a', 'body', 'S1');
    sp.set('b', 'body', 'S2');
    const decision = checkSynthesisReadGate(['S1', 'S2'], sp, 'Lead');
    expect(decision.ok).toBe(false);
    expect(decision.stale.map(s => s.section).sort()).toEqual(['a', 'b']);
  });
});

describe('formatReviewRoundReadyNotification', () => {
  it('returns null when there are no unreviewed specialists', () => {
    const sp = new Scratchpad();
    expect(formatReviewRoundReadyNotification([], sp, 'Lead')).toBeNull();
  });

  it('marks a never-read authored section as UNREAD', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead')!;
    expect(msg).toContain('"findings" v1 [UNREAD]');
  });

  it('marks a read-then-revised section as STALE with the last-read version', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'S');
    sp.markRead('Lead', 'findings');
    sp.set('findings', 'v2', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead')!;
    expect(msg).toContain('"findings" v2 [STALE — you last read v1]');
  });

  it('marks a read-at-current section as up to date', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'S');
    sp.markRead('Lead', 'findings');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead')!;
    expect(msg).toContain('"findings" v1 [up to date]');
  });

  it('notes specialists who authored no sections', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'Ghost', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead')!;
    expect(msg).toContain('Ghost: no scratchpad section authored');
  });

  it('lists multiple specialists on separate lines', () => {
    const sp = new Scratchpad();
    sp.set('frontend-findings', 'body', 'Frontend');
    sp.set('backend-findings', 'body', 'Backend');
    const specialists = [
      makeAgent({ name: 'Frontend', role: 'specialist' }),
      makeAgent({ name: 'Backend', role: 'specialist' }),
    ];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead')!;
    expect(msg).toContain('  - Frontend:');
    expect(msg).toContain('  - Backend:');
  });

  it('omits the pending paragraph when pendingNames is empty or omitted', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msgDefault = formatReviewRoundReadyNotification(specialists, sp, 'Lead')!;
    const msgEmpty = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [])!;
    expect(msgDefault).not.toContain('Approval and revision are BLOCKED');
    expect(msgEmpty).not.toContain('Approval and revision are BLOCKED');
    expect(msgDefault).toBe(msgEmpty);
  });

  it('appends the pending paragraph when pendingNames has entries', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'Frontend');
    const specialists = [makeAgent({ name: 'Frontend', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', ['code-reviewer'])!;
    expect(msg).toContain('Approval and revision are BLOCKED until these never-dispatched specialists are resolved: code-reviewer.');
    expect(msg).toContain('Spawn them with team_spawn_specialist or cancel them with team_cancel_specialist');
    const pendingIdx = msg.indexOf('Approval and revision are BLOCKED');
    const specialistLineIdx = msg.indexOf('  - Frontend:');
    const closingIdx = msg.indexOf('After reading, call team_approve_specialist');
    expect(specialistLineIdx).toBeGreaterThan(-1);
    expect(pendingIdx).toBeGreaterThan(specialistLineIdx);
    expect(closingIdx).toBeGreaterThan(pendingIdx);
  });
});

describe('isSpecialistSettled', () => {
  it('treats awaiting-review, completed, cancelled, and failed as settled', () => {
    expect(isSpecialistSettled('awaiting-review')).toBe(true);
    expect(isSpecialistSettled('completed')).toBe(true);
    expect(isSpecialistSettled('cancelled')).toBe(true);
    expect(isSpecialistSettled('failed')).toBe(true);
  });

  it('does NOT treat standby, running, pending, or monitoring as settled', () => {
    expect(isSpecialistSettled('standby')).toBe(false);
    expect(isSpecialistSettled('running')).toBe(false);
    expect(isSpecialistSettled('pending')).toBe(false);
    expect(isSpecialistSettled('monitoring')).toBe(false);
  });
});

describe('classifyStrandedStandby', () => {
  it('returns not-stranded when the target is not in standby', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' }),
      makeAgent({ name: 'B', role: 'specialist', status: 'running' }),
    ];
    expect(classifyStrandedStandby('B', agents, false)).toBe('not-stranded');
  });

  it('returns not-stranded when another dispatched specialist is still running (a peer could wake it)', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'running' }),
      makeAgent({ name: 'B', role: 'specialist', status: 'standby' }),
    ];
    expect(classifyStrandedStandby('B', agents, false)).toBe('not-stranded');
  });

  it('nudges under mutual standby — a parked peer emits no wake event, so both are stranded', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'standby' }),
      makeAgent({ name: 'B', role: 'specialist', status: 'standby' }),
    ];
    expect(classifyStrandedStandby('A', agents, false)).toBe('nudge');
    expect(classifyStrandedStandby('B', agents, false)).toBe('nudge');
  });

  it('ignores still-pending (never dispatched) specialists when deciding strandedness', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' }),
      makeAgent({ name: 'B', role: 'specialist', status: 'standby' }),
      makeAgent({ name: 'C', role: 'specialist', status: 'pending' }),
    ];
    expect(classifyStrandedStandby('B', agents, false)).toBe('nudge');
  });

  it('repro shape: peers = [A awaiting-review, B standby], target B → nudge, then convert once nudged', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' }),
      makeAgent({ name: 'B', role: 'specialist', status: 'standby' }),
    ];
    expect(classifyStrandedStandby('B', agents, false)).toBe('nudge');
    expect(classifyStrandedStandby('B', agents, true)).toBe('convert');
  });

  it('treats a completed/cancelled/failed peer as settled (stranded → nudge)', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'completed' }),
      makeAgent({ name: 'B', role: 'specialist', status: 'standby' }),
    ];
    expect(classifyStrandedStandby('B', agents, false)).toBe('nudge');
  });
});

describe('checkReviewActionPrecondition', () => {
  it('rejects when pending exists even if reviewRoundReady is true (the bug repro)', () => {
    const decision = checkReviewActionPrecondition(['code-reviewer'], [], true, 'approve');
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('Cannot approve — these specialists were never dispatched: code-reviewer.');
    expect(decision.error).toContain('Spawn them with team_spawn_specialist or cancel them with team_cancel_specialist.');
  });

  it('uses "request revision" verb in error text when action is revise', () => {
    const decision = checkReviewActionPrecondition(['code-reviewer'], [], true, 'revise');
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('Cannot request revision — these specialists were never dispatched: code-reviewer.');
  });

  it('reports non-settled specialists when pending is empty', () => {
    const decision = checkReviewActionPrecondition(
      [],
      [{ name: 'frontend', status: 'running', toolCallCount: 4 }],
      false,
      'approve',
    );
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('Review round not ready — specialists still working: frontend (running, 4 tools).');
    expect(decision.error).toContain('Wait for the [REVIEW ROUND READY] system notification.');
  });

  it('reports the no-specialists terminal error when pending and non-settled are empty and reviewRoundReady is false', () => {
    const decision = checkReviewActionPrecondition([], [], false, 'approve');
    expect(decision.ok).toBe(false);
    expect(decision.error).toBe('No specialists are awaiting review.');
  });

  it('passes when pending and non-settled are empty and reviewRoundReady is true', () => {
    const decision = checkReviewActionPrecondition([], [], true, 'approve');
    expect(decision.ok).toBe(true);
    expect(decision.error).toBeUndefined();
  });

  it('prefers the pending error when pending and non-settled both have entries', () => {
    const decision = checkReviewActionPrecondition(
      ['code-reviewer'],
      [{ name: 'frontend', status: 'running', toolCallCount: 1 }],
      false,
      'approve',
    );
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('Cannot approve — these specialists were never dispatched: code-reviewer.');
    expect(decision.error).not.toContain('still working');
  });

  it('rejects with the non-settled error when reviewRoundReady is true but a specialist is still working', () => {
    const decision = checkReviewActionPrecondition(
      [],
      [{ name: 'frontend', status: 'running', toolCallCount: 2 }],
      true,
      'approve',
    );
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain('Review round not ready — specialists still working: frontend (running, 2 tools).');
  });
});
