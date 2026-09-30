import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import type { QuestionAnnotations } from '../../../shared/types/permissions';
import { buildCanUseToolContext, formatDenyReason } from '../permission-gate';
import { TOOL_ASK_USER_QUESTION } from '../../../shared/tool-names';

const optionSchema = Type.Object({
  label: Type.String({ description: 'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.' }),
  description: Type.String({ description: 'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.' }),
  preview: Type.Optional(Type.String({ description: 'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.' })),
});

const questionSchema = Type.Object({
  question: Type.String({ description: 'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"' }),
  header: Type.String({ description: 'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".' }),
  multiSelect: Type.Boolean({ description: 'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.' }),
  options: Type.Array(optionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
  }),
});

const askSchema = Type.Object(
  { questions: Type.Array(questionSchema, { minItems: 1, maxItems: 4, description: 'Questions to ask the user (1-4 questions)' }) },
  { additionalProperties: false },
);

/** Mirror of the SDK `AskUserQuestionOutput` — the tool result the webview `QuestionToolCard` and the
 * model both read (answers keyed by question text; per-question notes/preview under `annotations`). */
interface AskUserQuestionOutput {
  questions: unknown;
  answers: Record<string, string>;
  annotations?: QuestionAnnotations;
}

/**
 * Build the `AskUserQuestion` tool. Per the tool-interaction ownership split (US-004), it drives
 * `QuestionManager` directly through `canUseTool` (the gate allows it without re-prompting) and
 * returns the full SDK `AskUserQuestionOutput` (`{ questions, answers, annotations? }`) as the tool
 * result, so the answered card renders the user's choices and the model receives their notes.
 */
export function createAskUserQuestionTool(pi: PiCodingAgentModule, permissionHandler: PermissionHandler): ToolDefinition {
  return pi.defineTool<typeof askSchema, undefined>({
    name: TOOL_ASK_USER_QUESTION,
    label: 'AskUserQuestion',
    description: [
      'Use this tool only when you are blocked on a decision that is genuinely the user\'s to make: one you cannot resolve from the request, the code, or sensible defaults.',
      '',
      'Usage notes:',
      '- Users will always be able to select "Other" to provide custom text input',
      '- Use multiSelect: true to allow multiple answers to be selected for a question',
      '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
      '',
      'Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval.',
      '',
      'Reserve this for decisions where the user\'s answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.',
      '',
      'Preview feature:',
      'Use the optional `preview` field on options when presenting concrete artifacts that users need to visually compare:',
      '- HTML mockups of UI layouts or components',
      '- Formatted code snippets showing different implementations',
      '- Visual comparisons or diagrams',
      '',
      'Preview content must be a self-contained HTML fragment (no <html>/<body> wrapper, no <script> or <style> tags — use inline style attributes instead). Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).',
    ].join('\n'),
    parameters: askSchema,
    execute: async (toolCallId, params, signal) => {
      const result = await permissionHandler.canUseTool(
        TOOL_ASK_USER_QUESTION,
        params as Record<string, unknown>,
        buildCanUseToolContext(toolCallId, signal),
      );
      if (result.behavior === 'deny') {
        // Mirror the SDK: a cancelled question is an error tool result (pi turns the throw into an
        // isError result), so the card renders the "denied" state instead of a green "completed".
        throw new Error(formatDenyReason(result.message));
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
      return { content: [{ type: 'text', text: JSON.stringify(output) }], details: undefined };
    },
  });
}
