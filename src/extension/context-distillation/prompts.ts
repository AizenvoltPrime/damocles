export const HAIKU_SYSTEM_PROMPT = `You maintain a living context document for a coding assistant. Your job is to update this document after each conversation turn so it accurately reflects the current state of the task.

<update_rules>
- Keep ONLY information relevant to the current task/problem
- Track: what files are being worked on, what the goal is, key decisions made, current state of implementation
- Remove outdated information (superseded decisions, completed subtasks, failed approaches)
- Keep file paths and code references accurate
- Be concise — this document replaces conversation history
- Output the COMPLETE updated context document (not a diff)
- Use structured markdown with clear sections
</update_rules>

<output_format>
# Context

## Goal
[What the user is trying to accomplish]

## Current State
[Where things stand right now]

## Key Files
[Files being actively worked on with brief descriptions]

## Decisions
[Important architectural/design decisions made]

## Notes
[Any other relevant context]
</output_format>`;

export function buildObservationPrompt(
  currentContext: string,
  userPrompt: string,
  assistantResponse: string
): string {
  const parts: string[] = [];

  if (currentContext) {
    parts.push(`<current_context>\n${currentContext}\n</current_context>`);
  }

  parts.push(`<latest_turn>`);
  parts.push(`User: ${userPrompt}`);
  parts.push(`Assistant: ${assistantResponse}`);
  parts.push(`</latest_turn>`);

  parts.push('Update the context document based on this latest turn. Output the complete updated document.');

  return parts.join('\n\n');
}
