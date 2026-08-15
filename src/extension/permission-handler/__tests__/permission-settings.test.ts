import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

/** Captured so an unusable file can be proved to leave a trace, without quoting the file. */
const logMock = vi.hoisted(() => vi.fn());
vi.mock('../../logger', () => ({ log: logMock }));

const { tmpRoot } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpRoot: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-perm-settings-')) };
});

const home = path.join(tmpRoot, 'home');
const workspace = path.join(tmpRoot, 'workspace');

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

import { loadPermissionsByPriority } from '../permission-settings';

/** The eight read locations, most-specific first — mirrors the order under test. */
const ORDERED_FILES = [
  [workspace, '.damocles', 'settings.local.json'],
  [workspace, '.claude', 'settings.local.json'],
  [workspace, '.damocles', 'settings.json'],
  [workspace, '.claude', 'settings.json'],
  [home, '.damocles', 'settings.local.json'],
  [home, '.claude', 'settings.local.json'],
  [home, '.damocles', 'settings.json'],
  [home, '.claude', 'settings.json'],
] as const;

function writeSettings(segments: readonly string[], permissions: Record<string, string[]>): void {
  const filePath = path.join(...segments);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ permissions }), 'utf-8');
}

/** A rule naming its own file, so the returned order can be asserted exactly. */
const ruleFor = (index: number) => `Bash(file-${index}:*)`;

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  logMock.mockClear();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadPermissionsByPriority', () => {
  it('reads the eight paths in local > project > global order, .damocles before .claude in each tier', async () => {
    ORDERED_FILES.forEach((segments, index) => {
      writeSettings(segments, { allow: [ruleFor(index)] });
    });

    const result = await loadPermissionsByPriority(workspace);

    expect(result.map(perms => perms.allow[0])).toEqual(
      ORDERED_FILES.map((_, index) => ruleFor(index)),
    );
  });

  it('drops the four workspace paths when there is no workspace', async () => {
    ORDERED_FILES.forEach((segments, index) => {
      writeSettings(segments, { allow: [ruleFor(index)] });
    });

    const result = await loadPermissionsByPriority(null);

    expect(result.map(perms => perms.allow[0])).toEqual([
      ruleFor(4),
      ruleFor(5),
      ruleFor(6),
      ruleFor(7),
    ]);
  });

  it('does not let a file with no rules occupy a precedence slot and shadow a lower one', async () => {
    writeSettings(ORDERED_FILES[0], { allow: [], deny: [], ask: [] });
    writeSettings(ORDERED_FILES[2], { deny: ['Bash(git push:*)'] });

    const result = await loadPermissionsByPriority(workspace);

    expect(result).toHaveLength(1);
    expect(result[0]?.deny).toEqual(['Bash(git push:*)']);
  });
});

/** Write raw bytes, for the shapes `writeSettings` cannot express. */
function writeRaw(segments: readonly string[], content: string): void {
  const filePath = path.join(...segments);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('loadPermissionsByPriority — unusable files', () => {
  it('logs a malformed file instead of silently reading as empty', async () => {
    // This fails OPEN: every `deny` in the file vanishes and the agent proceeds to ask or allow. The
    // one signal the user gets must therefore not be nothing.
    writeRaw(ORDERED_FILES[0], '{ "permissions": { "deny": ["Bash(rm:*)"] }, }');
    writeSettings(ORDERED_FILES[2], { deny: ['Bash(git push:*)'] });

    const result = await loadPermissionsByPriority(workspace);

    expect(result).toHaveLength(1);
    expect(logMock.mock.calls.flat().join(' ')).toContain('is not valid JSON');
  });

  it('never puts the parser message in the log, which quotes the file', async () => {
    writeRaw(ORDERED_FILES[0], '{"permissions":{"deny":["Bash(rm:*)"],"note":sk-SUPERSECRET}}');

    await loadPermissionsByPriority(workspace);

    expect(logMock.mock.calls.flat().join(' ')).not.toContain('SUPERSECRET');
  });

  it('says nothing about a file that is simply absent', async () => {
    await loadPermissionsByPriority(workspace);

    expect(logMock.mock.calls.flat().join(' ')).not.toContain('could not be read');
  });

  it('treats a top-level null as no rules rather than throwing', async () => {
    // `JSON.parse("null")` succeeds, and indexing the result throws — which upstream used to strand
    // the tool call waiting on the approval that triggered the read.
    writeRaw(ORDERED_FILES[0], 'null');
    writeSettings(ORDERED_FILES[2], { allow: ['Bash(ls:*)'] });

    const result = await loadPermissionsByPriority(workspace);

    expect(result).toHaveLength(1);
    expect(result[0]?.allow).toEqual(['Bash(ls:*)']);
  });

  it('ignores a permissions block that is not an object, and non-array rule lists', async () => {
    writeRaw(ORDERED_FILES[0], JSON.stringify({ permissions: 'all' }));
    writeRaw(ORDERED_FILES[1], JSON.stringify({ permissions: { allow: 'Bash(ls:*)' } }));
    writeRaw(ORDERED_FILES[2], JSON.stringify({ note: 'no permissions key at all' }));
    writeSettings(ORDERED_FILES[3], { allow: ['Bash(ls:*)'] });

    const result = await loadPermissionsByPriority(workspace);

    expect(result).toHaveLength(1);
    expect(result[0]?.allow).toEqual(['Bash(ls:*)']);
  });
});
