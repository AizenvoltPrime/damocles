import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { PermissionHandler } from '../index';
import type { McpToolIdentity } from '../types';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { runPermissionGate, type GatePermissionContext, type PanelGateContext } from '../../pi-session/permission-gate';
import { createDamoclesExtensionFactory } from '../../pi-session/damocles-extension';
import { createMcpToolName } from '../../pi-session/mcp/naming';
import { DAMOCLES_PLANS_DIR, isPlanFilePath } from '../../paths';
import { POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

const HOME = os.homedir();
const WS = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-rule-ws-')));
const OUTSIDE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-rule-out-')));
const windows = process.platform === 'win32';

const writeSettings = (dir: string, file: string, permissions: object): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ permissions }));
};
const setUser = (p: object): void => writeSettings(path.join(HOME, '.damocles'), 'settings.json', p);
const setProject = (p: object): void => writeSettings(path.join(WS, '.damocles'), 'settings.json', p);
const handler = (): PermissionHandler => {
  const h = new PermissionHandler(createFakePlatform());
  h.setCwd(WS);
  h.setWorkspacePath(WS);
  return h;
};
const ev = (toolName: string, input: object, toolCallId = 'c1'): ToolCallEvent => ({ type: 'tool_call', toolName, toolCallId, input }) as unknown as ToolCallEvent;
const gate = (h: PermissionHandler, toolName: string, input: object, extra: Partial<GatePermissionContext> = {}) =>
  runPermissionGate(ev(toolName, input), { permissionHandler: h, isPlanMode: () => false, ...extra }, undefined);
/** Claude Code's `//` absolute form of a native path: `C:\x` as `//c/x`, `/tmp/x` as `//tmp/x`. */
const abs = (native: string): string => {
  const slashed = native.split(path.sep).join('/');
  return `/${/^[A-Za-z]:\//.test(slashed) ? `/${slashed[0]!.toLowerCase()}${slashed.slice(2)}` : slashed}`;
};
const write = (file: string, content = 'x'): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const canLink = (() => {
  const probe = path.join(OUTSIDE, 'link-probe');
  try {
    fs.symlinkSync(OUTSIDE, probe, 'junction');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();
const canFileLink = (() => {
  const probe = path.join(OUTSIDE, 'file-link-probe');
  try {
    fs.symlinkSync(path.join(OUTSIDE, 'missing'), probe, 'file');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  fs.rmSync(path.join(HOME, '.damocles', 'settings.json'), { force: true });
  fs.rmSync(path.join(HOME, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(WS, '.damocles'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

describe('Read rules cover Grep, Glob and Ls', () => {
  it('a Read deny on a file blocks a search of that file and a search whose glob or pattern names it', async () => {
    setUser({ deny: ['Read(secret.txt)'] });
    const h = handler();
    for (const [tool, input] of [
      ['grep', { pattern: 'x', path: 'secret.txt' }],
      ['grep', { pattern: 'x', glob: 'secret.txt' }],
      ['find', { pattern: 'secret.txt' }],
      ['find', { pattern: '**/secret.txt', path: 'sub' }],
    ] as const) {
      const result = await gate(h, tool, input);
      expect(result?.block, `${tool} ${JSON.stringify(input)}`).toBe(true);
      expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    }
    expect(await gate(h, 'grep', { pattern: 'x', glob: '*.ts' })).toBeUndefined();
  });

  it('a Read deny on a folder blocks a search rooted at it or inside it', async () => {
    setUser({ deny: ['Read(secrets/**)'] });
    const h = handler();
    for (const [tool, input] of [
      ['grep', { pattern: 'x', path: 'secrets' }],
      ['find', { pattern: '*', path: 'secrets' }],
      ['ls', { path: 'secrets' }],
      ['ls', { path: path.join(WS, 'secrets', 'sub') }],
    ] as const) {
      expect((await gate(h, tool, input))?.block, `${tool} ${JSON.stringify(input)}`).toBe(true);
    }
  });

  it('a Read ask rule prompts for a search rooted at the folder', async () => {
    setUser({ ask: ['Read(secrets/**)'] });
    const h = handler();
    const prompted: string[] = [];
    h.setPostMessage((msg: ExtensionToWebviewMessage) => {
      if (msg.type !== 'requestPermission') return;
      prompted.push(msg.toolName);
      void h.resolveApproval(msg.toolUseId, true);
    });
    expect(await gate(h, 'ls', { path: 'secrets' })).toBeUndefined();
    expect(prompted).toEqual(['Ls']);
  });

  it('a search rooted above a covered folder runs, and the filter Grep and Glob apply covers the folder\'s files', async () => {
    setUser({ deny: ['Read(secrets/**)'], ask: ['Read(*.pem)'] });
    const h = handler();
    expect(await gate(h, 'grep', { pattern: 'x' })).toBeUndefined();
    expect(await gate(h, 'find', { pattern: '*.ts' })).toBeUndefined();
    expect(await gate(h, 'ls', {})).toBeUndefined();
    const covered = await h.readRuleFilter();
    expect(covered(path.join(WS, 'secrets', 'k.txt'))).toBe(true);
    expect(covered(path.join(WS, 'deep', 'secrets', 'k.txt'))).toBe(true);
    expect(covered(path.join(WS, 'certs', 'key.pem'))).toBe(true);
    expect(covered(path.join(WS, 'notes.txt'))).toBe(false);
  });

  it('a Read allow rule never applies to a search, and under YOLO nothing is covered', async () => {
    setUser({ allow: ['Read(secrets/**)'], deny: ['Read(secrets/**)'] });
    const h = handler();
    h.setDangerouslySkipPermissions(true);
    expect(await gate(h, 'ls', { path: 'secrets' })).toBeUndefined();
    expect((await h.readRuleFilter())(path.join(WS, 'secrets', 'k.txt'))).toBe(false);
  });
});

describe('an Edit rule covers every tool that edits files', () => {
  it('Write and GenerateImage, with or without a path', async () => {
    setUser({ deny: ['Edit(secrets/**)'] });
    expect(await handler().matchRule('Write', { file_path: 'secrets/key.txt' })).toBe('deny');
    expect(await handler().matchRule('GenerateImage', { file_path: 'secrets/k.png', prompt: 'x' })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: 'secrets/key.txt' })).toBeNull();
    setUser({ ask: ['Edit'] });
    expect(await handler().matchRule('Write', { file_path: 'a.txt' })).toBe('ask');
    setUser({ allow: ['Edit(src/**)'] });
    expect(await handler().evaluatePermission('Write', { file_path: 'src/a.ts', content: 'x' })).toBe('allow');
    expect(await handler().evaluatePermission('Write', { file_path: 'lib/a.ts', content: 'x' })).toBe('ask');
  });
});

describe('the four path forms', () => {
  it('/path in a project settings file is relative to the project folder', async () => {
    setProject({ deny: ['Read(/secrets/**)'] });
    expect(await handler().matchRule('Read', { file_path: 'secrets/k.txt' })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: path.join(WS, 'secrets', 'k.txt') })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: 'vendor/secrets/k.txt' })).toBeNull();
    expect(await handler().matchRule('Read', { file_path: path.join(HOME, '.damocles', 'secrets', 'k.txt') })).toBeNull();
  });

  it('/path in ~/.damocles/settings.json is relative to ~/.damocles, and in ~/.claude/settings.json to ~/.claude', async () => {
    setUser({ deny: ['Read(/secrets/**)'] });
    expect(await handler().matchRule('Read', { file_path: path.join(HOME, '.damocles', 'secrets', 'k.txt') })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: 'secrets/k.txt' })).toBeNull();
    fs.rmSync(path.join(HOME, '.damocles', 'settings.json'));
    writeSettings(path.join(HOME, '.claude'), 'settings.json', { deny: ['Read(/secrets/**)'] });
    expect(await handler().matchRule('Read', { file_path: '~/.claude/secrets/k.txt' })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: 'secrets/k.txt' })).toBeNull();
  });

  it('//path is absolute, and //**/name matches at any depth from the root', async () => {
    setUser({ deny: [`Read(${abs(OUTSIDE)}/**)`] });
    expect(await handler().matchRule('Read', { file_path: path.join(OUTSIDE, 'x.txt') })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: path.join(WS, 'x.txt') })).toBeNull();
    setUser({ deny: ['Read(//**/.env)'] });
    expect(await handler().matchRule('Read', { file_path: path.join(OUTSIDE, 'deep', '.env') })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: path.join(OUTSIDE, 'deep', 'x.env') })).toBeNull();
  });

  it('a /path or //path allow rule allows only inside the cwd', async () => {
    setProject({ allow: ['Edit(/src/**)'] });
    expect(await handler().evaluatePermission('Edit', { file_path: 'src/a.ts' })).toBe('allow');
    expect(await handler().evaluatePermission('Edit', { file_path: 'lib/src/a.ts' })).toBe('ask');
    setProject({ allow: [`Edit(${abs(OUTSIDE)}/**)`] });
    expect(await handler().evaluatePermission('Edit', { file_path: path.join(OUTSIDE, 'a.ts') })).toBe('ask');
  });

  it('~/path is from home and ./path or path from the cwd', async () => {
    setUser({ deny: ['Read(~/private/**)', 'Read(./mine/**)'] });
    expect(await handler().matchRule('Read', { file_path: path.join(HOME, 'private', 'x.txt') })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: 'mine/x.txt' })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: 'private/x.txt' })).toBeNull();
  });
});

describe.runIf(windows)('a loopback admin share is the drive it shares', () => {
  const unc = (native: string, host: string): string => `\\\\${host}\\${native[0]}$${native.slice(2)}`;

  it('an absolute or ~/ deny rule covers every local-host spelling of the path', async () => {
    const secret = path.join(OUTSIDE, 'abs-secret.txt');
    write(secret);
    const homeFile = path.join(HOME, 'private', 'x.txt');
    write(homeFile);
    setUser({ deny: [`Read(${abs(secret)})`, 'Read(~/private/**)'] });
    const h = handler();
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '0--1.ipv6-literal.net', os.hostname()]) {
      expect(await h.matchRule('Read', { file_path: unc(secret, host) }), host).toBe('deny');
      expect(await h.matchRule('Read', { file_path: unc(homeFile, host) }), host).toBe('deny');
    }
    expect(await h.matchRule('Read', { file_path: `\\\\?\\UNC\\localhost\\${secret[0]}$${secret.slice(2)}` })).toBe('deny');
    expect(await h.matchRule('Read', { file_path: `\\\\.\\UNC\\127.0.0.1\\${secret[0]}$${secret.slice(2)}` })).toBe('deny');
    expect(await h.matchRule('Read', { file_path: `\\\\?\\${secret}` })).toBe('deny');
  });
});

describe('a rule list entry that is not a string', () => {
  it('is dropped, and the rest of the file still applies', async () => {
    setUser({ deny: [42, 'Read(secret.txt)'] });
    expect(await handler().matchRule('Read', { file_path: 'secret.txt' })).toBe('deny');
    expect(await handler().matchRule('Read', { file_path: 'notes.txt' })).toBeNull();
    writeSettings(path.join(WS, '.damocles'), 'settings.local.json', { deny: [{ tool: 'Bash' }] });
    expect(await handler().matchRule('Bash', { command: 'ls' })).toBeNull();
  });
});

/** A panel for the shared extension's `tool_call` handler around a real handler. */
const extensionPanel = (h: PermissionHandler): PanelGateContext => ({
  permissionHandler: h,
  isPlanMode: () => false,
  budgetStopRequested: () => false,
  getSessionModel: () => 'claude-opus-4-8',
  getSystemPromptEnv: () => ({ cwd: WS, model: 'claude-opus-4-8', isGitRepo: false, platform: process.platform, shell: 'bash', osVersion: 'test', compassEnabled: false, thinkingDisabled: false }),
  getPlanFilePath: () => path.join(DAMOCLES_PLANS_DIR, 'plan-test.md'),
  postMessage: () => undefined,
});
const toolCallHandler = (panel: PanelGateContext): ((event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>) => {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const pi = { on: (event: string, fn: (e: unknown, c: unknown) => unknown) => { handlers[event] = fn; return () => undefined; } };
  createDamoclesExtensionFactory({ get: () => panel, values: () => [panel] }, { get: () => undefined })(pi as never);
  return handlers['tool_call'] as never;
};
const ctx = (signal?: AbortSignal): unknown => ({ sessionManager: { getSessionId: () => 's1', buildSessionProjection: () => ({ messages: [] }) }, signal });

describe('a permission check that throws blocks the call', () => {
  it('a read included, as a policy block that does not end the turn', async () => {
    setUser({ deny: ['Read(secret.txt)'] });
    const h = new PermissionHandler(createFakePlatform());
    h.setWorkspacePath(WS);
    const result = await toolCallHandler(extensionPanel(h))(ev('read', { path: 'notes.txt' }), ctx());
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result).not.toHaveProperty('terminate');
  });
});

describe('mcp__ rules match the server and tool names, not the pi tool name', () => {
  const call = (server: string, tool: string): [string, Record<string, unknown>, McpToolIdentity] => [createMcpToolName(server, tool), {}, { server, tool }];

  it('a server rule names one server only', async () => {
    for (const rule of ['mcp__srv', 'mcp__srv__*']) {
      setUser({ deny: [rule] });
      expect(await handler().matchRule(...call('srv', 't')), rule).toBe('deny');
      expect(createMcpToolName('srv_', 't')).toBe('mcp__srv___t');
      expect(await handler().matchRule(...call('srv_', 't')), rule).toBeNull();
      expect(await handler().matchRule(...call('srv-', 't')), rule).toBeNull();
    }
    setUser({ deny: ['mcp__a'] });
    expect(await handler().matchRule(...call('a__b', 't'))).toBeNull();
    expect(await handler().matchRule(...call('a', 'b__t'))).toBe('deny');
    setUser({ deny: ['mcp__my-srv'] });
    expect(await handler().matchRule(...call('my.srv', 't'))).toBeNull();
    expect(await handler().matchRule(...call('my_srv', 't'))).toBeNull();
    expect(await handler().matchRule(...call('my-srv', 't'))).toBe('deny');
    setUser({ deny: ['mcp__my_srv'] });
    expect(await handler().matchRule(...call('my.srv', 't'))).toBe('deny');
  });

  it('two long server names that share their first 50 characters stay apart', async () => {
    const [serverA, serverB] = ['A', 'B'].map((tail) => `${'s'.repeat(50)}${tail.repeat(10)}`) as [string, string];
    expect(createMcpToolName(serverB, 'go').slice(0, 55)).toBe(createMcpToolName(serverA, 'go').slice(0, 55));
    setUser({ ask: [`mcp__${serverA}`] });
    expect(await handler().matchRule(...call(serverA, 'go'))).toBe('ask');
    expect(await handler().matchRule(...call(serverB, 'go'))).toBeNull();
  });

  it('an exact rule matches a hashed name by its raw names, and by the pi name itself', async () => {
    const longTool = 'x'.repeat(70);
    setUser({ deny: [`mcp__srv__${longTool}`, 'mcp__context7__resolve-library-id'] });
    expect(await handler().matchRule(...call('srv', longTool))).toBe('deny');
    expect(await handler().matchRule(...call('srv', `${longTool}y`))).toBeNull();
    expect(await handler().matchRule(...call('context7', 'resolve-library-id'))).toBe('deny');
    const hashed = createMcpToolName('srv', 'get.x', () => true);
    setUser({ deny: [hashed] });
    expect(await handler().matchRule(hashed, {})).toBe('deny');
  });

  it('the gate passes the descriptor\'s names to the rules', async () => {
    setUser({ deny: ['mcp__srv'] });
    const identities: Record<string, McpToolIdentity> = { mcp__srv___t: { server: 'srv_', tool: 't' }, mcp__srv__t: { server: 'srv', tool: 't' } };
    const extra = { mcpToolIdentity: (name: string) => identities[name] };
    expect(await gate(handler(), 'mcp__srv___t', {}, extra)).toBeUndefined();
    expect((await gate(handler(), 'mcp__srv__t', {}, extra))?.block).toBe(true);
  });
});

describe('the plan file', () => {
  const plans = DAMOCLES_PLANS_DIR;
  beforeEach(() => {
    fs.rmSync(plans, { recursive: true, force: true });
    fs.mkdirSync(plans, { recursive: true });
  });

  it.runIf(canLink)('is never a path that a junction in the plans folder leads out of', async () => {
    fs.symlinkSync(WS, path.join(plans, 'jn'), 'junction');
    const target = path.join(plans, 'jn', 'evil.md');
    expect(isPlanFilePath(target)).toBe(false);
    const h = handler();
    expect(await h.evaluatePermission('Write', { file_path: target, content: 'x' })).toBe('ask');
    h.setPermissionMode('plan');
    const blocked = await runPermissionGate(ev('write', { path: target, content: 'x' }), { permissionHandler: h, isPlanMode: () => true }, undefined);
    expect(blocked?.block).toBe(true);
  });

  it.runIf(canFileLink)('is never a file link, live or dangling, that leads out of the plans folder', () => {
    write(path.join(WS, 'target.md'));
    fs.symlinkSync(path.join(WS, 'target.md'), path.join(plans, 'live.md'), 'file');
    fs.symlinkSync(path.join(WS, 'missing.md'), path.join(plans, 'dangling.md'), 'file');
    expect(isPlanFilePath(path.join(plans, 'live.md'))).toBe(false);
    expect(isPlanFilePath(path.join(plans, 'dangling.md'))).toBe(false);
    expect(isPlanFilePath(path.join(plans, 'plain.md'))).toBe(true);
  });

  it('is never a hard link to a file outside the plans folder', async () => {
    const victim = path.join(WS, 'victim.md');
    write(victim);
    const linked = path.join(plans, 'hard.md');
    fs.linkSync(victim, linked);
    expect(isPlanFilePath(linked)).toBe(false);
    expect(await handler().evaluatePermission('Write', { file_path: linked, content: 'x' })).toBe('ask');
    const blocked = await runPermissionGate(ev('write', { path: linked, content: 'x' }), { permissionHandler: handler(), isPlanMode: () => true }, undefined);
    expect(blocked?.block).toBe(true);
    write(path.join(plans, 'own.md'));
    expect(isPlanFilePath(path.join(plans, 'own.md'))).toBe(true);
  });

  it.runIf(windows)('is recognised in another case and with an upper-case extension', () => {
    expect(isPlanFilePath(path.join(plans.toUpperCase(), 'x.md'))).toBe(true);
    expect(isPlanFilePath(path.join(plans, 'x.MD'))).toBe(true);
  });

  const realPlans = fs.realpathSync.native(path.dirname(path.dirname(plans)));
  it.runIf(realPlans !== path.dirname(path.dirname(plans)))('is recognised through another name for the home folder, such as its 8.3 name', () => {
    const otherSpelling = path.join(realPlans, '.damocles', 'plans', 'x.md');
    expect(otherSpelling).not.toBe(path.join(plans, 'x.md'));
    expect(isPlanFilePath(otherSpelling)).toBe(true);
    expect(isPlanFilePath(path.join(plans, 'x.md'))).toBe(true);
  });
});

describe('an allow rule and a workspace path written another way', () => {
  const shortWs = path.join(os.tmpdir(), path.basename(WS));
  it.runIf(shortWs !== WS)('an 8.3 spelling of the workspace', async () => {
    setUser({ allow: ['Edit(src/**)'] });
    expect(await handler().evaluatePermission('Edit', { file_path: path.join(shortWs, 'src', 'a.ts') })).toBe('allow');
    expect(await handler().evaluatePermission('Edit', { file_path: path.join(shortWs, 'lib', 'a.ts') })).toBe('ask');
  });

  it.runIf(windows)('a \\\\?\\ spelling of the workspace', async () => {
    setUser({ allow: ['Edit(src/**)'] });
    expect(await handler().evaluatePermission('Edit', { file_path: `\\\\?\\${path.join(WS, 'src', 'a.ts')}` })).toBe('allow');
  });
});

describe('aborting a prompt', () => {
  it('denies the call as an unasked policy block, through the extension wiring', async () => {
    const h = handler();
    const controller = new AbortController();
    const posted: ExtensionToWebviewMessage[] = [];
    h.setPostMessage((msg: ExtensionToWebviewMessage) => {
      posted.push(msg);
      if (msg.type === 'requestPermission') setTimeout(() => controller.abort(), 0);
    });
    const result = await toolCallHandler(extensionPanel(h))(ev('bash', { command: 'rm -rf build' }), ctx(controller.signal));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('aborted before this approval was answered');
    expect(result).not.toHaveProperty('terminate');
    expect(h.pendingPromptKinds().size > 0).toBe(false);
    expect(posted.filter((m) => m.type === 'permissionAutoResolved')).toEqual([expect.objectContaining({ outcome: 'withdrawn' })]);
  });
});
