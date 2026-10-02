import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

// Rows and examples of https://code.claude.com/docs/en/permissions.md, "Tool name wildcards" and "Read and Edit".
const { tmpRoot, fakeHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-cc-rules-')));
  return { tmpRoot: root, fakeHome: nodePath.join(root, 'home') };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { EvaluatorManager } from '../managers/evaluator-manager';
import { PermissionState } from '../state';
import type { McpToolIdentity } from '../types';
import type { PermissionBehavior } from '../../../shared/types/permissions';

const projects = path.join(tmpRoot, 'projects');
const ws = path.join(projects, 'app');
const otherProject = path.join(projects, 'other');
const outside = path.join(tmpRoot, 'outside');
const windows = process.platform === 'win32';

/** Claude Code's `//` absolute form of a native path: `C:\x` as `//c/x`, `/tmp/x` as `//tmp/x`. */
const abs = (native: string): string => {
  const slashed = native.split(path.sep).join('/');
  return `/${/^[A-Za-z]:\//.test(slashed) ? `/${slashed[0]!.toLowerCase()}${slashed.slice(2)}` : slashed}`;
};

type Source = 'project' | 'local' | 'user' | 'userDamocles';
const sourceFile: Record<Source, string> = {
  project: path.join(ws, '.claude', 'settings.json'),
  local: path.join(ws, '.claude', 'settings.local.json'),
  user: path.join(fakeHome, '.claude', 'settings.json'),
  userDamocles: path.join(fakeHome, '.damocles', 'settings.json'),
};
const settings = (source: Source, permissions: Partial<Record<PermissionBehavior, string[]>>): void => {
  fs.mkdirSync(path.dirname(sourceFile[source]), { recursive: true });
  fs.writeFileSync(sourceFile[source], JSON.stringify({ permissions }));
};

const evaluators: EvaluatorManager[] = [];
const evaluator = (): EvaluatorManager => {
  const state = new PermissionState();
  state.cwd = ws;
  const built = new EvaluatorManager(state, createFakePlatform());
  evaluators.push(built);
  return built;
};
/** The behavior of the rule a call on `file` matches, or null when no rule does. */
const rule = (tool: string, file: string): Promise<PermissionBehavior | null> =>
  evaluator().matchRule(tool, { file_path: file, content: 'x', prompt: 'x' }, ws);
const mcp = (server: string, tool: string): Promise<PermissionBehavior | null> => {
  const identity: McpToolIdentity = { server, tool };
  return evaluator().matchRule(`mcp__${server}__${tool}`, {}, ws, identity);
};

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
});
afterEach(() => {
  while (evaluators.length) evaluators.pop()!.dispose();
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Read and Edit: the four pattern types', () => {
  it('//path is an absolute path from the file system root', async () => {
    settings('user', { deny: [`Read(${abs(tmpRoot)}/alice/secrets/**)`] });
    expect(await rule('Read', path.join(tmpRoot, 'alice', 'secrets', 'k.txt'))).toBe('deny');
    expect(await rule('Read', path.join(tmpRoot, 'alice', 'k.txt'))).toBeNull();
  });

  it('~/path is a path from the home directory', async () => {
    settings('user', { deny: ['Read(~/Documents/*.pdf)'] });
    expect(await rule('Read', path.join(fakeHome, 'Documents', 'a.pdf'))).toBe('deny');
    expect(await rule('Read', path.join(fakeHome, 'Documents', 'sub', 'a.pdf'))).toBeNull();
    expect(await rule('Read', path.join(ws, 'Documents', 'a.pdf'))).toBeNull();
  });

  it('/path is relative to the settings source: <primary working directory>/src/**/*.ts in project settings', async () => {
    settings('project', { deny: ['Edit(/src/**/*.ts)'] });
    expect(await rule('Edit', path.join(ws, 'src', 'a', 'b.ts'))).toBe('deny');
    expect(await rule('Edit', path.join(ws, 'src', 'b.ts'))).toBe('deny');
    expect(await rule('Edit', path.join(ws, 'lib', 'src', 'b.ts'))).toBeNull();
  });

  it('path is relative to the current directory: Read(*.env) matches <cwd>/*.env', async () => {
    settings('user', { deny: ['Read(*.env)'] });
    expect(await rule('Read', path.join(ws, 'a.env'))).toBe('deny');
    expect(await rule('Read', path.join(projects, 'a.env'))).toBeNull();
  });

  it('./path is the same rule type as path', async () => {
    settings('user', { deny: ['Read(./.env)'] });
    expect(await rule('Read', path.join(ws, '.env'))).toBe('deny');
    expect(await rule('Read', path.join(projects, '.env'))).toBeNull();
  });

  it('a single leading slash is not an absolute path: /Users/alice/file anchors at the settings source', async () => {
    const single = abs(tmpRoot).slice(1);
    settings('project', { deny: [`Read(${single}/alice/file)`] });
    expect(await rule('Read', path.join(tmpRoot, 'alice', 'file'))).toBeNull();
    expect(await rule('Read', path.join(ws, ...single.split('/'), 'alice', 'file'))).toBe('deny');
  });
});

describe('Read and Edit: where a /path pattern resolves', () => {
  it('project settings at .claude/settings.json: <primary working directory>/path', async () => {
    settings('project', { deny: ['Read(/notes/**)'] });
    expect(await rule('Read', path.join(ws, 'notes', 'a.txt'))).toBe('deny');
    expect(await rule('Read', path.join(ws, '.claude', 'notes', 'a.txt'))).toBeNull();
  });

  it('local settings at .claude/settings.local.json: <primary working directory>/path', async () => {
    settings('local', { deny: ['Read(/notes/**)'] });
    expect(await rule('Read', path.join(ws, 'notes', 'a.txt'))).toBe('deny');
    expect(await rule('Read', path.join(ws, '.claude', 'notes', 'a.txt'))).toBeNull();
  });

  it('user settings at ~/.claude/settings.json: ~/.claude/path', async () => {
    settings('user', { deny: ['Read(/notes/**)'] });
    expect(await rule('Read', path.join(fakeHome, '.claude', 'notes', 'a.txt'))).toBe('deny');
    expect(await rule('Read', path.join(ws, 'notes', 'a.txt'))).toBeNull();
  });

  it('Damocles user settings at ~/.damocles/settings.json: ~/.damocles/path', async () => {
    settings('userDamocles', { deny: ['Read(/notes/**)'] });
    expect(await rule('Read', path.join(fakeHome, '.damocles', 'notes', 'a.txt'))).toBe('deny');
    expect(await rule('Read', path.join(ws, 'notes', 'a.txt'))).toBeNull();
  });

  it('Read(/secrets/**) in user settings blocks ~/.claude/secrets/**, not a secrets directory in the project', async () => {
    settings('user', { deny: ['Read(/secrets/**)'] });
    expect(await rule('Read', path.join(fakeHome, '.claude', 'secrets', 'k'))).toBe('deny');
    expect(await rule('Read', path.join(ws, 'secrets', 'k'))).toBeNull();
  });

  it('a // or ~/ rule in user settings applies inside every project', async () => {
    settings('user', { deny: ['Read(//**/secrets/**)', 'Read(~/.aws/**)'] });
    expect(await rule('Read', path.join(otherProject, 'secrets', 'k'))).toBe('deny');
    expect(await rule('Read', path.join(fakeHome, '.aws', 'credentials'))).toBe('deny');
  });
});

describe('Read and Edit: Windows paths are matched in POSIX form', () => {
  it.runIf(windows)('C:\\Users\\alice becomes /c/Users/alice, so //c/**/.env matches .env files anywhere on that drive', async () => {
    settings('user', { deny: [`Read(//${tmpRoot[0]!.toLowerCase()}/**/.env)`] });
    expect(await rule('Read', path.join(outside, 'deep', '.env'))).toBe('deny');
    expect(await rule('Read', path.join(outside, 'deep', 'x.env'))).toBeNull();
  });

  it('//**/.env matches across all drives', async () => {
    settings('user', { deny: ['Read(//**/.env)'] });
    expect(await rule('Read', path.join(outside, 'deep', '.env'))).toBe('deny');
    expect(await rule('Read', path.join(fakeHome, '.env'))).toBe('deny');
  });

  it.runIf(windows)('//**/.env matches a .env on a UNC share, which is //server/share in POSIX form', async () => {
    settings('user', { deny: ['Read(//**/.env)', 'Read(//localhost/zznosuchshare/keys/**)'] });
    expect(await rule('Read', '\\\\localhost\\zznosuchshare\\x\\.env')).toBe('deny');
    expect(await rule('Read', '\\\\localhost\\zznosuchshare\\keys\\a')).toBe('deny');
  });

  it.runIf(windows)('//tmp is /tmp, not C:\\tmp, which is //c/tmp', async () => {
    const drive = tmpRoot.slice(0, 3);
    settings('user', { deny: ['Edit(//zz-dam-no-such-dir/scratch.txt)'] });
    expect(await rule('Edit', path.join(drive, 'zz-dam-no-such-dir', 'scratch.txt'))).toBeNull();
    settings('user', { deny: [`Edit(//${drive[0]!.toLowerCase()}/zz-dam-no-such-dir/scratch.txt)`] });
    expect(await rule('Edit', path.join(drive, 'zz-dam-no-such-dir', 'scratch.txt'))).toBe('deny');
  });
});

describe('Read and Edit: examples', () => {
  it('Edit(/docs/**): edits in <primary working directory>/docs/, not /docs/ or <primary working directory>/.claude/docs/', async () => {
    settings('project', { deny: ['Edit(/docs/**)'] });
    expect(await rule('Edit', path.join(ws, 'docs', 'a.md'))).toBe('deny');
    expect(await rule('Edit', path.resolve('/docs/a.md'))).toBeNull();
    expect(await rule('Edit', path.join(ws, '.claude', 'docs', 'a.md'))).toBeNull();
  });

  it('Read(~/.zshrc): reads your home directory\'s .zshrc', async () => {
    settings('user', { deny: ['Read(~/.zshrc)'] });
    expect(await rule('Read', path.join(fakeHome, '.zshrc'))).toBe('deny');
    expect(await rule('Read', path.join(ws, '.zshrc'))).toBeNull();
    expect(await rule('Read', path.join(fakeHome, 'sub', '.zshrc'))).toBeNull();
  });

  it('Edit(//tmp/scratch.txt): edits the absolute path /tmp/scratch.txt', async () => {
    settings('user', { deny: [`Edit(${abs(tmpRoot)}/tmp/scratch.txt)`] });
    expect(await rule('Edit', path.join(tmpRoot, 'tmp', 'scratch.txt'))).toBe('deny');
    expect(await rule('Edit', path.join(ws, 'tmp', 'scratch.txt'))).toBeNull();
  });

  it('Read(src/**) as an allow rule reads from <current-directory>/src/ only', async () => {
    settings('user', { allow: ['Read(src/**)'] });
    expect(await rule('Read', path.join(ws, 'src', 'a.ts'))).toBe('allow');
    expect(await rule('Read', path.join(ws, 'lib', 'src', 'a.ts'))).toBeNull();
  });

  it('Read(src/**) as a deny or ask rule matches a src directory at any depth under the current directory', async () => {
    for (const behavior of ['deny', 'ask'] as const) {
      settings('user', { [behavior]: ['Read(src/**)'] });
      expect(await rule('Read', path.join(ws, 'src', 'a.ts'))).toBe(behavior);
      expect(await rule('Read', path.join(ws, 'lib', 'src', 'a.ts'))).toBe(behavior);
    }
  });
});

describe('Read and Edit: a rule only matches files under its anchor', () => {
  it('Read(.env) or Read(**/.env) blocks any .env at or under the current directory', async () => {
    for (const pattern of ['.env', '**/.env']) {
      settings('user', { deny: [`Read(${pattern})`] });
      expect(await rule('Read', path.join(ws, '.env')), pattern).toBe('deny');
      expect(await rule('Read', path.join(ws, 'a', 'b', '.env')), pattern).toBe('deny');
    }
  });

  it('Read(.env) or Read(**/.env) does not block .env in a parent directory or another project', async () => {
    for (const pattern of ['.env', '**/.env']) {
      settings('user', { deny: [`Read(${pattern})`] });
      expect(await rule('Read', path.join(projects, '.env')), pattern).toBeNull();
      expect(await rule('Read', path.join(otherProject, '.env')), pattern).toBeNull();
    }
  });

  it('Read(//**/.env) blocks any .env anywhere on the filesystem', async () => {
    settings('user', { deny: ['Read(//**/.env)'] });
    for (const file of [path.join(ws, '.env'), path.join(projects, '.env'), path.join(otherProject, '.env'), path.join(fakeHome, '.env')]) {
      expect(await rule('Read', file), file).toBe('deny');
    }
  });

  it('a bare filename allow rule approves at any depth under the cwd, never above it', async () => {
    settings('user', { allow: ['Edit(*.md)'] });
    expect(await rule('Edit', path.join(ws, 'a.md'))).toBe('allow');
    expect(await rule('Edit', path.join(ws, 'docs', 'a.md'))).toBe('allow');
    expect(await rule('Edit', path.join(projects, 'a.md'))).toBeNull();
  });

  it('a relative deny or ask rule does not match outside the cwd', async () => {
    for (const behavior of ['deny', 'ask'] as const) {
      settings('user', { [behavior]: ['Read(secrets/**)', 'Read(config.json)'] });
      expect(await rule('Read', path.join(outside, 'secrets', 'k'))).toBeNull();
      expect(await rule('Read', path.join(otherProject, 'config.json'))).toBeNull();
    }
  });
});

describe('Read and Edit: a single-segment directory pattern', () => {
  it('Allow rules: Edit(src/**) matches only <cwd>/src and the files under it', async () => {
    settings('user', { allow: ['Edit(src/**)'] });
    expect(await rule('Edit', path.join(ws, 'src', 'a', 'b.ts'))).toBe('allow');
    expect(await rule('Edit', path.join(ws, 'pkg', 'src', 'b.ts'))).toBeNull();
  });

  it('Allow rules: Edit(**/src/**) allows a directory name at any depth', async () => {
    settings('user', { allow: ['Edit(**/src/**)'] });
    expect(await rule('Edit', path.join(ws, 'pkg', 'src', 'b.ts'))).toBe('allow');
  });

  it('Deny and ask rules: Read(secrets/**) matches a directory named secrets at any depth under the current directory', async () => {
    for (const behavior of ['deny', 'ask'] as const) {
      settings('user', { [behavior]: ['Read(secrets/**)'] });
      expect(await rule('Read', path.join(ws, 'secrets', 'k'))).toBe(behavior);
      expect(await rule('Read', path.join(ws, 'a', 'b', 'secrets', 'k'))).toBe(behavior);
    }
  });

  it('src/*.ts is a single-segment directory pattern too', async () => {
    settings('user', { deny: ['Edit(src/*.ts)'] });
    expect(await rule('Edit', path.join(ws, 'pkg', 'src', 'a.ts'))).toBe('deny');
    settings('user', { allow: ['Edit(src/*.ts)'] });
    expect(await rule('Edit', path.join(ws, 'src', 'a.ts'))).toBe('allow');
    expect(await rule('Edit', path.join(ws, 'pkg', 'src', 'a.ts'))).toBeNull();
  });

  it('Every other pattern shape matches at the same depth in every rule type: Edit(/src/**) and Edit(src/components/**) only at their anchored location', async () => {
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      settings('project', { [behavior]: ['Edit(/src/**)', 'Edit(src/components/**)'] });
      expect(await rule('Edit', path.join(ws, 'src', 'a.ts')), behavior).toBe(behavior);
      expect(await rule('Edit', path.join(ws, 'pkg', 'src', 'a.ts')), behavior).toBeNull();
      expect(await rule('Edit', path.join(ws, 'pkg', 'src', 'components', 'a.ts')), behavior).toBeNull();
    }
  });

  it('a pattern ending only in / follows gitignore and matches that folder at any depth in every rule type', async () => {
    for (const behavior of ['allow', 'deny'] as const) {
      settings('user', { [behavior]: ['Edit(build/)'] });
      expect(await rule('Edit', path.join(ws, 'pkg', 'build', 'a.js')), behavior).toBe(behavior);
    }
  });
});

describe('Read and Edit: each pattern shape against src/app.ts and vendor/pkg/src/lib.js', () => {
  const app = path.join(ws, 'src', 'app.ts');
  const lib = path.join(ws, 'vendor', 'pkg', 'src', 'lib.js');

  it('Edit(src/**) as an allow rule: Yes, No', async () => {
    settings('user', { allow: ['Edit(src/**)'] });
    expect(await rule('Edit', app)).toBe('allow');
    expect(await rule('Edit', lib)).toBeNull();
  });

  it('Edit(src/**) as a deny or ask rule: Yes, Yes', async () => {
    for (const behavior of ['deny', 'ask'] as const) {
      settings('user', { [behavior]: ['Edit(src/**)'] });
      expect(await rule('Edit', app)).toBe(behavior);
      expect(await rule('Edit', lib)).toBe(behavior);
    }
  });

  it('Edit(/src/**) in any rule type: Yes, No', async () => {
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      settings('project', { [behavior]: ['Edit(/src/**)'] });
      expect(await rule('Edit', app)).toBe(behavior);
      expect(await rule('Edit', lib)).toBeNull();
    }
  });

  it('Edit(**/src/**) in any rule type: Yes, Yes', async () => {
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      settings('user', { [behavior]: ['Edit(**/src/**)'] });
      expect(await rule('Edit', app)).toBe(behavior);
      expect(await rule('Edit', lib)).toBe(behavior);
    }
  });
});

describe('Read and Edit: escaping', () => {
  it('Edit(./Finance (2024)/**) matches the Finance (2024) folder as spelled', async () => {
    settings('user', { allow: ['Edit(./Finance (2024)/**)'] });
    expect(await rule('Edit', path.join(ws, 'Finance (2024)', 'q1.xlsx'))).toBe('allow');
    expect(await rule('Edit', path.join(ws, 'Finance 2024', 'q1.xlsx'))).toBeNull();
  });

  it('an escaped gitignore character matches only the literal path, and an unescaped one is a pattern', async () => {
    settings('user', { deny: ['Read(\\[2024-06\\] Reports/**)'] });
    expect(await rule('Read', path.join(ws, '[2024-06] Reports', 'a.pdf'))).toBe('deny');
    expect(await rule('Read', path.join(ws, '2 Reports', 'a.pdf'))).toBeNull();
    settings('user', { deny: ['Read([2024-06] Reports/**)'] });
    expect(await rule('Read', path.join(ws, '[2024-06] Reports', 'a.pdf'))).toBeNull();
    expect(await rule('Read', path.join(ws, '2 Reports', 'a.pdf'))).toBe('deny');
  });
});

describe('Read and Edit: a path that is not a usable gitignore pattern', () => {
  it('a deny or ask rule still guards that exact path', async () => {
    for (const behavior of ['deny', 'ask'] as const) {
      settings('user', { [behavior]: ['Read(#private.txt)'] });
      expect(await rule('Read', path.join(ws, '#private.txt'))).toBe(behavior);
      expect(await rule('Read', path.join(ws, 'sub', '#private.txt'))).toBeNull();
    }
  });

  it.runIf(windows)('on Windows a deny rule ending in a lone \\ guards that exact path, the folder it names', async () => {
    settings('user', { deny: ['Read(vaultdir\\)'] });
    expect(await rule('Read', path.join(ws, 'vaultdir'))).toBe('deny');
    expect(await rule('Read', `${path.join(ws, 'vaultdir')}\\`)).toBe('deny');
    expect(await rule('Read', path.join(ws, 'sub', 'vaultdir'))).toBeNull();
  });

  it('an allow rule with an unusable pattern does not approve anything', async () => {
    settings('user', { allow: ['Edit(#notes.md)'] });
    expect(await rule('Edit', path.join(ws, '#notes.md'))).toBeNull();
  });

  it('a pattern git gives up on, such as an unclosed bracket, still guards that exact path as a deny rule', async () => {
    settings('user', { deny: ['Read(a[)', 'Read(~/notes/b[)'], allow: ['Edit(c[)'] });
    expect(await rule('Read', path.join(ws, 'a['))).toBe('deny');
    expect(await rule('Read', path.join(ws, 'sub', 'a['))).toBeNull();
    expect(await rule('Read', path.join(fakeHome, 'notes', 'b['))).toBe('deny');
    expect(await rule('Edit', path.join(ws, 'c['))).toBeNull();
  });
});

describe('Read and Edit: negation with !', () => {
  it('Read(*.env) followed by Read(!sample.env) blocks every .env file at any depth except files named sample.env', async () => {
    settings('user', { deny: ['Read(*.env)', 'Read(!sample.env)'] });
    expect(await rule('Read', path.join(ws, 'a.env'))).toBe('deny');
    expect(await rule('Read', path.join(ws, 'sub', 'b.env'))).toBe('deny');
    expect(await rule('Read', path.join(ws, 'sample.env'))).toBeNull();
    expect(await rule('Read', path.join(ws, 'sub', 'sample.env'))).toBeNull();
  });

  it('carves out of an ask list the same way', async () => {
    settings('user', { ask: ['Read(*.env)', 'Read(!sample.env)'] });
    expect(await rule('Read', path.join(ws, 'a.env'))).toBe('ask');
    expect(await rule('Read', path.join(ws, 'sample.env'))).toBeNull();
  });

  it('a ! rule listed first carves nothing out', async () => {
    settings('user', { deny: ['Read(!sample.env)', 'Read(*.env)'] });
    expect(await rule('Read', path.join(ws, 'sample.env'))).toBe('deny');
  });

  it('the carve-out reaches only rules from the same source', async () => {
    settings('user', { deny: ['Read(./.env)'] });
    settings('project', { deny: ['Read(!.env)'] });
    expect(await rule('Read', path.join(ws, '.env'))).toBe('deny');
  });

  it('the carve-out reaches only the list it is in and rules for the same tool', async () => {
    settings('user', { deny: ['Read(*.env)', 'Edit(!sample.env)'], ask: ['Read(!sample.env)'] });
    expect(await rule('Read', path.join(ws, 'sample.env'))).toBe('deny');
  });

  it('Read(!~/notes/public/**) carves nothing out of Read(~/notes/**)', async () => {
    settings('user', { deny: ['Read(~/notes/**)', 'Read(!~/notes/public/**)'] });
    expect(await rule('Read', path.join(fakeHome, 'notes', 'public', 'a.md'))).toBe('deny');
  });

  it('a ! pattern followed by / or // carves nothing out of a rule anchored with that prefix', async () => {
    settings('project', { deny: ['Read(/notes/**)', 'Read(!/notes/public/**)', `Read(${abs(outside)}/**)`, `Read(!${abs(outside)}/public/**)`] });
    expect(await rule('Read', path.join(ws, 'notes', 'public', 'a.md'))).toBe('deny');
    expect(await rule('Read', path.join(outside, 'public', 'a.md'))).toBe('deny');
    settings('project', { deny: ['Read(/*/private/**)', 'Read(!/x/private/**)'] });
    expect(await rule('Read', path.join(ws, 'x', 'private', 'a.md'))).toBe('deny');
  });

  it('a ! pattern is read relative to the current directory even when / follows the !', async () => {
    settings('user', { deny: ['Read(*.env)', 'Read(!/sample.env)'] });
    expect(await rule('Read', path.join(ws, 'sample.env'))).toBeNull();
    expect(await rule('Read', path.join(ws, 'sub', 'sample.env'))).toBe('deny');
  });

  it('with Read(secrets/**) and Read(!secrets/public/**), secrets/public stays blocked along with the rest of secrets', async () => {
    settings('user', { deny: ['Read(secrets/**)', 'Read(!secrets/public/**)'] });
    expect(await rule('Read', path.join(ws, 'secrets', 'public', 'a.md'))).toBe('deny');
    expect(await rule('Read', path.join(ws, 'secrets', 'k'))).toBe('deny');
  });

  it('an allow rule starting with ! approves nothing', async () => {
    settings('user', { allow: ['Edit(!secrets/**)'] });
    expect(await rule('Edit', path.join(ws, 'a.ts'))).toBeNull();
  });
});

describe('Read and Edit: a Read deny rule also blocks the Edit and Write tools on the same path', () => {
  it('Edit, Write and GenerateImage, including creating a new file there', async () => {
    fs.mkdirSync(path.join(ws, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'secrets', 'k.txt'), 'x');
    settings('user', { deny: ['Read(secrets/**)'] });
    expect(await rule('Edit', path.join(ws, 'secrets', 'k.txt'))).toBe('deny');
    expect(await rule('Write', path.join(ws, 'secrets', 'new.txt'))).toBe('deny');
    expect(await rule('GenerateImage', path.join(ws, 'secrets', 'new.png'))).toBe('deny');
    expect(await rule('Write', path.join(ws, 'src', 'new.txt'))).toBeNull();
  });

  it('a Write(path) allow rule is never consulted, so it approves nothing; Edit(path) approves Write', async () => {
    settings('user', { allow: ['Write(docs/**)'] });
    expect(await rule('Write', path.join(ws, 'docs', 'a.md'))).toBeNull();
    settings('user', { allow: ['Edit(docs/**)'] });
    expect(await rule('Write', path.join(ws, 'docs', 'a.md'))).toBe('allow');
  });

  it('a Read ask or allow rule does not extend to edits', async () => {
    settings('user', { ask: ['Read(secrets/**)'], allow: ['Read(src/**)'] });
    expect(await rule('Edit', path.join(ws, 'secrets', 'k.txt'))).toBeNull();
    expect(await rule('Edit', path.join(ws, 'src', 'a.ts'))).toBeNull();
  });
});

/** Whether this host can create a directory link without elevation (a junction on Windows). */
const canLink = (() => {
  const probe = path.join(tmpRoot, 'link-probe');
  try {
    fs.symlinkSync(tmpRoot, probe, 'junction');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(canLink)('Read and Edit: symlinks', () => {
  const link = (target: string, at: string): void => {
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, 'junction');
  };

  it('with Read(./project/**) allowed and Read(~/.ssh/**) denied, a link in ./project pointing into ~/.ssh is blocked', async () => {
    link(path.join(fakeHome, '.ssh'), path.join(ws, 'project', 'keys'));
    settings('user', { allow: ['Read(./project/**)'], deny: ['Read(~/.ssh/**)'] });
    expect(await rule('Read', path.join(ws, 'project', 'keys', 'id_rsa'))).toBe('deny');
  });

  it('Allow rules: a read through a symlink inside an allowed directory that points outside it does not match the rule', async () => {
    link(outside, path.join(ws, 'project', 'out'));
    settings('user', { allow: ['Read(./project/**)'] });
    expect(await rule('Read', path.join(ws, 'project', 'out', 'x.txt'))).toBeNull();
    expect(await rule('Read', path.join(ws, 'project', 'x.txt'))).toBe('allow');
  });

  it('Deny rules: apply when the requested path matches, wherever it resolves to', async () => {
    link(outside, path.join(ws, 'project', 'out'));
    settings('user', { deny: ['Read(./project/**)'] });
    expect(await rule('Read', path.join(ws, 'project', 'out', 'x.txt'))).toBe('deny');
  });

  it('Writes through a symlink: a write inside the cwd that resolves outside it is not auto-approved in acceptEdits mode', async () => {
    link(outside, path.join(ws, 'out'));
    const state = new PermissionState();
    state.cwd = ws;
    state.permissionMode = 'acceptEdits';
    const acceptEdits = new EvaluatorManager(state, createFakePlatform());
    evaluators.push(acceptEdits);
    for (const tool of ['Edit', 'Write', 'GenerateImage']) {
      expect(await acceptEdits.evaluate(tool, { file_path: path.join(ws, 'out', 'new.txt'), prompt: 'x' }, ws), tool).toBe('ask');
      expect(await acceptEdits.evaluate(tool, { file_path: path.join(ws, 'plain', 'new.txt'), prompt: 'x' }, ws), tool).toBe('allow');
    }
  });

  it('a deny or ask rule written through a symlinked directory with a ~/, / or // pattern also applies at its real location', async () => {
    link(path.join(outside, 'home-real'), path.join(fakeHome, 'linked'));
    link(path.join(outside, 'ws-real'), path.join(ws, 'linked'));
    link(path.join(outside, 'abs-real'), path.join(tmpRoot, 'abs-linked'));
    settings('user', { deny: ['Read(~/linked/**)'] });
    expect(await rule('Read', path.join(outside, 'home-real', 'x'))).toBe('deny');
    settings('project', { ask: ['Read(/linked/**)', `Read(${abs(path.join(tmpRoot, 'abs-linked'))}/**)`] });
    expect(await rule('Read', path.join(outside, 'ws-real', 'x'))).toBe('ask');
    expect(await rule('Read', path.join(outside, 'abs-real', 'x'))).toBe('ask');
  });
});

const shortName = (target: string): string => execSync(`for %I in ("${target}") do @echo %~sI`, { shell: 'cmd.exe', encoding: 'utf8' }).trim();
/** Whether the temp volume gives a long folder name an 8.3 alias. */
const hasShortNames = windows && (() => {
  const probe = fs.mkdtempSync(path.join(path.dirname(tmpRoot), 'dam-cc-83-'));
  const longDir = path.join(probe, 'Long Directory Name');
  fs.mkdirSync(longDir);
  const aliased = shortName(longDir) !== longDir;
  fs.rmSync(probe, { recursive: true, force: true });
  return aliased;
})();

describe.runIf(hasShortNames)('Read and Edit: 8.3 short names', () => {
  it('a relative deny rule written with a folder\'s 8.3 name covers its long spelling, and still only under the cwd', async () => {
    const longDir = path.join(ws, 'Long Directory Name');
    fs.mkdirSync(longDir, { recursive: true });
    settings('user', { deny: [`Read(${path.basename(shortName(longDir))}/**)`] });
    expect(await rule('Read', path.join(longDir, 'a.txt'))).toBe('deny');
    expect(await rule('Read', path.join(outside, 'Long Directory Name', 'a.txt'))).toBeNull();
  });
});

describe('Tool name wildcards', () => {
  it('"*" as a deny or ask rule matches every tool', async () => {
    for (const behavior of ['deny', 'ask'] as const) {
      settings('user', { [behavior]: ['*'] });
      expect(await evaluator().matchRule('Bash', { command: 'ls' }, ws)).toBe(behavior);
      expect(await rule('Read', path.join(ws, 'a.txt'))).toBe(behavior);
      expect(await mcp('github', 'get_issue')).toBe(behavior);
    }
  });

  it('"mcp__*" as a deny or ask rule matches every MCP tool across all servers', async () => {
    for (const behavior of ['deny', 'ask'] as const) {
      settings('user', { [behavior]: ['mcp__*'] });
      expect(await mcp('github', 'get_issue')).toBe(behavior);
      expect(await mcp('puppeteer', 'navigate')).toBe(behavior);
      expect(await evaluator().matchRule('Bash', { command: 'ls' }, ws)).toBeNull();
    }
  });

  it('a deny glob must match the full tool name', async () => {
    settings('user', { deny: ['Bas*', 'mcp__git*__get_*'] });
    expect(await evaluator().matchRule('Bash', { command: 'ls' }, ws)).toBe('deny');
    expect(await rule('Read', path.join(ws, 'a.txt'))).toBeNull();
    expect(await mcp('github', 'get_issue')).toBe('deny');
    expect(await mcp('github', 'list_issues')).toBeNull();
    expect(await mcp('gitlab', 'get_mr')).toBe('deny');
  });

  it('mcp__puppeteer__* as an allow rule matches every tool from the puppeteer server', async () => {
    settings('user', { allow: ['mcp__puppeteer__*'] });
    expect(await mcp('puppeteer', 'navigate')).toBe('allow');
    expect(await mcp('github', 'get_issue')).toBeNull();
  });

  it('mcp__github__get_* as an allow rule matches its get_ tools', async () => {
    settings('user', { allow: ['mcp__github__get_*'] });
    expect(await mcp('github', 'get_issue')).toBe('allow');
    expect(await mcp('github', 'list_issues')).toBeNull();
    expect(await mcp('githubx', 'get_issue')).toBeNull();
  });

  it('an unanchored allow glob such as "*", "B*" or "mcp__*" does not auto-approve anything', async () => {
    settings('user', { allow: ['*', 'B*', 'mcp__*'] });
    expect(await evaluator().matchRule('Bash', { command: 'ls' }, ws)).toBeNull();
    expect(await mcp('github', 'get_issue')).toBeNull();
  });

  it('an allow glob whose server segment is not literal does not auto-approve anything', async () => {
    settings('user', { allow: ['mcp__git*__get_issue', 'mcp__*__get_issue'] });
    expect(await mcp('github', 'get_issue')).toBeNull();
  });
});
