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

export function formatReviewRoundReadyNotification(
  unreviewed: TeamAgent[],
  scratchpad: Scratchpad,
  leadName: string,
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
  return (
    `[REVIEW ROUND READY] All dispatched specialists have reported. ` +
    `Call team_read_scratchpad for every section marked UNREAD or STALE before approving — ` +
    `the approval gate will reject team_approve_specialist until you do.\n\n` +
    specialistLines.join('\n') +
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
