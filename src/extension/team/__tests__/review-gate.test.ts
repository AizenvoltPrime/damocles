import { describe, it, expect } from 'vitest';
import { Scratchpad } from '../scratchpad';
import {
  checkApprovalReadGate,
  checkSynthesisReadGate,
  formatReviewRoundReadyNotification,
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
});
