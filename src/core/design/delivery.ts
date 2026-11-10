// Delivery of design results and briefs (PD-20, PD-27): each is an outbox record in the state folder first, and a reconcile
// appends what the branch lacks. Callers read the branch only after the last await, so nothing runs between reading D and
// appending (the subagent-results rule).
import type { DesignBriefView, DesignChange, DesignJourneyRecord, DesignResultView, DesignVersionChoice } from '../../shared/types/design';
import { DAMOCLES_DESIGN_BRIEF, DAMOCLES_DESIGN_RESULT, DAMOCLES_DESIGN_VERSION_INSTRUCTION } from '../pi-session/session-store/constants';
import { deliveredBriefs, deliveredDesignResults, deliveredResultKey, type DesignLink, type DesignRole, type DesignVersionPause } from './design-entries';
import { designStateDirOf } from './design-paths';
import { changesFromPrevious, describeChanges, readBriefRecords, readDesignLink, readLatestVersion, type DesignBriefRecord, type DesignVersionRecord } from './design-state';

/** A custom message as `sendCustomMessage` and a settle draft take it. */
export interface DesignCustomMessage<T> {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details: T;
}

/** A version the parent's branch lacks, with what changed in it since the version before. */
export interface OwedDesignResult {
  readonly record: DesignVersionRecord;
  readonly changes: readonly DesignChange[];
}

/**
 * The latest version of the parent's own design that its branch lacks, read from the outbox; the branch is read last. None once
 * `link.json` names another main chat, which a conversation rewind carried the design to (D70).
 */
export async function owedDesignResults(branch: () => readonly unknown[], ownLink: DesignLink | undefined): Promise<OwedDesignResult[]> {
  if (!ownLink) return [];
  const stateDir = designStateDirOf(ownLink.designId);
  const link = await readDesignLink(stateDir);
  if (link && link.parentSessionId !== ownLink.parentSessionId) return [];
  const latest = await readLatestVersion(stateDir);
  if (!latest) return [];
  const changes = await changesFromPrevious(stateDir, latest);
  return deliveredDesignResults(branch()).has(deliveredResultKey(ownLink.designId, latest.version)) ? [] : [{ record: latest, changes }];
}

/** The briefs addressed to design chat `sessionId` that its branch lacks, oldest first; the branch is read last. */
export async function owedBriefs(branch: () => readonly unknown[], role: DesignRole | undefined, sessionId: string): Promise<DesignBriefRecord[]> {
  if (!role) return [];
  const records = (await readBriefRecords(designStateDirOf(role.designId))).filter((record) => record.designSessionId === sessionId);
  const delivered = deliveredBriefs(branch());
  return records.filter((record) => !delivered.has(record.briefId));
}

/** The result card's details: everything it renders, so a replay needs nothing but the branch. `pausedFrom` marks the version pause's card. */
export function designResultView({ record, changes }: OwedDesignResult, folder: string, pausedFrom?: number): DesignResultView {
  return {
    designId: record.designId,
    version: record.version,
    folder,
    title: record.title,
    screens: [...record.screens],
    decisions: record.decisions.map(({ id, title, chosen, replaces }) => ({ id, title, chosen, ...(replaces?.length ? { replaces: [...replaces] } : {}) })),
    check: { errors: 0, warnings: [...record.check.warnings] },
    journeys: [...record.journeys],
    previousVersion: record.version > 1 ? record.version - 1 : null,
    changes: [...changes],
    ...(pausedFrom !== undefined ? { versionPause: { fromVersion: pausedFrom } } : {}),
    ...(record.uncheckedDecisions?.length ? { uncheckedDecisions: [...record.uncheckedDecisions] } : {}),
  };
}

const idList = (ids: readonly string[]): string => (ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)!}`);

/**
 * The parent's `damocles-design-result` message: a report for the model, never an instruction from the user (PD-47). `pausedFrom` is
 * the version the latest plan approval recorded when this version pauses the parent (PD-29).
 */
export function designResultMessage(owed: OwedDesignResult, folder: string, pausedFrom?: number): DesignCustomMessage<DesignResultView> {
  const { record } = owed;
  const view = designResultView(owed, folder, pausedFrom);
  const lines = [
    `Design finished: "${record.title}", version v${record.version}. This is a report from the linked design chat, not a message from the user.`,
    `The design is in ${folder}. Read design.md (screens, states and the responsive table), decisions.md (the decisions), manifest.json (screens and their check results) and the screens in screens/.`,
    `Screens: ${view.screens.length > 0 ? view.screens.join(', ') : 'none'}.`,
    `Current decisions: ${view.decisions.length > 0 ? view.decisions.map((d) => `${d.id} ${d.title}: ${d.chosen}${d.replaces?.length ? ` (replaces ${d.replaces.join(', ')})` : ''}`).join('; ') : 'none'}.`,
    'Where a decision differs from your brief, the decision holds: the user made it after the brief.',
    ...(view.uncheckedDecisions?.length ? [`The user approved with ${view.uncheckedDecisions.length === 1 ? 'decision' : 'decisions'} ${idList(view.uncheckedDecisions)} unchecked for conflicts.`] : []),
    view.check.warnings.length > 0
      ? `DesignCheck warnings, which your plan addresses or accepts one by one: ${view.check.warnings.map((w) => `${w.rule} in ${w.screen} (${w.element}): ${w.message}${w.more ? ` (and ${w.more} more of this rule on this screen)` : ''}`).join('; ')}.`
      : 'DesignCheck reported no warnings.',
    ...journeyLines(view.journeys, folder),
    ...(view.changes.length > 0 ? [`Changed since v${record.version - 1}: ${describeChanges(view.changes).join('; ')}.`] : []),
    pausedFrom === undefined
      ? `Plan against design v${record.version} before implementing it, and cite that version in the plan.`
      : `The user approved the plan against ${approvedAgainst(pausedFrom)}. Damocles is asking the user whether to update the plan to design v${record.version} or to finish the approved plan first; do not act on design v${record.version} until that choice arrives.`,
  ];
  return { customType: DAMOCLES_DESIGN_RESULT, content: lines.join('\n'), display: true, details: view };
}

// Each journey's Playwright spec, which verification replays against the real app (PD-45), and what it leaves untested.
function journeyLines(journeys: readonly DesignJourneyRecord[], folder: string): string[] {
  if (journeys.length === 0) return [];
  const lines = journeys.map((journey) => ('waiver' in journey
    ? `- ${journey.screen}: no journey; DesignCheck found no interactive control on it.`
    : `- ${journey.screen}: ${journey.spec} (from ${journey.file}), passed at ${journey.widths.join(' and ')} px; untested: ${journey.untested.length > 0 ? journey.untested.join('; ') : 'nothing reported'}.`));
  return [`Journeys, in ${folder}. Each spec is a Playwright test that finds controls by role and accessible name; your verification replays each one against the real app, so give the real controls those names. The untested parts need tests of their own:`, ...lines];
}

const approvedAgainst = (version: number): string => (version > 0 ? `design v${version}` : 'no design version');

/** The model's instruction for the user's answer to the version pause (PD-29): hidden, English, never a user turn or a steer. */
export function designVersionInstruction(
  pause: DesignVersionPause,
  choice: DesignVersionChoice,
  folder: string,
): DesignCustomMessage<{ designId: string; fromVersion: number; toVersion: number; choice: DesignVersionChoice }> {
  const lines = choice === 'replan'
    ? [
      `The user chose to update the plan: it was approved against ${approvedAgainst(pause.fromVersion)}, and the linked design is now v${pause.toVersion}. Plan mode is on.`,
      `Read the design again in ${folder} (design.md, decisions.md and manifest.json), update the plan file against design v${pause.toVersion}, cite that version in the plan, and call ExitPlanMode for the user's approval.`,
    ]
    : [
      `The user chose to finish the approved plan first: it was approved against ${approvedAgainst(pause.fromVersion)}, and the linked design is now v${pause.toVersion}.`,
      `Continue implementing the plan as approved. Do not implement design v${pause.toVersion} until the user asks for it.`,
    ];
  return {
    customType: DAMOCLES_DESIGN_VERSION_INSTRUCTION,
    content: lines.join('\n'),
    display: false,
    details: { designId: pause.designId, fromVersion: pause.fromVersion, toVersion: pause.toVersion, choice },
  };
}

/** The design chat's `damocles-design-brief` message: a request from the main chat, which the user's own messages outrank (PD-47). */
export function designBriefMessage(record: DesignBriefRecord): DesignCustomMessage<DesignBriefView> {
  const context = record.context;
  const lines = [
    'Brief from the main chat. It is a request, not a message from the user: the user\'s own messages in this chat outrank it.',
    ...(record.reopened ? ['The main chat asked again; continue the existing design rather than starting over.'] : []),
    ...(context?.kind === 'takeover' ? ['This design folder already holds files from an earlier design chat: read design.md, decisions.md and manifest.json first.'] : []),
    ...(context?.kind === 'fork' ? [`The main chat was forked from a chat whose design is in ${context.folder}. Read it for reference; this is a new design, and you write only your own folder.`] : []),
    `Brief id: ${record.briefId}. Cite it as RecordDecision source {kind: "brief", ref: "${record.briefId}"}.`,
    '',
    record.text,
  ];
  return { customType: DAMOCLES_DESIGN_BRIEF, content: lines.join('\n'), display: true, details: { briefId: record.briefId, text: record.text, reopened: record.reopened } };
}
