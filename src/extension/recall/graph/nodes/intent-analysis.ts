import { log } from '../../../logger';
import { loadSdkQuery } from '../../../shared/sdk-loader';
import type { SdkQuery } from '../../../shared/sdk-loader';
import { DEFAULT_SUBCALL_MODEL, DIRECT_CONTEXT_THRESHOLD } from '../../types';
import { isContinuationPrompt } from '../../recall-loop';
import type { RecallGraphState, SessionTrace } from '../recall-graph-state';
import type { NodeExecutionContext } from '../types';

const INTENT_TIMEOUT_MS = 10_000;

interface IntentClassification {
  intent: 'debug' | 'refactor' | 'feature' | 'test' | 'explain' | 'recall' | 'continuation' | 'general';
  secondaryIntent: 'debug' | 'refactor' | 'feature' | 'test' | 'explain' | 'recall' | null;
  keyEntities: string[];
}

const INTENT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['debug', 'refactor', 'feature', 'test', 'explain', 'recall', 'continuation', 'general'],
    },
    secondaryIntent: {
      type: ['string', 'null'],
      enum: ['debug', 'refactor', 'feature', 'test', 'explain', 'recall', null],
    },
    keyEntities: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 15,
    },
  },
  required: ['intent', 'secondaryIntent', 'keyEntities'],
  additionalProperties: false,
};

const DEFAULTS: Partial<RecallGraphState> = { intent: 'general', secondaryIntent: null, keyEntities: [] };

export async function intentAnalysisNode(
  state: Readonly<RecallGraphState>,
  context: NodeExecutionContext,
): Promise<Partial<RecallGraphState>> {
  const skipReason = getSkipReason(state);
  if (skipReason) {
    log('[IntentAnalysis] Skipped — %s', skipReason);
    if (skipReason === 'continuation') {
      return { intent: 'continuation', secondaryIntent: null, keyEntities: [] };
    }
    return DEFAULTS;
  }

  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) {
    log('[IntentAnalysis] SDK unavailable, using defaults');
    return DEFAULTS;
  }

  const abortController = new AbortController();
  const onParentAbort = () => abortController.abort();
  context.abortSignal?.addEventListener('abort', onParentAbort);
  if (context.abortSignal?.aborted) abortController.abort();

  const timeoutHandle = setTimeout(() => abortController.abort(), INTENT_TIMEOUT_MS);

  try {
    const systemPrompt = buildIntentSystemPrompt();
    const userContent = buildIntentUserPrompt(state.userPrompt, state.sessionTrace);

    const generator = sdkQuery({
      prompt: userContent,
      options: {
        model: DEFAULT_SUBCALL_MODEL,
        systemPrompt,
        cwd: process.cwd(),
        persistSession: false,
        tools: [] as string[],
        abortController,
        thinking: { type: 'disabled' },
        outputFormat: { type: 'json_schema' as const, schema: INTENT_OUTPUT_SCHEMA },
      },
    } as Parameters<SdkQuery>[0]);

    let structuredOutput: IntentClassification | null = null;

    for await (const event of generator) {
      if (abortController.signal.aborted) break;

      const msg = event as {
        type: string;
        subtype?: string;
        structured_output?: IntentClassification;
      };

      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_structured_output_retries') {
          log('[IntentAnalysis] Structured output retries exhausted, using defaults');
          return DEFAULTS;
        }
        if (msg.structured_output) {
          structuredOutput = msg.structured_output;
        }
      }
    }

    if (!structuredOutput) return DEFAULTS;

    return {
      intent: structuredOutput.intent,
      secondaryIntent: structuredOutput.secondaryIntent === structuredOutput.intent
        ? null
        : structuredOutput.secondaryIntent ?? null,
      keyEntities: structuredOutput.keyEntities,
    };
  } catch (err) {
    if (!abortController.signal.aborted) {
      log('[IntentAnalysis] Error: %O', err);
    }
    return DEFAULTS;
  } finally {
    clearTimeout(timeoutHandle);
    context.abortSignal?.removeEventListener('abort', onParentAbort);
  }
}

function getSkipReason(state: Readonly<RecallGraphState>): string | null {
  if (state.history.length === 0) return 'empty history';

  const totalChars = state.history.reduce(
    (sum, t) => sum + t.userMessage.length + t.assistantResponse.length, 0,
  );
  if (totalChars <= DIRECT_CONTEXT_THRESHOLD) return 'under direct context threshold';

  if (isContinuationPrompt(state.userPrompt)) return 'continuation';

  return null;
}

function buildIntentSystemPrompt(): string {
  return `You are an intent classifier for a coding assistant's context retrieval system.
Given a user prompt and optional session history, classify the intent, optionally identify a secondary intent, and extract search terms.

Intent definitions:
- debug: Fixing bugs, errors, crashes, or unexpected behavior — "fix this error", "why is this crashing?", "this returns the wrong value", "the test is failing", investigating stack traces or unexpected output
- feature: Adding new functionality or implementing requirements — "add a button", "implement the login flow", "create a new endpoint", "build the dashboard"
- refactor: Restructuring, renaming, or reorganizing existing code — "clean this up", "extract this into a function", "rename X to Y", "simplify this logic", "split this file"
- test: Writing new tests, adding test coverage, or setting up test infrastructure — "write tests for X", "add unit tests", "set up the test harness", "increase coverage for Y". NOT fixing broken tests (that is debug)
- explain: Understanding code, architecture, or how something works — "how does X work?", "explain this function", "walk me through the flow", "what pattern is this using?"
- recall: Referencing something said earlier — "what did you say about X", "you mentioned Y", "go back to Z", "earlier you said", "the thing about"
- continuation: Follow-up with no new topic or search terms — "sounds good", "now apply that", "do the same for the other one", "show me the changes". ONLY when no identifiable topic, file name, error message, or technical term to search for
- general: Greetings, meta-questions, or intent genuinely unclear from the prompt

If the user's prompt clearly involves TWO distinct activities (e.g., "fix the failing test and write more tests"), set secondaryIntent to the secondary activity. Otherwise set it to null. secondaryIntent must differ from intent. Most prompts have no secondary intent.

For keyEntities, extract ALL significant search terms from the prompt — not just code identifiers. Include:
- File names, function names, class names, module names
- Conceptual terms, topics, and keywords the user references (e.g. "bridge", "sun", "authentication flow")
- Error messages or error keywords
- Names of things discussed earlier that the user is referencing back to`;
}

function buildIntentUserPrompt(userPrompt: string, sessionTrace: SessionTrace): string {
  let traceSection: string;
  const recentEntries = sessionTrace.entries.slice(-5);
  if (recentEntries.length > 0) {
    const lines = recentEntries.map(e =>
      `Turn ${e.promptIndex}: [${e.intent}${e.secondaryIntent ? `+${e.secondaryIntent}` : ''}] entities=[${e.keyEntities.join(', ')}] succeeded=${e.recallSucceeded}`
    );
    traceSection = lines.join('\n');
  } else {
    traceSection = 'No prior turns';
  }

  return `<session_trace>
${traceSection}
</session_trace>

Classify this prompt:
${userPrompt}`;
}
