/**
 * subagentTypeLabel.ts — Single source of truth mapping a subagent type id to its i18n label key.
 *
 * Returns the translation KEY (not the resolved string) so each call site keeps `t()` reactive to the
 * active locale. Returns null for an unknown type, letting the caller fall back to the raw id.
 */
export function subagentTypeLabelKey(agentType: string): string | null {
  const keys: Record<string, string> = {
    'code-reviewer': 'subagentTypes.codeReviewer',
    Explore: 'subagentTypes.explorer',
    Plan: 'subagentTypes.planner',
    'general-purpose': 'subagentTypes.agent',
    'claude-code-guide': 'subagentTypes.guide',
    'statusline-setup': 'subagentTypes.setup',
  };
  return keys[agentType] ?? null;
}
