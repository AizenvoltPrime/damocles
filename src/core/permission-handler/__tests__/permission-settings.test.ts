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

// A file's injected check failure: an error the network-rule check rejects with, or its refusal of a link onto a share.
const checkFailures = vi.hoisted(() => new Map<string, Error | 'refused'>());
vi.mock('../../config/local-config-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/local-config-path')>();
  return {
    ...actual,
    checkConfigPath: async (baseFolder: string, file: string) => {
      const failure = checkFailures.get(file);
      if (failure === 'refused') return { refused: 'share' };
      if (failure !== undefined) throw failure;
      return actual.checkConfigPath(baseFolder, file);
    },
  };
});

import ignore from 'ignore';
import { loadPermissionsByPriority, usableGitignorePattern, type FilePermissions, type RuleFileRecords } from '../permission-settings';
import { PermissionHandler } from '../index';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { getPiCodingAgent } from '../../pi-session/pi-loader';
import { englishText } from '../../../shared/localized-text';

/** The rules a first read in a fresh session gives, which must not be the unreadable outcome. */
async function filesOf(folder: { path: string; personalFiles: boolean } | null): Promise<FilePermissions[]> {
  const loaded = await loadPermissionsByPriority(folder, new Map());
  if (!('files' in loaded)) throw new Error('the rules were unreadable');
  return loaded.files;
}

const errno = (code: string): Error => Object.assign(new Error(code), { code });

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
  checkFailures.clear();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadPermissionsByPriority', () => {
  it('reads the eight paths in local > project > global order, .damocles before .claude in each tier', async () => {
    ORDERED_FILES.forEach((segments, index) => {
      writeSettings(segments, { allow: [ruleFor(index)] });
    });

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result.map(perms => perms.allow[0])).toEqual(
      ORDERED_FILES.map((_, index) => ruleFor(index)),
    );
  });

  it('drops the four workspace paths when there is no workspace', async () => {
    ORDERED_FILES.forEach((segments, index) => {
      writeSettings(segments, { allow: [ruleFor(index)] });
    });

    const result = await filesOf(null);

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

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result.map((perms) => perms.root)).toEqual([
      workspace, workspace, workspace, workspace,
      path.join(home, '.damocles'), path.join(home, '.claude'), path.join(home, '.damocles'), path.join(home, '.claude'),
    ]);
  });

  it('does not let a file with no rules occupy a precedence slot and shadow a lower one', async () => {
    writeSettings(ORDERED_FILES[0], { allow: [], deny: [], ask: [] });
    writeSettings(ORDERED_FILES[2], { deny: ['Bash(git push:*)'] });

    const result = await filesOf({ path: workspace, personalFiles: true });

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

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result).toHaveLength(1);
    expect(logMock.mock.calls.flat().join(' ')).toContain('is not valid JSON');
  });

  it('never puts the parser message in the log, which quotes the file', async () => {
    writeRaw(ORDERED_FILES[0], '{"permissions":{"deny":["Bash(rm:*)"],"note":sk-SUPERSECRET}}');

    await filesOf({ path: workspace, personalFiles: true });

    expect(logMock.mock.calls.flat().join(' ')).not.toContain('SUPERSECRET');
  });

  it('says nothing about a file that is simply absent', async () => {
    await filesOf({ path: workspace, personalFiles: true });

    expect(logMock.mock.calls.flat().join(' ')).not.toContain('could not be read');
  });

  it('treats a top-level null as no rules rather than throwing', async () => {
    // `JSON.parse("null")` succeeds, and indexing the result throws — which upstream used to strand
    // the tool call waiting on the approval that triggered the read.
    writeRaw(ORDERED_FILES[0], 'null');
    writeSettings(ORDERED_FILES[2], { allow: ['Bash(ls:*)'] });

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result).toHaveLength(1);
    expect(result[0]?.allow).toEqual(['Bash(ls:*)']);
  });

  it('reads a file that starts with a byte order mark, as the settings store does', async () => {
    writeRaw(ORDERED_FILES[0], `\uFEFF${JSON.stringify({ permissions: { deny: ['Read(secret.txt)'] } })}`);

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result[0]?.deny).toEqual(['Read(secret.txt)']);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('drops a rule that is not a string and logs its file and index, never its value', async () => {
    writeRaw(ORDERED_FILES[0], JSON.stringify({ permissions: { deny: [987654321, 'Read(secret.txt)', { tool: 'Bash-SECRET' }], ask: 'Read(SECRET-STRING)' } }));

    const result = await filesOf({ path: workspace, personalFiles: true });

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

    const result = await filesOf({ path: workspace, personalFiles: true });

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
    const inert = ['*', 'B*', 'mcp__*', 'mcp__git*__get_x', 'Edit(!secret-a/**)', 'Read(#secret-b)', 'Write(secret-c/**)', 'WebFetch(secret-d.com)', 'WebFetch(domain:*.secret-e.com)'];
    writeSettings(ORDERED_FILES[0], { allow: [...inert, 'mcp__github__get_*', 'Edit(src/**)', 'Write', 'WebFetch(domain:example.com)'], deny: inert, ask: inert });

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result[0]?.allow).toEqual(['mcp__github__get_*', 'Edit(src/**)', 'Write', 'WebFetch(domain:example.com)']);
    expect(result[0]?.deny).toEqual(inert);
    expect(result[0]?.ask).toEqual(inert);
    const logged = logMock.mock.calls.flat().join('\n');
    const file = path.join(...ORDERED_FILES[0]);
    for (const index of [0, 1, 2, 3]) expect(logged).toContain(`${file} permissions.allow[${index}] has a tool-name wildcard`);
    expect(logged).toContain(`${file} permissions.allow[4] is a ! carve-out`);
    expect(logged).toContain(`${file} permissions.allow[5] has a path that is not a usable gitignore pattern`);
    expect(logged).toContain(`${file} permissions.allow[6] is a Write path rule`);
    expect(logged).toContain(`${file} permissions.allow[7] is a WebFetch rule whose specifier is not domain:<host>`);
    expect(logged).toContain(`${file} permissions.allow[8] is a WebFetch domain rule that names no plain host`);
    expect(logged).not.toContain('secret');
    expect(logMock).toHaveBeenCalledTimes(9);
  });

  it('keeps a URI-scoped MCP resource rule in every list exactly as written', async () => {
    const rules = [
      'mcp__secret__read_mcp_resource(secret://passwords)',
      'mcp__docs__read_mcp_resource(repo://docs/*)',
      'mcp__docs__read_mcp_resource(file:///a (copy)/b))',
      'mcp__my.srv__read_mcp_resource(x://#a!b*)',
    ];
    writeSettings(ORDERED_FILES[0], { allow: rules, deny: rules, ask: rules });

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result[0]).toMatchObject({ allow: rules, deny: rules, ask: rules });
    expect(logMock).not.toHaveBeenCalled();
  });

  // A deny or ask that silently matches nothing fails open, so the user needs a signal.
  it('drops a deny or ask MCP rule whose parentheses no tool takes and logs its file and index, never its value', async () => {
    const inert = ['mcp__*__read_mcp_resource(file:///secret/*)', 'mcp__srv__get_secret(x)', 'mcp__srv__read_mcp_resource()', 'mcp__srv(secret)'];
    const live = ['mcp__srv__read_mcp_resource(file:///secret/*)', `${'mcp__' + 's'.repeat(50)}_0123abcd(x://secret)`, 'mcp__srv__*'];
    writeSettings(ORDERED_FILES[0], { deny: [...inert, ...live], ask: inert });

    const result = await filesOf({ path: workspace, personalFiles: true });

    expect(result[0]).toMatchObject({ deny: live, ask: [] });
    const logged = logMock.mock.calls.flat().join('\n');
    const file = path.join(...ORDERED_FILES[0]);
    expect(logged).toContain(`${file} permissions.deny[0] has a wildcard in its tool name`);
    for (const index of [1, 3]) expect(logged).toContain(`${file} permissions.deny[${index}] names a tool other than read_mcp_resource`);
    expect(logged).toContain(`${file} permissions.deny[2] is not an mcp__<server>__read_mcp_resource(<uri pattern>) rule`);
    for (const index of [0, 1, 2, 3]) expect(logged).toContain(`${file} permissions.ask[${index}]`);
    expect(logged).not.toContain('secret');
    expect(logMock).toHaveBeenCalledTimes(8);
  });
});

describe('loadPermissionsByPriority — a rules file that cannot be checked or read', () => {
  const subject = ORDERED_FILES[2];
  const file = path.join(...subject);
  const trusted = { path: workspace, personalFiles: true };
  const notices = (notifications: ReturnType<typeof createFakePlatform>['notifications']) => notifications.calls.map((call) => call.message);

  async function load(records: RuleFileRecords, notifications = createFakePlatform().notifications) {
    return loadPermissionsByPriority(trusted, records, undefined, notifications);
  }

  it('keeps the rules it last read after a timeout, with one notice across repeated reads', async () => {
    writeSettings(subject, { deny: ['Bash(rm:*)'], ask: ['Read(.env)'] });
    const records: RuleFileRecords = new Map();
    const { notifications } = createFakePlatform();
    expect(await load(records, notifications)).toMatchObject({ files: [{ deny: ['Bash(rm:*)'], ask: ['Read(.env)'] }] });

    checkFailures.set(file, errno('ETIMEDOUT'));
    for (let read = 0; read < 3; read++) {
      expect(await load(records, notifications)).toMatchObject({ files: [{ deny: ['Bash(rm:*)'], ask: ['Read(.env)'] }] });
    }

    expect(notices(notifications)).toHaveLength(1);
    expect(notices(notifications)[0]).toContain(file);
    expect(notices(notifications)[0]).toContain('did not answer');
    expect(notices(notifications)[0]).toContain('keeps the rules it last read');
    expect(logMock.mock.calls.flat().join(' ')).toContain(`${file} could not be read`);
  });

  it('cannot tell which rules apply when the file was never read, and says so once', async () => {
    writeSettings(subject, { deny: ['Bash(rm:*)'] });
    writeSettings(ORDERED_FILES[6], { allow: ['Read'] });
    checkFailures.set(file, errno('ETIMEDOUT'));
    const records: RuleFileRecords = new Map();
    const { notifications } = createFakePlatform();

    const first = await load(records, notifications);
    const second = await load(records, notifications);

    for (const loaded of [first, second]) {
      expect(loaded).not.toHaveProperty('files');
      if (!('unreadable' in loaded)) throw new Error('expected the unreadable outcome');
      expect(loaded.unreadable.file).toBe(file);
      expect(englishText(loaded.unreadable.reason)).toContain('did not answer');
    }
    expect(notices(notifications)).toHaveLength(1);
    expect(notices(notifications)[0]).toContain(file);
    expect(notices(notifications)[0]).toContain('blocks every tool call');
  });

  it('reads the file again once it answers, and a new failure gives a new notice', async () => {
    writeSettings(subject, { deny: ['Bash(rm:*)'] });
    const records: RuleFileRecords = new Map();
    const { notifications } = createFakePlatform();
    checkFailures.set(file, errno('ETIMEDOUT'));
    expect(await load(records, notifications)).toHaveProperty('unreadable');

    checkFailures.delete(file);
    writeSettings(subject, { deny: ['Bash(git push:*)'] });
    expect(await load(records, notifications)).toMatchObject({ files: [{ deny: ['Bash(git push:*)'] }] });

    checkFailures.set(file, errno('ETIMEDOUT'));
    expect(await load(records, notifications)).toMatchObject({ files: [{ deny: ['Bash(git push:*)'] }] });
    expect(notices(notifications)).toHaveLength(2);
    expect(notices(notifications)[1]).toContain('keeps the rules it last read');
  });

  it('reads a missing file, or one below a folder that is a file, as no rules with no notice', async () => {
    writeRaw([workspace, '.claude'], 'not a folder');
    const records: RuleFileRecords = new Map();
    const { notifications } = createFakePlatform();

    expect(await load(records, notifications)).toEqual({ files: [] });
    expect(notices(notifications)).toEqual([]);
    expect(logMock.mock.calls.flat().join(' ')).not.toContain('could not be read');
  });

  it('keeps no rules after a timeout when the file was missing at its last read', async () => {
    const records: RuleFileRecords = new Map();
    expect(await load(records)).toEqual({ files: [] });

    checkFailures.set(file, errno('ETIMEDOUT'));
    expect(await load(records)).toEqual({ files: [] });
  });

  it('takes a loop and a refused link onto a share as unreadable', async () => {
    writeSettings(subject, { deny: ['Bash(rm:*)'] });
    for (const [failure, reason] of [[errno('ELOOP'), 'loops'], ['refused', 'network share or WSL path']] as const) {
      checkFailures.set(file, failure);
      const loaded = await load(new Map());
      if (!('unreadable' in loaded)) throw new Error('expected the unreadable outcome');
      expect(loaded.unreadable.file).toBe(file);
      expect(englishText(loaded.unreadable.reason)).toContain(reason);
    }
  });

  it('anchors the last good rules at this load\'s folder, as a worktree chat shares its project\'s personal file', async () => {
    writeSettings(subject, { deny: ['Read(/secrets/**)'] });
    const records: RuleFileRecords = new Map();
    await load(records);
    for (const [key, record] of records) records.set(key, { ...record, lastGood: record.lastGood && { ...record.lastGood, root: path.join(tmpRoot, 'other-folder') } });

    checkFailures.set(file, errno('ETIMEDOUT'));
    expect(await load(records)).toMatchObject({ files: [{ deny: ['Read(/secrets/**)'], root: workspace }] });
  });

  it('takes a read that fails with ENOTDIR as a missing file', async () => {
    writeSettings(subject, { deny: ['Bash(rm:*)'] });
    const readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (target) => {
      if (String(target) === file) throw errno('ENOTDIR');
      throw errno('ENOENT');
    });
    try {
      expect(await load(new Map())).toEqual({ files: [] });
    } finally {
      readFile.mockRestore();
    }
  });

  it('takes a read that fails with EACCES as unreadable', async () => {
    writeSettings(subject, { deny: ['Bash(rm:*)'] });
    const readFile = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (target) => {
      if (String(target) === file) throw errno('EACCES');
      return '{}';
    });
    try {
      const loaded = await load(new Map());
      if (!('unreadable' in loaded)) throw new Error('expected the unreadable outcome');
      expect(englishText(loaded.unreadable.reason)).toContain('EACCES');
    } finally {
      readFile.mockRestore();
    }
  });

  it('reads a file that does not parse as no rules and no block, as its last good rules', async () => {
    writeSettings(subject, { deny: ['Bash(rm:*)'] });
    const records: RuleFileRecords = new Map();
    expect(await load(records)).toMatchObject({ files: [{ deny: ['Bash(rm:*)'] }] });

    writeRaw(subject, '{ "permissions": { "deny": ["Bash(rm:*)"] }, }');
    expect(await load(records)).toEqual({ files: [] });

    checkFailures.set(file, errno('ETIMEDOUT'));
    expect(await load(records)).toEqual({ files: [] });
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
    return new PermissionHandler(createFakePlatform(), getPiCodingAgent);
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

  it("filters MCP resource lists by the panel folder's rules", async () => {
    writeSettings([folderB, '.damocles', 'settings.json'], { deny: ['mcp__secret', 'mcp__docs__read_mcp_resource(docs://x)'] });
    const handler = makeHandler();
    handler.setWorkspacePath(folderB);
    const onB = await handler.mcpResourceRuleFilter('list_mcp_resources');
    expect(onB.serverCovered('secret')).toBe(true);
    expect(onB.resourceDenied('docs', 'docs://x')).toBe(true);

    handler.setWorkspacePath(workspace);
    const onA = await handler.mcpResourceRuleFilter('list_mcp_resources');
    expect(onA.serverCovered('secret')).toBe(false);
    expect(onA.resourceDenied('docs', 'docs://x')).toBe(false);
  });
});
