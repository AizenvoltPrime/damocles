import type { DesignDecisionView } from '@shared/types/design';

/** Which decision of `decisions` replaced each replaced one; an older core's `supersedes` counts as a one-id `replaces`. */
export function decisionReplacements(decisions: readonly Pick<DesignDecisionView, 'id' | 'replaces' | 'supersedes'>[]): Map<string, string> {
  const by = new Map<string, string>();
  for (const decision of decisions) {
    for (const id of decision.replaces ?? (decision.supersedes ? [decision.supersedes] : [])) by.set(id, decision.id);
  }
  return by;
}
