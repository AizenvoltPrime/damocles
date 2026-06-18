/**
 * prompts.ts — System prompt builder for agents.
 *
 * Ported from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 */

import type { AgentConfig, EnvInfo } from './types';

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

  const extraSections: string[] = [];
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  const extrasSuffix = extraSections.length > 0 ? '\n\n' + extraSections.join('\n') : '';

  if (config.promptMode === 'append') {
    const identity = parentSystemPrompt || genericBase;

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
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : '';

    // Place shared/stable content first so the LLM's KV cache can reuse the inherited prefix across
    // all subagent invocations. The <active_agent> tag and env block vary per call and follow it.
    return identity + '\n\n' + bridge + '\n\n' + activeAgentTag + envBlock + customSection + extrasSuffix;
  }

  // "replace" mode — env header + the config's full system prompt
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + '\n\n' + config.systemPrompt + extrasSuffix;
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
