import { describe, expect, it } from 'vitest';
import { isFeatureName, MAX_FEATURES } from '../handshake';
import { FEATURES } from '../protocol-version';

// the welcome and an app's core attach both carry FEATURES, and each parser refuses a list past MAX_FEATURES or a bad name
describe('FEATURES', () => {
  it('names each capability once, in a form the handshake parser accepts', () => {
    expect(FEATURES.filter((name, index) => FEATURES.indexOf(name) !== index)).toEqual([]);
    expect(FEATURES.filter((name) => !isFeatureName(name))).toEqual([]);
  });

  it('fits the welcome and the core attach', () => {
    expect(FEATURES.length).toBeLessThanOrEqual(MAX_FEATURES);
  });
});
