import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LEGACY_SUBSCRIPTION_REPOS,
  SUBSCRIPTION_SOURCE,
  classifySubscriptionSource,
  readClaudeAuthFromDisk,
} from '../subscription';

const repo = 'https://github.com/AizenvoltPrime/pi-anthropic-auth';
const legacyRepo = 'https://github.com/AizenvoltPrime/pi-anthropic-oauth';

/** pi keys git packages by repo identity, so the classifier is the only thing that spots an old pin or a replaced repo. */
describe('classifySubscriptionSource', () => {
  it('classifies the pinned source as current', () => {
    expect(classifySubscriptionSource(SUBSCRIPTION_SOURCE)).toBe('current');
  });

  it('classifies an older `@<sha>` pin of the current repo as stale', () => {
    expect(classifySubscriptionSource(`${repo}@15aef28a8a3090710b03a1435fe1385d3dd35f4e`)).toBe('stale');
  });

  it('classifies the `#<sha>` committish form as stale', () => {
    expect(classifySubscriptionSource(`${repo}#15aef28a8a3090710b03a1435fe1385d3dd35f4e`)).toBe('stale');
  });

  it('classifies an unpinned clone of the current repo as stale', () => {
    expect(classifySubscriptionSource(repo)).toBe('stale');
  });

  it('ignores unrelated packages', () => {
    expect(classifySubscriptionSource('https://github.com/someone/other-plugin@abc123')).toBe('unrelated');
  });

  it('ignores a sibling repo that merely shares the prefix', () => {
    expect(classifySubscriptionSource(`${repo}-experimental@abc123`)).toBe('unrelated');
  });

  it.each([
    ['the last legacy pin', `${legacyRepo}@8f82a2d207e12bfd313092d78333c594554f26fb`],
    ['the pre-0.86 legacy pin', `${legacyRepo}@96126a022ff30bd80fb94703ad76381edc130311`],
    ['a `#<sha>` legacy pin', `${legacyRepo}#8f82a2d207e12bfd313092d78333c594554f26fb`],
    ['an unpinned legacy clone', legacyRepo],
  ])('classifies %s as legacy', (_label, source) => {
    expect(classifySubscriptionSource(source)).toBe('legacy');
  });

  it('ignores a sibling of the legacy repo', () => {
    expect(classifySubscriptionSource(`${legacyRepo}-experimental@x`)).toBe('unrelated');
  });

  it('pins a repo that is not on the legacy list', () => {
    expect(LEGACY_SUBSCRIPTION_REPOS.some((legacy) => SUBSCRIPTION_SOURCE.startsWith(legacy))).toBe(false);
  });
});

describe('readClaudeAuthFromDisk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function agentDir(opts: { auth?: 'oauth' | 'api_key'; settings?: string }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-sub-'));
    dirs.push(dir);
    if (opts.auth) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ anthropic: { type: opts.auth } }));
    if (opts.settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), opts.settings);
    return dir;
  }
  const withPackages = (packages: unknown[]) => JSON.stringify({ packages });

  it.each([
    ['the current pin', [SUBSCRIPTION_SOURCE]],
    ['a stale pin', [`${repo}@abc`]],
    ['only a legacy pin', [`${legacyRepo}@8f82a2d207e12bfd313092d78333c594554f26fb`]],
    ['an object entry', [{ source: SUBSCRIPTION_SOURCE }]],
  ])('reads allowance for oauth plus %s', (_label, packages) => {
    expect(readClaudeAuthFromDisk(agentDir({ auth: 'oauth', settings: withPackages(packages) })).mode).toBe('allowance');
  });

  it('reads extra usage when only a sibling-prefix package is listed', () => {
    const settings = withPackages([`${legacyRepo}-experimental@x`, `${repo}-experimental@x`]);
    expect(readClaudeAuthFromDisk(agentDir({ auth: 'oauth', settings })).mode).toBe('extra');
  });

  it('reads extra usage with no settings file', () => {
    expect(readClaudeAuthFromDisk(agentDir({ auth: 'oauth' })).mode).toBe('extra');
  });

  it('reads extra usage with a malformed settings file', () => {
    expect(readClaudeAuthFromDisk(agentDir({ auth: 'oauth', settings: '{ "packages": [' })).mode).toBe('extra');
  });

  it('reads apikey for an api_key credential', () => {
    expect(readClaudeAuthFromDisk(agentDir({ auth: 'api_key', settings: withPackages([SUBSCRIPTION_SOURCE]) })).mode).toBe('apikey');
  });

  it('reads none with no auth.json', () => {
    expect(readClaudeAuthFromDisk(agentDir({})).mode).toBe('none');
  });
});
