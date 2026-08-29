import { ownEntry } from './ownEntry';

const LABEL_KEYS: Record<string, string> = {
  'code-reviewer': 'subagentTypes.codeReviewer',
  Explore: 'subagentTypes.explorer',
  Plan: 'subagentTypes.planner',
  'general-purpose': 'subagentTypes.agent',
  'claude-code-guide': 'subagentTypes.guide',
  'statusline-setup': 'subagentTypes.setup',
};

/**
 * Maps a subagent type id to its i18n label key, returning the key rather than the resolved string so
 * each call site keeps `t()` reactive to the active locale. Null lets the caller show the raw id.
 */
export function subagentTypeLabelKey(agentType: string): string | null {
  return ownEntry(LABEL_KEYS, agentType) ?? null;
}
