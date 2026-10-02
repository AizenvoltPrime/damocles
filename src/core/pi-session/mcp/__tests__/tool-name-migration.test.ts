import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The owned and notice files live under homedir(), so home points into a temp dir.
const { fakeRoot, fakeHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'damocles-tool-rename-'));
  return { fakeRoot: root, fakeHome: nodePath.join(root, 'home') };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

import { legacyToCurrentToolNames, migrateRenamedToolRules, type NoticeMemory } from '../tool-name-migration';
import { assignServerToolNames, createMcpToolName } from '../naming';
import type { McpToolNameEntry } from '../mcp-client-manager';

const folder = join(fakeRoot, 'ws');
const OLD = 'mcp__context7__resolve-library-id';
const NEW = 'mcp__context7__resolve_library_id';

function entries(server: string, tools: string[]): McpToolNameEntry[] {
  const names = assignServerToolNames(server, tools, new Set());
  return tools.map((tool) => ({ serverName: server, rawToolName: tool, piName: names.get(tool)! }));
}

function writeSettings(path: string, rules: { allow?: string[]; ask?: string[]; deny?: string[] }, extra: Record<string, unknown> = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...extra, permissions: rules }, null, 2)}\n`, 'utf-8');
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as { permissions: Record<string, string[]> } & Record<string, unknown>;

function memory(): NoticeMemory & { shown: Map<string, Set<string>> } {
  const shown = new Map<string, Set<string>>();
  return {
    shown,
    has: (file, rule) => shown.get(file)?.has(rule) ?? false,
    add: async (file, rules) => {
      const set = shown.get(file) ?? new Set<string>();
      for (const rule of rules) set.add(rule);
      shown.set(file, set);
    },
  };
}

const context7 = (): Map<string, string> =>
  legacyToCurrentToolNames({
    userServers: ['context7'],
    visibleUserServers: ['context7'],
    folderServers: [],
    userTools: entries('context7', ['resolve-library-id', 'get_docs']),
    folderTools: [],
  });

const owned = {
  user: () => join(fakeHome, '.damocles', 'settings.json'),
  userLocal: () => join(fakeHome, '.damocles', 'settings.local.json'),
  folderLocal: () => join(folder, '.damocles', 'settings.local.json'),
};

beforeEach(() => {
  // Windows can hold a just-written file briefly (indexer, antivirus) and fail the delete with EPERM.
  rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5 });
  rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
});
afterAll(() => rmSync(fakeRoot, { recursive: true, force: true }));

describe('legacyToCurrentToolNames', () => {
  it('maps only the tools whose name changed', () => {
    expect(Object.fromEntries(context7())).toEqual({ [OLD]: NEW });
  });

  it('rebuilds a folder server\u2019s suffixed legacy prefix around the visible user servers', () => {
    const renames = legacyToCurrentToolNames({
      userServers: ['my-server', 'other'],
      visibleUserServers: ['my-server'],
      folderServers: ['my.server'],
      userTools: entries('my-server', ['a-b']),
      folderTools: entries('my.server', ['x-y']),
    });
    expect(Object.fromEntries(renames)).toEqual({
      'mcp__my_server__a-b': 'mcp__my_server__a_b',
      'mcp__my_server_2__x-y': 'mcp__my_server__x_y',
    });
  });

  it('maps a legacy name over 64 characters to its hashed pi name', () => {
    const long = 'x'.repeat(70);
    const renames = legacyToCurrentToolNames({
      userServers: ['docs'],
      visibleUserServers: ['docs'],
      folderServers: [],
      userTools: entries('docs', [long]),
      folderTools: [],
    });
    expect(renames.get(`mcp__docs__${long}`)).toMatch(/^mcp__docs__x+_[0-9a-f]{8}$/);
  });

  it('never renames a legacy name that is another tool\u2019s current name, so a rerun changes nothing', async () => {
    const hyphenated = entries('a--b', ['c']);
    const plain: McpToolNameEntry[] = [
      { serverName: 'a', rawToolName: 'b__c', piName: createMcpToolName('a', 'b__c', (name) => name === hyphenated[0]!.piName) },
    ];
    const renames = legacyToCurrentToolNames({ userServers: ['a', 'a--b'], visibleUserServers: ['a', 'a--b'], folderServers: [], userTools: [...plain, ...hyphenated], folderTools: [] });
    expect(renames.has('mcp__a__b__c')).toBe(false);
    expect(renames.get('mcp__a_b__c')).toBe('mcp__a__b__c');

    writeSettings(owned.user(), { allow: ['mcp__a_b__c'] });
    await migrateRenamedToolRules(folder, renames, memory());
    await migrateRenamedToolRules(folder, renames, memory());
    expect(read(owned.user()).permissions).toEqual({ allow: ['mcp__a__b__c'] });
  });

  it('knows nothing about a server whose tools are not known yet', () => {
    expect(
      legacyToCurrentToolNames({ userServers: ['context7'], visibleUserServers: ['context7'], folderServers: [], userTools: [], folderTools: [] }).size,
    ).toBe(0);
  });
});

describe('migrateRenamedToolRules', () => {
  it('rewrites the three owned files, keeping each rule\u2019s (\u2026) argument part and every other key', async () => {
    writeSettings(owned.user(), { allow: [OLD, 'Bash(npm test)'], deny: [`${OLD}(react)`] }, { model: 'kept' });
    writeSettings(owned.userLocal(), { ask: [OLD] });
    writeSettings(owned.folderLocal(), { allow: [`${OLD}(/vercel/next.js)`, 'mcp__context7__get_docs'] });

    const notices = await migrateRenamedToolRules(folder, context7(), memory());

    expect(notices).toEqual([]);
    expect(read(owned.user())).toEqual({ model: 'kept', permissions: { allow: [NEW, 'Bash(npm test)'], deny: [`${NEW}(react)`] } });
    expect(read(owned.userLocal()).permissions).toEqual({ ask: [NEW] });
    expect(read(owned.folderLocal()).permissions).toEqual({ allow: [`${NEW}(/vercel/next.js)`, 'mcp__context7__get_docs'] });
  });

  it('leaves the project\u2019s .damocles/settings.json untouched and lists its rules once', async () => {
    const project = join(folder, '.damocles', 'settings.json');
    writeSettings(project, { allow: [OLD], deny: [`${OLD}(x)`] });
    const before = readFileSync(project, 'utf-8');
    const shown = memory();

    const notices = await migrateRenamedToolRules(folder, context7(), shown);

    expect(readFileSync(project, 'utf-8')).toBe(before);
    expect(notices).toEqual([{ path: project, displayPath: project, rules: [{ old: OLD, new: NEW }, { old: `${OLD}(x)`, new: `${NEW}(x)` }] }]);

    for (const notice of notices) await shown.add(notice.path, notice.rules.map((rule) => rule.old));
    await expect(migrateRenamedToolRules(folder, context7(), shown)).resolves.toEqual([]);
  });

  // Claude Code keeps `-` in MCP tool names, so these rules are correct for Claude Code as written.
  it('neither rewrites nor lists the rules in Claude Code\u2019s settings files', async () => {
    const claudeFiles = [
      join(folder, '.claude', 'settings.json'),
      join(folder, '.claude', 'settings.local.json'),
      join(fakeHome, '.claude', 'settings.json'),
      join(fakeHome, '.claude', 'settings.local.json'),
    ];
    for (const file of claudeFiles) writeSettings(file, { allow: [OLD] });
    const before = claudeFiles.map((file) => readFileSync(file, 'utf-8'));

    await expect(migrateRenamedToolRules(folder, context7(), memory())).resolves.toEqual([]);
    expect(claudeFiles.map((file) => readFileSync(file, 'utf-8'))).toEqual(before);
  });

  it('keeps migrating and collecting notices after one owned file fails', async () => {
    const outside = join(fakeRoot, 'outside-damocles');
    writeSettings(join(outside, 'settings.local.json'), { allow: [OLD] });
    mkdirSync(folder, { recursive: true });
    symlinkSync(outside, join(folder, '.damocles'), 'junction');
    const hooks = join(fakeHome, '.damocles', 'hooks.json');
    mkdirSync(dirname(hooks), { recursive: true });
    writeFileSync(hooks, JSON.stringify({ hooks: { tool_call: [{ match: OLD, command: 'echo hi' }] } }), 'utf-8');

    const notices = await migrateRenamedToolRules(folder, context7(), memory());

    expect(read(join(outside, 'settings.local.json')).permissions).toEqual({ allow: [OLD] });
    expect(notices).toEqual([{ path: hooks, displayPath: '~/.damocles/hooks.json', rules: [{ old: OLD, new: NEW }] }]);
  });

  it('shows a path outside home that only shares its prefix in full', async () => {
    const sibling = join(`${fakeHome}2`, 'agents', 'reviewer.md');
    await expect(migrateRenamedToolRules(folder, context7(), memory(), [{ path: sibling, names: [OLD] }])).resolves.toEqual([
      { path: sibling, displayPath: sibling, rules: [{ old: OLD, new: NEW }] },
    ]);
  });

  it('lists a hook matcher naming the old tool and never rewrites the hooks file', async () => {
    const hooks = join(folder, '.damocles', 'hooks.json');
    mkdirSync(dirname(hooks), { recursive: true });
    const text = JSON.stringify({ hooks: { tool_call: [{ match: `${OLD}|Bash`, command: 'echo hi' }] } }, null, 2);
    writeFileSync(hooks, text, 'utf-8');

    const notices = await migrateRenamedToolRules(folder, context7(), memory());

    expect(readFileSync(hooks, 'utf-8')).toBe(text);
    expect(notices).toEqual([{ path: hooks, displayPath: hooks, rules: [{ old: `${OLD}|Bash`, new: `${NEW}|Bash` }] }]);
  });

  function writeHookMatchers(matchers: string[]): string {
    const hooks = join(folder, '.damocles', 'hooks.json');
    mkdirSync(dirname(hooks), { recursive: true });
    writeFileSync(hooks, JSON.stringify({ hooks: { tool_call: matchers.map((match) => ({ match, command: 'echo hi' })) } }), 'utf-8');
    return hooks;
  }

  it('renames a hook matcher\u2019s legacy names only as whole tool names', async () => {
    writeHookMatchers([`${OLD}-now|Bash`, `x${OLD}`]);
    await expect(migrateRenamedToolRules(folder, context7(), memory())).resolves.toEqual([]);
  });

  it('renames every legacy name in one hook matcher into a single entry', async () => {
    const renames = new Map([...context7(), ['mcp__s__do-it', 'mcp__s__do_it']]);
    const hooks = writeHookMatchers([`${OLD}|mcp__s__do-it|mcp__s__do-it-now`]);

    await expect(migrateRenamedToolRules(folder, renames, memory())).resolves.toEqual([
      { path: hooks, displayPath: hooks, rules: [{ old: `${OLD}|mcp__s__do-it|mcp__s__do-it-now`, new: `${NEW}|mcp__s__do_it|mcp__s__do-it-now` }] },
    ]);
  });

  describe('tool name lists: agent disallowed_tools and project-scope damocles.tools.disabled', () => {
    const agentFile = () => join(fakeRoot, 'agents', 'reviewer.md');
    const projectSettings = () => join(folder, '.damocles', 'settings.json');

    function seedListFiles(): string[] {
      mkdirSync(dirname(agentFile()), { recursive: true });
      writeFileSync(agentFile(), `---\nname: reviewer\ndisallowed_tools: [${OLD}, mcp__context7__query_docs]\n---\nReview.\n`, 'utf-8');
      writeSettings(projectSettings(), {}, { 'damocles.tools.disabled': [OLD, 'mcp__context7__get_docs'] });
      return [readFileSync(agentFile(), 'utf-8'), readFileSync(projectSettings(), 'utf-8')];
    }

    const lists = () => [
      { path: agentFile(), names: [OLD, 'mcp__context7__query_docs'] },
      { path: projectSettings(), names: [OLD, 'mcp__context7__get_docs'] },
    ];

    it('lists each renamed name once per file, never an unchanged one, and writes neither file', async () => {
      const before = seedListFiles();

      const notices = await migrateRenamedToolRules(folder, context7(), memory(), lists());

      const byPath = new Map(notices.map((notice) => [notice.path, notice.rules]));
      expect(byPath.get(agentFile())).toEqual([{ old: OLD, new: NEW }]);
      // The project settings file also holds no permission rules here, so its only entry is the list name.
      expect(byPath.get(projectSettings())).toEqual([{ old: OLD, new: NEW }]);
      expect([readFileSync(agentFile(), 'utf-8'), readFileSync(projectSettings(), 'utf-8')]).toEqual(before);
    });

    it('does not repeat a list notice once it was shown', async () => {
      seedListFiles();
      const shown = memory();
      for (const notice of await migrateRenamedToolRules(folder, context7(), shown, lists())) {
        await shown.add(notice.path, notice.rules.map((rule) => rule.old));
      }

      await expect(migrateRenamedToolRules(folder, context7(), shown, lists())).resolves.toEqual([]);
    });

    it('lists nothing for names whose tool kept its name', async () => {
      const unchanged = [{ path: agentFile(), names: ['mcp__context7__query_docs', 'mcp__context7__get_docs'] }];
      await expect(migrateRenamedToolRules(folder, context7(), memory(), unchanged)).resolves.toEqual([]);
    });
  });

  it('is idempotent: a second run changes no bytes', async () => {
    writeSettings(owned.user(), { allow: [OLD] });
    await migrateRenamedToolRules(folder, context7(), memory());
    const once = readFileSync(owned.user(), 'utf-8');

    await expect(migrateRenamedToolRules(folder, context7(), memory())).resolves.toEqual([]);
    expect(readFileSync(owned.user(), 'utf-8')).toBe(once);
  });

  it('migrates a rule once its server connects, and not before', async () => {
    writeSettings(owned.user(), { allow: [OLD] });
    const notConnected = legacyToCurrentToolNames({ userServers: ['context7'], visibleUserServers: ['context7'], folderServers: [], userTools: [], folderTools: [] });

    await migrateRenamedToolRules(folder, notConnected, memory());
    expect(read(owned.user()).permissions).toEqual({ allow: [OLD] });

    await migrateRenamedToolRules(folder, context7(), memory());
    expect(read(owned.user()).permissions).toEqual({ allow: [NEW] });
  });

  it('creates no settings file that did not exist', async () => {
    await migrateRenamedToolRules(folder, context7(), memory());
    expect(existsSync(owned.user())).toBe(false);
    expect(existsSync(owned.folderLocal())).toBe(false);
  });

  it('leaves an unparseable owned file alone', async () => {
    mkdirSync(dirname(owned.user()), { recursive: true });
    writeFileSync(owned.user(), `{ "permissions": { "allow": ["${OLD}"] `, 'utf-8');
    await migrateRenamedToolRules(folder, context7(), memory());
    expect(readFileSync(owned.user(), 'utf-8')).toBe(`{ "permissions": { "allow": ["${OLD}"] `);
  });
});
