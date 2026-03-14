import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import { JsRepl, type ExecutionResult } from './js-repl';
import { extractCodeBlocks, stripPostCodeContent, detectFinalInModelResponse, type FinalResult } from './parsing';
import { buildRecallSystemPrompt, buildInitialPrompt, FORCED_ANSWER_PROMPT, buildContinuationPrompt } from './prompts';
import { SubCallHandler } from './sub-call-handler';
import { DIRECT_CONTEXT_THRESHOLD, TOTAL_LOOP_TIMEOUT_MS, ITERATION_TIMEOUT_MS, SPECIFIC_MESSAGE_MIN_LENGTH, RECENT_CONTEXT_MIN_TURNS, RECENT_CONTEXT_MAX_TURNS } from './types';
import type { StructuredTurn, RecallIteration, RecallTrajectory, RecallConfig, SubcallRecord } from './types';

async function resolveInlineFinal(result: FinalResult, repl: JsRepl): Promise<string | null> {
  if (result.type === 'final_var') {
    // Simple variable lookup first (handles FINAL_VAR("result") or FINAL_VAR(result))
    const simple = repl.resolveVariable(result.value);
    if (simple) return simple;

    // Evaluate as expression in REPL (handles property access like lastTurn.assistantResponse)
    // This mirrors the original RLM's environment.execute_code(f"print(FINAL_VAR({variable_name!r}))")
    const evalResult = await repl.execute(`console.log(${result.value})`);
    if (!evalResult.error && evalResult.stdout.trim()) {
      return evalResult.stdout.trim();
    }
    return null;
  }

  // FINAL with direct value
  let value = result.value;

  // If value contains JS template literal expressions, evaluate in the REPL sandbox
  // Models often write FINAL(... ${context[i].assistantResponse}) expecting evaluation
  if (/\$\{[^}]+\}/.test(value)) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    const evalResult = await repl.execute(`console.log(\`${escaped}\`)`);
    if (!evalResult.error && evalResult.stdout.trim()) {
      return evalResult.stdout.trim();
    }
  }

  return value;
}

async function executeBlocksIndividually(
  repl: JsRepl,
  codeBlocks: string[],
): Promise<ExecutionResult> {
  if (codeBlocks.length === 1) return repl.execute(codeBlocks[0]!);

  const allStdout: string[] = [];
  const allSubcalls: SubcallRecord[] = [];
  let finalValue: string | null = null;
  let finalVarName: string | null = null;
  let lastError: string | null = null;

  for (const block of codeBlocks) {
    const result = await repl.execute(block);
    allSubcalls.push(...result.subcalls);
    if (result.stdout) allStdout.push(result.stdout);

    if (result.finalValue) { finalValue = result.finalValue; break; }
    if (result.finalVarName) { finalVarName = result.finalVarName; break; }
    if (result.error) lastError = result.error;
  }

  return {
    stdout: allStdout.join('\n'),
    error: lastError,
    subcalls: allSubcalls,
    finalValue,
    finalVarName,
  };
}

const CONTINUATION_WORDS = new Set([
  'yes', 'ok', 'okay', 'yep', 'yeah', 'yea', 'sure', 'correct', 'right', 'exactly',
  'perfect', 'great', 'good', 'nice', 'fine', 'agreed',
  'no', 'nah', 'nope',
  'go', 'do', 'continue', 'proceed', 'try',
  'it', 'that', 'this', 'them', 'those',
  'the', 'a', 'please', 'thanks',
  'ahead', 'again', 'now', 'then', 'too', 'also', 'same',
  'and', 'or', 'but', 'so', 'just',
]);

export function isContinuationPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return true;
  if (/[\/\\]/.test(trimmed)) return false;
  if (/[a-zA-Z_]\.[a-zA-Z]{2,5}\b/.test(trimmed)) return false;

  const words = trimmed.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length > 10) return false;

  return words.every(w => CONTINUATION_WORDS.has(w));
}

function buildRecentFullContext(history: StructuredTurn[]): string {
  let startIdx = Math.max(0, history.length - RECENT_CONTEXT_MIN_TURNS);

  for (let i = startIdx - 1; i >= Math.max(0, history.length - RECENT_CONTEXT_MAX_TURNS); i--) {
    const turn = history[i]!;
    if (turn.userMessage.trim().length > SPECIFIC_MESSAGE_MIN_LENGTH || turn.filesTouched.length > 0) {
      startIdx = i;
      break;
    }
  }

  return buildDirectContext(history.slice(startIdx));
}

interface RecallLoopOptions {
  config: RecallConfig;
  cwd: string;
  model: string;
  abortSignal?: AbortSignal | undefined;
  intentContext: { intent: string; keyEntities: string[] };
  onIteration?: ((iteration: RecallIteration) => void) | undefined;
}

interface LoopResult {
  context: string | null;
  trajectory: RecallTrajectory;
}

export async function runRecallLoop(
  history: StructuredTurn[],
  userPrompt: string,
  promptIndex: number,
  options: RecallLoopOptions,
): Promise<LoopResult> {
  const startTime = Date.now();
  const totalChars = history.reduce((sum, t) =>
    sum + t.userMessage.length + t.assistantResponse.length
    + t.toolCalls.reduce((s, tc) => s + tc.result.length, 0), 0);

  const trajectory: RecallTrajectory = {
    promptIndex,
    userPrompt,
    iterations: [],
    finalContext: null,
    totalDurationMs: 0,
    shortCircuited: false,
    forcedAnswer: false,
    timedOut: false,
    turnCount: history.length,
    historyChars: totalChars,
  };

  if (history.length === 0) {
    trajectory.shortCircuited = true;
    trajectory.totalDurationMs = Date.now() - startTime;
    return { context: null, trajectory };
  }

  if (totalChars <= DIRECT_CONTEXT_THRESHOLD) {
    trajectory.shortCircuited = true;
    trajectory.finalContext = buildDirectContext(history);
    trajectory.totalDurationMs = Date.now() - startTime;
    log('[RecallLoop] History under %d chars (%d chars, %d turns), returning direct context', DIRECT_CONTEXT_THRESHOLD, totalChars, history.length);
    return { context: trajectory.finalContext, trajectory };
  }

  if (isContinuationPrompt(userPrompt) || options.intentContext.intent === 'continuation') {
    trajectory.shortCircuited = true;
    trajectory.finalContext = buildRecentFullContext(history);
    trajectory.totalDurationMs = Date.now() - startTime;
    log('[RecallLoop] Continuation prompt (heuristic=%s, intent=%s), returning recent context (%d chars)',
      isContinuationPrompt(userPrompt), options.intentContext.intent, trajectory.finalContext.length);
    return { context: trajectory.finalContext, trajectory };
  }

  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) {
    log('[RecallLoop] SDK query unavailable, falling back to recent context');
    const fallback = buildFallbackContext(history);
    trajectory.finalContext = fallback;
    trajectory.totalDurationMs = Date.now() - startTime;
    return { context: fallback, trajectory };
  }

  const subCallHandler = new SubCallHandler(options.cwd, options.config.subcallModel);
  const repl = new JsRepl(
    history,
    (prompt, model) => subCallHandler.query(prompt, model),
    (prompts, model) => subCallHandler.queryBatched(prompts, model),
  );

  const systemPrompt = buildRecallSystemPrompt(userPrompt, history.length, totalChars, options.intentContext);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: buildInitialPrompt(userPrompt) },
  ];

  try {
    for (let i = 0; i < options.config.maxIterations; i++) {
      if (options.abortSignal?.aborted) {
        log('[RecallLoop] Aborted at iteration %d', i);
        break;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > TOTAL_LOOP_TIMEOUT_MS) {
        log('[RecallLoop] Total timeout (%dms) exceeded at iteration %d', TOTAL_LOOP_TIMEOUT_MS, i);
        trajectory.timedOut = true;
        break;
      }

      const iterStart = Date.now();
      const subcalls: SubcallRecord[] = [];

      const remainingMs = TOTAL_LOOP_TIMEOUT_MS - (Date.now() - startTime);
      const iterTimeoutMs = Math.min(remainingMs, ITERATION_TIMEOUT_MS);

      const iterAbort = new AbortController();
      const iterTimer = setTimeout(() => iterAbort.abort(), iterTimeoutMs);
      const onParentAbort = () => iterAbort.abort();
      options.abortSignal?.addEventListener('abort', onParentAbort);
      if (options.abortSignal?.aborted) iterAbort.abort();

      let modelResponse: string | null;
      try {
        modelResponse = await callRootModel(
          sdkQuery,
          systemPrompt,
          messages,
          options.model,
          options.cwd,
          iterAbort.signal,
        );
      } finally {
        clearTimeout(iterTimer);
        options.abortSignal?.removeEventListener('abort', onParentAbort);
      }

      if (!modelResponse) {
        log('[RecallLoop] Iteration %d returned no response (timeout or empty), continuing', i);
        continue;
      }

      // Step 1: Extract code blocks (before any FINAL checking — matches original RLM flow)
      const codeBlocks = extractCodeBlocks(modelResponse);

      if (codeBlocks.length === 0) {
        const iteration: RecallIteration = {
          index: i,
          modelResponse,
          codeBlock: null,
          replOutput: null,
          subcalls,
          durationMs: Date.now() - iterStart,
        };
        trajectory.iterations.push(iteration);
        options.onIteration?.(iteration);

        // No code to execute — check model text for FINAL directly
        const inlineResult = detectFinalInModelResponse(modelResponse);
        if (inlineResult) {
          const resolved = await resolveInlineFinal(inlineResult, repl);
          if (resolved) {
            trajectory.finalContext = resolved;
            trajectory.totalDurationMs = Date.now() - startTime;
            log('[RecallLoop] FINAL detected in model text (no code) at iteration %d', i);
            return { context: resolved, trajectory };
          }
        }

        messages.push({ role: 'assistant', content: modelResponse });
        messages.push({ role: 'user', content: buildContinuationPrompt(userPrompt, repl.getVariableSummary()) });
        continue;
      }

      // Step 2: Execute code blocks individually — each in its own IIFE scope.
      // Prevents `const` redeclaration errors when the model reuses variable names
      // across multiple ```repl blocks (e.g. two blocks both declaring `const relevant`).
      const combinedCode = codeBlocks.join('\n');
      const execResult = await executeBlocksIndividually(repl, codeBlocks);
      subcalls.push(...execResult.subcalls);

      let replOutput = execResult.stdout;
      if (execResult.error) {
        replOutput += `\n[Error: ${execResult.error}]`;
      }

      const iteration: RecallIteration = {
        index: i,
        modelResponse,
        codeBlock: combinedCode,
        replOutput,
        subcalls,
        durationMs: Date.now() - iterStart,
      };
      trajectory.iterations.push(iteration);
      options.onIteration?.(iteration);

      // Step 3: Check structured FINAL result from sandbox function calls
      if (execResult.finalValue) {
        trajectory.finalContext = execResult.finalValue;
        trajectory.totalDurationMs = Date.now() - startTime;
        log('[RecallLoop] FINAL resolved in REPL at iteration %d, contextLen=%d', i, execResult.finalValue.length);
        return { context: execResult.finalValue, trajectory };
      }
      if (execResult.finalVarName) {
        const resolved = repl.resolveVariable(execResult.finalVarName);
        if (resolved) {
          trajectory.finalContext = resolved;
          trajectory.totalDurationMs = Date.now() - startTime;
          log('[RecallLoop] FINAL_VAR resolved in REPL at iteration %d, contextLen=%d', i, resolved.length);
          return { context: resolved, trajectory };
        }
      }

      // Step 4: Check model text for inline FINAL (matches original RLM flow)
      // Original RLM: find_final_answer() operates on the FULL response after code execution.
      // The model may write code + FINAL(...) as plain text in the same response — after
      // executing code, any referenced variables now exist in the REPL, so resolve it.
      const inlineResult = detectFinalInModelResponse(modelResponse);
      if (inlineResult) {
        const resolved = await resolveInlineFinal(inlineResult, repl);
        if (resolved) {
          trajectory.finalContext = resolved;
          trajectory.totalDurationMs = Date.now() - startTime;
          log('[RecallLoop] FINAL detected in model text (post-code) at iteration %d', i);
          return { context: resolved, trajectory };
        }
      }

      // Step 5: No FINAL found — feed REPL output back for next iteration.
      // Strip post-code content from assistant message to remove fabricated output.
      messages.push({ role: 'assistant', content: stripPostCodeContent(modelResponse) });
      messages.push({ role: 'user', content: `Code executed:\n\`\`\`repl\n${combinedCode}\n\`\`\`\n\nREPL output:\n${replOutput}\n\n${buildContinuationPrompt(userPrompt, repl.getVariableSummary())}` });
    }

    if (!trajectory.finalContext && !options.abortSignal?.aborted) {
      log('[RecallLoop] Max iterations/timeout reached, forcing final answer');
      trajectory.forcedAnswer = true;

      const forcedRemainingMs = TOTAL_LOOP_TIMEOUT_MS - (Date.now() - startTime);
      if (forcedRemainingMs < 15_000) {
        log('[RecallLoop] Insufficient time remaining (%dms) for forced answer, using fallback', forcedRemainingMs);
        trajectory.finalContext = buildFallbackContext(history);
      } else {
        const forcedAbort = new AbortController();
        const forcedTimeoutMs = Math.min(forcedRemainingMs, ITERATION_TIMEOUT_MS);
        const forcedTimer = setTimeout(() => forcedAbort.abort(), forcedTimeoutMs);
        const onParentAbort = () => forcedAbort.abort();
        options.abortSignal?.addEventListener('abort', onParentAbort);

        try {
          messages.push({ role: 'user', content: FORCED_ANSWER_PROMPT });
          const forcedResponse = await callRootModel(
            sdkQuery,
            systemPrompt,
            messages,
            options.model,
            options.cwd,
            forcedAbort.signal,
          );

          if (forcedResponse) {
            const forcedBlocks = extractCodeBlocks(forcedResponse);
            if (forcedBlocks.length > 0) {
              const execResult = await executeBlocksIndividually(repl, forcedBlocks);
              if (execResult.finalValue) {
                trajectory.finalContext = execResult.finalValue;
              } else if (execResult.finalVarName) {
                trajectory.finalContext = repl.resolveVariable(execResult.finalVarName);
              }
            }

            if (!trajectory.finalContext) {
              const inlineResult = detectFinalInModelResponse(forcedResponse);
              if (inlineResult) {
                trajectory.finalContext = await resolveInlineFinal(inlineResult, repl);
              }
            }
          }
        } finally {
          clearTimeout(forcedTimer);
          options.abortSignal?.removeEventListener('abort', onParentAbort);
        }

        if (!trajectory.finalContext) {
          trajectory.finalContext = buildFallbackContext(history);
          log('[RecallLoop] Using fallback context (last 3 turns)');
        }
      }
    }
  } finally {
    repl.dispose();
    subCallHandler.abort();
  }

  trajectory.totalDurationMs = Date.now() - startTime;
  return { context: trajectory.finalContext, trajectory };
}

async function callRootModel(
  sdkQuery: SdkQuery,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const abortController = new AbortController();

  const onAbort = () => abortController.abort();
  abortSignal?.addEventListener('abort', onAbort);

  // The SDK's query() only accepts a single prompt string — it has no multi-turn
  // messages parameter. Flatten the conversation history into one prompt so the
  // model can see its prior REPL interactions and progress toward FINAL.
  let prompt: string;
  if (messages.length === 1) {
    prompt = messages[0]!.content;
  } else {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        parts.push(`[Your previous response]\n${msg.content}`);
      } else {
        parts.push(msg.content);
      }
    }
    prompt = parts.join('\n\n');
  }

  try {
    const options = {
      model,
      maxTurns: 1,
      systemPrompt,
      cwd,
      persistSession: false,
      tools: [] as string[],
      abortController,
      thinking: { type: 'disabled' },
    };

    if (prompt.length > 400_000) {
      log('[RecallLoop] WARNING: Flattened prompt is %d chars (~%dK tokens) — approaching model context limits', prompt.length, Math.round(prompt.length / 4000));
    }
    log('[RecallLoop] Calling root model: model=%s, messageCount=%d, promptLen=%d', model, messages.length, prompt.length);

    const generator = sdkQuery({ prompt, options } as Parameters<SdkQuery>[0]);
    let streamText = '';
    let assistantText = '';
    let eventCount = 0;
    const eventTypes: string[] = [];

    for await (const event of generator) {
      if (abortController.signal.aborted) break;
      eventCount++;

      const msg = event as Record<string, unknown>;
      const msgType = msg['type'] as string;

      if (msgType === 'stream_event') {
        const streamEvent = msg['event'] as { type: string; delta?: { type: string; text?: string; thinking?: string } } | undefined;
        const subType = streamEvent?.type ?? 'unknown';
        const deltaType = streamEvent?.delta?.type;
        eventTypes.push(`stream:${subType}${deltaType ? ':' + deltaType : ''}`);

        if (streamEvent?.type === 'content_block_delta') {
          const delta = streamEvent.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            streamText += delta.text;
          }
        }
      } else if (msgType === 'assistant') {
        const message = msg['message'] as { content?: unknown[]; model?: string } | undefined;
        const blockTypes = message?.content?.map(b => (b as { type?: string })['type'] ?? '?').join(',') ?? 'none';
        eventTypes.push(`assistant(blocks=${blockTypes},model=${message?.model ?? '?'})`);

        if (message?.content) {
          for (const block of message.content) {
            const b = block as { type?: string; text?: string };
            if (b.type === 'text' && b.text) {
              assistantText += b.text;
            }
          }
        }
      } else {
        eventTypes.push(msgType);
      }
    }

    const responseText = streamText || assistantText;

    log('[RecallLoop] Root model response: events=%d, streamLen=%d, assistantLen=%d, types=[%s]',
      eventCount, streamText.length, assistantText.length, eventTypes.join(', '));

    return responseText || null;
  } catch (err) {
    if (abortController.signal.aborted) return null;
    log('[RecallLoop] Root model call error: %s', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

function buildDirectContext(history: StructuredTurn[]): string {
  const sections: string[] = [];
  for (const turn of history) {
    const toolLines = turn.toolCalls
      .map(tc => {
        const header = `${tc.name}(${summarizeInput(tc.input)})`;
        if (!tc.result) return header;
        return `${header}\nResult: ${tc.result}`;
      });
    const toolSection = toolLines.length > 0
      ? `\nTools:\n${toolLines.join('\n\n')}`
      : '';
    sections.push(`[Prompt ${turn.promptIndex}] User: ${turn.userMessage}${toolSection}\nAssistant: ${turn.assistantResponse}`);
  }
  return sections.join('\n\n');
}

function buildFallbackContext(history: StructuredTurn[]): string {
  const recent = history.slice(-3);
  return buildDirectContext(recent);
}

function summarizeInput(input: Record<string, unknown>): string {
  if (input['file_path']) return String(input['file_path']);
  if (input['command']) return String(input['command']).slice(0, 80);
  if (input['pattern']) return String(input['pattern']);
  if (input['query']) return String(input['query']).slice(0, 80);
  const keys = Object.keys(input);
  return keys.slice(0, 3).join(', ');
}
