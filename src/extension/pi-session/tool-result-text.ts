/** Join the text blocks of a pi tool result into the single string the webview tool card renders. */
export function joinResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  // A custom tool or an MCP shim may answer with a bare string; returning '' there blanks the card and,
  // for the team runner, writes the blank into the agent log as the authoritative replay.
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}
