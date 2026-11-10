import { Type, type Static } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import { invalidQuestionInput, questionPreviewRefusal, validateQuestions } from '../../permission-handler/managers/question-manager';
import { ASK_USER_QUESTION_LIMITS, type QuestionAnnotations } from '../../../shared/types/permissions';
import { buildCanUseToolContext, formatDenyReason, formatPolicyBlockReason } from '../permission-gate';
import { TOOL_ASK_USER_QUESTION } from '../../../shared/tool-names';
import { MAX_QUESTION_PREVIEW_CHARS, QUESTION_PREVIEW_FORM } from '../../../shared/question-preview';
import { DESIGN_DECISIONS_DETAIL_KEY } from '../../../shared/types/design';
import { MAX_DECISION_FIELD_CHARS, type DesignDecisionRecord } from '../../design/design-entries';
import type { QuestionDecisionResult, QuestionLike } from '../../design/decisions';
import { MAX_REFERENCE_ROW_REF_CHARS } from '../../design/references';
import type { UserAnswerNote } from '../../../shared/steer';
import { ASK_AS_OFTEN_AS_NEEDED } from '../ask-user-question-rules';

const { MIN_QUESTIONS, MAX_QUESTIONS, MIN_OPTIONS, MAX_OPTIONS } = ASK_USER_QUESTION_LIMITS;
const DESIGN_PREVIEW_FORM = '{ "kind": "design", "path": "variants/<option>/<screen>.html" }';

/** Records the decisions an answered question set makes in a design chat (PD-6, PD-15, D99); a subagent's questions record on its design chat's branch. */
export interface QuestionDecisions {
  /** `annotations`: the user's notes and chosen previews, by question; a subagent's notes are kept on the design chat's branch. */
  record(questions: readonly QuestionLike[], answers: Readonly<Record<string, string>>, signal: AbortSignal, annotations?: QuestionAnnotations): Promise<QuestionDecisionResult>;
}

/** A subagent's questions: the card names the agent that asks, and in a design chat its parent learns each answer with its result. */
export interface QuestionAsker {
  readonly agentId: string;
  /** The `Agent` call that started the subagent; the question card names the agent through it, as a permission prompt does. */
  readonly parentToolUseId: string;
  answered?(notes: readonly UserAnswerNote[]): void;
}

/**
 * Each answered question with its note and the decision it recorded, matched by the question text the decision's source holds,
 * and whether the user's typed words and note are on the design chat's record.
 */
function answerNotes(questions: readonly QuestionLike[], answers: Readonly<Record<string, string>>, annotations: QuestionAnnotations | undefined, recorded: QuestionDecisionResult): UserAnswerNote[] {
  return questions.flatMap((question) => {
    const answer = answers[question.question];
    if (typeof answer !== 'string' || answer.trim() === '') return [];
    const ref = question.question.slice(0, MAX_DECISION_FIELD_CHARS);
    const decision = recorded.records.find((record) => record.source.kind === 'question' && record.source.ref === ref);
    const notes = annotations?.[question.question]?.notes?.trim();
    return [{
      question: question.question,
      answer,
      ...(notes ? { notes } : {}),
      ...(decision ? { decisionId: decision.id } : {}),
      ...(decision?.conflicts?.length ? { conflicts: decision.conflicts.map((flag) => flag.id) } : {}),
      ...(recorded.wordsRecorded?.includes(question.question) ? { wordsOnRecord: true } : {}),
    }];
  });
}

// question-manager.ts takes the design kind only in a design chat, so only a design chat's description names it.
const previewSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('markdown'),
      content: Type.String({ maxLength: MAX_QUESTION_PREVIEW_CHARS, description: 'Markdown shown beside the options while this option is focused.' }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('design'), path: Type.String({ maxLength: 400 }) }, { additionalProperties: false }),
]);

const optionSchema = Type.Object({
  label: Type.String({ description: 'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.' }),
  description: Type.String({ description: 'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.' }),
  preview: Type.Optional(previewSchema),
});

const questionSchema = Type.Object({
  question: Type.String({ description: 'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"' }),
  header: Type.String({ description: 'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".' }),
  multiSelect: Type.Boolean({ description: 'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.' }),
  options: Type.Array(optionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: `The available choices for this question. Must have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.`,
  }),
  // question-manager.ts takes a reference only in design work, so only a design description names it.
  reference: Type.Optional(Type.String({ maxLength: MAX_REFERENCE_ROW_REF_CHARS })),
});

const askSchema = Type.Object(
  { questions: Type.Array(questionSchema, { minItems: MIN_QUESTIONS, maxItems: MAX_QUESTIONS, description: `Questions to ask the user (${MIN_QUESTIONS}-${MAX_QUESTIONS} questions)` }) },
  { additionalProperties: false },
);

/** Mirror of the SDK `AskUserQuestionOutput` — the tool result the webview `QuestionToolCard` and the
 * model both read (answers keyed by question text; per-question notes/preview under `annotations`). */
interface AskUserQuestionOutput {
  questions: unknown;
  answers: Record<string, string>;
  annotations?: QuestionAnnotations;
  /** In a design chat, what the answers recorded as decisions, for the model. */
  decisions?: readonly string[];
}

/**
 * Build the `AskUserQuestion` tool. Per the tool-interaction ownership split (US-004), it drives
 * `QuestionManager` directly through `canUseTool` (the gate allows it without re-prompting) and
 * returns the full SDK `AskUserQuestionOutput` (`{ questions, answers, annotations? }`) as the tool
 * result, so the answered card renders the user's choices and the model receives their notes.
 */
/**
 * `questionDecisions`: a design chat's tool, or its subagent's, whose answers record decisions. `designPreviews`: a tool whose
 * description names the design kind; fixed for the session (PD-17). `asker`: a subagent's tool.
 */
export function createAskUserQuestionTool(pi: PiCodingAgentModule, permissionHandler: PermissionHandler, questionDecisions?: QuestionDecisions, designPreviews = false, asker?: QuestionAsker): ToolDefinition {
  return pi.defineTool<typeof askSchema, { [DESIGN_DECISIONS_DETAIL_KEY]: DesignDecisionRecord[] } | undefined>({
    name: TOOL_ASK_USER_QUESTION,
    label: 'AskUserQuestion',
    // In design work pi then runs the whole batch in order, so a preview written earlier in the batch exists when it asks.
    ...(questionDecisions || designPreviews ? { executionMode: 'sequential' as const } : {}),
    description: [
      'Use this tool only when you are blocked on a decision that is genuinely the user\'s to make: one you cannot resolve from the request, the code, or sensible defaults.',
      '',
      'Usage notes:',
      `- ${ASK_AS_OFTEN_AS_NEEDED}`,
      '- Users will always be able to select "Other" to provide custom text input',
      '- Use multiSelect: true to allow multiple answers to be selected for a question',
      '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
      '',
      'Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval.',
      '',
      'Reserve this for decisions where the user\'s answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.',
      '',
      'Preview feature:',
      'Use the optional `preview` field on options when presenting concrete artifacts that users need to compare side by side:',
      '- Code snippets showing different implementations (fenced code blocks with a language tag)',
      '- Outlines, file layouts, or short tables contrasting the options',
      '',
      `A preview is an object: ${QUESTION_PREVIEW_FORM}. The content is Markdown (at most ${MAX_QUESTION_PREVIEW_CHARS} characters), shown beside the options while one is focused; HTML in it is shown as literal text, never rendered. Do not use previews for simple preference questions where labels and descriptions suffice. Previews work on single-select and multiSelect questions.`,
      ...(designPreviews ? [`In this design chat a preview may also be ${DESIGN_PREVIEW_FORM}: a screen you wrote in this design (an .html file below screens/ or variants/, relative to the design folder), which the user sees as a thumbnail they can open. Write each option's screen first, then ask; use it to compare layouts side by side. One question uses one preview kind: every preview of a question is design, or every one is markdown.`] : []),
      ...(designPreviews ? ['', 'To ask about an element of a reference image, give its question reference: "R<n>#<element>", naming a row MapReference wrote, such as "R1#Hero card". The decision the answer records names that row, so ask one question per element.'] : []),
    ].join('\n'),
    parameters: askSchema,
    prepareArguments: (args) => {
      const refusal = questionPreviewRefusal((args as { questions?: unknown } | null)?.questions, designPreviews);
      if (refusal) throw new Error(formatPolicyBlockReason(invalidQuestionInput(refusal)));
      return args as Static<typeof askSchema>;
    },
    execute: async (toolCallId, params, signal) => {
      const result = await permissionHandler.canUseTool(
        TOOL_ASK_USER_QUESTION,
        params as Record<string, unknown>,
        buildCanUseToolContext(toolCallId, signal, asker?.parentToolUseId ?? null),
      );
      if (result.behavior === 'deny') {
        // Mirror the SDK: a cancelled question is an error tool result (pi turns the throw into an
        // isError result), so the card renders the "denied" state instead of a green "completed".
        throw new Error(result.policy ? formatPolicyBlockReason(result.message) : formatDenyReason(result.message));
      }
      const updated = result.updatedInput as {
        questions?: unknown;
        answers?: Record<string, string>;
        annotations?: QuestionAnnotations;
      } | undefined;
      const output: AskUserQuestionOutput = {
        questions: updated?.questions ?? params.questions,
        answers: updated?.answers ?? {},
        ...(updated?.annotations ? { annotations: updated.annotations } : {}),
      };
      // decisions come from the questions the user was shown, as the question manager validated them
      const shown = validateQuestions(output.questions, true);
      const questions = shown.ok ? shown.questions : [];
      const recorded = questionDecisions ? await questionDecisions.record(questions, output.answers, signal ?? new AbortController().signal, output.annotations) : { records: [], notes: [] };
      const decisions = recorded.records;
      asker?.answered?.(answerNotes(questions, output.answers, output.annotations, recorded));
      const answered: AskUserQuestionOutput = {
        ...output,
        ...(decisions.length > 0 || recorded.notes.length > 0 ? { decisions: [...decisions.map((decision) => `Recorded ${decision.id} · ${decision.title}: ${decision.chosen}${decision.replaces?.length ? ` (replaces ${decision.replaces.join(', ')})` : ''}.`), ...recorded.notes] } : {}),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(answered) }],
        details: decisions.length > 0 ? { [DESIGN_DECISIONS_DETAIL_KEY]: decisions } : undefined,
      };
    },
  });
}
