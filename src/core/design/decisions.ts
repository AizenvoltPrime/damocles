// Decisions (PD-15, D99): entries core appends to the design chat's branch inside the design folder's write lane, numbered
// there, each checked for conflicts with the current decisions when it is written.
import type { DecisionCheckUnavailable, DesignDecisionConflict, DesignDecisionSourceKind, UncheckedDecisionGroup } from '../../shared/types/design';
import type { QuestionAnnotations } from '../../shared/types/permissions';
import { DAMOCLES_DESIGN_DECISION, DAMOCLES_DESIGN_DECISION_CHECK, DAMOCLES_DESIGN_SUBAGENT_ANSWER } from '../pi-session/session-store/constants';
import { checkDecisionConflicts, type ConflictCheckOutcome, type DecisionConflictJudge } from './decision-conflicts';
import {
  answerParts,
  currentDecisions,
  decisionCheckEntryData,
  decisionEntryData,
  decisionsOnBranch,
  deliveredBriefs,
  MAX_DECISION_FIELD_CHARS,
  MAX_DECISION_REFS,
  nextDecisionId,
  subagentAnswerEntryData,
  userAuthoredQuoted,
  type DesignDecisionRecord,
} from './design-entries';
import { rewriteDecisions } from './design-files';
import { withDesignWrite } from './design-writes';
import { log } from '../logger';
import { markupSourceRefusal } from './markup';
import { referenceSourceRefusal } from './references';
import { tweakSourceRefusal } from './tweaks';

export const MAX_DECISION_FILES = 64;

/** Where a design chat's decisions are recorded: its branch and its design folder. */
export interface DecisionLedger {
  readonly folder: string;
  readonly designId: string;
  /** The design chat's branch, root first, read now. */
  branch(): readonly unknown[];
  /**
   * Reads link.json and throws DecisionRefusedError unless the chat is still the design chat it names and is not handing the
   * design over. Every writer calls it inside the folder's write lane, right before it appends.
   */
  ensureCurrent(): Promise<void>;
  /** Appends a custom entry to that branch; throws once the chat it was made for is no longer bound. */
  append(customType: string, data: Record<string, unknown>): void;
  /** The decisions changed: the preview hears `design.changed` with no paths, and the chat's design state follows. */
  changed(): void;
  /** decisions.md could not be rewritten after a decision was recorded; the next rebuild writes it. */
  writeFailed(err: unknown): void;
}

/** A decision before it is numbered. */
export type DecisionDraft = Omit<DesignDecisionRecord, 'id'>;

/**
 * Checks a draft before it is appended and returns the draft to record, or throws DecisionRefusedError. `all` is the branch's
 * decisions now and `added` those to check against: every one at the first call, then the ones that landed since.
 */
export type DecisionAdmission = (all: readonly DesignDecisionRecord[], added: readonly DesignDecisionRecord[]) => Promise<DecisionDraft>;

/** Thrown when a decision is refused; the message tells the model why. */
export class DecisionRefusedError extends Error {}

/** The refusal of a write from a chat whose design moved to another chat, or is moving there. */
export const DESIGN_CONTINUES_ELSEWHERE = 'This design continues in another chat, so nothing was recorded here.';

/** A refusal for conflicts the check found, whose message is the whole text the model reads. */
export class DecisionConflictError extends DecisionRefusedError {}

const listOf = (ids: readonly string[]): string => `[${ids.map((id) => JSON.stringify(id)).join(', ')}]`;

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * Appends one decision in the folder's write lane: it reads the branch, takes the next id, appends the entry, rewrites
 * decisions.md and tells the preview. `admit` runs outside the lane, since its model call must not hold other design writes;
 * when decisions landed meanwhile, the lane is let go and `admit` runs again for them, until none did.
 */
export async function recordDesignDecision(ledger: DecisionLedger, admit: DecisionAdmission): Promise<DesignDecisionRecord> {
  let seen = decisionsOnBranch(ledger.branch());
  let draft = await admit(seen, seen);
  for (;;) {
    const known = new Set(seen.map((decision) => decision.id));
    const landed = await withDesignWrite(ledger.folder, async (): Promise<{ record: DesignDecisionRecord } | { all: DesignDecisionRecord[]; added: DesignDecisionRecord[] }> => {
      const all = decisionsOnBranch(ledger.branch());
      const added = all.filter((decision) => !known.has(decision.id));
      if (added.length > 0) return { all, added };
      await ledger.ensureCurrent();
      const record: DesignDecisionRecord = { ...draft, id: nextDecisionId(all) };
      ledger.append(DAMOCLES_DESIGN_DECISION, decisionEntryData(record));
      await rewriteOrReport(ledger);
      return { record };
    });
    if ('record' in landed) return landed.record;
    seen = landed.all;
    draft = await admit(landed.all, landed.added);
  }
}

async function rewriteOrReport(ledger: DecisionLedger): Promise<void> {
  try {
    await rewriteDecisions(ledger.folder, ledger.designId, decisionsOnBranch(ledger.branch()));
  } catch (err) {
    ledger.writeFailed(err);
  }
  ledger.changed();
}

/** Records FinishDesign's later check of decision `id` in the folder's write lane: checked now, with a question decision's flags. */
export function recordDecisionCheck(ledger: DecisionLedger, id: string, conflicts: readonly DesignDecisionConflict[]): Promise<void> {
  return withDesignWrite(ledger.folder, async () => {
    await ledger.ensureCurrent();
    ledger.append(DAMOCLES_DESIGN_DECISION_CHECK, decisionCheckEntryData(id, conflicts));
    await rewriteOrReport(ledger);
  });
}

/** Records what the user typed answering a subagent's question on the design chat's branch, so RecordDecision can quote it. */
function recordSubagentAnswer(ledger: DecisionLedger, data: Record<string, unknown>): Promise<void> {
  return withDesignWrite(ledger.folder, async () => {
    await ledger.ensureCurrent();
    ledger.append(DAMOCLES_DESIGN_SUBAGENT_ANSWER, data);
  });
}

function clip(text: string): string {
  return text.length > MAX_DECISION_FIELD_CHARS ? text.slice(0, MAX_DECISION_FIELD_CHARS) : text;
}

const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const describe = (decision: Pick<DesignDecisionRecord, 'id' | 'title'>): string => `${decision.id} ${decision.title}`;

// The decisions a draft may conflict with: current, and not named in its replaces or stillHolds.
function checkedAgainst(draft: Pick<DecisionDraft, 'replaces' | 'stillHolds'>, all: readonly DesignDecisionRecord[], among: readonly DesignDecisionRecord[]): DesignDecisionRecord[] {
  const current = new Set(currentDecisions(all).map((decision) => decision.id));
  const named = new Set([...(draft.replaces ?? []), ...(draft.stillHolds ?? [])]);
  return among.filter((decision) => current.has(decision.id) && !named.has(decision.id));
}

/** The decision's check fields after one more run of the check: unchecked once any run could not check. */
function afterCheck(previous: Pick<DecisionDraft, 'conflictCheck' | 'uncheckedReason'>, outcome: ConflictCheckOutcome): Pick<DecisionDraft, 'conflictCheck' | 'uncheckedReason'> {
  if (previous.conflictCheck === 'unchecked') return previous;
  return outcome.kind === 'unchecked' ? { conflictCheck: 'unchecked', uncheckedReason: outcome.reason } : { conflictCheck: 'checked' };
}

/** The flags as the model reads them: each flagged decision, its kind and the reason. */
function flagLines(flags: readonly DesignDecisionConflict[], all: readonly DesignDecisionRecord[]): string {
  const byId = new Map(all.map((decision) => [decision.id, decision]));
  return flags.map((flag) => `${byId.has(flag.id) ? describe(byId.get(flag.id)!) : flag.id} (${flag.kind}: ${flag.reason})`).join('; ');
}

export interface RecordDecisionInput {
  readonly title: string;
  readonly chosen: string;
  readonly rejected?: readonly string[];
  readonly source: { readonly kind: DesignDecisionSourceKind; readonly ref: string };
  readonly files?: readonly string[];
  readonly replaces?: readonly string[];
  readonly stillHolds?: readonly string[];
}

/**
 * The RecordDecision draft, once its fields are in bounds and its source is shown to exist: a `chat` source quotes text the user
 * wrote on the branch, a `brief` source names a brief delivered on it, a `markup` source names a change pin of design folder
 * `folder`'s feedback/F<n>.json, a `tweak` source names a tweak whose latest kept value is `chosen`, a `reference` source names a
 * mapping row of references/R<n>.json ('R<n>#<element>'), and a `question` source names the question decision it refines,
 * which `decisionRuleRefusal` checks.
 */
export async function decisionDraft(branch: readonly unknown[], input: RecordDecisionInput, folder: string): Promise<DecisionDraft> {
  const fields = [input.title, input.chosen, input.source.ref, ...(input.rejected ?? []), ...(input.files ?? [])];
  if (fields.some((field) => field.length > MAX_DECISION_FIELD_CHARS)) throw new DecisionRefusedError(`Each decision field holds at most ${MAX_DECISION_FIELD_CHARS} characters.`);
  if ((input.files ?? []).length > MAX_DECISION_FILES) throw new DecisionRefusedError(`A decision names at most ${MAX_DECISION_FILES} files.`);
  if ((input.replaces ?? []).length > MAX_DECISION_REFS || (input.stillHolds ?? []).length > MAX_DECISION_REFS) throw new DecisionRefusedError(`A decision names at most ${MAX_DECISION_REFS} decisions in replaces or stillHolds.`);
  if (input.title.trim() === '' || input.chosen.trim() === '') throw new DecisionRefusedError('A decision needs a title and what was chosen.');
  switch (input.source.kind) {
    case 'chat':
      if (!userAuthoredQuoted(branch, input.source.ref)) {
        throw new DecisionRefusedError('Nothing the user wrote in this chat contains the quoted source (their messages, the text they typed or noted in an answer, a subagent\'s question included, a change note on FinishDesign, or a steer they sent a subagent). Quote the user\'s own words exactly, or ask with AskUserQuestion.');
      }
      break;
    case 'brief': {
      const briefs = deliveredBriefs(branch);
      if (!briefs.has(input.source.ref)) {
        throw new DecisionRefusedError(`No brief with id ${input.source.ref} reached this chat. ${briefs.size > 0 ? `The briefs that did: ${[...briefs].join(', ')}.` : 'No brief reached it.'}`);
      }
      break;
    }
    case 'markup': {
      const refusal = await markupSourceRefusal(folder, input.source.ref);
      if (refusal !== undefined) throw new DecisionRefusedError(refusal);
      break;
    }
    case 'tweak': {
      const refusal = tweakSourceRefusal(branch, input.source.ref, input.chosen);
      if (refusal !== undefined) throw new DecisionRefusedError(refusal);
      break;
    }
    case 'reference': {
      const refusal = await referenceSourceRefusal(folder, input.source.ref);
      if (refusal !== undefined) throw new DecisionRefusedError(refusal);
      break;
    }
    case 'question':
      break;
    default:
      throw new DecisionRefusedError(`A ${String(input.source.kind)} source is not one RecordDecision takes.`);
  }
  return {
    v: 1,
    title: input.title.trim(),
    chosen: input.chosen.trim(),
    rejected: [...(input.rejected ?? [])],
    source: { kind: input.source.kind, ref: input.source.ref },
    files: [...(input.files ?? [])],
    ...(input.replaces && input.replaces.length > 0 ? { replaces: [...new Set(input.replaces)] } : {}),
    ...(input.stillHolds && input.stillHolds.length > 0 ? { stillHolds: [...new Set(input.stillHolds)] } : {}),
  };
}

/**
 * RecordDecision's checks against the branch's decisions `all`, in order: every id named is current; a current decision of the
 * same title (case-blind) is named in `replaces` or `stillHolds`; a question source names, as `D<n>`, a current question
 * decision that `replaces` names too.
 */
export function decisionRuleRefusal(draft: DecisionDraft, all: readonly DesignDecisionRecord[]): string | undefined {
  const current = currentDecisions(all);
  const currentIds = new Set(current.map((decision) => decision.id));
  const replaces = draft.replaces ?? [];
  const stillHolds = draft.stillHolds ?? [];
  const listCurrent = (): string => (current.length > 0 ? `The current decisions: ${current.map(describe).join(', ')}.` : 'There are no current decisions.');
  for (const [field, ids] of [['replaces', replaces], ['stillHolds', stillHolds]] as const) {
    const stale = ids.filter((id) => !currentIds.has(id));
    if (stale.length > 0) return `${field} names ${stale.join(', ')}, which ${stale.length === 1 ? 'is' : 'are'} not a current decision. ${listCurrent()}`;
  }
  const both = replaces.filter((id) => stillHolds.includes(id));
  if (both.length > 0) return `${both.join(', ')} cannot be in both replaces and stillHolds.`;
  const named = new Set([...replaces, ...stillHolds]);
  const titled = current.filter((decision) => sameTitle(decision.title, draft.title) && !named.has(decision.id));
  if (titled.length > 0) {
    const ids = titled.map((decision) => decision.id);
    return `${titled.map(describe).join(', ')} already ${titled.length === 1 ? 'has' : 'have'} this title. Call RecordDecision again with replaces: ${listOf(ids)} if this decision replaces ${titled.length === 1 ? 'it' : 'them'} (restate anything that still holds), or stillHolds: ${listOf(ids)} if both stand.`;
  }
  if (draft.source.kind === 'question') {
    const refined = current.find((decision) => decision.id === draft.source.ref);
    if (!refined || refined.source.kind !== 'question' || !replaces.includes(refined.id)) {
      return 'AskUserQuestion records each answer itself. A question source refines a current question decision: give its id as ref, such as {kind: "question", ref: "D24"}, and name that id in replaces too.';
    }
  }
  return undefined;
}

/** What RecordDecision recorded, and the current decisions to review by hand when the check could not run. */
export interface RecordedDecision {
  readonly record: DesignDecisionRecord;
  readonly review: readonly DesignDecisionRecord[];
}

/**
 * RecordDecision: its checks, then the conflict check, then the append (D99). A flag the input does not name in `replaces` or
 * `stillHolds` refuses the call, recording nothing; a check that cannot run records the decision unchecked.
 */
export async function recordChosenDecision(ledger: DecisionLedger, judge: DecisionConflictJudge, input: RecordDecisionInput, signal: AbortSignal): Promise<RecordedDecision> {
  const base = await decisionDraft(ledger.branch(), input, ledger.folder);
  let checks: Pick<DecisionDraft, 'conflictCheck' | 'uncheckedReason'> = {};
  let review: DesignDecisionRecord[] = [];
  const record = await recordDesignDecision(ledger, async (all, added) => {
    const refusal = decisionRuleRefusal(base, all);
    if (refusal !== undefined) throw new DecisionRefusedError(refusal);
    const against = checkedAgainst(base, all, added);
    const outcome = await checkDecisionConflicts(judge, base, against, signal);
    signal.throwIfAborted();
    if (outcome.kind === 'checked' && outcome.flags.length > 0) {
      const ids = outcome.flags.map((flag) => flag.id);
      throw new DecisionConflictError(`Not recorded: ${base.title} conflicts with current decisions. ${flagLines(outcome.flags, all)}. Call RecordDecision again with replaces: ${listOf(ids)} if this decision replaces ${ids.length === 1 ? 'it' : 'them'} (restate anything that still holds), or stillHolds: ${listOf(ids)} if both stand.`);
    }
    checks = afterCheck(checks, outcome);
    if (outcome.kind === 'unchecked') review = checkedAgainst(base, all, currentDecisions(all));
    return { ...base, ...checks };
  });
  return { record, review: record.conflictCheck === 'unchecked' ? review : [] };
}

/** The fix for a question decision's flags: a refining RecordDecision, or for a subagent's question, a report to the designer. */
function questionFix(record: Pick<DesignDecisionRecord, 'id' | 'agentId'>, flags: readonly DesignDecisionConflict[]): string {
  if (record.agentId !== undefined) return SUBAGENT_REPORTS;
  const ids = flags.map((flag) => flag.id);
  return `Record what the user decided with RecordDecision, source {kind: "question", ref: "${record.id}"}, replaces: ${listOf([record.id, ...ids])} (restate anything that still holds), or replaces: ${listOf([record.id])} and stillHolds: ${listOf(ids)} where both stand.`;
}

// A subagent has no RecordDecision: what the user chose goes back to the designer in its result.
const SUBAGENT_REPORTS = 'Report the user\'s choice in your result; the designer records it.';

const UNCHECKED_TEXT: Readonly<Record<DecisionCheckUnavailable, string>> = {
  noModel: 'no background model',
  unreachable: 'the background model could not be reached',
  rejected: 'the background model refused the request',
  unanswered: 'the background model gave no valid answer',
  stopped: 'the check was stopped',
};

const STOPPED: ConflictCheckOutcome = { kind: 'unchecked', reason: 'stopped' };

// Two questions are the same when their text is, whitespace collapsed and case-blind.
const questionKey = (text: string): string => clip(text).replace(/\s+/g, ' ').trim().toLowerCase();

export interface QuestionLike {
  readonly question: string;
  readonly header?: string;
  readonly multiSelect?: boolean;
  readonly options: readonly { readonly label: string }[];
  /** The reference row the question asks about, 'R<n>#<element>', which the question manager checked. */
  readonly reference?: string;
}

/** The decisions an AskUserQuestion answer recorded, and what the model reads about them. */
export interface QuestionDecisionResult {
  readonly records: DesignDecisionRecord[];
  /** English, for the model: answers that recorded nothing, stored flags and their fix, decisions left unchecked. */
  readonly notes: readonly string[];
  /** The questions whose typed words or notes a subagent's answer left on the design chat's branch. */
  readonly wordsRecorded?: readonly string[];
}

/** The design chat's subagent that asked, and the notes the user added to its answers. */
export interface QuestionSubagent {
  readonly agentId: string;
  readonly annotations?: QuestionAnnotations;
}

/**
 * One decision per answered question that chose an option: the header is the title, the answer the chosen value, the other
 * options the rejected ones and the question's reference row its `reference`. A current decision answering the same question is
 * replaced; every other current decision, one of the same title included, is checked as RecordDecision's are, and the flags are stored rather than refused, since the user
 * already answered (D99). A subagent's answer also leaves what the user typed and noted on the design chat's branch, the only
 * place its designer can quote it from. A question that fails to record becomes a note, and the others still record.
 */
export async function recordQuestionDecisions(
  ledger: DecisionLedger,
  judge: DecisionConflictJudge,
  questions: readonly QuestionLike[],
  answers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  subagent?: QuestionSubagent,
): Promise<QuestionDecisionResult> {
  const records: DesignDecisionRecord[] = [];
  const notes: string[] = [];
  const wordsRecorded: string[] = [];
  for (const question of questions) {
    const answer = answers[question.question];
    if (typeof answer !== 'string' || answer.trim() === '') continue;
    const title = clip((question.header ?? '').trim() || question.question);
    try {
      const labels = question.options.map((option) => option.label);
      const { chosen, typed } = answerParts(answer, labels, question.multiSelect === true);
      const noted = subagent?.annotations?.[question.question]?.notes?.trim() ?? '';
      if (subagent && (typed !== '' || noted !== '')) {
        await recordSubagentAnswer(ledger, subagentAnswerEntryData({ agentId: subagent.agentId, question: clip(question.question), typed: clip(typed), ...(noted !== '' ? { notes: clip(noted) } : {}) }));
        wordsRecorded.push(question.question);
      }
      if (chosen.size === 0) {
        notes.push(`No decision was recorded for "${title}": the answer chose no option. ${subagent ? SUBAGENT_REPORTS : 'If the user decided something in it, record it with RecordDecision, quoting their words (source kind "chat").'}`);
        continue;
      }
      const record = await recordAnswer(ledger, judge, {
        v: 1,
        title,
        chosen: clip(answer.trim()),
        rejected: labels.filter((label) => !chosen.has(label)).map(clip),
        source: { kind: 'question', ref: clip(question.question) },
        ...(question.reference !== undefined ? { reference: question.reference } : {}),
        files: [],
        ...(subagent ? { agentId: subagent.agentId } : {}),
      }, signal);
      records.push(record);
      const all = decisionsOnBranch(ledger.branch());
      if (record.conflicts?.length) notes.push(`${describe(record)} conflicts with current decisions: ${flagLines(record.conflicts, all)}. DesignCheck reports it as an error, and FinishDesign refuses, until it is resolved. ${questionFix(record, record.conflicts)}`);
      if (record.conflictCheck === 'unchecked') {
        notes.push(`The conflict check could not run for ${record.id} (${UNCHECKED_TEXT[record.uncheckedReason ?? 'unreachable']}); compare it with the other current decisions yourself. FinishDesign checks it again.`);
      }
    } catch (err) {
      log('[decisions] recording the answer to %s failed: %O', JSON.stringify(title), err);
      notes.push(`The answer to "${title}" was not recorded. ${sentence(err instanceof Error ? err.message : String(err))} ${subagent ? SUBAGENT_REPORTS : 'Record what the user chose with RecordDecision.'}`);
    }
  }
  return { records, notes, ...(subagent ? { wordsRecorded } : {}) };
}

// One answered question's decision: it replaces the current decision answering the same question, and its flags are stored.
async function recordAnswer(ledger: DecisionLedger, judge: DecisionConflictJudge, base: DecisionDraft, signal: AbortSignal): Promise<DesignDecisionRecord> {
  const asked = questionKey(base.source.ref);
  let checks: Pick<DecisionDraft, 'conflictCheck' | 'uncheckedReason'> = {};
  const flags = new Map<string, DesignDecisionConflict>();
  return recordDesignDecision(ledger, async (all, added) => {
    const replaces = currentDecisions(all)
      .filter((decision) => decision.source.kind === 'question' && questionKey(decision.source.ref) === asked)
      .map((decision) => decision.id)
      .slice(0, MAX_DECISION_REFS);
    const draft: DecisionDraft = { ...base, ...(replaces.length > 0 ? { replaces } : {}) };
    // a stopped run leaves the answer unchecked: the user answered, so it is recorded
    const checked = signal.aborted ? STOPPED : await checkDecisionConflicts(judge, draft, checkedAgainst(draft, all, added), signal);
    const outcome = checked.kind === 'unchecked' && signal.aborted ? STOPPED : checked;
    if (outcome.kind === 'checked') for (const flag of outcome.flags) if (flags.size < MAX_DECISION_REFS) flags.set(flag.id, flag);
    checks = afterCheck(checks, outcome);
    return { ...draft, ...checks, ...(flags.size > 0 ? { conflicts: [...flags.values()] } : {}) };
  });
}

/** FinishDesign's check of the current decisions recorded unchecked: why it refuses, and the decisions it still could not check. */
export interface DecisionRecheck {
  readonly refusal?: string;
  readonly unchecked: readonly { readonly id: string; readonly reason: DecisionCheckUnavailable }[];
}

/** The decisions FinishDesign still could not check, grouped by why, each cause in the order it first appears. */
export function uncheckedByCause(unchecked: DecisionRecheck['unchecked']): UncheckedDecisionGroup[] {
  const groups = new Map<DecisionCheckUnavailable, string[]>();
  for (const { id, reason } of unchecked) groups.set(reason, [...(groups.get(reason) ?? []), id]);
  return [...groups].map(([cause, ids]) => ({ ids, cause }));
}

/**
 * Checks every current decision recorded unchecked against the other current decisions (FinishDesign, D99). A clean one gets a
 * check entry; a flagged question decision stores its flags in one; a flagged RecordDecision decision refuses FinishDesign.
 */
export async function recheckUncheckedDecisions(ledger: DecisionLedger, judge: DecisionConflictJudge, signal: AbortSignal): Promise<DecisionRecheck> {
  const all = decisionsOnBranch(ledger.branch());
  const current = currentDecisions(all);
  const refusals: string[] = [];
  const unchecked: { id: string; reason: DecisionCheckUnavailable }[] = [];
  for (const decision of current.filter((candidate) => candidate.conflictCheck === 'unchecked')) {
    const others = current.filter((other) => other.id !== decision.id && !(decision.stillHolds ?? []).includes(other.id) && !(other.stillHolds ?? []).includes(decision.id));
    const outcome = await checkDecisionConflicts(judge, decision, others, signal);
    signal.throwIfAborted();
    if (outcome.kind === 'unchecked') {
      unchecked.push({ id: decision.id, reason: outcome.reason });
      continue;
    }
    if (outcome.flags.length === 0 || decision.source.kind === 'question') await recordDecisionCheck(ledger, decision.id, outcome.flags);
    if (outcome.flags.length === 0) continue;
    const ids = outcome.flags.map((flag) => flag.id);
    refusals.push(decision.source.kind === 'question'
      ? `- ${describe(decision)} conflicts with ${flagLines(outcome.flags, all)}. ${questionFix(decision, outcome.flags)}`
      : `- ${describe(decision)} conflicts with ${flagLines(outcome.flags, all)}. Record it again with RecordDecision, replaces: ${listOf([decision.id, ...ids])} if it replaces ${ids.length === 1 ? 'that decision' : 'those decisions'} (restate anything that still holds), or replaces: ${listOf([decision.id])} and stillHolds: ${listOf(ids)} if both stand.`);
  }
  return {
    ...(refusals.length > 0 ? { refusal: `FinishDesign refused: the conflict check found current decisions that conflict.\n${refusals.join('\n')}` } : {}),
    unchecked,
  };
}

/** Why the check could not run, as the model reads it. */
export function uncheckedText(reason: DecisionCheckUnavailable): string {
  return UNCHECKED_TEXT[reason];
}
