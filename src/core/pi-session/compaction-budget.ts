import type { AutoCompactConfig } from "../../shared/types/settings";

export interface CompactionBudget {
  /** The effective trigger percent for this model: the per-model override, else the plain value. */
  triggerPercent: number;
  /** pi auto-compacts when contextTokens > contextWindow - reserveTokens. */
  reserveTokens: number;
  /** Present only when the model override sets `keepRecentPercent`; pi keeps its own default when absent. */
  keepRecentTokens?: number;
}

/** The `damocles.autoCompact.triggerPercent` contribution default, used when the configured value is
 *  unusable. Must equal the `default` in package.json. */
const DEFAULT_TRIGGER_PERCENT = 80;

// Bounds of the package.json contribution. VS Code applies `minimum`/`maximum` only to the editor's
// JSON hints, and it validates nothing inside a `type: object` setting, so a settings file can hand any
// value at all to `getConfiguration().get()`.
const MIN_TRIGGER_PERCENT = 50;
const MAX_TRIGGER_PERCENT = 95;
const MIN_KEEP_RECENT_PERCENT = 1;
const MAX_KEEP_RECENT_PERCENT = 50;

/** Clamp a settings percentage into [min, max], or `null` when it is not a usable number. NaN and
 *  Infinity pass a `typeof === "number"` test, so the finiteness check carries the guard. */
function clampPercent(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

/** `modelValue` is an exact `DEFAULT_MODELS[].value`. Damocles keys its own override map by that value
 *  and translates to pi's token counts here rather than writing pi's `compaction.modelOverrides`
 *  (keyed by `"provider/modelId"`), which would outrank the `reserveTokens` re-asserted every turn.
 *
 *  This is also where the untrusted settings object becomes numbers pi accepts: pi's
 *  `getCompactionTokenSetting` throws for anything that is not a non-negative safe integer, and it
 *  throws inside the per-turn compaction read, so an unclamped value breaks every turn rather than one. */
export function resolveCompactionBudget(
  cfg: AutoCompactConfig,
  modelValue: string,
  contextWindow: number,
): CompactionBudget {
  const entry = cfg.modelOverrides?.[modelValue];
  const triggerPercent =
    clampPercent(entry?.triggerPercent, MIN_TRIGGER_PERCENT, MAX_TRIGGER_PERCENT) ??
    clampPercent(cfg.triggerPercent, MIN_TRIGGER_PERCENT, MAX_TRIGGER_PERCENT) ??
    DEFAULT_TRIGGER_PERCENT;
  const reserveTokens = Math.max(1, Math.round(contextWindow * (1 - triggerPercent / 100)));

  const keepRecentPercent = clampPercent(entry?.keepRecentPercent, MIN_KEEP_RECENT_PERCENT, MAX_KEEP_RECENT_PERCENT);
  if (keepRecentPercent === null) return { triggerPercent, reserveTokens };
  return {
    triggerPercent,
    reserveTokens,
    // Keeping as much as the threshold it just crossed would re-trigger compaction on the next turn, so
    // the kept slice must stay strictly below the post-compaction budget.
    keepRecentTokens: Math.max(
      1,
      Math.min(Math.round((contextWindow * keepRecentPercent) / 100), contextWindow - reserveTokens - 1),
    ),
  };
}
