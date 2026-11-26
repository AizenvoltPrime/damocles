import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { desktopTarget, fileSeconds, parseShard, planShards, specFiles, testList, type Report } from '../e2e-shards.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const spec = (file: string, durations: readonly number[][]): NonNullable<Report['suites'][number]['specs']>[number] => ({
  file,
  tests: durations.map((attempts) => ({ results: attempts.map((duration) => ({ duration })) })),
});

describe('the desktop suite\'s shards', () => {
  // count-based splitting put every slow design spec into one mac shard, which outran the 45-minute limit
  it('spreads the slow files across shards by their recorded seconds, so each shard\'s time is about equal', () => {
    const files = [
      { file: 'design-a.spec.ts', tests: 3 }, { file: 'design-b.spec.ts', tests: 3 }, { file: 'design-c.spec.ts', tests: 3 },
      { file: 'about.spec.ts', tests: 10 }, { file: 'chat.spec.ts', tests: 10 }, { file: 'tabs.spec.ts', tests: 10 },
    ];
    const seconds = { 'design-a.spec.ts': 300, 'design-b.spec.ts': 280, 'design-c.spec.ts': 260, 'about.spec.ts': 100, 'chat.spec.ts': 90, 'tabs.spec.ts': 80 };
    const shards = planShards(files, seconds, 3);
    expect(shards).toEqual([['design-a.spec.ts', 'tabs.spec.ts'], ['chat.spec.ts', 'design-b.spec.ts'], ['about.spec.ts', 'design-c.spec.ts']]);
    expect(shards.flat().sort()).toEqual(files.map((file) => file.file).sort());
  });

  it('counts a file with no recorded time at the median seconds per test, and every test as one second when nothing is recorded', () => {
    const files = [{ file: 'a.spec.ts', tests: 2 }, { file: 'b.spec.ts', tests: 4 }, { file: 'new.spec.ts', tests: 10 }];
    // a: 50 s a test, b: 10 s a test, so new.spec.ts counts 10 x 50 = 500 s on its own shard
    expect(planShards(files, { 'a.spec.ts': 100, 'b.spec.ts': 40 }, 2)).toEqual([['new.spec.ts'], ['a.spec.ts', 'b.spec.ts']]);
    expect(planShards(files, {}, 2)).toEqual([['new.spec.ts'], ['a.spec.ts', 'b.spec.ts']]);
  });

  it('reads each file\'s tests from a report or listing, and the seconds of every attempt, retries included', () => {
    const report: Report = { suites: [{ specs: [spec('a.spec.ts', [[1000, 500]])], suites: [{ specs: [spec('a.spec.ts', [[2000]]), spec('b.spec.ts', [[250]])] }] }] };
    expect(specFiles(report)).toEqual([{ file: 'a.spec.ts', tests: 2 }, { file: 'b.spec.ts', tests: 1 }]);
    expect(fileSeconds(report)).toEqual({ 'a.spec.ts': 3.5, 'b.spec.ts': 0.25 });
  });

  // a shard that hit globalTimeout reports its unstarted tests with no result and its last one interrupted; recording those
  // files as near 0 s would pile them onto one shard in the next plan
  it('records no time for a file with a test that never started or was cut short', () => {
    const interrupted = { file: 'c.spec.ts', tests: [{ results: [{ duration: 9000, status: 'interrupted' }] }] };
    const report: Report = { suites: [{ specs: [spec('a.spec.ts', [[1000]]), spec('b.spec.ts', [[1000], []]), interrupted] }] };
    expect(fileSeconds(report)).toEqual({ 'a.spec.ts': 1 });
  });

  it('takes a shard as <current>/<total> within its total, and a target the release builds', () => {
    expect(parseShard('2/7')).toEqual({ current: 2, total: 7 });
    for (const bad of ['0/7', '8/7', '7', undefined]) expect(() => parseShard(bad)).toThrow('--shard takes');
    expect(desktopTarget('mac-arm64')).toBe('mac-arm64');
    for (const bad of ['macos-arm64', 'toString', undefined]) expect(() => desktopTarget(bad)).toThrow('--target takes a desktop target');
  });

  it('refuses more shards than spec files, since an empty test list runs nothing and passes', () => {
    expect(() => planShards([{ file: 'a.spec.ts', tests: 3 }], {}, 2)).toThrow('2 shards for 1 spec files would leave a shard with no tests');
  });

  // the plan hands Playwright whole files of the dev project; titles cannot be listed, since a describe title holds "›"
  it('writes a test list Playwright runs exactly the named files of the dev project from', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'damocles-shards-'));
    try {
      const list = join(dir, 'tests.txt');
      writeFileSync(list, testList(['about.spec.ts']));
      // with this set, the json reporter writes to that file instead of stdout
      const { PLAYWRIGHT_JSON_OUTPUT_FILE: _, ...env } = process.env;
      const listed = spawnSync(process.execPath, [join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config', 'playwright.desktop.config.ts', '--project=dev', '--list', '--reporter=json', `--test-list=${list}`], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      expect(listed.status, listed.stderr).toBe(0);
      const files = specFiles(JSON.parse(listed.stdout) as Report);
      expect(files.map((file) => file.file)).toEqual(['about.spec.ts']);
      expect(files[0]!.tests).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
