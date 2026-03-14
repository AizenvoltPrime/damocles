export interface AgentResultParts {
  texts: string[];
  prompt: string | null;
}

export function parseAgentResult(raw: string): AgentResultParts | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.content && Array.isArray(parsed.content)) {
      const texts = parsed.content
        .filter((b: Record<string, unknown>) => b['type'] === 'text' && typeof b['text'] === 'string')
        .map((b: Record<string, unknown>) => b['text'] as string);
      if (texts.length > 0) {
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : null;
        return { texts, prompt };
      }
    }
  } catch { /* not parseable */ }
  return null;
}

export function extractAgentText(raw: string): string {
  const result = parseAgentResult(raw);
  if (!result) return raw;
  const prefix = result.prompt ? `[Agent prompt: ${result.prompt}]\n` : '';
  return prefix + result.texts.join('\n');
}
