import { describe, it, expect } from 'vitest';
import { Scratchpad } from '../scratchpad';
import {
  checkApprovalReadGate,
  checkBriefReadGate,
  checkReviewActionPrecondition,
  checkReviewerReportGate,
  checkSynthesisReadGate,
  classifyStrandedStandby,
  classifyTerminalContract,
  formatReviewRoundReadyNotification,
  isDeliverableStatus,
  isSpecialistFinal,
  isSpecialistSettled,
} from '../review-gate';
import { ReviewCoverage, type CoverageView } from '../review-coverage';
import type { TeamAgent } from '../types';

/** The rejection text of a gate decision, failing if it was accepted or carried no reason. */
function rejection(decision: { ok: boolean; error?: string | undefined }): string {
  if (decision.ok) throw new Error('expected a rejected decision, got ok');
  if (decision.error === undefined) throw new Error('a rejected decision carried no error text');
  return decision.error;
}

function makeAgent(partial: Partial<TeamAgent> & { name: string; role: TeamAgent['role'] }): TeamAgent {
  return {
    agentId: `id-${partial.name}`,
    teamId: 'team-1',
    attempt: 0,
    specialization: '',
    status: 'awaiting-review',
    model: 'test',
    profileId: null,
    activeMs: 0,
    runningSince: null,
    toolCallCount: 0, carriedToolCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    carriedUsage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    dollarBilled: true,
    effort: null,
    finalResponse: null,
    result: null,
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
    expect(rejection(decision)).toContain('Cannot approve "Frontend"');
    expect(rejection(decision)).toContain('"frontend-findings" is v2');
    expect(rejection(decision)).toContain('you last read v1');
  });

  it('fails when the lead has never read the specialist\'s section', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const decision = checkApprovalReadGate('S', sp, 'Lead');
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toContain('never read');
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

describe('checkBriefReadGate', () => {
  it('blocks spawning when the lead has not read the seeded mission-brief', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'the spec');
    const decision = checkBriefReadGate(sp, 'Lead');
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toContain('mission-brief');
    expect(rejection(decision)).toContain('team_read_scratchpad');
  });

  it('passes after the lead reads the mission-brief section by name', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'the spec');
    sp.markRead('Lead', 'mission-brief');
    expect(checkBriefReadGate(sp, 'Lead').ok).toBe(true);
  });

  it('passes after the lead reads all sections (markAllRead)', () => {
    const sp = new Scratchpad();
    sp.seedImmutable('mission-brief', 'the spec');
    sp.markAllRead('Lead');
    expect(checkBriefReadGate(sp, 'Lead').ok).toBe(true);
  });

  it('is a no-op (passes) when mission-brief is absent (defensive — never bricks a team)', () => {
    const sp = new Scratchpad();
    expect(checkBriefReadGate(sp, 'Lead').ok).toBe(true);
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
    expect(rejection(decision)).toContain('Cannot synthesize');
    expect(rejection(decision)).toContain('"frontend-findings" is v2');
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
    expect(formatReviewRoundReadyNotification([], sp, 'Lead', [], [])).toBeNull();
  });

  it('marks a never-read authored section as UNREAD', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [])!;
    expect(msg).toContain('"findings" v1 [UNREAD]');
  });

  it('marks a read-then-revised section as STALE with the last-read version', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'S');
    sp.markRead('Lead', 'findings');
    sp.set('findings', 'v2', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [])!;
    expect(msg).toContain('"findings" v2 [STALE — you last read v1]');
  });

  it('marks a read-at-current section as up to date', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'v1', 'S');
    sp.markRead('Lead', 'findings');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [])!;
    expect(msg).toContain('"findings" v1 [up to date]');
  });

  it('notes specialists who authored no sections', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'Ghost', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [])!;
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
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [])!;
    expect(msg).toContain('  - Frontend:');
    expect(msg).toContain('  - Backend:');
  });

  it('omits the pending paragraph when pendingNames is empty', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [])!;
    expect(msg).not.toContain('Approval and revision are BLOCKED');
  });

  it('appends the pending paragraph when pendingNames has entries', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'Frontend');
    const specialists = [makeAgent({ name: 'Frontend', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', ['code-reviewer'], [])!;
    expect(msg).toContain('Approval and revision are BLOCKED until these never-dispatched specialists are resolved: code-reviewer.');
    expect(msg).toContain('Spawn them with team_spawn_specialist or cancel them with team_cancel_specialist');
    const pendingIdx = msg.indexOf('Approval and revision are BLOCKED');
    const specialistLineIdx = msg.indexOf('  - Frontend:');
    const closingIdx = msg.indexOf('After reading, call team_approve_specialist');
    expect(specialistLineIdx).toBeGreaterThan(-1);
    expect(pendingIdx).toBeGreaterThan(specialistLineIdx);
    expect(closingIdx).toBeGreaterThan(pendingIdx);
  });

  it('lists a steer under its own specialist only, followed by the steer paragraph', () => {
    const sp = new Scratchpad();
    const specialists = [
      makeAgent({ name: 'A', role: 'specialist' }),
      makeAgent({ name: 'B', role: 'specialist' }),
    ];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'A', message: 'use v2', attempt: 0 },
    ])!;
    expect(msg).toContain('  - A: no scratchpad section authored\n    user steer: "use v2"\n  - B: no scratchpad section authored\n\n');
    expect(msg.match(/user steer:/g)).toHaveLength(1);
    expect(msg).toContain("User steers are the user's authoritative changes");
    expect(msg.indexOf("User steers are")).toBeLessThan(msg.indexOf('After reading'));
  });

  it('is unchanged when there are no steers', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [])!;
    expect(msg).toBe(
      '[REVIEW ROUND READY] All dispatched specialists have reported. ' +
      'Call team_read_scratchpad for every section marked UNREAD or STALE before approving — ' +
      'the approval gate will reject team_approve_specialist until you do.\n\n' +
      '  - S: "findings" v1 [UNREAD]' +
      '\n\nAfter reading, call team_approve_specialist (satisfactory) or team_request_revision (changes needed) for each.',
    );
  });

  it('does not list a steer on the lead', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'Lead', message: 'wrap up', attempt: 0 },
    ])!;
    expect(msg).not.toContain('user steer');
    expect(msg).not.toContain('User steers are');
  });

  it('keeps a multi-line steer on one line', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'S', message: 'first\nsecond', attempt: 0 },
    ])!;
    expect(msg).toContain('    user steer: "first\\nsecond"\n');
  });

  it('keeps several steers in order', () => {
    const sp = new Scratchpad();
    sp.set('findings', 'body', 'S');
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'S', message: 'one', attempt: 0 },
      { memberName: 'S', message: 'two', attempt: 0 },
    ])!;
    expect(msg).toContain('  - S: "findings" v1 [UNREAD]\n    user steer: "one"\n    user steer: "two"');
  });

  const USER_STEERS = "User steers are the user's authoritative changes";
  const EARLIER_STEERS = 'Earlier attempt steers went to a previous attempt';
  const CURRENT_IMAGES = 'Steer images reached only the steered specialist, not you';
  const EARLIER_IMAGES = 'Their images reached only the attempt that was steered';

  it('labels a steer from an earlier attempt and keeps it out of the steered-task paragraph', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'S', role: 'specialist', attempt: 1 })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'S', message: 'old ask', attempt: 0 },
    ])!;
    expect(msg).toContain('  - S: no scratchpad section authored\n    earlier attempt steer (not delivered to this attempt): "old ask"\n\n');
    expect(msg).not.toContain('user steer:');
    expect(msg).not.toContain(USER_STEERS);
    expect(msg).toContain(`${EARLIER_STEERS} of the steered specialist and are not part of the current attempt's task.`);
    expect(msg.indexOf(EARLIER_STEERS)).toBeLessThan(msg.indexOf('After reading'));
  });

  it('lists earlier and current attempt steers in order, each with its own paragraph', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'S', role: 'specialist', attempt: 1 })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'S', message: 'old ask', attempt: 0 },
      { memberName: 'S', message: 'new ask', attempt: 1 },
    ])!;
    expect(msg).toContain(
      '  - S: no scratchpad section authored\n' +
      '    earlier attempt steer (not delivered to this attempt): "old ask"\n' +
      '    user steer: "new ask"\n\n' + USER_STEERS,
    );
    expect(msg.indexOf(USER_STEERS)).toBeLessThan(msg.indexOf(EARLIER_STEERS));
  });

  it('tells the lead that images of a current attempt steer reached only the specialist', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'S', message: '', imageCount: 2, attempt: 0 },
    ])!;
    expect(msg).toContain('    user steer: (no text) (+2 images)');
    expect(msg).toContain(`${CURRENT_IMAGES}; if its section does not say what they asked for, ask it.`);
    expect(msg).not.toContain(EARLIER_IMAGES);
  });

  it('tells the lead that images of an earlier attempt steer reached neither it nor the current attempt', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'S', role: 'specialist', attempt: 1 })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'S', message: 'match this', imageCount: 1, attempt: 0 },
      { memberName: 'S', message: 'text only', attempt: 1 },
    ])!;
    expect(msg).toContain(`${EARLIER_IMAGES}, so neither you nor the current attempt has seen them.`);
    expect(msg).not.toContain(CURRENT_IMAGES);
  });

  it('says nothing about images when no listed steer has any', () => {
    const sp = new Scratchpad();
    const specialists = [makeAgent({ name: 'S', role: 'specialist' })];
    const msg = formatReviewRoundReadyNotification(specialists, sp, 'Lead', [], [
      { memberName: 'S', message: 'text only', attempt: 0 },
      { memberName: 'Other', message: 'not listed', imageCount: 1, attempt: 0 },
    ])!;
    expect(msg).not.toContain(CURRENT_IMAGES);
    expect(msg).not.toContain(EARLIER_IMAGES);
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

describe('isDeliverableStatus', () => {
  const cases: Array<[TeamAgent['status'], boolean]> = [
    // Alive & subscribed to the bus — a message wakes them.
    ['running', true],
    ['awaiting-review', true],
    ['standby', true],
    ['monitoring', true],
    // Undeliverable — never prompted by a queued message (pending) or unsubscribed on exit (terminal).
    ['pending', false],
    ['completed', false],
    ['failed', false],
    ['cancelled', false],
  ];

  it.each(cases)('status %s → deliverable %s', (status, expected) => {
    expect(isDeliverableStatus(status)).toBe(expected);
  });

  it('covers all 8 statuses in the union (no status left unclassified)', () => {
    const allStatuses: Array<TeamAgent['status']> = [
      'pending', 'running', 'completed', 'failed', 'cancelled', 'awaiting-review', 'standby', 'monitoring',
    ];
    expect(cases.map(([s]) => s).sort()).toEqual([...allStatuses].sort());
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

describe('classifyTerminalContract', () => {
  it('returns not-owed when the target does not exist in the roster', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'running' }),
    ];
    expect(classifyTerminalContract('ghost', agents, false, false)).toBe('not-owed');
  });

  it('returns not-owed for a non-specialist (lead) target even when running & un-nudged', () => {
    const agents = [
      makeAgent({ name: 'Lead', role: 'lead', status: 'running' }),
    ];
    expect(classifyTerminalContract('Lead', agents, false, false)).toBe('not-owed');
  });

  it('returns not-owed for non-running statuses (standby / awaiting-review / completed)', () => {
    const standby = [makeAgent({ name: 'A', role: 'specialist', status: 'standby' })];
    const awaiting = [makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' })];
    const completed = [makeAgent({ name: 'A', role: 'specialist', status: 'completed' })];
    expect(classifyTerminalContract('A', standby, false, false)).toBe('not-owed');
    expect(classifyTerminalContract('A', awaiting, false, false)).toBe('not-owed');
    expect(classifyTerminalContract('A', completed, false, false)).toBe('not-owed');
  });

  it('returns not-owed at the review-round ceiling even when running & un-nudged (bare end is the cap)', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'running' }),
    ];
    expect(classifyTerminalContract('A', agents, false, true)).toBe('not-owed');
    // ceiling wins even if somehow already nudged
    expect(classifyTerminalContract('A', agents, true, true)).toBe('not-owed');
  });

  it('returns nudge for a running specialist that has not yet been nudged', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'running' }),
    ];
    expect(classifyTerminalContract('A', agents, false, false)).toBe('nudge');
  });

  it('returns convert for a running specialist that was already nudged (re-offended)', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'running' }),
    ];
    expect(classifyTerminalContract('A', agents, true, false)).toBe('convert');
  });

  it('repro shape: lone running specialist → nudge, then convert once nudged (below the ceiling)', () => {
    const agents = [
      makeAgent({ name: 'A', role: 'specialist', status: 'running' }),
    ];
    expect(classifyTerminalContract('A', agents, false, false)).toBe('nudge');
    expect(classifyTerminalContract('A', agents, true, false)).toBe('convert');
  });
});

describe('checkReviewActionPrecondition', () => {
  it('rejects when pending exists even if reviewRoundReady is true (the bug repro)', () => {
    const decision = checkReviewActionPrecondition(['code-reviewer'], [], true, 'approve');
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toContain('Cannot approve — these specialists were never dispatched: code-reviewer.');
    expect(rejection(decision)).toContain('Spawn them with team_spawn_specialist or cancel them with team_cancel_specialist.');
  });

  it('uses "request revision" verb in error text when action is revise', () => {
    const decision = checkReviewActionPrecondition(['code-reviewer'], [], true, 'revise');
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toContain('Cannot request revision — these specialists were never dispatched: code-reviewer.');
  });

  it('reports non-settled specialists when pending is empty', () => {
    const decision = checkReviewActionPrecondition(
      [],
      [{ name: 'frontend', status: 'running', toolCallCount: 4 }],
      false,
      'approve',
    );
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toContain('Review round not ready — specialists still working: frontend (running, 4 tools).');
    expect(rejection(decision)).toContain('Wait for the [REVIEW ROUND READY] system notification.');
  });

  it('reports the no-specialists terminal error when pending and non-settled are empty and reviewRoundReady is false', () => {
    const decision = checkReviewActionPrecondition([], [], false, 'approve');
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toBe('No specialists are awaiting review.');
  });

  it('passes when pending and non-settled are empty and reviewRoundReady is true', () => {
    const decision = checkReviewActionPrecondition([], [], true, 'approve');
    expect(decision).toEqual({ ok: true });
  });

  it('prefers the pending error when pending and non-settled both have entries', () => {
    const decision = checkReviewActionPrecondition(
      ['code-reviewer'],
      [{ name: 'frontend', status: 'running', toolCallCount: 1 }],
      false,
      'approve',
    );
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toContain('Cannot approve — these specialists were never dispatched: code-reviewer.');
    expect(rejection(decision)).not.toContain('still working');
  });

  it('rejects with the non-settled error when reviewRoundReady is true but a specialist is still working', () => {
    const decision = checkReviewActionPrecondition(
      [],
      [{ name: 'frontend', status: 'running', toolCallCount: 2 }],
      true,
      'approve',
    );
    expect(decision.ok).toBe(false);
    expect(rejection(decision)).toContain('Review round not ready — specialists still working: frontend (running, 2 tools).');
  });
});

describe('isSpecialistFinal', () => {
  it.each(['completed', 'cancelled', 'failed'] as Array<TeamAgent['status']>)('%s is final', (status) => {
    expect(isSpecialistFinal(status)).toBe(true);
  });

  it.each(['awaiting-review', 'running', 'standby', 'pending', 'monitoring'] as Array<TeamAgent['status']>)('%s is not final', (status) => {
    expect(isSpecialistFinal(status)).toBe(false);
  });
});

describe('checkReviewerReportGate', () => {
  it('passes once the reviewer holds the current version of every implementor section', () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('backend-api', 'v1', 'backend');
    scratchpad.markRead('appsec', 'backend-api');
    expect(checkReviewerReportGate('appsec', ['backend'], scratchpad)).toEqual({ ok: true, stale: [] });
  });

  it('lists every unread or stale implementor section, in the brief text', () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('backend-api', 'v1', 'backend');
    scratchpad.markRead('appsec', 'backend-api');
    scratchpad.set('backend-api', 'v2', 'backend');
    scratchpad.set('frontend-ui', 'v1', 'frontend');
    scratchpad.set('unrelated', 'v1', 'qa');
    expect(rejection(checkReviewerReportGate('appsec', ['backend', 'frontend'], scratchpad))).toBe(
      'Cannot report complete: your review is out of date. "backend-api" is v2 by backend (you last read v1); "frontend-ui" is v1 by frontend (never read). ' +
      'Read each listed section with team_read_scratchpad, update your review, then report again.',
    );
  });

  it('gates nothing for a reviewer of nobody', () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('backend-api', 'v1', 'backend');
    expect(checkReviewerReportGate('qa', [], scratchpad).ok).toBe(true);
  });
});

describe('formatReviewRoundReadyNotification coverage lines', () => {
  const statusOf = (map: Record<string, TeamAgent['status']>) => (name: string): TeamAgent['status'] => map[name] ?? 'awaiting-review';

  const viewOf = (status: Record<string, TeamAgent['status']>, scratchpad: Scratchpad): CoverageView => ({
    statusOf: statusOf(status),
    staleReads: (reviewer, implementor) => scratchpad.getStaleSectionsFor(reviewer, implementor),
  });

  function notify(coverage: ReviewCoverage, agents: TeamAgent[], status: Record<string, TeamAgent['status']> = {}, scratchpad = new Scratchpad()): string {
    return formatReviewRoundReadyNotification(agents, scratchpad, 'Lead', [], [], { model: coverage, view: viewOf(status, scratchpad) })!;
  }

  function paired(): ReviewCoverage {
    const coverage = new ReviewCoverage();
    coverage.declare('appsec', ['backend']);
    coverage.land('backend', { attempt: 0, round: 2 });
    return coverage;
  }

  const backend = makeAgent({ name: 'backend', role: 'specialist' });
  const appsec = makeAgent({ name: 'appsec', role: 'specialist' });

  it('APPROVED and current', () => {
    const coverage = paired();
    coverage.recordSignoffs('appsec', [{ implementor: 'backend', verdict: 'approve' }]);
    expect(notify(coverage, [backend])).toContain('  - backend: no scratchpad section authored\n    reviewed by appsec: APPROVED revision 2 [current]');
  });

  it('CHANGES REQUESTED blocks approval', () => {
    const coverage = paired();
    coverage.recordSignoffs('appsec', [{ implementor: 'backend', verdict: 'changes_requested' }]);
    expect(notify(coverage, [backend])).toContain('reviewed by appsec: CHANGES REQUESTED on revision 2 [approval blocked: revise or dismiss]');
  });

  it('a sign-off on an older revision is NOT CURRENT', () => {
    const coverage = new ReviewCoverage();
    coverage.declare('appsec', ['backend']);
    coverage.land('backend', { attempt: 0, round: 1 });
    coverage.recordSignoffs('appsec', [{ implementor: 'backend', verdict: 'approve' }]);
    coverage.land('backend', { attempt: 0, round: 2 });
    expect(notify(coverage, [backend])).toContain('reviewed by appsec: signed off on revision 1 [NOT CURRENT, approval blocked]');
  });

  it('a current approve over a section the implementor changed after it is NOT CURRENT, through the same decision as the gate', () => {
    const scratchpad = new Scratchpad();
    scratchpad.set('backend-api', 'v1', 'backend');
    scratchpad.markRead('appsec', 'backend-api');
    const coverage = paired();
    coverage.recordSignoffs('appsec', [{ implementor: 'backend', verdict: 'approve' }]);
    scratchpad.set('backend-api', 'v2 after a peer question', 'backend');

    expect(notify(coverage, [backend], {}, scratchpad))
      .toContain('reviewed by appsec: APPROVED revision 2 but has not read "backend-api" v2 [NOT CURRENT, approval blocked]');
    expect(coverage.checkApproval('backend', viewOf({}, scratchpad))).toContain('appsec signed off on it but has not read "backend-api" v2');
  });

  it('a final reviewer that never reviewed the revision offers redispatch or dismissal, and a completed one only dismissal', () => {
    expect(notify(paired(), [backend], { appsec: 'cancelled' })).toContain('appsec cancelled, revision 2 unreviewed [approval blocked: redispatch appsec or dismiss with team_dismiss_review]');
    expect(notify(paired(), [backend], { appsec: 'completed' })).toContain('appsec completed, revision 2 unreviewed [approval blocked: dismiss with team_dismiss_review]');
  });

  it('a dismissed review reads as current', () => {
    const coverage = paired();
    coverage.dismiss('appsec', 'backend', 'accepted as remaining work', viewOf({ appsec: 'failed' }, new Scratchpad()));
    expect(notify(coverage, [backend], { appsec: 'failed' })).toContain('reviewed by appsec: review of revision 2 DISMISSED by you [current]');
  });

  it('a reviewer line asks for its implementor first, and the round closes with the ordering rule', () => {
    const text = notify(paired(), [backend, appsec]);
    expect(text).toContain('  - appsec: no scratchpad section authored\n    reviews backend: awaiting review [approval blocked: approve or revise backend first]');
    expect(text.endsWith('for each. Approve implementors before their reviewers.')).toBe(true);
  });

  it('a team with no pairs renders exactly as without coverage', () => {
    const agents = [backend];
    expect(notify(new ReviewCoverage(), agents)).toBe(formatReviewRoundReadyNotification(agents, new Scratchpad(), 'Lead', [], []));
  });
});
