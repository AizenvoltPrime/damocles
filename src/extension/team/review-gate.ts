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

/**
 * Mechanical lead read-gate for spawning: the lead cannot spawn a specialist until it has read the
 * immutable `mission-brief` section (mirrors checkApprovalReadGate). Defensive when the section is
 * absent (never bricks a team). A section read (markRead) or a read-all (markAllRead) satisfies it.
 */
export function checkBriefReadGate(
  scratchpad: Scratchpad,
  leadName: string,
): { ok: boolean; error?: string } {
  if (!scratchpad.get('mission-brief')) return { ok: true };
  if (scratchpad.getReadVersion(leadName, 'mission-brief') >= 1) return { ok: true };
  return {
    ok: false,
    error:
      'Cannot spawn a specialist yet — read the `mission-brief` section via team_read_scratchpad first. ' +
      'It is the authoritative specification; ground every specialist task in it before spawning.',
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

/** Whether a message sent now can actually reach the agent: true only for statuses whose runner is alive
 *  and subscribed to the bus (`running`/`awaiting-review`/`standby`/`monitoring`). `pending` runners
 *  aren't spawned yet and terminal ones have unsubscribed, so a send to either is silently dropped. */
export function isDeliverableStatus(status: TeamAgent['status']): boolean {
  return status === 'running'
    || status === 'awaiting-review'
    || status === 'standby'
    || status === 'monitoring';
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

/**
 * Decide how to handle a specialist that ended its turn owing a terminal action — it called neither
 * `team_report_complete` (→ confirmedComplete) nor `team_standby` (→ pendingStandby), so the runner's
 * `keepAlive` is false and the session would otherwise break out and settle as terminal `completed`.
 * That silent completion is the root deadlock: the lead then waits forever to review a specialist that
 * never entered `awaiting-review`. Pure mirror of classifyStrandedStandby: an agent snapshot plus a
 * caller-tracked "already nudged" flag and a ceiling flag, returning the action with no side effects.
 *
 * - `not-owed`: target doesn't exist, isn't a specialist, or isn't `running` (already settled/parked —
 *   nothing owed); OR it is at the review-round ceiling, where a bare end is the intended cap behavior
 *   (reportComplete throws there, and a convert couldn't stick because keepAlive stays false).
 * - `nudge`: running and not yet nudged — give it one deferred nudge + a grace turn to end properly.
 * - `convert`: running and the nudge was already delivered — it re-offended, so force → awaiting-review.
 *
 * The caller gates on `completionResolved`; this function is deliberately unaware of it.
 */
export function classifyTerminalContract(
  target: string,
  agents: TeamAgent[],
  alreadyNudged: boolean,
  atReviewCeiling: boolean,
): 'not-owed' | 'nudge' | 'convert' {
  const self = agents.find(a => a.name === target);
  if (!self || self.role !== 'specialist' || self.status !== 'running') return 'not-owed';
  if (atReviewCeiling) return 'not-owed';
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
