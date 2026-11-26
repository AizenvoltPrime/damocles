import { describe, expect, it } from 'vitest';
import { compareVersions, isVersion } from '../semver';

describe('compareVersions', () => {
  it('orders by SemVer precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions('3.4.0', '3.4.0')).toBe(0);
    expect(compareVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBeGreaterThan(0);
  });

  it('throws on a string that is not a version', () => {
    expect(() => compareVersions('3.4', '3.4.0')).toThrow('Not a version: "3.4"');
    expect(() => compareVersions('3.4.0', '3.4.01')).toThrow('Not a version: "3.4.01"');
    for (const value of ['3.4', 'v3.4.0', '3.4.0 ', '3.4.0/../x', 'x'.repeat(65), 7, '03.4.0', '3.4.0-01', '3.4.0-a..b', '3.4.0+0123456789ab']) expect(isVersion(value), String(value)).toBe(false);
  });
});
