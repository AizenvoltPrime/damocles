import { describe, it, expect } from 'vitest';
import { SUBSCRIPTION_SOURCE, isStaleSubscriptionPin } from '../subscription';

/**
 * Guards the plugin re-pin migration. pi keys git packages by a ref-agnostic identity, so a
 * `settings.json` entry left at an older committish is invisible to every "is it installed?" check;
 * this predicate is the only thing that spots it.
 */
describe('isStaleSubscriptionPin', () => {
  const repo = 'https://github.com/AizenvoltPrime/pi-anthropic-oauth';

  it('ignores the currently pinned source', () => {
    expect(isStaleSubscriptionPin(SUBSCRIPTION_SOURCE)).toBe(false);
  });

  it('flags an older `@<sha>` pin', () => {
    expect(isStaleSubscriptionPin(`${repo}@15aef28a8a3090710b03a1435fe1385d3dd35f4e`)).toBe(true);
  });

  it('flags the legacy `#<sha>` committish form', () => {
    expect(isStaleSubscriptionPin(`${repo}#15aef28a8a3090710b03a1435fe1385d3dd35f4e`)).toBe(true);
  });

  it('flags an unpinned clone of the same repo', () => {
    expect(isStaleSubscriptionPin(repo)).toBe(true);
  });

  it('ignores unrelated packages', () => {
    expect(isStaleSubscriptionPin('https://github.com/someone/other-plugin@abc123')).toBe(false);
  });

  it('ignores a sibling repo that merely shares the prefix', () => {
    expect(isStaleSubscriptionPin(`${repo}-experimental@abc123`)).toBe(false);
  });
});
