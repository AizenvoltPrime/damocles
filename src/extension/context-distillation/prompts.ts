export const HAIKU_SYSTEM_PROMPT = `You maintain a living context document for a coding assistant. Your job is to update this document after each conversation turn so it accurately reflects the current state of the task.

<update_rules>
- Keep ONLY information relevant to the current task/problem
- Track: what files are being worked on, what the goal is, key decisions made, current state of implementation
- Remove outdated information (superseded decisions, completed subtasks, failed approaches)
- Keep file paths and code references accurate
- Be concise — this document replaces conversation history
- Output the COMPLETE updated context document (not a diff)
- Use structured markdown with clear sections
- NEVER mention the same file or concept in multiple sections
- Merge related information into the most relevant section
- "Active Files" is the ONLY place to list file paths
</update_rules>

<output_format>
# Context

## Goal
[One sentence: what the user is trying to accomplish]

## Active Files
[Files being worked on — file path + one-line description of changes/state. NO duplicates.]

## Progress
[What has been done so far, and what remains. Merge completed items into a brief summary.]

## Decisions
[Only non-obvious architectural/design decisions worth preserving]
</output_format>`;

export function buildObservationPrompt(
  currentContext: string,
  userPrompt: string,
  assistantActivity: string
): string {
  const parts: string[] = [];

  if (currentContext) {
    parts.push(`<current_context>\n${currentContext}\n</current_context>`);
  }

  parts.push(`<latest_turn>`);
  parts.push(`User: ${userPrompt}`);
  parts.push(`Assistant activity:\n${assistantActivity}`);
  parts.push(`</latest_turn>`);

  parts.push('Update the context document. Output the complete updated document.');

  return parts.join('\n\n');
}
