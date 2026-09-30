/**
 * prompts.ts — System prompt builder for agents.
 *
 * Ported from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 */

import { STEERING_PROTOCOL_BLOCK } from '../steering-protocol';
import { COMMENT_RULES_BODY, TEST_RUN_RULES_BODY } from '../code-rules';
import { buildNarrationRule } from '../prose-rules';
import { mechanismRecordRule, sliceMechanismRungs } from '../delivery-mechanisms';
import type { AgentConfig, EnvInfo } from './types';

/**
 * Replace-mode agents that write code (the bundled profiles, a user agent with a write tool) inherit no
 * comment policy and no test cadence, so they get the same bodies the panel carries. Capability-gated
 * like `compassBlock`: Explore and Plan hold no write tool and would only be paying for rules they
 * cannot act on.
 */
const codeRulesBlock = `# Comments
${COMMENT_RULES_BODY}

# Running tests and checks
${TEST_RUN_RULES_BODY}`;

/**
 * An agent's narration is spent from the PARENT's context window, and the parent reads only the final
 * result, so it is pure overhead here. Applied in both modes: replace-mode agents (Explore, Plan, the
 * bundled profiles) have no tone rules of their own, and an append-mode agent inherits the panel's
 * `# Text output` cadence, which asks for an opening sentence and per-step updates. The override line
 * settles that conflict in favour of this section, which sits later in the prompt.
 */
const narrationBlock = `# Narration
${buildNarrationRule('Your final result to the parent agent, and anything you write into a file')}`;

const narrationBlockAppend = `${narrationBlock}
- This section replaces any narration or progress-update cadence stated earlier in this prompt.`;

/**
 * Emitted last in both modes so it wins over the agent's own instructions, and static so it costs the
 * cache prefix nothing. Every mode ends on `turnEndingConfirmation`, the one check-in the rules must not remove.
 */
const turnEndingRules = `# Ending your turn
A message with no tool call ends your turn, and its text is returned to the parent as your final result. Three endings are correct: the task is done, nothing can advance without the parent, or what blocks you is deliberately out of your reach, such as a permission gate or a credential you do not hold.
- Do not stop on a progress report. A summary that closes by announcing your next step is not an ending.
- Do not stop on an offer to carry on, such as "I'll carry on unless you'd prefer otherwise." The parent was not going to answer it.
- Do not stop on a list of decisions for the parent when, by your own account, none of them blocks the remaining work.
- Do not stop because the turn has run long or a milestone is done. Neither is a stopping condition.
- Put status notes and recommendations in the same message as your next tool call, and carry on with whatever does not depend on the parent's answer.
- If you catch yourself inviting the parent to redirect you, or offering to wait, delete it and do the next thing.`;

const turnEndingConfirmation = 'None of this overrides the confirmation a risky or destructive action needs.';

const turnEndingBlock = `${turnEndingRules}
${turnEndingConfirmation}`;

const turnEndingBlockAppend = `${turnEndingRules}
This section overrides any turn-ending cadence stated earlier in this prompt.
${turnEndingConfirmation}`;

/**
 * Escape a value for safe interpolation into the `<active_agent name="…">` attribute. Agent names
 * legitimately contain spaces (e.g. "AI Engineer"), so a name-whitelist is too strict — instead the
 * quote/angle-bracket/ampersand chars that could close the tag and inject prompt markup are escaped.
 */
function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Extra sections to inject into the system prompt (skills, etc.). */
export interface PromptExtras {
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
  /**
   * Compass guidance, set only when the agent's RESOLVED toolset holds the Compass tools — a `tools: *`
   * agent inherits them and would otherwise hold eight tools it was told nothing about. The predicate is
   * the caller's because only it has the resolved set. A request, not a guarantee: an agent whose
   * inherited identity already carries a `<compass>` section drops it (see `buildAgentPrompt`).
   */
  compassBlock?: string;
  /**
   * True when the agent's RESOLVED toolset holds a write-category tool. The caller's to decide, for the
   * same reason `compassBlock` is: only it has the resolved set. Append-mode agents already inherit both
   * bodies from the panel prompt, so the block is emitted in replace mode only.
   */
  writesFiles?: boolean;
  /**
   * The delivery-mechanism ladder the Plan agent assigns from. Set by the caller, for the same reason
   * `compassBlock` is: the team rung belongs in it only when the PARENT can call `create_team`, and only
   * the caller knows that. Emitted in both prompt modes, unlike `writesFiles`: an append-mode agent
   * inherits guidance about delegating its OWN work, which is a different question from which mechanism
   * a plan should assign to a slice the parent will implement later.
   */
  planMechanismBlock?: string;
}

/**
 * The ladder the Plan agent assigns from, worded for an agent writing a plan rather than executing one:
 * it names the mechanisms the IMPLEMENTER will use, not tools this agent holds. The rungs come from
 * `delivery-mechanisms.ts`, so this block and the plan-mode guidance state them in the same words.
 */
export function buildPlanMechanismBlock(teamEnabled: boolean): string {
  const rungs = sliceMechanismRungs(teamEnabled)
    .map((rung) => `- ${rung}`)
    .join('\n');
  return `# Delivery mechanisms
Give every slice in the plan a delivery mechanism, and pick the smallest one that fits:
${rungs}

${mechanismRecordRule(teamEnabled)}`;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: env header + config.systemPrompt (full control, no parent identity)
 * - "append" mode: parent system prompt + sub-agent context + env header + config.systemPrompt
 * - "append" with empty systemPrompt: pure parent clone
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so downstream
 * policy systems can resolve per-agent policy by parsing the system prompt.
 *
 * @param parentSystemPrompt  The parent agent's effective system prompt (for append mode).
 * @param extras  Optional extra sections to inject (preloaded skills).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${escapeXmlAttr(config.name)}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : 'Not a git repository'}
Platform: ${env.platform}`;

  // Append mode inherits the parent's whole prompt, which already carries a `<compass>` section when
  // Compass is enabled — appending the agent variant there briefs the model twice, in two voices, on
  // one subsystem. De-duplication lives here because only this function knows what the identity
  // resolves to: append falls back to `genericBase`, which has no `<compass>`, so a mode check alone
  // would wrongly suppress the block for a parentless append-mode agent.
  const identity = config.promptMode === 'append' ? parentSystemPrompt || genericBase : '';
  const compassBlock = identity.includes('<compass>') ? undefined : extras?.compassBlock;

  const extraSections: string[] = [];
  if (compassBlock) extraSections.push(`\n${compassBlock}`);
  if (extras?.planMechanismBlock) extraSections.push(`\n${extras.planMechanismBlock}`);
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  const extrasSuffix = extraSections.length > 0 ? '\n\n' + extraSections.join('\n') : '';

  if (config.promptMode === 'append') {
    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the Read tool instead of cat/head/tail
- Use the Edit tool instead of sed/awk
- Use the Write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
- You cannot spawn subagents or start teams. Do the work yourself, or report back what is out of scope
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : '';

    // Place shared/stable content first so the LLM's KV cache can reuse the inherited prefix across
    // all subagent invocations. The <active_agent> tag and env block vary per call and follow it.
    return identity + '\n\n' + bridge + '\n\n' + narrationBlockAppend + '\n\n' + STEERING_PROTOCOL_BLOCK + '\n\n' + activeAgentTag + envBlock + customSection + extrasSuffix + '\n\n' + turnEndingBlockAppend;
  }

  // "replace" mode — env header + the config's full system prompt
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  const codeRules = extras?.writesFiles ? codeRulesBlock + '\n\n' : '';

  return activeAgentTag + replaceHeader + '\n\n' + narrationBlock + '\n\n' + codeRules + STEERING_PROTOCOL_BLOCK + '\n\n' + config.systemPrompt + extrasSuffix + '\n\n' + turnEndingBlock;
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
