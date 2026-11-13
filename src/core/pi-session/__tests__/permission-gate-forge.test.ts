import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPermissionGate, type PanelGateContext } from '../permission-gate';
import { PermissionHandler } from '../../permission-handler';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PermissionDetail } from '../../../shared/types/permissions';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import type { ForgeToolsPort } from '../tools/forge-tools';
import { toolCategory } from '../tool-normalization';
import { resolveAgentToolset } from '../subagents/agent-toolset';
import type { AgentConfig } from '../subagents/types';
import { FORGE_PI_TOOL_NAMES } from '../tools/forge-tool-specs';
import { deferredToolNames, loadableToolNames } from '../tools/deferred-tools';
import type { DesignScope } from '../../design/design-write-rule';
import { setLocalForgeAccounts } from '../../user-scope';

// The GitHub and GitLab tools at the gate (docs/invariants.md "Permissions and plan mode"): reads run in every mode, writes ask
// in default and acceptEdits, run in YOLO, are blocked in plan mode, for read-only agents and team reviewers, and nothing of
// the group runs in a design chat. Settings rules apply, a project-scoped rule naming the target the gate resolved.

const PROJECT = 'gitlab.com/grp/damocles';

const DETAIL: PermissionDetail = {
  title: { message: 'Comment on merge request {0}?', args: ['!45'] },
  subtitle: { message: 'writes to the server as you' },
  facts: [{ label: { message: 'Server' }, value: 'gitlab.com' }],
  content: { label: { message: 'Comment text' }, text: 'Ready for review.' },
  alwaysAllowLabel: { message: "Yes, and don't ask again for {0} on {1}", args: ['ForgeComment', 'grp/damocles'] },
  approvedStatus: { message: 'Allowed once. Posting the comment to {0} as {1} on {2}.', args: ['!45', 'alexios-s', 'gitlab.com'] },
};
const SUGGESTION = { type: 'addRules' as const, rules: [{ toolName: 'ForgeComment', ruleContent: PROJECT }], behavior: 'allow' as const, destination: 'localSettings' as const };

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

function port(overrides: Partial<ForgeToolsPort> = {}): ForgeToolsPort & { target: ReturnType<typeof vi.fn>; approval: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => ({ text: 'ran' })),
    target: vi.fn(async () => ({ ok: true as const, project: PROJECT })),
    approval: vi.fn(async () => ({ ok: true as const, detail: DETAIL, suggestion: SUGGESTION })),
    ...overrides,
  } as ForgeToolsPort & { target: ReturnType<typeof vi.fn>; approval: ReturnType<typeof vi.fn> };
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-forge-'));
let hasAccount = true;
beforeAll(() => setLocalForgeAccounts(() => hasAccount));
afterAll(() => {
  setLocalForgeAccounts(() => false);
  fs.rmSync(workspace, { recursive: true, force: true });
});

function writeRules(rules: { allow?: string[]; ask?: string[]; deny?: string[] }): void {
  fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: rules }));
}

function clearRules(): void {
  fs.rmSync(path.join(workspace, '.damocles'), { recursive: true, force: true });
}

interface Setup {
  readonly mode?: 'default' | 'acceptEdits' | 'plan';
  readonly yolo?: boolean;
  readonly readOnlyShell?: boolean;
  readonly design?: boolean;
  readonly forgeTools?: ForgeToolsPort | null;
}

function gate(setup: Setup = {}) {
  const handler = new PermissionHandler(createFakePlatform());
  handler.setWorkspacePath(workspace);
  handler.setCwd(workspace);
  handler.setPermissionMode(setup.mode ?? 'default');
  handler.setDangerouslySkipPermissions(setup.yolo ?? false);
  const prompts: Array<Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>> = [];
  handler.setPostMessage((msg) => {
    if (msg.type !== 'requestPermission') return;
    prompts.push(msg);
    void handler.resolveApproval(msg.toolUseId, true);
  });
  const forgeTools = setup.forgeTools === null ? undefined : setup.forgeTools ?? port();
  const panel = {
    permissionHandler: handler,
    isPlanMode: () => setup.mode === 'plan',
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    ...(setup.readOnlyShell ? { readOnlyShell: true } : {}),
    ...(setup.design ? { designScope: () => ({ folder: workspace, cwd: workspace } as unknown as DesignScope) } : {}),
    ...(forgeTools ? { forgeTools } : {}),
    postMessage: () => undefined,
  } as unknown as PanelGateContext;
  return { panel, handler, prompts, forgeTools };
}

const COMMENT = { number: 45, body: 'Ready for review.' };

function expectPolicyBlock(result: Awaited<ReturnType<typeof runPermissionGate>>, words?: string): void {
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
  expect(result?.reason).not.toContain(FEEDBACK_MARKER);
  if (words !== undefined) expect(result?.reason).toContain(words);
}

describe('GitHub and GitLab tools at the gate: mode x tool', () => {
  const cases: Array<{ name: string; setup: Setup; read: 'run' | 'block'; write: 'ask' | 'run' | 'block'; words?: string }> = [
    { name: 'default', setup: { mode: 'default' }, read: 'run', write: 'ask' },
    { name: 'acceptEdits', setup: { mode: 'acceptEdits' }, read: 'run', write: 'ask' },
    { name: 'plan', setup: { mode: 'plan' }, read: 'run', write: 'block', words: 'Plan mode is active' },
    { name: 'YOLO', setup: { mode: 'default', yolo: true }, read: 'run', write: 'run' },
    { name: 'a read-only agent', setup: { mode: 'default', readOnlyShell: true }, read: 'run', write: 'block', words: 'read-only agent' },
    { name: 'a read-only agent in YOLO', setup: { mode: 'default', yolo: true, readOnlyShell: true }, read: 'run', write: 'block', words: 'read-only agent' },
    { name: 'a design chat', setup: { mode: 'default', design: true }, read: 'block', write: 'block', words: 'A design chat cannot use the GitHub and GitLab tools.' },
    { name: 'a design chat in YOLO', setup: { mode: 'default', yolo: true, design: true }, read: 'block', write: 'block', words: 'A design chat cannot use the GitHub and GitLab tools.' },
  ];

  for (const { name, setup, read, write, words } of cases) {
    it(`${name}: ForgePipelines ${read}s, ForgeComment ${write === 'ask' ? 'asks' : `${write}s`}`, async () => {
      const { panel, prompts, forgeTools } = gate(setup);
      const readResult = await runPermissionGate(ev('ForgePipelines', 'r1'), panel, undefined);
      if (read === 'run') expect(readResult).toBeUndefined();
      else expectPolicyBlock(readResult, words);
      const writeResult = await runPermissionGate(ev('ForgeComment', 'w1', COMMENT), panel, undefined);
      if (write === 'block') {
        expectPolicyBlock(writeResult, words);
        expect(prompts).toEqual([]);
        expect(forgeTools!.approval).not.toHaveBeenCalled();
        return;
      }
      expect(writeResult).toBeUndefined();
      if (write === 'run') {
        expect(prompts).toEqual([]);
        expect(forgeTools!.approval).not.toHaveBeenCalled();
        return;
      }
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ toolUseId: 'w1', toolName: 'ForgeComment', ...DETAIL, suggestions: [SUGGESTION] });
    });
  }

  it('the card is resolved before the prompt posts, and a refusal blocks the write without asking', async () => {
    const refused = port({ approval: vi.fn(async () => ({ ok: false as const, answer: { text: 'Damocles has no account on gitlab.com.', isError: true as const } })) });
    const { panel, prompts } = gate({ forgeTools: refused });
    expectPolicyBlock(await runPermissionGate(ev('ForgeComment', 'w1', COMMENT), panel, undefined), 'Damocles has no account on gitlab.com.');
    expect(prompts).toEqual([]);
  });

  it('a call whose target does not resolve is blocked with its reason before any rule or prompt', async () => {
    const refused = port({ target: vi.fn(async () => ({ ok: false as const, answer: { text: 'Reading another repository is off.', isError: true as const } })) });
    const { panel, prompts } = gate({ forgeTools: refused });
    expectPolicyBlock(await runPermissionGate(ev('ForgeIssues', 'r1', { project: 'other/repo' }), panel, undefined), 'Reading another repository is off.');
    expect(prompts).toEqual([]);
  });

  it('with no account on this computer nothing of the group runs, in any mode, YOLO included', async () => {
    hasAccount = false;
    try {
      for (const setup of [{ mode: 'default' as const }, { mode: 'default' as const, yolo: true }]) {
        const { panel, forgeTools } = gate(setup);
        expectPolicyBlock(await runPermissionGate(ev('ForgePipelines', 'r1'), panel, undefined), 'No GitHub or GitLab account is signed in.');
        expectPolicyBlock(await runPermissionGate(ev('ForgeComment', 'w1', COMMENT), panel, undefined), 'No GitHub or GitLab account is signed in.');
        expect(forgeTools!.target).not.toHaveBeenCalled();
      }
    } finally {
      hasAccount = true;
    }
  });

  it('an abort while the target or the card resolves blocks as an aborted wait, and any other failure is thrown on', async () => {
    const abortingWith = (method: 'target' | 'approval', controller: AbortController) => vi.fn(async (_call: unknown, signal: AbortSignal) => {
      controller.abort(new Error(`aborted in ${method}`));
      throw signal.reason;
    });
    for (const method of ['target', 'approval'] as const) {
      const controller = new AbortController();
      const { panel, prompts } = gate({ forgeTools: port({ [method]: abortingWith(method, controller) }) });
      expectPolicyBlock(await runPermissionGate(ev('ForgeComment', 'w1', COMMENT), panel, controller.signal), 'aborted before this tool call could run');
      expect(prompts).toEqual([]);
    }
    const broken = port({ target: vi.fn(async () => {
      throw new Error('broken');
    }) });
    await expect(runPermissionGate(ev('ForgeComment', 'w1', COMMENT), gate({ forgeTools: broken }).panel, new AbortController().signal)).rejects.toThrow('broken');
  });

  it('an agent without the tools runs none of them', async () => {
    const { panel } = gate({ forgeTools: null });
    expectPolicyBlock(await runPermissionGate(ev('ForgePipelines', 'r1'), panel, undefined), 'not available to this agent');
  });
});

describe('GitHub and GitLab tools at the gate: settings rules', () => {
  it('a deny rule blocks the write in every mode, YOLO aside', async () => {
    writeRules({ deny: ['ForgeComment'] });
    try {
      for (const mode of ['default', 'acceptEdits'] as const) {
        const { panel, prompts, forgeTools } = gate({ mode });
        expectPolicyBlock(await runPermissionGate(ev('ForgeComment', 'w1', COMMENT), panel, undefined), 'Permission denied by a rule in your Damocles settings');
        expect(prompts).toEqual([]);
        expect(forgeTools!.approval).not.toHaveBeenCalled();
      }
    } finally {
      clearRules();
    }
  });

  it("option 2's rule names the project the gate resolved: it runs that project's write unasked and asks on another", async () => {
    writeRules({ allow: [`ForgeComment(${PROJECT})`] });
    try {
      const own = gate();
      expect(await runPermissionGate(ev('ForgeComment', 'w1', COMMENT), own.panel, undefined)).toBeUndefined();
      expect(own.prompts).toEqual([]);
      const other = gate({ forgeTools: port({ target: vi.fn(async () => ({ ok: true as const, project: 'gitlab.com/grp/other' })) }) });
      expect(await runPermissionGate(ev('ForgeComment', 'w2', COMMENT), other.panel, undefined)).toBeUndefined();
      expect(other.prompts).toHaveLength(1);
    } finally {
      clearRules();
    }
  });

  it('a project-scoped rule never matches what the model wrote in the input', async () => {
    writeRules({ allow: ['ForgeComment(gitlab.com/evil/repo)'] });
    try {
      const { panel, prompts } = gate();
      await runPermissionGate(ev('ForgeComment', 'w1', { ...COMMENT, forgeProject: 'gitlab.com/evil/repo', project: 'gitlab.com/evil/repo' }), panel, undefined);
      expect(prompts).toHaveLength(1);
    } finally {
      clearRules();
    }
  });

  it('a deny or ask rule may glob the project; an allow rule names one project exactly', async () => {
    writeRules({ deny: ['ForgeComment(gitlab.com/grp/*)'], allow: ['ForgeIssues(gitlab.com/*)'] });
    try {
      const { panel, prompts } = gate();
      expectPolicyBlock(await runPermissionGate(ev('ForgeComment', 'w1', COMMENT), panel, undefined));
      expect(prompts).toEqual([]);
      const other = gate({ forgeTools: port({ target: vi.fn(async () => ({ ok: true as const, project: 'gitlab.com/other/app' })) }) });
      expect(await runPermissionGate(ev('ForgeComment', 'w2', COMMENT), other.panel, undefined)).toBeUndefined();
      expect(other.prompts).toHaveLength(1);
    } finally {
      clearRules();
    }
  });

  it('an ask rule makes a read prompt', async () => {
    writeRules({ ask: ['ForgeJobLog'] });
    try {
      const { panel, prompts } = gate();
      expect(await runPermissionGate(ev('ForgeJobLog', 'r1', { job: 1 }), panel, undefined)).toBeUndefined();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.title).toBeUndefined();
    } finally {
      clearRules();
    }
  });
});

describe('GitHub and GitLab tools: agents and loadability', () => {
  it('the writes are write-category tools, so an agent holding only the reads stays read-only', () => {
    for (const name of ['ForgeJobAction', 'ForgeOpenMergeRequest', 'ForgeComment']) expect(toolCategory(name)).toBe('write');
    for (const name of ['ForgePipelines', 'ForgeJobs', 'ForgeJobLog', 'ForgeMergeRequest', 'ForgeMergeRequests', 'ForgeIssue', 'ForgeIssues']) expect(toolCategory(name)).toBe('read');
    const config = { name: 'reader', description: '', extensions: true } as unknown as AgentConfig;
    expect(resolveAgentToolset({ ...config, builtinToolNames: ['read', 'ForgePipelines', 'ForgeJobLog'] }, ['read', ...FORGE_PI_TOOL_NAMES]).readOnly).toBe(true);
    expect(resolveAgentToolset({ ...config, builtinToolNames: ['read', 'ForgeComment'] }, ['read', ...FORGE_PI_TOOL_NAMES]).readOnly).toBe(false);
  });

  it('the group is loadable only with an account, and never in a design chat or an agent it started', () => {
    const deferred = deferredToolNames(['read', ...FORGE_PI_TOOL_NAMES], []);
    expect(deferred).toEqual([...FORGE_PI_TOOL_NAMES]);
    expect(loadableToolNames(deferred, { browser: true, forge: true, relayedTool: () => true }, false)).toEqual([...FORGE_PI_TOOL_NAMES]);
    expect(loadableToolNames(deferred, { browser: true, forge: false, relayedTool: () => true }, false)).toEqual([]);
    expect(loadableToolNames(deferred, { browser: true, forge: true, relayedTool: () => true }, true)).toEqual([]);
  });
});
