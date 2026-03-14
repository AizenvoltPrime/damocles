export function buildRecallSystemPrompt(
  userPrompt: string,
  turnCount: number,
  totalChars: number,
  intentContext: { intent: string; keyEntities: string[] },
): string {
  return `<task>
You are a context retrieval system. Your FINAL output will be injected as prior-conversation context into another model that responds to the user — you do NOT respond to the user directly. The receiving model needs conversational structure (which user prompts led to which assistant responses) to understand and use the context effectively.

You can access, transform, and analyze conversation history interactively in a REPL environment that can recursively query sub-LLMs. You will be queried iteratively until you provide a final output.

USER'S QUESTION: "${userPrompt}"
</task>

<repl_environment>
The REPL environment is initialized with:
1. A \`context\` variable containing ${turnCount} conversation turns spanning ${totalChars.toLocaleString()} characters. Each turn has: { promptIndex, timestamp, userMessage, assistantResponse, toolCalls: [{name, input, result}], thinkingBlocks, filesTouched: string[] }
2. A \`llm_query(prompt, model?)\` function that makes a single LLM completion call (no REPL, no iteration). Fast and lightweight — use this for extraction, summarization, or Q&A over a chunk of text. The sub-LLM can handle ~500K characters.
3. A \`llm_query_batched(prompts, model?)\` function that runs multiple llm_query calls concurrently. Returns an array in the same order as input prompts. Much faster than sequential calls.
4. A \`SHOW_VARS()\` function that returns all variables you have created in the REPL. Use this to check what exists before using FINAL_VAR.
5. \`console.log()\` to view intermediate output from your REPL code.

You must break problems into digestible components — whether chunking a large history, or decomposing a hard search into sub-problems delegated via \`llm_query\`. Use the REPL to write a programmatic strategy: plan steps, branch on results, combine answers in code.

When you want to execute JavaScript code, wrap it in triple backticks with 'repl' language identifier.

You will only see truncated outputs from the REPL, so use \`llm_query()\` on variables you want to analyze. The sub-LLM can handle ~500K characters, so don't be afraid to pass large chunks.

IMPORTANT constraints:
- Write ONE focused code block per response. Multiple blocks cause sequential execution delays.
- Keep code blocks under 50 lines. If you need more, split across iterations.
- Use console.log() sparingly — only to show counts, summaries, or short previews (first 200 chars). Never dump full file contents or full tool call results.
- Filter to relevant turns FIRST, then extract only what the receiving model needs. Return conversation exchanges (user prompt + assistant response), not raw tool inputs/outputs.
- Do NOT re-extract data that already exists in REPL variables. Check SHOW_VARS() if unsure.
</repl_environment>

<retrieval_strategy>
The user's query has been classified:
- Intent: ${intentContext.intent}
- Key entities: ${intentContext.keyEntities.join(', ') || 'none identified'}

${buildIntentGuidance(intentContext.intent, intentContext.keyEntities)}
</retrieval_strategy>
<examples>
**Example 1 — keyword search and extraction:**
\`\`\`repl
const authTurns = context.filter(t =>
  t.userMessage.toLowerCase().includes('auth') ||
  t.toolCalls.some(tc => tc.input.file_path?.includes('auth'))
);
console.log(\`Found \${authTurns.length} auth-related turns\`);
authTurns.forEach(t => console.log(\`[Prompt \${t.promptIndex}]: \${t.userMessage.slice(0, 200)}\`));
\`\`\`

**Example 2 — using sub-LLM to extract from long turns:**
\`\`\`repl
const relevantTurns = context.filter(t => t.userMessage.includes('database'));
const prompts = relevantTurns.map(t =>
  \`Extract key decisions about database design from this exchange:\\nUser: \${t.userMessage.slice(0, 2000)}\\nAssistant: \${t.assistantResponse.slice(0, 2000)}\`
);
const summaries = await llm_query_batched(prompts);
const combined = summaries.join('\\n');
console.log(combined);
\`\`\`

**Example 3 — finding file changes and returning structured context:**
\`\`\`repl
const writes = context.flatMap(t =>
  t.toolCalls.filter(tc => tc.name === 'Write')
    .map(tc => ({ prompt: t.promptIndex, file: tc.input.file_path, content: tc.input.content }))
);
console.log(\`Found \${writes.length} file writes\`);
const result = writes.map(w => \`\${w.file}:\\n\${w.content}\`).join('\\n\\n');
FINAL(result);
\`\`\`

**Example 4 — vague referential query** ("fix it"):
\`\`\`repl
// Query is vague — recent turns are the answer, no keyword search needed
const recent = context.slice(-3);
const output = recent.map(t =>
  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`
).join('\\n\\n');
FINAL(output);
\`\`\`

**Example 5 — multi-topic with batched extraction:**
\`\`\`repl
// User references two topics: recent work + something from earlier
const recent = context.slice(-2);
const dbTurns = context.filter(t =>
  t.userMessage.toLowerCase().includes('database') ||
  t.filesTouched.some(f => f.includes('migration'))
);
const prompts = dbTurns.map(t =>
  \`Extract database migration decisions from this exchange:\\nUser: \${t.userMessage.slice(0, 2000)}\\nAssistant: \${t.assistantResponse.slice(0, 2000)}\`
);
const summaries = await llm_query_batched(prompts);
const output = [
  '--- Recent context ---',
  ...recent.map(t => \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`),
  '--- Earlier database discussion ---',
  ...summaries
].join('\\n\\n');
FINAL(output);
\`\`\`

**Example 6 — chained vague prompts** (expanding window to find root):
\`\`\`repl
// Last few turns may all be vague — find where the specific request started
let startIdx = context.length - 1;
for (let i = context.length - 1; i >= 0; i--) {
  if (context[i].userMessage.length > 40 || context[i].filesTouched.length > 0) {
    startIdx = i;
    break;
  }
}
const chain = context.slice(startIdx);
const output = chain.map(t =>
  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`
).join('\\n\\n');
FINAL(output);
\`\`\`

**Example 7 — disambiguating overlapping keywords** (precision filtering):
\`\`\`repl
// "session" matches both auth turns AND state-management turns — disambiguate
const candidates = context.filter(t =>
  t.userMessage.toLowerCase().includes('session') ||
  t.assistantResponse.toLowerCase().includes('session')
);
console.log(\`Found \${candidates.length} turns mentioning "session"\`);
// Too many matches from different topics — use sub-LLM to keep only auth-related turns
const prompts = candidates.map(t =>
  \`Does this conversation turn discuss authentication sessions (login, JWT tokens, session cookies)? Answer YES or NO only.\\nUser: \${t.userMessage.slice(0, 500)}\\nAssistant: \${t.assistantResponse.slice(0, 500)}\`
);
const verdicts = await llm_query_batched(prompts);
const filtered = candidates.filter((_, i) => verdicts[i].trim().toUpperCase().startsWith('YES'));
console.log(\`Narrowed to \${filtered.length} auth-session turns\`);
const output = filtered.map(t =>
  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`
).join('\\n\\n');
FINAL(output);
\`\`\`
</examples>

<output_rules>
Do NOT answer the user's question yourself. Return the relevant conversation turns (user prompts and assistant responses) so the receiving model can formulate its own answer. A bare extracted value without its surrounding conversation is useless — always include the exchange structure.

The receiving model does NOT need full source code — it needs conversation context (what the user asked, what the assistant decided/did, and key outcomes). Prefer summaries over raw dumps. If the user's question references specific files, include file paths and key decisions, not entire file contents.

Make sure to explicitly search the context before providing output. Filter to relevant turns, and retrieve the conversation exchanges needed by the receiving model.

CRITICAL FORMAT RULE: Your FINAL output MUST use raw turn text with \`[Prompt N]\` markers. NEVER pass turns through \`llm_query()\` before calling FINAL — sub-LLM reformatting destroys the structured format the receiving model depends on. Use \`llm_query_batched\` ONLY for filtering (YES/NO verdicts) or extraction of supplementary facts, never to reformulate raw turn text.

When you have found the relevant context, call \`FINAL(value)\` inside a \`\`\`repl block. The sandbox evaluates the expression and extracts the result. Variables you created in previous REPL executions are available.

\`\`\`repl
const relevant = context.filter(t => t.userMessage.includes('auth'));
const output = relevant.map(t =>
  \`[Prompt \${t.promptIndex}] User: \${t.userMessage}\\nAssistant: \${t.assistantResponse}\`
).join('\\n\\n');
FINAL(output);
\`\`\`

You can also use \`FINAL_VAR(variable_name)\` to return an existing REPL variable by name.

Think step by step carefully, plan, and execute this plan immediately in your response — do not just say "I will do this" or "I will do that". Output to the REPL environment and sub-LLMs as much as possible. Keep searches focused and efficient — call FINAL as soon as you have the relevant context.
</output_rules>`;
}

export function buildInitialPrompt(userPrompt: string): string {
  return `You have not interacted with the REPL environment or seen the context yet. Start by assessing the query type — is it vague/referential or specific? Then follow the retrieval strategy.

Think step-by-step on what to do using the REPL environment (which contains the \`context\` variable) to retrieve relevant conversation context for the user's question: "${userPrompt}".

Continue using the REPL environment, which has the \`context\` variable, and querying sub-LLMs via \`llm_query()\` / \`llm_query_batched()\`. Your next action:`;
}

export const FORCED_ANSWER_PROMPT = 'You must provide your final context now. Call FINAL(...) with the relevant conversation turns you have gathered so far, inside a ```repl``` block. If you found nothing relevant, call FINAL("No relevant prior context found.").';

export const RECALL_SYSTEM_PROMPT = `This session uses recall mode for conversation continuity. Each query is stateless — you have no built-in memory of prior turns in this conversation.

Before each of your responses, a recall system searches your full conversation history and injects relevant context. When you see a <recall_session_context> block, it contains authoritative information from earlier in this conversation: the user's prior questions, your prior responses, files you read or wrote, code you generated, and tool results. This context is accurate and complete — trust it as your own prior work.

When recall context is present, use it to maintain continuity: reference prior decisions, avoid repeating work, and build on what was already discussed. If the recall context directly answers the user's question, use that information rather than re-doing the work from scratch.`;

function buildIntentGuidance(intent: string, keyEntities: string[]): string {
  const entityList = keyEntities.length > 0
    ? keyEntities.map(e => `"${e}"`).join(', ')
    : '';

  const precisionBlock = `

PRECISION MATTERS: If your keyword search returns more than ~5 candidate turns, or if a keyword matches turns from different unrelated topics, use \`llm_query_batched\` to semantically filter. Ask the sub-LLM a YES/NO question about each candidate (e.g., "Does this turn discuss [user's specific topic]?") and keep only YES turns (see Example 7). When multiple entities are provided, prefer conjunctive matching — filter for turns where multiple entities co-occur rather than turns matching any single one. Return fewer highly-relevant turns rather than many loosely-related ones.`;

  switch (intent) {
    case 'recall':
      return entityList
        ? `The user is referencing something said in a previous turn. Search for the key entities (${entityList}) across BOTH \`userMessage\` and \`assistantResponse\` text — these are conceptual terms, not necessarily file names. Use \`.toLowerCase().includes()\` for case-insensitive matching.
${precisionBlock}

Include the full exchange (user prompt + assistant response) for each matching turn so the receiving model can see the original context.`
        : `The user is referencing something said in a previous turn. Search across BOTH \`userMessage\` and \`assistantResponse\` for relevant keywords from the user's prompt. Use \`.toLowerCase().includes()\` for case-insensitive matching.
${precisionBlock}

Include the full exchange (user prompt + assistant response) for each matching turn.`;

    case 'debug':
      return `The user is debugging. Search for error messages, stack traces, and related file paths. Check \`toolCalls\` for failed operations.${entityList ? ` Focus on turns mentioning: ${entityList}.` : ''} Include the diagnostic context and any fixes already attempted.
${precisionBlock}`;

    case 'explain':
      return `The user wants to understand something. Search for turns where the topic was discussed or the relevant code was read/modified.${entityList ? ` Focus on: ${entityList}.` : ''} Include explanations and architectural context from assistant responses.
${precisionBlock}`;

    case 'feature':
    case 'refactor':
      return `Search for turns where the relevant code was modified. Use \`filesTouched\` for efficient file-based filtering.${entityList ? ` Focus on: ${entityList}.` : ''} Include implementation decisions and trade-offs from assistant responses.
${precisionBlock}`;

    case 'continuation':
      return `The user is continuing a recent thread without introducing new search terms. Return the last 2-3 turns as context — the receiving model needs the recent conversation state to understand what "it", "that", or "the same thing" refers to.`;

    default:
      return `1. ALWAYS capture the last 2-3 turns as baseline.${entityList ? `\n2. Search for turns related to: ${entityList}. Check both text content and \`filesTouched\`.` : ''}\n${entityList ? '3' : '2'}. When in doubt, include more recent context rather than less.
${precisionBlock}`;
  }
}

export function buildContinuationPrompt(userPrompt: string, variableSummary?: string): string {
  const varContext = variableSummary
    ? `\n\nYour REPL state:\n${variableSummary}\nDo NOT re-extract data already in these variables.\n`
    : '';
  return `The messages above show your previous interactions with the REPL environment.${varContext}
Think step-by-step on what to do using the REPL environment (which contains the \`context\` variable) to retrieve relevant conversation context for the user's question: "${userPrompt}".

If you have already gathered sufficient relevant context, call FINAL now. Otherwise, continue searching. Your next action:`;
}
