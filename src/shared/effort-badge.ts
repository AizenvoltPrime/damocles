/** The thinking levels pi runs at, one badge label each. Damocles' `ultracode` reaches pi as `max`. */
export const EFFORT_BADGE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type EffortBadgeLevel = (typeof EFFORT_BADGE_LEVELS)[number];

const LEVELS: ReadonlySet<string> = new Set(EFFORT_BADGE_LEVELS);

export function isEffortBadgeLevel(value: unknown): value is EffortBadgeLevel {
  return typeof value === 'string' && LEVELS.has(value);
}

/** The i18n key of a level's badge label. */
export function effortBadgeLabelKey(level: EffortBadgeLevel): string {
  return `effortBadge.level.${level}`;
}

/**
 * The effort to publish for a level pi ran at, or undefined. A model that does not reason
 * (`Model.reasoning` false or unknown) never gets a badge, whatever level pi reports for it.
 */
export function publishedEffort(level: unknown, modelReasons: boolean | undefined): EffortBadgeLevel | undefined {
  return modelReasons === true && isEffortBadgeLevel(level) ? level : undefined;
}

/** The effective effort of a live pi session: `thinkingLevel` is the level after pi clamps it to the model. */
export function sessionEffort(session: {
  readonly thinkingLevel: unknown;
  readonly model?: { readonly reasoning?: boolean } | undefined;
}): EffortBadgeLevel | undefined {
  return publishedEffort(session.thinkingLevel, session.model?.reasoning);
}
