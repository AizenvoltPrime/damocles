import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import type { SdkQuery } from '../shared/sdk-loader';
import { JsRepl } from './js-repl';
import { extractCodeBlocks, detectFinal, detectFinalInModelResponse, type FinalResult } from './parsing';
import { buildRecallSystemPrompt, INITIAL_REPL_PROMPT, FORCED_ANSWER_PROMPT } from './prompts';
import { SubCallHandler } from './sub-call-handler';
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

interface RecallLoopOptions {
  config: RecallConfig;
  cwd: string;
  model: string;
  abortSignal?: AbortSignal;
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
  const totalChars = history.reduce((sum, t) => sum + t.userMessage.length + t.assistantResponse.length, 0);

  const trajectory: RecallTrajectory = {
    promptIndex,
    userPrompt,
    iterations: [],
    finalContext: null,
    totalDurationMs: 0,
    shortCircuited: false,
    forcedAnswer: false,
    turnCount: history.length,
    historyChars: totalChars,
  };

  if (history.length === 0) {
    trajectory.shortCircuited = true;
    trajectory.totalDurationMs = Date.now() - startTime;
    return { context: null, trajectory };
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

  const systemPrompt = buildRecallSystemPrompt(userPrompt, history.length, totalChars);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  try {
    for (let i = 0; i < options.config.maxIterations; i++) {
      if (options.abortSignal?.aborted) {
        log('[RecallLoop] Aborted at iteration %d', i);
        break;
      }

      const iterStart = Date.now();
      const subcalls: SubcallRecord[] = [];

      const modelResponse = await callRootModel(
        sdkQuery,
        systemPrompt,
        messages,
        options.model,
        options.cwd,
        options.abortSignal,
      );

      if (!modelResponse) break;

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
        messages.push({ role: 'user', content: 'No FINAL() call detected in your response. If you already found the answer, call FINAL(your answer) now as plain text. Otherwise, write a ```repl code block to search further.' });
        continue;
      }

      // Step 2: Execute code blocks FIRST — variables must exist before FINAL resolution
      // Original RLM: _completion_turn() runs all blocks, then completion() checks for FINAL
      const combinedCode = codeBlocks.join('\n');
      const execResult = await repl.execute(combinedCode);
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

      // Step 3: Check REPL stdout for FINAL (from sandbox FINAL()/FINAL_VAR() function calls)
      const finalResult = detectFinal(replOutput);
      if (finalResult) {
        let finalValue: string | null;
        if (finalResult.type === 'final_var') {
          finalValue = repl.resolveVariable(finalResult.value);
        } else {
          finalValue = finalResult.value;
        }

        if (finalValue) {
          trajectory.finalContext = finalValue;
          trajectory.totalDurationMs = Date.now() - startTime;
          log('[RecallLoop] FINAL resolved in REPL at iteration %d, contextLen=%d', i, finalValue.length);
          return { context: finalValue, trajectory };
        }
      }

      // Step 4: When code blocks were present, do NOT accept model-text FINAL.
      // The model wrote code and FINAL in the same response — the FINAL was generated
      // before seeing code execution results and is speculative. Feed REPL output back
      // and let the model write an informed FINAL after seeing the actual results.
      messages.push({ role: 'assistant', content: modelResponse });
      messages.push({ role: 'user', content: `Code executed:\n\`\`\`repl\n${combinedCode}\n\`\`\`\n\nREPL output:\n${replOutput}\n\nReview the output above. If you have enough information to answer the user's question, call FINAL(your answer) as plain text now. Otherwise, write more \`\`\`repl code to search further.` });
    }

    if (!trajectory.finalContext && !options.abortSignal?.aborted) {
      log('[RecallLoop] Max iterations/timeout reached, forcing final answer');
      trajectory.forcedAnswer = true;

      messages.push({ role: 'user', content: FORCED_ANSWER_PROMPT });
      const forcedResponse = await callRootModel(
        sdkQuery,
        systemPrompt,
        messages,
        options.model,
        options.cwd,
        options.abortSignal,
      );

      if (forcedResponse) {
        const forcedBlocks = extractCodeBlocks(forcedResponse);
        if (forcedBlocks.length > 0) {
          const execResult = await repl.execute(forcedBlocks.join('\n'));
          const finalResult = detectFinal(execResult.stdout);
          if (finalResult) {
            trajectory.finalContext = finalResult.type === 'final_var'
              ? repl.resolveVariable(finalResult.value)
              : finalResult.value;
          }
        }

        if (!trajectory.finalContext) {
          const inlineResult = detectFinalInModelResponse(forcedResponse);
          if (inlineResult) {
            trajectory.finalContext = await resolveInlineFinal(inlineResult, repl);
          }
        }
      }

      if (!trajectory.finalContext) {
        trajectory.finalContext = buildFallbackContext(history);
        log('[RecallLoop] Using fallback context (last 3 turns)');
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

  const prompt = messages.length === 0
    ? INITIAL_REPL_PROMPT
    : messages[messages.length - 1]!.content;

  const priorMessages = messages.length > 1
    ? messages.slice(0, -1).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: [{ type: 'text' as const, text: m.content }],
      }))
    : undefined;

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
      ...(priorMessages ? { messages: priorMessages } : {}),
    };

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
    const toolSummary = turn.toolCalls.length > 0
      ? `\nTools: ${turn.toolCalls.map(tc => `${tc.name}(${summarizeInput(tc.input)})`).join(', ')}`
      : '';
    sections.push(`[Prompt ${turn.promptIndex}] User: ${turn.userMessage}${toolSummary}\nAssistant: ${turn.assistantResponse}`);
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
