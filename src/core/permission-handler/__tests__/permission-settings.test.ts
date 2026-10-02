import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

/** Captured so an unusable file can be proved to leave a trace, without quoting the file. */
const logMock = vi.hoisted(() => vi.fn());
vi.mock('../../logger', () => ({ log: logMock }));

const { tmpRoot, home } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-perm-settings-'));
  return { tmpRoot: root, home: nodePath.join(root, 'home') };
});
const workspace = path.join(tmpRoot, 'workspace');

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

import ignore from 'ignore';
import { loadPermissionsByPriority, usableGitignorePattern } from '../permission-settings';
import { PermissionHandler } from '../index';
import { createFakePlatform } from '../../../__mocks__/fake-platform';

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

  it('carries the folder a /path rule in each file is relative to: the project, or the home file\'s own folder', async () => {
    ORDERED_FILES.forEach((segments, index) => {
      writeSettings(segments, { allow: [ruleFor(index)] });
    });

    const result = await loadPermissionsByPriority(workspace);

    expect(result.map((perms) => perms.root)).toEqual([
      workspace, workspace, workspace, workspace,
      path.join(home, '.damocles'), path.join(home, '.claude'), path.join(home, '.damocles'), path.join(home, '.claude'),
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

  it('reads a file that starts with a byte order mark, as the settings store does', async () => {
    writeRaw(ORDERED_FILES[0], `\uFEFF${JSON.stringify({ permissions: { deny: ['Read(secret.txt)'] } })}`);

    const result = await loadPermissionsByPriority(workspace);

    expect(result[0]?.deny).toEqual(['Read(secret.txt)']);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('drops a rule that is not a string and logs its file and index, never its value', async () => {
    writeRaw(ORDERED_FILES[0], JSON.stringify({ permissions: { deny: [987654321, 'Read(secret.txt)', { tool: 'Bash-SECRET' }], ask: 'Read(SECRET-STRING)' } }));

    const result = await loadPermissionsByPriority(workspace);

    expect(result).toHaveLength(1);
    expect(result[0]?.deny).toEqual(['Read(secret.txt)']);
    expect(result[0]?.ask).toEqual([]);
    const logged = logMock.mock.calls.flat().join('\n');
    const file = path.join(...ORDERED_FILES[0]);
    expect(logged).toContain(`${file} permissions.deny[0] is not a string`);
    expect(logged).toContain(`${file} permissions.deny[2] is not a string`);
    expect(logged).toContain(`${file} permissions.ask is not a list`);
    expect(logged).not.toContain('987654321');
    expect(logged).not.toContain('SECRET');
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

  it('reads a pattern as unusable exactly when node-ignore compiles no rule that can match', () => {
    for (const pattern of ['', '   ', '#x', 'x\\', 'x\\\\\\', 'x\\/', 'a[', 'a[]', 'a[\\]', '[[:nosuch:]]', '[[:alpha:]', 'a[b-'])
      expect(usableGitignorePattern(pattern), JSON.stringify(pattern)).toBe(false);
    for (const pattern of ['x', '\\#x', 'x\\\\', 'a[]]', '[!a]', '[^a]', '[a-\\]]', '[[:alpha:]]', '[[:x]', '[c-a]', '/', 'a]'])
      expect(usableGitignorePattern(pattern), JSON.stringify(pattern)).toBe(true);
    for (const pattern of ['a[', '[[:nosuch:]]', '#x', 'a[]]', '[[:x]', 'x']) {
      const compiled = (ignore().add([pattern]) as unknown as { _rules: { _rules: Array<{ regex: RegExp }> } })._rules._rules;
      expect(compiled.length > 0 && !compiled[0]!.regex.source.includes('[]'), JSON.stringify(pattern)).toBe(usableGitignorePattern(pattern));
    }
  });

  it('drops an allow rule that can approve nothing and logs its file and index, never its value', async () => {
    const inert = ['*', 'B*', 'mcp__*', 'mcp__git*__get_x', 'Edit(!secret-a/**)', 'Read(#secret-b)', 'Write(secret-c/**)'];
    writeSettings(ORDERED_FILES[0], { allow: [...inert, 'mcp__github__get_*', 'Edit(src/**)', 'Write'], deny: inert, ask: inert });

    const result = await loadPermissionsByPriority(workspace);

    expect(result[0]?.allow).toEqual(['mcp__github__get_*', 'Edit(src/**)', 'Write']);
    expect(result[0]?.deny).toEqual(inert);
    expect(result[0]?.ask).toEqual(inert);
    const logged = logMock.mock.calls.flat().join('\n');
    const file = path.join(...ORDERED_FILES[0]);
    for (const index of [0, 1, 2, 3]) expect(logged).toContain(`${file} permissions.allow[${index}] has a tool-name wildcard`);
    expect(logged).toContain(`${file} permissions.allow[4] is a ! carve-out`);
    expect(logged).toContain(`${file} permissions.allow[5] has a path that is not a usable gitignore pattern`);
    expect(logged).toContain(`${file} permissions.allow[6] is a Write path rule`);
    expect(logged).not.toContain('secret');
    expect(logMock).toHaveBeenCalledTimes(7);
  });
});

/**
 * Each panel's handler reads the project rules of that panel's folder. `folderB` sits next to the
 * main workspace, the way a second root of a multi-root window does.
 */
describe('PermissionHandler follows the panel folder', () => {
  const folderB = path.join(tmpRoot, 'folder-b');
  const npmTest = { command: 'npm test' };

  function makeHandler(): PermissionHandler {
    return new PermissionHandler(createFakePlatform());
  }

  beforeEach(() => {
    fs.rmSync(folderB, { recursive: true, force: true });
    writeSettings([folderB, '.damocles', 'settings.json'], { allow: ['Bash(npm test)'] });
  });

  it("allows B's rule in a panel on B and asks in a panel on the other folder", async () => {
    const onB = makeHandler();
    const onA = makeHandler();
    onB.setWorkspacePath(folderB);
    onA.setWorkspacePath(workspace);

    expect(await onB.evaluatePermission('Bash', npmTest)).toBe('allow');
    expect(await onA.evaluatePermission('Bash', npmTest)).toBe('ask');
  });

  it('drops the previous folder\'s rules as soon as the panel moves', async () => {
    const handler = makeHandler();
    handler.setWorkspacePath(folderB);
    expect(await handler.evaluatePermission('Bash', npmTest)).toBe('allow');

    handler.setWorkspacePath(workspace);
    expect(await handler.evaluatePermission('Bash', npmTest)).toBe('ask');

    handler.setWorkspacePath(null);
    expect(await handler.evaluatePermission('Bash', npmTest)).toBe('ask');
  });
});
