import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import {
  legacyToCurrentToolNames,
  migrateRenamedToolRules,
  noticeForDisplay,
  resourceNameToToolName,
  resourceRuleFor,
  retiredResourceToolNames,
  toolRenames,
  type AdditionMemory,
  type LegacyToolNameInput,
  type MigrationMemory,
  type NoticeMemory,
  type PersonalToolLists,
  type ToolNameList,
  type ToolRenames,
} from '../tool-name-migration';
import { parseMcpResourceUriRule } from '../../../permission-handler/mcp-resource-rule';
import { renamedRuleNoticeKey, type McpRenamedToolRuleNotice } from '../../../../shared/types/mcp';
import { assignServerToolNames, createMcpToolName } from '../naming';
import type { McpToolNameEntry } from '../mcp-client-manager';
import { installWorktreeProjectLookup } from '../../../worktrees/personal-config';
import { renamedRuleNoticeMemory } from '../../pi-runtime';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';

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

function additionMemory(): AdditionMemory {
  const added = new Map<string, Set<string>>();
  return {
    has: (file, addition) => added.get(file)?.has(addition) ?? false,
    add: async (file, additions) => {
      const set = added.get(file) ?? new Set<string>();
      for (const addition of additions) set.add(addition);
      added.set(file, set);
    },
  };
}

function noticeMemory(): NoticeMemory {
  const shown = new Set<string>();
  const key = (location: Parameters<NoticeMemory['has']>[0], entry: { old: string; new: string }) => JSON.stringify([renamedRuleNoticeKey(location), entry.old, entry.new]);
  return {
    has: (location, entry) => shown.has(key(location, entry)),
    add: async (location, entries) => {
      for (const entry of entries) shown.add(key(location, entry));
    },
  };
}

function memory(): MigrationMemory {
  return { notices: noticeMemory(), additions: additionMemory() };
}

/** A run's notices as the folder's panels get them, remembered as the folder runtime remembers them. */
async function showRun(...args: Parameters<typeof migrateRenamedToolRules>): Promise<McpRenamedToolRuleNotice[]> {
  const { notices } = await migrateRenamedToolRules(...args);
  for (const notice of notices) await args[2].notices.add(notice, notice.rules);
  return notices.map(noticeForDisplay);
}

const migrate = async (...args: Parameters<typeof migrateRenamedToolRules>): Promise<McpRenamedToolRuleNotice[]> =>
  (await migrateRenamedToolRules(...args)).notices.map(noticeForDisplay);

/** Personal lists held in `list.value`, rewritten entry by entry as the settings store's rewrite does. */
function personalList(initial: string[], lists: () => ToolNameList[] = () => []): PersonalToolLists & { value: string[] } {
  const holder = {
    value: initial,
    rewrite: async (rename: (name: string) => string) => {
      holder.value = holder.value.map(rename);
    },
    lists,
  };
  return holder;
}

const NO_RETIRED: LegacyToolNameInput['retiredResources'] = { user: [], folder: [] };

const context7Legacy = (): Map<string, string> =>
  legacyToCurrentToolNames({
    userServers: ['context7'],
    visibleUserServers: ['context7'],
    folderServers: [],
    userTools: entries('context7', ['resolve-library-id', 'get_docs']),
    folderTools: [],
    retiredResources: NO_RETIRED,
  });
const context7 = (): ToolRenames => toolRenames(context7Legacy(), new Map());

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
    expect(Object.fromEntries(context7Legacy())).toEqual({ [OLD]: NEW });
  });

  it('rebuilds a folder server\u2019s suffixed legacy prefix around the visible user servers', () => {
    const renames = legacyToCurrentToolNames({
      userServers: ['my-server', 'other'],
      visibleUserServers: ['my-server'],
      folderServers: ['my.server'],
      userTools: entries('my-server', ['a-b']),
      folderTools: entries('my.server', ['x-y']),
      retiredResources: NO_RETIRED,
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
      retiredResources: NO_RETIRED,
    });
    expect(renames.get(`mcp__docs__${long}`)).toMatch(/^mcp__docs__x+_[0-9a-f]{8}$/);
  });

  it('never renames a legacy name that is another tool\u2019s current name, so a rerun changes nothing', async () => {
    const hyphenated = entries('a--b', ['c']);
    const plain: McpToolNameEntry[] = [
      { serverName: 'a', rawToolName: 'b__c', piName: createMcpToolName('a', 'b__c', (name) => name === hyphenated[0]!.piName) },
    ];
    const renames = legacyToCurrentToolNames({ userServers: ['a', 'a--b'], visibleUserServers: ['a', 'a--b'], folderServers: [], userTools: [...plain, ...hyphenated], folderTools: [], retiredResources: NO_RETIRED });
    expect(renames.has('mcp__a__b__c')).toBe(false);
    expect(renames.get('mcp__a_b__c')).toBe('mcp__a__b__c');

    writeSettings(owned.user(), { allow: ['mcp__a_b__c'] });
    await migrate(folder, toolRenames(renames, new Map()), memory());
    await migrate(folder, toolRenames(renames, new Map()), memory());
    expect(read(owned.user()).permissions).toEqual({ allow: ['mcp__a__b__c'] });
  });

  it('knows nothing about a server whose tools are not known yet', () => {
    expect(
      legacyToCurrentToolNames({ userServers: ['context7'], visibleUserServers: ['context7'], folderServers: [], userTools: [], folderTools: [], retiredResources: NO_RETIRED }).size,
    ).toBe(0);
  });
});

describe('migrateRenamedToolRules', () => {
  it('rewrites the three owned files, keeping each rule\u2019s (\u2026) argument part and every other key', async () => {
    writeSettings(owned.user(), { allow: [OLD, 'Bash(npm test)'], deny: [`${OLD}(react)`] }, { model: 'kept' });
    writeSettings(owned.userLocal(), { ask: [OLD] });
    writeSettings(owned.folderLocal(), { allow: [`${OLD}(/vercel/next.js)`, 'mcp__context7__get_docs'] });

    const notices = await migrate(folder, context7(), memory());

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

    const notices = await showRun(folder, context7(), shown);

    expect(readFileSync(project, 'utf-8')).toBe(before);
    expect(notices).toEqual([{ path: project, displayPath: project, rules: [{ old: OLD, new: NEW }, { old: `${OLD}(x)`, new: `${NEW}(x)` }] }]);

    await expect(migrate(folder, context7(), shown)).resolves.toEqual([]);
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

    await expect(migrate(folder, context7(), memory())).resolves.toEqual([]);
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

    const notices = await migrate(folder, context7(), memory());

    expect(read(join(outside, 'settings.local.json')).permissions).toEqual({ allow: [OLD] });
    expect(notices).toEqual([{ path: hooks, displayPath: '~/.damocles/hooks.json', rules: [{ old: OLD, new: NEW }] }]);
  });

  it('shows a path outside home that only shares its prefix in full', async () => {
    const sibling = join(`${fakeHome}2`, 'agents', 'reviewer.md');
    await expect(migrate(folder, context7(), memory(), [{ path: sibling, names: [OLD] }])).resolves.toEqual([
      { path: sibling, displayPath: sibling, rules: [{ old: OLD, new: NEW }] },
    ]);
  });

  it('lists a hook matcher naming the old tool and never rewrites the hooks file', async () => {
    const hooks = join(folder, '.damocles', 'hooks.json');
    mkdirSync(dirname(hooks), { recursive: true });
    const text = JSON.stringify({ hooks: { tool_call: [{ match: `${OLD}|Bash`, command: 'echo hi' }] } }, null, 2);
    writeFileSync(hooks, text, 'utf-8');

    const notices = await migrate(folder, context7(), memory());

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
    await expect(migrate(folder, context7(), memory())).resolves.toEqual([]);
  });

  it('renames every legacy name in one hook matcher into a single entry', async () => {
    const renames = new Map([...context7Legacy(), ['mcp__s__do-it', 'mcp__s__do_it']]);
    const hooks = writeHookMatchers([`${OLD}|mcp__s__do-it|mcp__s__do-it-now`]);

    await expect(migrate(folder, toolRenames(renames, new Map()), memory())).resolves.toEqual([
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

      const notices = await migrate(folder, context7(), memory(), lists());

      const byPath = new Map(notices.map((notice) => [renamedRuleNoticeKey(notice), notice.rules]));
      expect(byPath.get(agentFile())).toEqual([{ old: OLD, new: NEW }]);
      // The project settings file also holds no permission rules here, so its only entry is the list name.
      expect(byPath.get(projectSettings())).toEqual([{ old: OLD, new: NEW }]);
      expect([readFileSync(agentFile(), 'utf-8'), readFileSync(projectSettings(), 'utf-8')]).toEqual(before);
    });

    it('does not repeat a list notice once it was shown', async () => {
      seedListFiles();
      const shown = memory();
      await showRun(folder, context7(), shown, lists());

      await expect(migrate(folder, context7(), shown, lists())).resolves.toEqual([]);
    });

    it('lists nothing for names whose tool kept its name', async () => {
      const unchanged = [{ path: agentFile(), names: ['mcp__context7__query_docs', 'mcp__context7__get_docs'] }];
      await expect(migrate(folder, context7(), memory(), unchanged)).resolves.toEqual([]);
    });
  });

  it('is idempotent: a second run changes no bytes', async () => {
    writeSettings(owned.user(), { allow: [OLD] });
    await migrate(folder, context7(), memory());
    const once = readFileSync(owned.user(), 'utf-8');

    await expect(migrate(folder, context7(), memory())).resolves.toEqual([]);
    expect(readFileSync(owned.user(), 'utf-8')).toBe(once);
  });

  it('migrates a rule once its server connects, and not before', async () => {
    writeSettings(owned.user(), { allow: [OLD] });
    const notConnected = legacyToCurrentToolNames({ userServers: ['context7'], visibleUserServers: ['context7'], folderServers: [], userTools: [], folderTools: [], retiredResources: NO_RETIRED });

    await migrate(folder, toolRenames(notConnected, new Map()), memory());
    expect(read(owned.user()).permissions).toEqual({ allow: [OLD] });

    await migrate(folder, context7(), memory());
    expect(read(owned.user()).permissions).toEqual({ allow: [NEW] });
  });

  it('creates no settings file that did not exist', async () => {
    await migrate(folder, context7(), memory());
    expect(existsSync(owned.user())).toBe(false);
    expect(existsSync(owned.folderLocal())).toBe(false);
  });

  it('leaves an unparseable owned file alone', async () => {
    mkdirSync(dirname(owned.user()), { recursive: true });
    writeFileSync(owned.user(), `{ "permissions": { "allow": ["${OLD}"] `, 'utf-8');
    await migrate(folder, context7(), memory());
    expect(readFileSync(owned.user(), 'utf-8')).toBe(`{ "permissions": { "allow": ["${OLD}"] `);
  });
});

describe('retired get_* resource tools', () => {
  it('slugs resource names as the retired get_* tools did', () => {
    expect(resourceNameToToolName('My Resource')).toBe('my_resource');
    expect(resourceNameToToolName('123abc')).toBe('resource_123abc');
    expect(resourceNameToToolName('!!!')).toBe('resource');
  });

  const secretInput = (over: Partial<LegacyToolNameInput> = {}): LegacyToolNameInput => ({
    userServers: ['secret'],
    visibleUserServers: ['secret'],
    folderServers: [],
    userTools: entries('secret', ['rotate']),
    folderTools: [],
    retiredResources: {
      user: [
        {
          serverName: 'secret',
          rawToolNames: ['rotate'],
          resources: [
            { uri: 'secret://passwords', name: 'Passwords' },
            { uri: 'secret://passwords-v2', name: 'passwords' },
            { uri: 'secret://logs/today', name: 'logs' },
          ],
        },
      ],
      folder: [],
    },
    ...over,
  });

  it('maps each former name to its server and cached URI, the first resource of a slug keeping it', () => {
    expect(Object.fromEntries(retiredResourceToolNames(secretInput()))).toEqual({
      mcp__secret__get_passwords: [{ server: 'secret', uri: 'secret://passwords', rawName: 'get_passwords', piName: 'mcp__secret__get_passwords', userServer: true }],
      mcp__secret__get_logs: [{ server: 'secret', uri: 'secret://logs/today', rawName: 'get_logs', piName: 'mcp__secret__get_logs', userServer: true }],
    });
  });

  it('also maps the server spelled as written and as Claude Code writes it, for a server named my-srv', async () => {
    const input = secretInput({
      userServers: ['my-srv'],
      visibleUserServers: ['my-srv'],
      userTools: [],
      retiredResources: { user: [{ serverName: 'my-srv', rawToolNames: [], resources: [{ uri: 'v://passwords', name: 'passwords' }] }], folder: [] },
    });
    expect([...retiredResourceToolNames(input).keys()].sort()).toEqual(['mcp__my-srv__get_passwords', 'mcp__my_srv__get_passwords']);

    writeSettings(owned.user(), { deny: ['mcp__my-srv__get_passwords'] });
    await migrate(folder, toolRenames(new Map(), retiredResourceToolNames(input)), memory());
    expect(read(owned.user()).permissions).toEqual({ deny: ['mcp__my_srv__read_mcp_resource(v://passwords)'] });
  });

  it('skips a slug a server tool of the same raw name held, and a former name that is a current tool name', () => {
    const input = secretInput({
      userTools: entries('secret', ['get_logs', 'rotate']),
      retiredResources: { user: [{ serverName: 'secret', rawToolNames: ['get_logs', 'rotate'], resources: [{ uri: 'secret://logs', name: 'logs' }, { uri: 'secret://passwords', name: 'passwords' }] }], folder: [] },
    });
    expect([...retiredResourceToolNames(input).keys()]).toEqual(['mcp__secret__get_passwords']);
  });

  it('rebuilds a hashed former name for a long server name', () => {
    const server = 's'.repeat(60);
    const input: LegacyToolNameInput = {
      userServers: [server],
      visibleUserServers: [server],
      folderServers: [],
      userTools: [],
      folderTools: [],
      retiredResources: { user: [{ serverName: server, rawToolNames: [], resources: [{ uri: 'x://a', name: 'a' }] }], folder: [] },
    };
    const resource = retiredResourceToolNames(input).get(createMcpToolName(server, 'get_a'));
    expect(createMcpToolName(server, 'get_a')).toMatch(/_[0-9a-f]{8}$/);
    expect(resource).toMatchObject([{ server, uri: 'x://a', rawName: 'get_a' }]);
  });

  const dotted = { serverName: 'my.srv', rawToolNames: [], resources: [{ uri: 'dot://x', name: 'x' }] };
  const underscored = { serverName: 'my_srv', rawToolNames: [], resources: [{ uri: 'under://x', name: 'x' }] };
  const hashedUnderscored = createMcpToolName('my_srv', 'get_x', () => true);

  // Older builds named one manager's servers in sorted order, each taking the names earlier ones held.
  it('replays a later server whose name sanitizes the same as an earlier one\u2019s with the hashed name it got', async () => {
    const input: LegacyToolNameInput = {
      userServers: ['my.srv', 'my_srv'],
      visibleUserServers: ['my.srv', 'my_srv'],
      folderServers: [],
      userTools: [],
      folderTools: [],
      retiredResources: { user: [underscored, dotted], folder: [] },
    };
    const retired = retiredResourceToolNames(input);
    expect(retired.get(hashedUnderscored)!.map((tool) => [tool.server, tool.piName])).toEqual([['my_srv', hashedUnderscored]]);
    expect(retired.get('mcp__my_srv__get_x')!.map((tool) => [tool.server, tool.piName])).toEqual([
      ['my.srv', 'mcp__my_srv__get_x'],
      ['my_srv', hashedUnderscored],
    ]);
    writeSettings(owned.user(), { deny: ['mcp__my_srv__get_x', hashedUnderscored], allow: ['mcp__my_srv__get_x'] });

    await migrate(folder, toolRenames(new Map(), retired), memory());

    const { deny, allow } = read(owned.user()).permissions;
    expect(deny).toEqual([`${createMcpToolName('my.srv', 'read_mcp_resource')}(dot://x)`, `${createMcpToolName('my_srv', 'read_mcp_resource')}(under://x)`]);
    expect(allow).toHaveLength(1);
  });

  it('replays the user manager over every user server, a hidden one included, and reserves the visible ones\u2019 names for the folder', () => {
    const input = (visible: string[]): LegacyToolNameInput => ({
      userServers: ['my.srv', 'my_srv'],
      visibleUserServers: visible,
      folderServers: ['my-srv'],
      userTools: [],
      folderTools: [],
      retiredResources: { user: [dotted, underscored], folder: [{ serverName: 'my-srv', rawToolNames: [], resources: [{ uri: 'dash://x', name: 'x' }] }] },
    });
    const hashedDashed = createMcpToolName('my-srv', 'get_x', () => true);

    const underscoredOnly = retiredResourceToolNames(input(['my_srv']));
    expect(underscoredOnly.get(hashedUnderscored)!.map((tool) => tool.uri)).toEqual(['under://x']);
    expect(underscoredOnly.get(hashedDashed)).toBeUndefined();
    expect(underscoredOnly.get('mcp__my_srv__get_x')!.map((tool) => tool.uri)).toEqual(['dash://x', 'under://x']);

    expect(retiredResourceToolNames(input([])).get('mcp__my_srv__get_x')!.map((tool) => [tool.uri, tool.userServer])).toEqual([['dash://x', false]]);
  });

  it('every produced rule parses back to the exact URI and the server\u2019s read_mcp_resource name', () => {
    const uris = ['secret://passwords', 'docs://a(b)c', 'docs://trailing)', 'docs://(', 'file:///My Docs/report (final).pdf', 'glob://lit*eral*', 'x://))(('];
    for (const server of ['secret', 'my.server', 'v'.repeat(60)]) {
      for (const uri of uris) {
        const rule = resourceRuleFor({ server, uri });
        expect(parseMcpResourceUriRule(rule), rule).toEqual({ toolName: createMcpToolName(server, 'read_mcp_resource'), uriPattern: uri });
      }
    }
  });

  it('keeps rules on one resource: a URI-scoped rule, a matcher on the server identity, and advice for exact-name lists', () => {
    const renames = toolRenames(new Map(), retiredResourceToolNames(secretInput()));
    expect(renames.rules.get('mcp__secret__get_passwords')).toBe('mcp__secret__read_mcp_resource(secret://passwords)');
    expect(renames.matchers.get('mcp__secret__get_passwords')).toBe('mcp__secret__read_mcp_resource');
    expect(renames.names.get('mcp__secret__get_passwords')).toContain('mcp__secret__read_mcp_resource(secret://passwords)');
  });

  it('rewrites deny, ask and allow rules in owned files exactly, leaves a parenthesized one, and is idempotent', async () => {
    const renames = toolRenames(new Map(), retiredResourceToolNames(secretInput()));
    writeSettings(owned.user(), {
      deny: ['mcp__secret__get_passwords', 'mcp__secret__get_passwords(x)'],
      ask: ['mcp__secret__get_logs'],
      allow: ['mcp__secret__get_logs', 'mcp__secret__rotate'],
    });

    await migrate(folder, renames, memory());
    const once = readFileSync(owned.user(), 'utf-8');
    await migrate(folder, renames, memory());

    expect(read(owned.user()).permissions).toEqual({
      deny: ['mcp__secret__read_mcp_resource(secret://passwords)', 'mcp__secret__get_passwords(x)'],
      ask: ['mcp__secret__read_mcp_resource(secret://logs/today)'],
      allow: ['mcp__secret__read_mcp_resource(secret://logs/today)', 'mcp__secret__rotate'],
    });
    expect(readFileSync(owned.user(), 'utf-8')).toBe(once);
  });

  it('lists the committed project rule, a hook matcher and an exact-name list once each, with their replacements', async () => {
    const renames = toolRenames(new Map(), retiredResourceToolNames(secretInput()));
    const project = join(folder, '.damocles', 'settings.json');
    writeSettings(project, { deny: ['mcp__secret__get_passwords'] });
    const hooks = join(folder, '.damocles', 'hooks.json');
    writeFileSync(hooks, JSON.stringify({ hooks: { tool_call: [{ match: 'mcp__secret__get_passwords', command: 'echo hi' }] } }), 'utf-8');
    const agent = join(fakeRoot, 'agents', 'auditor.md');
    const shown = memory();

    const notices = await showRun(folder, renames, shown, [{ path: agent, names: ['mcp__secret__get_passwords'] }]);
    const byPath = new Map(notices.map((notice) => [renamedRuleNoticeKey(notice), notice.rules]));

    expect(byPath.get(project)).toEqual([{ old: 'mcp__secret__get_passwords', new: 'mcp__secret__read_mcp_resource(secret://passwords)' }]);
    expect(byPath.get(hooks)).toEqual([{ old: 'mcp__secret__get_passwords', new: 'mcp__secret__read_mcp_resource' }]);
    expect(byPath.get(agent)).toEqual([{ old: 'mcp__secret__get_passwords', new: 'mcp__secret__read_mcp_resource(secret://passwords)' }]);
    expect(read(project).permissions).toEqual({ deny: ['mcp__secret__get_passwords'] });

    await expect(migrate(folder, renames, shown, [{ path: agent, names: ['mcp__secret__get_passwords'] }])).resolves.toEqual([]);
  });
});

describe('retired get_* resource tools: patterns and files that named them indirectly', () => {
  const secret = (): LegacyToolNameInput => ({
    userServers: ['secret'],
    visibleUserServers: ['secret'],
    folderServers: [],
    userTools: entries('secret', ['get_token']),
    folderTools: [],
    retiredResources: { user: [{ serverName: 'secret', rawToolNames: ['get_token'], resources: [{ uri: 'secret://passwords', name: 'passwords' }] }], folder: [] },
  });
  const renames = (): ToolRenames => toolRenames(new Map(), retiredResourceToolNames(secret()));
  const PASSWORDS_RULE = 'mcp__secret__read_mcp_resource(secret://passwords)';

  it('keeps a deny or ask glob that covered a retired tool and adds the rule keeping its coverage beside it, once', async () => {
    writeSettings(owned.user(), {
      deny: ['mcp__secret__get_*', 'mcp__*__get_passwords', 'mcp__secret__*'],
      ask: ['mcp__secret__get_pass*'],
      allow: ['mcp__secret__get_*'],
    });

    await migrate(folder, renames(), memory());
    const once = readFileSync(owned.user(), 'utf-8');
    await migrate(folder, renames(), memory());

    expect(read(owned.user()).permissions).toEqual({
      deny: ['mcp__secret__get_*', 'mcp__secret__read_mcp_resource', 'mcp__*__get_passwords', PASSWORDS_RULE, 'mcp__secret__*'],
      ask: ['mcp__secret__get_pass*', PASSWORDS_RULE],
      allow: ['mcp__secret__get_*'],
    });
    expect(readFileSync(owned.user(), 'utf-8')).toBe(once);
  });

  it('keeps a glob over every get_ tool of every server as one read_mcp_resource glob, however many resources are cached', async () => {
    const resources = Array.from({ length: 300 }, (_, index) => ({ uri: `file:///docs/${index}.md`, name: `doc ${index}` }));
    const input: LegacyToolNameInput = {
      ...secret(),
      userServers: ['secret', 'files'],
      visibleUserServers: ['secret', 'files'],
      retiredResources: { user: [...secret().retiredResources.user, { serverName: 'files', rawToolNames: [], resources }], folder: [] },
    };
    writeSettings(owned.user(), { deny: ['mcp__*__get_*'] });

    await migrate(folder, toolRenames(new Map(), retiredResourceToolNames(input)), memory());

    expect(read(owned.user()).permissions).toEqual({ deny: ['mcp__*__get_*', 'mcp__*__read_mcp_resource'] });
  });

  it('never adds a rule again once the user removed what it added', async () => {
    writeSettings(owned.user(), { deny: ['mcp__secret__get_*'], ask: ['mcp__secret__get_pass*'] });
    const remembered = memory();
    await migrate(folder, renames(), remembered);
    expect(read(owned.user()).permissions).toEqual({ deny: ['mcp__secret__get_*', 'mcp__secret__read_mcp_resource'], ask: ['mcp__secret__get_pass*', PASSWORDS_RULE] });

    writeSettings(owned.user(), { deny: ['mcp__secret__get_*'], ask: ['mcp__secret__get_pass*'] });
    await migrate(folder, renames(), remembered);

    expect(read(owned.user()).permissions).toEqual({ deny: ['mcp__secret__get_*'], ask: ['mcp__secret__get_pass*'] });
  });

  it('lists a covering glob in the committed project file with the rule to add', async () => {
    const project = join(folder, '.damocles', 'settings.json');
    writeSettings(project, { deny: ['mcp__secret__get_*'] });
    const notices = await migrate(folder, renames(), memory());
    expect(notices).toEqual([{ path: project, displayPath: project, rules: [{ old: 'mcp__secret__get_*', new: 'mcp__secret__get_*, mcp__secret__read_mcp_resource' }] }]);
  });

  it('lists a hook matcher pattern that matched a retired tool and misses the resource read', async () => {
    const hooks = join(folder, '.damocles', 'hooks.json');
    mkdirSync(dirname(hooks), { recursive: true });
    writeFileSync(hooks, JSON.stringify({ hooks: { tool_call: [{ match: 'mcp__secret__get_.*', command: 'x' }, { match: 'mcp__secret__.*', command: 'y' }] } }), 'utf-8');

    const notices = await migrate(folder, renames(), memory());

    expect(notices).toEqual([{ path: hooks, displayPath: hooks, rules: [{ old: 'mcp__secret__get_.*', new: 'mcp__secret__get_.*|mcp__secret__read_mcp_resource' }] }]);
  });

  it('lists a retired tool rule in Claude Code\u2019s settings files, never a renamed one, and writes neither', async () => {
    const claude = join(fakeHome, '.claude', 'settings.json');
    writeSettings(claude, { deny: ['mcp__secret__get_passwords', OLD] });
    const before = readFileSync(claude, 'utf-8');
    const both = toolRenames(context7Legacy(), retiredResourceToolNames(secret()));

    const notices = await migrate(folder, both, memory());

    expect(notices).toEqual([{ path: claude, displayPath: '~/.claude/settings.json', rules: [{ old: 'mcp__secret__get_passwords', new: PASSWORDS_RULE }] }]);
    expect(readFileSync(claude, 'utf-8')).toBe(before);
  });

  it("rewrites a personal damocles.tools.disabled entry for a retired tool into the entry turning that resource off, once, leaving the rest", async () => {
    const both = toolRenames(context7Legacy(), retiredResourceToolNames(secret()));
    const personal = personalList(['Bash', 'mcp__secret__get_passwords', OLD, PASSWORDS_RULE, 'read_mcp_resource', 'Bash']);
    const rewrite = vi.spyOn(personal, 'rewrite');

    const notices = await migrate(folder, both, memory(), [], personal);

    expect(rewrite).toHaveBeenCalledTimes(1);
    // The renamed tool's entry moves to toolExposure elsewhere (`McpManager.migrateDisabledMcpTools`).
    expect(personal.value).toEqual(['Bash', PASSWORDS_RULE, OLD, PASSWORDS_RULE, 'read_mcp_resource', 'Bash']);
    expect(notices).toEqual([]);
  });

  it('rewrites only the pi name, the one spelling a damocles.tools.disabled entry ever matched', async () => {
    const dotted: LegacyToolNameInput = {
      userServers: ['my.secret'],
      visibleUserServers: ['my.secret'],
      folderServers: [],
      userTools: entries('my.secret', ['get_token']),
      folderTools: [],
      retiredResources: { user: [{ serverName: 'my.secret', rawToolNames: ['get_token'], resources: [{ uri: 'secret://passwords', name: 'passwords' }] }], folder: [] },
    };
    const piName = createMcpToolName('my.secret', 'get_passwords');
    const asWritten = 'mcp__my.secret__get_passwords';
    expect(piName).not.toBe(asWritten);
    const personal = personalList([piName, asWritten]);

    await migrate(folder, toolRenames(new Map(), retiredResourceToolNames(dotted)), memory(), [], personal);

    expect(personal.value).toEqual([`${createMcpToolName('my.secret', 'read_mcp_resource')}(secret://passwords)`, asWritten]);
  });

  it('asks for no personal rewrite when no retired resource tool is known', async () => {
    const personal = personalList([]);
    const rewrite = vi.spyOn(personal, 'rewrite');
    await migrate(folder, toolRenames(context7Legacy(), new Map()), memory(), [], personal);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('a personal rewrite that fails is logged, leaves the run incomplete, and keeps the rest of the migration and its notices', async () => {
    const project = join(folder, '.damocles', 'settings.json');
    writeSettings(project, { deny: ['mcp__secret__get_passwords'] });
    const personal: PersonalToolLists = { rewrite: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }, lists: () => [] };

    const result = await migrateRenamedToolRules(folder, renames(), memory(), [], personal);

    expect(result.notices.map(renamedRuleNoticeKey)).toEqual([project]);
    expect(result.complete).toBe(false);
    await expect(migrateRenamedToolRules(folder, renames(), memory(), [], personalList([]))).resolves.toMatchObject({ complete: true });
  });

  it('lists the project scope kept as a host setting (VS Code workspace settings) under the setting, once', async () => {
    const shown = memory();
    const list = { setting: 'damocles.tools.disabled', names: ['mcp__secret__get_passwords', 'read_mcp_resource'] };

    const notices = await showRun(folder, renames(), shown, [list]);

    expect(notices).toEqual([{ setting: 'damocles.tools.disabled', displayPath: 'damocles.tools.disabled in workspace settings', rules: [{ old: 'mcp__secret__get_passwords', new: PASSWORDS_RULE }] }]);
    await expect(migrate(folder, renames(), shown, [list])).resolves.toEqual([]);
  });

  // Exact-name lists matched pi names only, so another spelling of a retired tool there never turned anything off.
  it('lists only a retired tool\u2019s pi name in an exact-name list it does not own', async () => {
    const input: LegacyToolNameInput = {
      ...secret(),
      userServers: ['my-srv'],
      visibleUserServers: ['my-srv'],
      userTools: [],
      retiredResources: { user: [{ serverName: 'my-srv', rawToolNames: [], resources: [{ uri: 'v://passwords', name: 'passwords' }] }], folder: [] },
    };
    const agent = join(fakeRoot, 'agents', 'auditor.md');

    const notices = await migrate(folder, toolRenames(new Map(), retiredResourceToolNames(input)), memory(), [{ path: agent, names: ['mcp__my-srv__get_passwords', 'mcp__my_srv__get_passwords'] }]);

    expect(notices).toEqual([{ path: agent, displayPath: agent, rules: [{ old: 'mcp__my_srv__get_passwords', new: 'mcp__my_srv__read_mcp_resource(v://passwords)' }] }]);
  });

  it('writes a rule that two legacy names became, or that an addition repeats, once', async () => {
    const legacy = new Map([['mcp__a__x-y', 'mcp__a__x_y'], ['mcp__a2__x-y', 'mcp__a__x_y']]);
    writeSettings(owned.user(), { allow: ['mcp__a__x-y', 'Bash', 'mcp__a2__x-y', 'Bash'] });

    await migrate(folder, toolRenames(legacy, new Map()), memory());

    expect(read(owned.user()).permissions).toEqual({ allow: ['mcp__a__x_y', 'Bash', 'Bash'] });
  });
});

describe('retired get_* resource tools in places every folder shares', () => {
  const FOLDER_URI = 'file:///project-a/README.md';
  const DOCS_RULE = `mcp__docs__read_mcp_resource(${FOLDER_URI})`;
  const PASSWORDS_RULE = 'mcp__secret__read_mcp_resource(secret://passwords)';
  const input = (): LegacyToolNameInput => ({
    userServers: ['secret'],
    visibleUserServers: ['secret'],
    folderServers: ['docs'],
    userTools: [],
    folderTools: [],
    retiredResources: {
      user: [{ serverName: 'secret', rawToolNames: [], resources: [{ uri: 'secret://passwords', name: 'passwords' }] }],
      folder: [{ serverName: 'docs', rawToolNames: [], resources: [{ uri: FOLDER_URI, name: 'readme' }] }],
    },
  });
  const renames = (): ToolRenames => toolRenames(new Map(), retiredResourceToolNames(input()));

  it('rewrites a folder server\u2019s retired tool only in the folder\u2019s own file and lists it in the home files', async () => {
    writeSettings(owned.user(), { deny: ['mcp__docs__get_readme', 'mcp__secret__get_passwords'] });
    writeSettings(owned.folderLocal(), { deny: ['mcp__docs__get_readme'] });

    const notices = await migrate(folder, renames(), memory());

    expect(read(owned.user()).permissions).toEqual({ deny: ['mcp__docs__get_readme', PASSWORDS_RULE] });
    expect(read(owned.folderLocal()).permissions).toEqual({ deny: [DOCS_RULE] });
    expect(notices).toEqual([{ path: owned.user(), displayPath: '~/.damocles/settings.json', rules: [{ old: 'mcp__docs__get_readme', new: DOCS_RULE }] }]);
  });

  it('adds a server-wide read rule for a folder server\u2019s get_* glob in a home file, and lists a narrower glob there', async () => {
    writeSettings(owned.user(), { deny: ['mcp__docs__get_*'], ask: ['mcp__docs__get_read*'] });

    const notices = await migrate(folder, renames(), memory());

    expect(read(owned.user()).permissions).toEqual({ deny: ['mcp__docs__get_*', 'mcp__docs__read_mcp_resource'], ask: ['mcp__docs__get_read*'] });
    expect(notices).toEqual([{ path: owned.user(), displayPath: '~/.damocles/settings.json', rules: [{ old: 'mcp__docs__get_read*', new: `mcp__docs__get_read*, ${DOCS_RULE}` }] }]);
  });

  it('rewrites only a user server\u2019s entry in the personal lists and lists a folder server\u2019s under its scope', async () => {
    const personal = personalList(['mcp__docs__get_readme', 'mcp__secret__get_passwords'], () => [
      { setting: 'damocles.tools.disabled', scope: 'user', names: personal.value },
    ]);

    const notices = await migrate(folder, renames(), memory(), [], personal);

    expect(personal.value).toEqual(['mcp__docs__get_readme', PASSWORDS_RULE]);
    expect(notices).toEqual([{ setting: 'damocles.tools.disabled', scope: 'user', displayPath: 'damocles.tools.disabled in user settings', rules: [{ old: 'mcp__docs__get_readme', new: DOCS_RULE }] }]);
    expect(renamedRuleNoticeKey(notices[0]!)).not.toBe(renamedRuleNoticeKey({ setting: 'damocles.tools.disabled', displayPath: '' }));
  });

  describe('in a chat worktree, whose personal files are its project\u2019s', () => {
    const project = join(fakeRoot, 'project');
    let restore: { dispose(): void } | undefined;
    beforeEach(() => {
      rmSync(project, { recursive: true, force: true, maxRetries: 5 });
      restore = installWorktreeProjectLookup({
        projectOf: (target) => (target === folder ? project : undefined),
        recordsOfProject: () => [],
        get: () => undefined,
        chatRecordFor: () => undefined,
      });
    });
    afterEach(() => restore?.dispose());

    it('treats the project\u2019s local file as shared with the project', async () => {
      const projectLocal = join(project, '.damocles', 'settings.local.json');
      writeSettings(projectLocal, { deny: ['mcp__docs__get_readme'] });

      const notices = await migrate(folder, renames(), memory());

      expect(read(projectLocal).permissions).toEqual({ deny: ['mcp__docs__get_readme'] });
      expect(notices.map(renamedRuleNoticeKey)).toEqual([projectLocal]);
    });

    it('lists a retired tool rule in the project\u2019s personal Claude Code file, not the worktree\u2019s', async () => {
      const projectClaude = join(project, '.claude', 'settings.local.json');
      writeSettings(projectClaude, { deny: ['mcp__secret__get_passwords'] });
      writeSettings(join(folder, '.claude', 'settings.local.json'), { deny: ['mcp__secret__get_passwords'] });

      const notices = await migrate(folder, renames(), memory());

      expect(notices.map(renamedRuleNoticeKey)).toEqual([projectClaude]);
    });
  });
});

describe('renamed-rule notice memory across workspaces and replacements', () => {
  const folderB = join(fakeRoot, 'ws-b');
  const NOTICES_KEY = 'damocles.mcp.renamedToolRuleNotices';
  type State = ReturnType<typeof createFakePlatform>['state'];
  const docsRenames = (uri: string, legacy: ReadonlyMap<string, string> = new Map()): ToolRenames =>
    toolRenames(
      legacy,
      retiredResourceToolNames({
        userServers: ['secret'],
        visibleUserServers: ['secret'],
        folderServers: ['docs'],
        userTools: [],
        folderTools: [],
        retiredResources: {
          user: [{ serverName: 'secret', rawToolNames: [], resources: [{ uri: 'secret://passwords', name: 'passwords' }] }],
          folder: [{ serverName: 'docs', rawToolNames: [], resources: [{ uri, name: 'readme' }] }],
        },
      }),
    );
  const homeNotice = (uri: string): McpRenamedToolRuleNotice => ({
    path: owned.user(),
    displayPath: '~/.damocles/settings.json',
    rules: [{ old: 'mcp__docs__get_readme', new: `mcp__docs__read_mcp_resource(${uri})` }],
  });
  /** Two windows on one machine: a workspace state each, one global state. */
  const windows = (): { a: State; b: State } => {
    const a = createFakePlatform().state;
    return { a, b: { workspace: createFakePlatform().state.workspace, global: a.global } };
  };
  const inWindow = (state: State, at: string): MigrationMemory => ({ notices: renamedRuleNoticeMemory(state, at), additions: additionMemory() });

  it('shows a project server\u2019s notice in another workspace, with that workspace\u2019s replacement', async () => {
    writeSettings(owned.user(), { deny: ['mcp__docs__get_readme'] });
    const { a, b } = windows();

    await expect(showRun(folder, docsRenames('file:///a/README.md'), inWindow(a, folder))).resolves.toEqual([homeNotice('file:///a/README.md')]);
    await expect(showRun(folderB, docsRenames('file:///b/README.md'), inWindow(b, folderB))).resolves.toEqual([homeNotice('file:///b/README.md')]);
  });

  // Two clones of one repository give a project server the same URIs, and each workspace still needs its notice.
  it('remembers a project server\u2019s notice per workspace, even where the replacement reads the same', async () => {
    writeSettings(owned.user(), { deny: ['mcp__docs__get_readme'] });
    const { a, b } = windows();
    await showRun(folder, docsRenames('docs://readme'), inWindow(a, folder));

    await expect(showRun(folderB, docsRenames('docs://readme'), inWindow(b, folderB))).resolves.toEqual([homeNotice('docs://readme')]);
  });

  it('shows a user server\u2019s notice once across workspaces', async () => {
    const claude = join(fakeHome, '.claude', 'settings.json');
    writeSettings(claude, { deny: ['mcp__secret__get_passwords'] });
    const { a, b } = windows();

    await expect(showRun(folder, docsRenames('file:///a/README.md'), inWindow(a, folder))).resolves.toEqual([
      { path: claude, displayPath: '~/.claude/settings.json', rules: [{ old: 'mcp__secret__get_passwords', new: 'mcp__secret__read_mcp_resource(secret://passwords)' }] },
    ]);
    await expect(showRun(folderB, docsRenames('file:///b/README.md'), inWindow(b, folderB))).resolves.toEqual([]);
  });

  it('does not show a notice twice in one workspace', async () => {
    writeSettings(owned.user(), { deny: ['mcp__docs__get_readme'] });
    const { a } = windows();
    await showRun(folder, docsRenames('file:///a/README.md'), inWindow(a, folder));

    await expect(showRun(folder, docsRenames('file:///a/README.md'), inWindow(a, folder))).resolves.toEqual([]);
  });

  it('shows a rule again when its replacement changes, and never a replacement already shown', async () => {
    writeSettings(owned.user(), { deny: ['mcp__docs__get_readme'] });
    const { a } = windows();
    await showRun(folder, docsRenames('file:///a/README.md'), inWindow(a, folder));

    await expect(showRun(folder, docsRenames('file:///a/docs/README.md'), inWindow(a, folder))).resolves.toEqual([homeNotice('file:///a/docs/README.md')]);
    await expect(showRun(folder, docsRenames('file:///a/README.md'), inWindow(a, folder))).resolves.toEqual([]);
  });

  it('keeps entries remembered by rule alone quiet after an upgrade, until their replacement changes', async () => {
    const hooks = join(fakeHome, '.damocles', 'hooks.json');
    mkdirSync(dirname(hooks), { recursive: true });
    writeFileSync(hooks, JSON.stringify({ hooks: { tool_call: [{ match: OLD, command: 'x' }] } }), 'utf-8');
    const project = join(folder, '.damocles', 'settings.json');
    writeSettings(project, { deny: ['mcp__docs__get_readme'] });
    const state = createFakePlatform({
      globalState: { [NOTICES_KEY]: { [hooks]: [OLD] } },
      workspaceState: { [NOTICES_KEY]: { [project]: ['mcp__docs__get_readme'] } },
    }).state;

    await expect(showRun(folder, docsRenames('file:///a/README.md', context7Legacy()), inWindow(state, folder))).resolves.toEqual([]);

    await expect(showRun(folder, docsRenames('file:///a/docs/README.md', context7Legacy()), inWindow(state, folder))).resolves.toEqual([
      { path: project, displayPath: project, rules: [{ old: 'mcp__docs__get_readme', new: 'mcp__docs__read_mcp_resource(file:///a/docs/README.md)' }] },
    ]);
  });

  // Global state never recorded which workspace's replacement was shown.
  it('shows a project server\u2019s notice that global state holds by rule alone', async () => {
    writeSettings(owned.user(), { deny: ['mcp__docs__get_readme'] });
    const state = createFakePlatform({ globalState: { [NOTICES_KEY]: { [owned.user()]: ['mcp__docs__get_readme'] } } }).state;

    await expect(showRun(folder, docsRenames('file:///a/README.md'), inWindow(state, folder))).resolves.toEqual([homeNotice('file:///a/README.md')]);
  });
});
