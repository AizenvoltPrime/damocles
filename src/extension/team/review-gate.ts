import type { Scratchpad, StaleSectionInfo } from './scratchpad';
import type { TeamAgent } from './types';

export interface ReadGateDecision {
  ok: boolean;
  error?: string;
  stale: StaleSectionInfo[];
}

export function checkApprovalReadGate(
  specialistName: string,
  scratchpad: Scratchpad,
  leadName: string,
): ReadGateDecision {
  const stale = scratchpad.getStaleSectionsFor(leadName, specialistName);
  if (stale.length === 0) return { ok: true, stale: [] };
  return {
    ok: false,
    stale,
    error:
      `Cannot approve "${specialistName}" — their work has been updated since your last read: ` +
      `${formatStaleList(stale)}. Call team_read_scratchpad for each listed section before approving.`,
  };
}

// Re-check staleness at synthesis time because a specialist's final tool call can complete
// after team_approve_specialist aborts their session — the write lands between approval and
// abort-acknowledge, so the lead's read cursor may be behind the current version.
export function checkSynthesisReadGate(
  specialistNames: Iterable<string>,
  scratchpad: Scratchpad,
  leadName: string,
): ReadGateDecision {
  const stale: StaleSectionInfo[] = [];
  for (const name of specialistNames) {
    stale.push(...scratchpad.getStaleSectionsFor(leadName, name));
  }
  if (stale.length === 0) return { ok: true, stale: [] };
  return {
    ok: false,
    stale,
    error:
      `Cannot synthesize — team-member sections have been updated since your last read: ` +
      `${formatStaleList(stale)}. Call team_read_scratchpad for each listed section before synthesizing.`,
  };
}

export type ReviewActionPreconditionDecision =
  | { ok: true }
  | { ok: false; error: string };

export function checkReviewActionPrecondition(
  pendingNames: string[],
  nonSettled: Array<{ name: string; status: TeamAgent['status']; toolCallCount: number }>,
  reviewRoundReady: boolean,
  action: 'approve' | 'revise',
): ReviewActionPreconditionDecision {
  if (pendingNames.length > 0) {
    const verb = action === 'approve' ? 'approve' : 'request revision';
    return {
      ok: false,
      error:
        `Cannot ${verb} — these specialists were never dispatched: ${pendingNames.join(', ')}. ` +
        `Spawn them with team_spawn_specialist or cancel them with team_cancel_specialist.`,
    };
  }
  if (nonSettled.length > 0) {
    const list = nonSettled.map(d => `${d.name} (${d.status}, ${d.toolCallCount} tools)`).join(', ');
    return {
      ok: false,
      error:
        `Review round not ready — specialists still working: ${list}. ` +
        `Wait for the [REVIEW ROUND READY] system notification.`,
    };
  }
  if (!reviewRoundReady) {
    return { ok: false, error: 'No specialists are awaiting review.' };
  }
  return { ok: true };
}

/** The settled set shared by the review gate and stranded-standby recovery. `standby` is deliberately
 *  NOT settled — a standby specialist still owes a final turn; recovery is what moves it into this set. */
export function isSpecialistSettled(status: TeamAgent['status']): boolean {
  return status === 'awaiting-review'
    || status === 'completed'
    || status === 'cancelled'
    || status === 'failed';
}

/**
 * Decide how to recover a specialist that ended its turn in `standby` while no peer can wake it — a
 * state no event will resolve (see the deadlock analysis in the plan). Pure: takes an agent snapshot
 * plus a caller-tracked "already nudged" flag and returns the action, with no side effects.
 *
 * A standby specialist can only be woken by a peer that is still `running` — a running agent can write
 * the scratchpad (broadcast) or send it a direct message. A peer that is itself parked in `standby`, or
 * already settled, will emit no such event. So the target is stranded unless some OTHER specialist is
 * still running. This also covers mutual standby: two specialists both parked are each stranded, and the
 * caller nudges both (the wake breaks the cycle — each can then message a peer or report complete).
 *
 * - `not-stranded`: `target` isn't in standby, OR some other specialist is still `running` and could wake it.
 * - `nudge`: stranded and not yet nudged — give it one clean final turn to report complete.
 * - `convert`: stranded and the nudge was already DELIVERED — it re-standbyed, so force standby → awaiting-review.
 */
export function classifyStrandedStandby(
  target: string,
  agents: TeamAgent[],
  alreadyNudged: boolean,
): 'not-stranded' | 'nudge' | 'convert' {
  const self = agents.find(a => a.name === target);
  if (!self || self.status !== 'standby') return 'not-stranded';
  const someoneRunning = agents.some(a =>
    a.role === 'specialist' && a.name !== target && a.status === 'running');
  if (someoneRunning) return 'not-stranded';
  return alreadyNudged ? 'convert' : 'nudge';
}

export function formatReviewRoundReadyNotification(
  unreviewed: TeamAgent[],
  scratchpad: Scratchpad,
  leadName: string,
  pendingNames: string[] = [],
): string | null {
  if (unreviewed.length === 0) return null;
  const specialistLines = unreviewed.map(agent => {
    const authored = scratchpad.getSectionsAuthoredBy(agent.name);
    if (authored.length === 0) {
      return `  - ${agent.name}: no scratchpad section authored`;
    }
    const fragments = authored.map(entry => {
      const readVersion = scratchpad.getReadVersion(leadName, entry.section);
      let status: string;
      if (readVersion === 0) status = 'UNREAD';
      else if (readVersion < entry.version) status = `STALE — you last read v${readVersion}`;
      else status = 'up to date';
      return `"${entry.section}" v${entry.version} [${status}]`;
    });
    return `  - ${agent.name}: ${fragments.join(', ')}`;
  });
  const pendingParagraph = pendingNames.length > 0
    ? `\n\nApproval and revision are BLOCKED until these never-dispatched specialists are resolved: ${pendingNames.join(', ')}. ` +
      `Spawn them with team_spawn_specialist or cancel them with team_cancel_specialist.`
    : '';
  return (
    `[REVIEW ROUND READY] All dispatched specialists have reported. ` +
    `Call team_read_scratchpad for every section marked UNREAD or STALE before approving — ` +
    `the approval gate will reject team_approve_specialist until you do.\n\n` +
    specialistLines.join('\n') +
    pendingParagraph +
    `\n\nAfter reading, call team_approve_specialist (satisfactory) or team_request_revision (changes needed) for each.`
  );
}

function formatStaleList(stale: StaleSectionInfo[]): string {
  return stale
    .map(s => {
      const readLabel = s.lastReadVersion === 0 ? 'never read' : `you last read v${s.lastReadVersion}`;
      return `"${s.section}" is v${s.currentVersion} by ${s.author} (${readLabel})`;
    })
    .join('; ');
}
