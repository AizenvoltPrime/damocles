// Decisions (PD-15, PD-6): records in the details of the tool result that made them, numbered from the branch root.
import type { DesignDecisionSourceKind } from '../../shared/types/design';
import { decisionsOnBranch, deliveredBriefs, MAX_DECISION_FIELD_CHARS, userMessageQuoted, type DesignDecisionRecord } from './design-entries';
import { markupSourceRefusal } from './markup';
import { referenceSourceRefusal } from './references';
import { tweakSourceRefusal } from './tweaks';

export const MAX_DECISION_FILES = 64;

interface QuestionLike {
  readonly question: string;
  readonly header?: string;
  readonly multiSelect?: boolean;
  readonly options: readonly { readonly label: string }[];
}

/**
 * The option labels an answer chose. The answer is the selected labels joined with ", ", then any text the user typed, so a
 * label may hold a comma: the whole answer is matched against each label first, then labels are read off its start in turn.
 */
function chosenLabels(answer: string, labels: readonly string[], multiSelect: boolean): Set<string> {
  const text = answer.trim();
  const whole = labels.find((label) => label.trim() === text);
  if (whole !== undefined) return new Set([whole]);
  const longestFirst = [...labels].filter((label) => label !== '').sort((a, b) => b.length - a.length);
  const chosen = new Set<string>();
  let at = 0;
  while (at < text.length) {
    const label = longestFirst.find((candidate) => text.startsWith(candidate, at) && (at + candidate.length === text.length || text.startsWith(', ', at + candidate.length)));
    if (label === undefined) break;
    chosen.add(label);
    if (!multiSelect) break;
    at += label.length + 2;
  }
  return chosen;
}

function clip(text: string): string {
  return text.length > MAX_DECISION_FIELD_CHARS ? text.slice(0, MAX_DECISION_FIELD_CHARS) : text;
}

/** The id the next decision on top of `earlier` gets, and the latest one with the same title, which it supersedes. */
function numbered(earlier: readonly DesignDecisionRecord[], title: string): { id: string; supersedes?: string } {
  const key = title.trim().toLowerCase();
  const previous = [...earlier].reverse().find((decision) => decision.title.trim().toLowerCase() === key);
  return { id: `D${earlier.length + 1}`, ...(previous ? { supersedes: previous.id } : {}) };
}

/**
 * One decision per answered question of an AskUserQuestion result in a design chat: the header is the title, the answer
 * the chosen value and the other options the rejected ones. Unanswered questions record nothing.
 */
export function questionDecisions(
  branch: readonly unknown[],
  questions: readonly QuestionLike[],
  answers: Readonly<Record<string, string>>,
  pending: readonly DesignDecisionRecord[] = [],
): DesignDecisionRecord[] {
  const decisions = [...decisionsOnBranch(branch), ...pending];
  const made: DesignDecisionRecord[] = [];
  for (const question of questions) {
    const answer = answers[question.question];
    if (typeof answer !== 'string' || answer.trim() === '') continue;
    const title = clip((question.header ?? '').trim() || question.question);
    const labels = question.options.map((option) => option.label);
    const chosen = chosenLabels(answer, labels, question.multiSelect === true);
    const record: DesignDecisionRecord = {
      v: 1,
      ...numbered(decisions, title),
      title,
      chosen: clip(answer.trim()),
      rejected: labels.filter((label) => !chosen.has(label)).map(clip),
      source: { kind: 'question', ref: clip(question.question) },
      files: [],
    };
    decisions.push(record);
    made.push(record);
  }
  return made;
}

export interface RecordDecisionInput {
  readonly title: string;
  readonly chosen: string;
  readonly rejected?: readonly string[];
  readonly source: { readonly kind: DesignDecisionSourceKind; readonly ref: string };
  readonly files?: readonly string[];
}

/** Thrown when RecordDecision refuses; the message tells the model why. */
export class DecisionRefusedError extends Error {}

/**
 * The RecordDecision record, once its source is shown to exist: a `chat` source quotes a user message on the branch, a
 * `brief` source names a brief delivered on it, and a `markup` source names a change pin of design folder `folder`'s
 * feedback/F<n>.json, a `tweak` source names a tweak whose latest kept value is `chosen`, and a `reference` source names a mapping
 * row of references/R<n>.json ('R<n>#<element>'). A question source comes only from AskUserQuestion.
 */
export async function recordDecision(branch: readonly unknown[], input: RecordDecisionInput, pending: readonly DesignDecisionRecord[], folder: string): Promise<DesignDecisionRecord> {
  const fields = [input.title, input.chosen, input.source.ref, ...(input.rejected ?? []), ...(input.files ?? [])];
  if (fields.some((field) => field.length > MAX_DECISION_FIELD_CHARS)) throw new DecisionRefusedError(`Each decision field holds at most ${MAX_DECISION_FIELD_CHARS} characters.`);
  if ((input.files ?? []).length > MAX_DECISION_FILES) throw new DecisionRefusedError(`A decision names at most ${MAX_DECISION_FILES} files.`);
  if (input.title.trim() === '' || input.chosen.trim() === '') throw new DecisionRefusedError('A decision needs a title and what was chosen.');
  switch (input.source.kind) {
    case 'chat':
      if (!userMessageQuoted(branch, input.source.ref)) {
        throw new DecisionRefusedError('No user message in this chat contains the quoted source. Quote the user\'s own words exactly, or ask with AskUserQuestion.');
      }
      break;
    case 'brief':
      if (!deliveredBriefs(branch).has(input.source.ref)) throw new DecisionRefusedError(`No brief with id ${input.source.ref} reached this chat.`);
      break;
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
    default:
      throw new DecisionRefusedError(`A ${input.source.kind} source is recorded only by AskUserQuestion; use chat (a quote of the user), brief (a brief id), markup (F<n>#pin<k> of a change pin), tweak (the id of a kept tweak) or reference (R<n>#<element> of a mapping row).`);
  }
  const title = input.title.trim();
  return {
    v: 1,
    ...numbered([...decisionsOnBranch(branch), ...pending], title),
    title,
    chosen: input.chosen.trim(),
    rejected: [...(input.rejected ?? [])],
    source: { kind: input.source.kind, ref: input.source.ref },
    files: [...(input.files ?? [])],
  };
}
