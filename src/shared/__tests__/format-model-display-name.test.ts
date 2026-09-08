import { describe, expect, it } from 'vitest';
import { formatModelDisplayName } from '../utils';

/**
 * `ExploreCard.vue` renders whatever model id a persisted session carries, so the table below covers all
 * eleven `DEFAULT_MODELS` values. It also covers three id shapes that never appear in that list: the
 * legacy `claude-fable-5`, which an un-migrated Explore card still holds; the dated aliases Anthropic
 * publishes for every model, whose 8-digit date must not read as a minor version; and two `[1m]` suffixed
 * ids, which pi's catalog does not expose but `system-prompt.test.ts` feeds through the same shape, so
 * these rows pin that a bracketed suffix leaves the version parse alone.
 */

describe('formatModelDisplayName', () => {
  it.each([
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-fable-5-1[1m]', 'Fable 5.1'],
    ['claude-fable-5', 'Fable 5'],
    ['claude-opus-5', 'Opus 5'],
    ['claude-opus-5[1m]', 'Opus 5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-sonnet-5-1', 'Sonnet 5.1'],
    ['claude-opus-5-20260101', 'Opus 5'],
    ['claude-sonnet-5-20260101', 'Sonnet 5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['gpt-5.6-sol', '5.6 sol'],
    ['gpt-5.6-terra', '5.6 terra'],
    ['gpt-5.6-luna', '5.6 luna'],
    ['step-3.7-flash', '3.7 flash'],
    ['deepseek-v4-pro', 'v4 pro'],
    ['deepseek-v4-flash', 'v4 flash'],
  ])('renders %s as %s', (modelId, expected) => {
    expect(formatModelDisplayName(modelId)).toBe(expected);
  });

  it('returns null for a missing id', () => {
    expect(formatModelDisplayName(undefined)).toBeNull();
    expect(formatModelDisplayName('')).toBeNull();
  });
});
