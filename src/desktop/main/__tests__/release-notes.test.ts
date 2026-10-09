import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationService } from '../../../platform/notification-service';
import { announceInstalledVersion, compareVersions, isVersion, LAST_SEEN_VERSION_KEY, parseChangelog, ReleaseNotesSource, type InstalledVersionDeps } from '../release-notes';

const changelogUrl = new URL('../../../../CHANGELOG.md', import.meta.url);
const CHANGELOG = readFileSync(changelogUrl, 'utf8');
const VERSION = (JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('compareVersions', () => {
  it('orders by SemVer precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions('3.4.0', '3.4.0')).toBe(0);
  });

  it('throws on a string that is not a version', () => {
    expect(() => compareVersions('3.4', '3.4.0')).toThrow('Not a version: "3.4"');
    for (const value of ['3.4', 'v3.4.0', '3.4.0 ', '3.4.0/../x', 'x'.repeat(65), 7]) expect(isVersion(value)).toBe(false);
  });
});

describe('parseChangelog', () => {
  it('indexes every version heading of the real CHANGELOG.md, newest first, with the running version', () => {
    const headings = CHANGELOG.split('\n').filter((line) => /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\r?$/.test(line));
    const sections = parseChangelog(CHANGELOG);
    expect(headings.length).toBeGreaterThan(250);
    expect(sections).toHaveLength(headings.length);
    expect(new Set(sections.map((section) => section.version)).size).toBe(sections.length);
    for (let i = 0; i < sections.length - 1; i++) expect(compareVersions(sections[i]!.version, sections[i + 1]!.version)).toBeGreaterThan(0);
    const current = sections.find((section) => section.version === VERSION);
    expect(current).toBeDefined();
    expect(current!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(current!.markdown).toMatch(/^### /);
    expect(current!.markdown).not.toContain(`## [${VERSION}]`);
    expect(sections.every((section) => !/^## /m.test(section.markdown))).toBe(true);
  });

  it('orders versions by precedence, not by their place in the file', () => {
    const text = ['## [1.9.0] - 2026-01-01', '## [1.10.0] - 2026-01-03', '## [1.9.1] - 2026-01-02'].join('\n');
    expect(parseChangelog(text).map((section) => section.version)).toEqual(['1.10.0', '1.9.1', '1.9.0']);
  });

  it('skips a malformed heading and ends the section above it there', () => {
    const text = [
      '# Changelog',
      '',
      '## [1.2.0] - 2026-01-02',
      '### Added',
      '- two',
      '## [1.1] - 2026-01-01',
      '- lost',
      '## [1.0.0] - 2025-12-31',
      '- one',
      '## [Unreleased]',
      '- later',
      '## [1.0.0] - 2025-12-30',
      '- repeated',
      '## [0.9.0] - 2025-12-29',
    ].join('\r\n');
    expect(parseChangelog(text)).toEqual([
      { version: '1.2.0', date: '2026-01-02', markdown: '### Added\r\n- two' },
      { version: '1.0.0', date: '2025-12-31', markdown: '- one' },
      { version: '0.9.0', date: '2025-12-29', markdown: '' },
    ]);
  });
});

describe('ReleaseNotesSource', () => {
  it('serves the index and one version of the file, and refuses a version it does not hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn'));
    dirs.push(dir);
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, CHANGELOG);
    const source = new ReleaseNotesSource(file, VERSION, () => undefined);
    const index = await source.index();
    expect(index.current).toBe(VERSION);
    expect(index.versions[0]).toEqual({ version: parseChangelog(CHANGELOG)[0]!.version, date: expect.any(String) });
    expect(index.versions.some((entry) => entry.version === VERSION)).toBe(true);
    expect(await source.has(VERSION)).toBe(true);
    expect(await source.has('0.0.1-nope')).toBe(false);
    expect((await source.notes(VERSION)).markdown).toBe(parseChangelog(CHANGELOG).find((s) => s.version === VERSION)!.markdown);
    await expect(source.notes('0.0.1-nope')).rejects.toThrow('No release notes for "0.0.1-nope"');
  });

  it('reads the file again after a failed read, and logs the reason instead of sending its path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn'));
    dirs.push(dir);
    const file = join(dir, 'CHANGELOG.md');
    const lines: string[] = [];
    const source = new ReleaseNotesSource(file, VERSION, (line) => lines.push(line));
    const failure = await source.index().then(() => undefined, (err: unknown) => err as Error);
    expect(failure?.message).toBe('The release notes could not be read');
    expect(lines).toEqual([expect.stringMatching(/^\[release-notes\] could not read .*CHANGELOG\.md: .*ENOENT/)]);
    writeFileSync(file, CHANGELOG);
    expect((await source.index()).current).toBe(VERSION);
    expect(await source.has(VERSION)).toBe(true);
  });
});

describe('announceInstalledVersion', () => {
  function harness(lastSeen: unknown, version = '3.4.0', answer?: string): { deps: InstalledVersionDeps; stored: Map<string, unknown>; notices: string[][]; opened: string[] } {
    const stored = new Map<string, unknown>(lastSeen === undefined ? [] : [[LAST_SEEN_VERSION_KEY, lastSeen]]);
    const notices: string[][] = [];
    const opened: string[] = [];
    const notifications = {
      info: async (message: string, ...actions: string[]) => {
        notices.push([message, ...actions]);
        return answer;
      },
    } as unknown as NotificationService;
    return {
      stored,
      notices,
      opened,
      deps: {
        version,
        state: {
          get: ((key: string) => stored.get(key)) as InstalledVersionDeps['state']['get'],
          update: async (key, value) => {
            stored.set(key, value);
          },
        },
        notifications,
        t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])),
        openWhatsNew: (release) => opened.push(release),
        log: () => undefined,
      },
    };
  }

  it('posts one notice on the first launch of a higher version, and its action opens that version', async () => {
    const run = harness('3.3.9', '3.4.0', "See what's new");
    await announceInstalledVersion(run.deps);
    expect(run.notices).toEqual([['Damocles 3.4.0 is installed', "See what's new"]]);
    expect(run.opened).toEqual(['3.4.0']);
    expect(run.stored.get(LAST_SEEN_VERSION_KEY)).toBe('3.4.0');
    await announceInstalledVersion(run.deps);
    expect(run.notices).toHaveLength(1);
  });

  it('opens nothing when the notice is dismissed', async () => {
    const run = harness('3.3.9');
    await announceInstalledVersion(run.deps);
    expect(run.notices).toHaveLength(1);
    expect(run.opened).toEqual([]);
  });

  it.each([
    ['a first install', undefined],
    ['the same version', '3.4.0'],
    ['a downgrade', '3.10.0'],
    ['a later prerelease of the same core', '3.4.0-rc.1'],
    ['an unreadable record', 42],
  ])('posts nothing on %s and records the running version', async (_label, lastSeen) => {
    const run = harness(lastSeen, lastSeen === '3.4.0-rc.1' ? '3.4.0-beta.1' : '3.4.0');
    await announceInstalledVersion(run.deps);
    expect(run.notices).toEqual([]);
    expect(run.opened).toEqual([]);
    expect(run.stored.get(LAST_SEEN_VERSION_KEY)).toBe(lastSeen === '3.4.0-rc.1' ? '3.4.0-beta.1' : '3.4.0');
  });

  it('compares versions numerically, not as text', async () => {
    const run = harness('3.9.0', '3.10.0');
    await announceInstalledVersion(run.deps);
    expect(run.notices).toHaveLength(1);
  });

  it('has its strings in the English and Greek bundles', () => {
    for (const bundle of ['bundle.l10n.json', 'bundle.l10n.el.json']) {
      const table = JSON.parse(readFileSync(new URL(`../../../../l10n/${bundle}`, import.meta.url), 'utf8')) as Record<string, string>;
      for (const message of ['Damocles {0} is installed', "See what's new"]) expect(table[message], `${bundle}: ${message}`).toBeTruthy();
    }
  });
});
