import { describe, expect, it } from 'vitest';
import { appVersionOf, compareAppVersions, isAppVersion } from '../app-version';

describe('app versions', () => {
  // SemVer 2.0.0 section 11, plus the core numbers
  it('are ordered by SemVer precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareAppVersions(ordered[i]!, ordered[i + 1]!), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
      expect(compareAppVersions(ordered[i + 1]!, ordered[i]!), `${ordered[i + 1]} > ${ordered[i]}`).toBeGreaterThan(0);
    }
    for (const version of ordered) expect(compareAppVersions(version, version)).toBe(0);
  });

  it('put a numeric identifier below an alphanumeric one, and compare alphanumeric ones in ASCII order', () => {
    expect(compareAppVersions('1.0.0-1', '1.0.0-a')).toBeLessThan(0);
    expect(compareAppVersions('1.0.0-999', '1.0.0-0a')).toBeLessThan(0);
    expect(compareAppVersions('1.0.0-B', '1.0.0-a')).toBeLessThan(0);
    expect(compareAppVersions('1.0.0-a-b', '1.0.0-a.b')).toBeGreaterThan(0);
  });

  it('compare numbers beyond 2^53 exactly, in the core and in a prerelease, and go on past an equal identifier', () => {
    expect(compareAppVersions('9007199254740993.0.0', '9007199254740992.0.0')).toBeGreaterThan(0);
    expect(compareAppVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBeGreaterThan(0);
    expect(compareAppVersions('1.0.0-12345678901234567890.1', '1.0.0-12345678901234567890.2')).toBeLessThan(0);
  });

  it('are the SemVer 2.0.0 grammar without build metadata, at most 64 characters', () => {
    for (const version of ['0.0.0', '1.2.3', '1.0.0-0', '1.0.0-0a', '1.0.0-a-b', '1.0.0--', '1.0.0-x.7.z.92', '10.20.30-rc.1']) expect(isAppVersion(version), version).toBe(true);
    for (const version of [
      '', '1.2', '1.2.3.4', 'v1.2.3', ' 1.2.3', '1.2.3 ',
      '01.2.3', '1.02.3', '1.2.03', '1.0.0-01', '1.0.0-a.00',
      '1.0.0-', '1.0.0-.', '1.0.0-a..b', '1.0.0-a.', '1.0.0-.a', '1.0.0-a_b',
      '1.0.0+build', '1.0.0-rc.1+0123456789ab',
      `1.0.0-${'a'.repeat(59)}`,
      7, undefined,
    ]) expect(isAppVersion(version), String(version)).toBe(false);
    expect(isAppVersion(`1.0.0-${'a'.repeat(58)}`)).toBe(true);
  });

  it('are what a server version names before its build', () => {
    expect(appVersionOf('1.0.0-rc.1+0123456789ab')).toBe('1.0.0-rc.1');
    expect(appVersionOf('1.0.0')).toBe('1.0.0');
  });
});
