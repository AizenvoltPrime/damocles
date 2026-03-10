export function buildRecallSystemPrompt(userPrompt: string, turnCount: number, totalChars: number): string {
  return `You are tasked with answering a query using conversation history as context. You can access, transform, and analyze this context interactively in a REPL environment that can recursively query sub-LLMs. You will be queried iteratively until you provide a final answer.

USER'S QUESTION: "${userPrompt}"

The REPL environment is initialized with:
1. A \`context\` variable containing ${turnCount} conversation turns spanning ${totalChars.toLocaleString()} characters. Each turn has: { promptIndex, timestamp, userMessage, assistantResponse, toolCalls: [{name, input, result}], thinkingBlocks }
2. A \`llm_query(prompt, model?)\` function that makes a single LLM completion call (no REPL, no iteration). Fast and lightweight — use this for extraction, summarization, or Q&A over a chunk of text. The sub-LLM can handle ~500K characters.
3. A \`llm_query_batched(prompts, model?)\` function that runs multiple llm_query calls concurrently. Returns an array in the same order as input prompts. Much faster than sequential calls.
4. A \`SHOW_VARS()\` function that returns all variables you have created in the REPL. Use this to check what exists before using FINAL_VAR.
5. \`console.log()\` to view intermediate output from your REPL code.

**Breaking down problems:** You must break problems into digestible components — whether chunking a large history, or decomposing a hard search into sub-problems delegated via \`llm_query\`. Use the REPL to write a programmatic strategy: plan steps, branch on results, combine answers in code.

When you want to execute JavaScript code, wrap it in triple backticks with 'repl' language identifier.

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

**Example 3 — finding file changes and returning raw context:**
\`\`\`repl
const writes = context.flatMap(t =>
  t.toolCalls.filter(tc => tc.name === 'Write')
    .map(tc => ({ prompt: t.promptIndex, file: tc.input.file_path, content: tc.input.content }))
);
console.log(\`Found \${writes.length} file writes\`);
writes.forEach(w => console.log(\`[Prompt \${w.prompt}] \${w.file}: \${w.content?.slice(0, 200)}\`));
const result = writes.map(w => \`\${w.file}:\\n\${w.content}\`).join('\\n\\n');
\`\`\`
Then return the collected data:
FINAL_VAR(result)

You will only see truncated outputs from the REPL, so use \`llm_query()\` on variables you want to analyze. The sub-LLM can handle ~500K characters, so don't be afraid to pass large chunks.

Make sure to explicitly look through the context before answering. Search for relevant keywords, filter to relevant turns, and extract the information needed to answer the user's question.

IMPORTANT: When you are done with the iterative process, you MUST provide a final answer using FINAL, NOT inside code blocks. Do not use these tags unless you have completed your task. You have two options:
1. Use FINAL(your final answer here) to provide the answer directly
2. Use FINAL_VAR(variable_name) to return a variable you have created in the REPL environment as your final output

WARNING — COMMON MISTAKE: FINAL_VAR retrieves an EXISTING variable. You MUST create and assign the variable in a \`\`\`repl block FIRST, then call FINAL_VAR in a SEPARATE response. For example:
- WRONG: Calling FINAL_VAR(my_answer) without first creating \`my_answer\` in a repl block
- CORRECT: First run the code to create the variable, then in the NEXT response call FINAL_VAR(my_answer)

If you're unsure what variables exist, call SHOW_VARS() in a repl block.

Think step by step carefully, plan, and execute this plan immediately in your response. Output to the REPL environment and sub-LLMs as much as possible. Keep searches focused and efficient — call FINAL as soon as you have sufficient context.`;
}

export const INITIAL_REPL_PROMPT = 'You have not interacted with the REPL environment or seen the context yet. Start by exploring the `context` variable to find information relevant to the user\'s question. Write ```repl code blocks. Do NOT provide a FINAL answer yet — first explore the data.';

export const FORCED_ANSWER_PROMPT = 'You must provide your final context now. Call FINAL(...) with whatever you have gathered so far. Write FINAL(your answer) as plain text, NOT inside a code block. If you found nothing relevant, call FINAL("No relevant prior context found.").';

export const RECALL_SYSTEM_PROMPT = `This session uses recall mode for conversation continuity. Each query is stateless — you have no built-in memory of prior turns in this conversation.

Before each of your responses, a recall system searches your full conversation history and injects relevant context. When you see a <recall_session_context> block, it contains authoritative information from earlier in this conversation: the user's prior questions, your prior responses, files you read or wrote, code you generated, and tool results. This context is accurate and complete — trust it as your own prior work.

When recall context is present, use it to maintain continuity: reference prior decisions, avoid repeating work, and build on what was already discussed. If the recall context directly answers the user's question, use that information rather than re-doing the work from scratch.`;
