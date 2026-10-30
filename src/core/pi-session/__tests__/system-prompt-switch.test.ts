import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, getSystemMessageText, type FauxResponseStep, type SystemMessage } from '@earendil-works/pi-ai';
import { buildAgentStartResult } from '../agent-start';
import { registerIdentityPromptFold } from '../identity-prompt-fold';
import type { PanelGateContext, SystemPromptEnv } from '../permission-gate';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { MODEL_SWITCH_NOTE, SYSTEM_PROMPT_PREAMBLE } from '../system-prompt';
import { buildAgentPrompt } from '../subagents/prompts';
import { DEFAULT_AGENTS } from '../subagents/default-agents';
import type { SubagentEngine } from '../subagents/agent-manager';
import type { AgentConfig } from '../subagents/types';
import { bindPanel, blockingShell, panelSession, realPiSessions } from './real-pi-fixtures';

/**
 * pi diffs the sections Damocles' `before_agent_start` handler writes against the transcript's current
 * ones and records every changed section, in full, as a mid-conversation system message. These tests
 * switch the model or the thinking level between two prompts of a real pi session and read that message.
 */

interface SystemEntry {
  role: 'system';
  sections?: Record<string, string | null>;
}

const systemMessages = (session: AgentSession): SystemEntry[] =>
  (session.messages as unknown as { role: string }[]).filter((m): m is SystemEntry => m.role === 'system');

function panelStub(env: SystemPromptEnv, mode: { planMode: boolean } = { planMode: false }): PanelGateContext {
  return {
    permissionHandler: {} as PanelGateContext['permissionHandler'],
    isPlanMode: () => mode.planMode,
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    budgetStopRequested: () => false,
    getSessionModel: () => env.model,
    memoryWorkspace: () => '/repo',
    getSystemPromptEnv: () => ({ ...env }),
    getPlanFilePath: () => '/plans/plan-cafe.md',
    isTeamEnabled: () => false,
    postMessage: () => undefined,
  } as PanelGateContext;
}

describe('a mid-chat model or thinking switch, through real pi', () => {
  const { boot, dispose } = realPiSessions();
  afterEach(dispose);

  /** Runs one prompt on Opus 5.5 with thinking on, applies `change`, runs a second, and returns the patch pi recorded for it. */
  async function patchAfterSwitch(change: (session: AgentSession, env: SystemPromptEnv) => Promise<void>): Promise<Record<string, string | null>> {
    const env: SystemPromptEnv = {
      cwd: '/repo',
      model: 'claude-opus-5-5',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: false,
      thinkingDisabled: false,
    };
    const { session } = await boot(blockingShell().definition, [fauxAssistantMessage('one'), fauxAssistantMessage('two')], (pi) => {
      pi.on('before_agent_start', async (event, ctx) =>
        buildAgentStartResult(event, panelStub(env), ctx.sessionManager.getSessionId(), ctx.sessionManager, () => true),
      );
    });
    session.setThinkingLevel('high');
    await session.prompt('first');
    const before = systemMessages(session);
    expect(before).toHaveLength(1);
    expect(Object.keys(before[0]!.sections ?? {})).toContain('preamble');

    await change(session, env);
    await session.prompt('second');
    const later = systemMessages(session).slice(before.length);
    return Object.assign({}, ...later.map((m) => m.sections ?? {})) as Record<string, string | null>;
  }

  it('a switch to Haiku 5.5 with thinking off patches the model and output-form sections, never the preamble', async () => {
    const patch = await patchAfterSwitch(async (session, env) => {
      const haiku = session.modelRuntime.getModel('anthropic', 'claude-haiku-5-5');
      if (!haiku) throw new Error('claude-haiku-5-5 missing from the catalog');
      await session.setModel(haiku);
      session.setThinkingLevel('off');
      env.model = 'claude-haiku-5-5';
      env.thinkingDisabled = true;
    });
    expect(Object.keys(patch).sort()).toEqual(['damocles_model', 'damocles_output_form']);
    expect(patch['damocles_model']).toContain('Haiku 5.5');
    expect(patch['damocles_output_form']).toContain('# Output form');
  });

  it('turning thinking off on the same model patches only the output-form section', async () => {
    const patch = await patchAfterSwitch(async (session, env) => {
      session.setThinkingLevel('off');
      env.thinkingDisabled = true;
    });
    expect(Object.keys(patch)).toEqual(['damocles_output_form']);
  });
});

// pi sends a patch as a mid-conversation system message, which pi-ai places after the user's prompt for Anthropic.
describe('what the provider receives across a model switch or a folder move, through real pi', () => {
  const { boot, dispose } = realPiSessions();
  afterEach(dispose);

  it('folds the prompt through a model switch into the leading system message, which later requests on that model keep', async () => {
    const env: SystemPromptEnv = {
      cwd: '/repo',
      model: 'claude-opus-5-5',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: false,
      thinkingDisabled: false,
    };
    const requests: SystemEntry[][] = [];
    const answer = (text: string): FauxResponseStep => (context) => {
      requests.push((context.messages as unknown as { role: string }[]).filter((m): m is SystemEntry => m.role === 'system'));
      return fauxAssistantMessage(text);
    };
    const { session } = await boot(blockingShell().definition, [answer('one'), answer('two'), answer('three')], (pi) => {
      pi.on('before_agent_start', async (event, ctx) =>
        buildAgentStartResult(event, panelStub(env), ctx.sessionManager.getSessionId(), ctx.sessionManager, () => true),
      );
      registerIdentityPromptFold(pi);
    });
    session.setThinkingLevel('high');
    await session.prompt('first');

    const haiku = session.modelRuntime.getModel('anthropic', 'claude-haiku-5-5');
    if (!haiku) throw new Error('claude-haiku-5-5 missing from the catalog');
    await session.setModel(haiku);
    env.model = 'claude-haiku-5-5';
    await session.prompt('second');

    const afterSwitch = requests[1]!;
    expect(afterSwitch).toHaveLength(1);
    expect(afterSwitch[0]!.sections?.['damocles_model']).toContain('Haiku 5.5');
    expect(afterSwitch[0]!.sections?.['preamble']).toBe(requests[0]![0]!.sections?.['preamble']);
    // The transcript still records pi's patch; only the request is folded.
    expect(systemMessages(session)).toHaveLength(2);

    session.setThinkingLevel('off');
    env.thinkingDisabled = true;
    await session.prompt('third');

    const sameModel = requests[2]!;
    expect(rendered(sameModel[0]!)).toBe(rendered(afterSwitch[0]!));
    expect(sameModel).toHaveLength(2);
    expect(Object.keys(sameModel[1]!.sections ?? {})).toEqual(['damocles_output_form']);
  });

  it('re-folds at a return to a model after another model replied, with a head naming both earlier runs', async () => {
    const env = opusEnv();
    const { requests, session } = await bootRecording(env, 3);
    await session.prompt('first');
    await switchTo(session, env, 'claude-haiku-5-5');
    await session.prompt('second');
    await switchTo(session, env, 'claude-opus-5-5');
    await session.prompt('third');

    expect(requests[1]![0]!.sections?.['damocles_model']).toContain('Haiku 5.5');
    expect(requests[2]).toHaveLength(1);
    expect(requests[2]![0]!.sections?.['damocles_model']).toContain('named Opus 5.5');
    expect(requests[2]![0]!.sections?.['damocles_model']).toContain('replies in this conversation came from Opus 5.5 (claude-opus-5-5), then Haiku 5.5 (claude-haiku-5-5); replies since then are yours.');
  });

  it('sends the original leading message byte for byte after a switch away and back with no prompt between', async () => {
    const env = opusEnv();
    const { requests, session } = await bootRecording(env, 2);
    await session.prompt('first');
    await switchTo(session, env, 'claude-haiku-5-5');
    await switchTo(session, env, 'claude-opus-5-5');
    await session.prompt('second');

    expect(requests[1]).toHaveLength(1);
    expect(rendered(requests[1]![0]!)).toBe(rendered(requests[0]![0]!));
  });

  it("after Opus replies and the chat switches to Haiku, the folded head names Opus, and Haiku's own reply causes no patch at the next prompt", async () => {
    const env = opusEnv();
    const { requests, session } = await bootRecording(env, 3);
    await session.prompt('first');
    await switchTo(session, env, 'claude-haiku-5-5');
    await session.prompt('second');
    await session.prompt('third');

    expect(requests[1]).toHaveLength(1);
    expect(requests[1]![0]!.sections?.['damocles_model']).toContain('named Haiku 5.5');
    expect(requests[1]![0]!.sections?.['damocles_model']).toContain('replies in this conversation came from Opus 5.5 (claude-opus-5-5); replies since then are yours.');
    expect(systemMessages(session)).toHaveLength(2);
    expect(requests[2]).toHaveLength(1);
    expect(rendered(requests[2]![0]!)).toBe(rendered(requests[1]![0]!));
  });

  it('a resumed file whose replies came from Sonnet, continued on Haiku, names Sonnet', async () => {
    const env = opusEnv();
    const first = await bootRecording(env, 1, { sessionManager: (cwd) => SessionManager.create(cwd, path.join(cwd, 'sessions')) });
    await switchTo(first.session, env, 'claude-sonnet-5-5');
    await first.session.prompt('first');
    const file = first.session.sessionManager.getSessionFile();
    if (!file) throw new Error('the first session wrote no file');

    const resumed = await bootRecording(env, 1, { sessionManager: (cwd) => SessionManager.open(file, path.dirname(file), cwd) });
    await switchTo(resumed.session, env, 'claude-haiku-5-5');
    await resumed.session.prompt('second');

    expect(first.requests[0]![0]!.sections?.['damocles_model']).toContain(MODEL_SWITCH_NOTE);
    expect(resumed.requests[0]).toHaveLength(1);
    expect(resumed.requests[0]![0]!.sections?.['damocles_model']).toContain('replies in this conversation came from Sonnet 5.5 (claude-sonnet-5-5); replies since then are yours.');
  });

  it('keeps the leading message when a run produced no Damocles prompt, and when the prompt returns on the same model', async () => {
    // A missing panel, or a prompt build that threw, makes pi patch every Damocles section away, `damocles_model` included.
    const env = opusEnv();
    const { requests, session, damocles } = await bootRecording(env, 3);
    await session.prompt('first');
    damocles.off = true;
    await session.prompt('second');
    damocles.off = false;
    await session.prompt('third');

    expect(systemMessages(session)[1]!.sections?.['damocles_model']).toBeNull();
    expect(rendered(requests[1]![0]!)).toBe(rendered(requests[0]![0]!));
    expect(rendered(requests[2]![0]!)).toBe(rendered(requests[0]![0]!));
  });

  it("gives an append-mode subagent on another model the parent's prompt without the parent's model section", async () => {
    const env = opusEnv();
    const panel = panelSession([]);
    const engine = (panel as unknown as { buildSubagentEngine: (pi: unknown, folder: unknown) => SubagentEngine }).buildSubagentEngine({}, {});
    let parentHead: SystemEntry | undefined;
    let inherited = '';
    // An agent is spawned from a tool call, inside the parent's run.
    const answer: FauxResponseStep = (context) => {
      parentHead = (context.messages as unknown as SystemEntry[])[0];
      inherited = engine.getParentSystemPrompt();
      return fauxAssistantMessage('ok');
    };
    const { session } = await boot(blockingShell().definition, [answer], (pi) => {
      pi.on('before_agent_start', async (event, ctx) =>
        buildAgentStartResult(event, panelStub(env), ctx.sessionManager.getSessionId(), ctx.sessionManager, () => true),
      );
      registerIdentityPromptFold(pi);
    });
    bindPanel(panel, session);
    await session.prompt('first');

    expect(parentHead?.sections?.['damocles_model']).toContain('Opus 5.5');
    const haikuAgent: AgentConfig = { ...DEFAULT_AGENTS.get('general-purpose')!, model: 'haiku' };
    const agentPrompt = buildAgentPrompt(haikuAgent, '/repo', { isGitRepo: false, branch: '', platform: 'linux' }, inherited);
    expect(agentPrompt).toContain(SYSTEM_PROMPT_PREAMBLE);
    expect(agentPrompt).toContain('<damocles_environment>');
    expect(agentPrompt).not.toContain('<damocles_model>');
    expect(agentPrompt).not.toContain('Opus');
    expect(agentPrompt).not.toContain(MODEL_SWITCH_NOTE);
  });

  function opusEnv(): SystemPromptEnv {
    return { cwd: '/repo', model: 'claude-opus-5-5', isGitRepo: true, platform: 'linux', shell: 'bash', osVersion: 'Linux test', compassEnabled: false, thinkingDisabled: false };
  }

  /**
   * A real pi session with Damocles' prompt and the fold, recording the system messages of each request. Its `env.cwd` is
   * the session's own folder, as `PiSession.systemPromptEnv` gives it.
   */
  async function bootRecording(
    env: SystemPromptEnv,
    turns: number,
    options: { mode?: { planMode: boolean }; sessionManager?: (cwd: string) => SessionManager } = {},
  ): Promise<{ requests: SystemEntry[][]; session: AgentSession; cwd: string; damocles: { off: boolean } }> {
    const requests: SystemEntry[][] = [];
    const damocles = { off: false };
    const answer: FauxResponseStep = (context) => {
      requests.push((context.messages as unknown as { role: string }[]).filter((m): m is SystemEntry => m.role === 'system'));
      return fauxAssistantMessage('ok');
    };
    const { session, cwd } = await boot(blockingShell().definition, Array.from({ length: turns }, () => answer), (pi) => {
      pi.on('before_agent_start', async (event, ctx) =>
        damocles.off ? undefined : buildAgentStartResult(event, panelStub(env, options.mode), ctx.sessionManager.getSessionId(), ctx.sessionManager, () => true),
      );
      registerIdentityPromptFold(pi);
    }, options.sessionManager);
    env.cwd = cwd;
    session.setThinkingLevel('high');
    return { requests, session, cwd, damocles };
  }

  /**
   * A chat that ran one prompt in one folder, then moved to another as a hand-off moves it: its session file resumed in a
   * pi session on the new folder (`SessionManager.open(file, dir, cwd)`, `PiSession`'s reopen).
   */
  async function moveToAnotherFolder(env: SystemPromptEnv, turnsAfter: number): Promise<{ from: string; to: Awaited<ReturnType<typeof bootRecording>> }> {
    const first = await bootRecording(env, 1, { sessionManager: (cwd) => SessionManager.create(cwd, path.join(cwd, 'sessions')) });
    await first.session.prompt('first');
    const file = first.session.sessionManager.getSessionFile();
    if (!file) throw new Error('the first session wrote no file');
    const to = await bootRecording(env, turnsAfter, { sessionManager: (cwd) => SessionManager.open(file, path.dirname(file), cwd) });
    return { from: first.cwd, to };
  }

  it('a folder move folds: the new cwd and environment are in the leading message and no environment or cwd patch remains in the request', async () => {
    const env = opusEnv();
    const { from, to } = await moveToAnotherFolder(env, 1);
    await to.session.prompt('second');

    const moved = to.requests[0]!;
    expect(moved).toHaveLength(1);
    expect(moved[0]!.sections?.['cwd']).toBe(`<cwd>\n${to.cwd.replace(/\\/g, '/')}\n</cwd>`);
    expect(moved[0]!.sections?.['damocles_environment']).toContain(`Primary working directory: ${to.cwd}\n`);
    expect(rendered(moved[0]!)).not.toContain(from);
    expect(rendered(moved[0]!)).not.toContain(from.replace(/\\/g, '/'));
    // The transcript keeps pi's patch; only the request is folded.
    expect(Object.keys(systemMessages(to.session)[1]!.sections ?? {}).sort()).toEqual(['cwd', 'damocles_environment']);
  });

  it('a later request in the same folder sends the same leading message', async () => {
    const env = opusEnv();
    const { to } = await moveToAnotherFolder(env, 2);
    await to.session.prompt('second');
    await to.session.prompt('third');

    expect(to.requests[1]).toHaveLength(1);
    expect(rendered(to.requests[1]![0]!)).toBe(rendered(to.requests[0]![0]!));
  });

  it("a plan-mode toggle in the same folder still arrives as pi's patch", async () => {
    const env = opusEnv();
    const mode = { planMode: false };
    const { requests, session } = await bootRecording(env, 2, { mode });
    await session.prompt('first');
    mode.planMode = true;
    await session.prompt('second');

    expect(requests[1]).toHaveLength(2);
    expect(rendered(requests[1]![0]!)).toBe(rendered(requests[0]![0]!));
    expect(Object.keys(requests[1]![1]!.sections ?? {})).toEqual(['damocles_plan_mode']);
  });

  async function switchTo(session: AgentSession, env: SystemPromptEnv, id: string): Promise<void> {
    const model = session.modelRuntime.getModel('anthropic', id);
    if (!model) throw new Error(`${id} missing from the catalog`);
    await session.setModel(model);
    env.model = id;
  }
});

/** What the provider renders from a request's system message: its text, then its tool declarations. */
const rendered = (message: SystemEntry): string =>
  `${getSystemMessageText(message as unknown as SystemMessage)}\n${JSON.stringify((message as unknown as SystemMessage).toolsAdded ?? [])}`;
