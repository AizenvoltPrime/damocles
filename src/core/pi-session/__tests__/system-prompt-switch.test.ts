import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, getSystemMessageText, type FauxResponseStep, type SystemMessage } from '@earendil-works/pi-ai';
import { buildAgentStartResult } from '../agent-start';
import { registerModelSwitchPromptFold } from '../model-switch-prompt';
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

function panelStub(env: SystemPromptEnv): PanelGateContext {
  return {
    permissionHandler: {} as PanelGateContext['permissionHandler'],
    isPlanMode: () => false,
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
describe('what the provider receives across a model switch, through real pi', () => {
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
      registerModelSwitchPromptFold(pi);
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

  it('sends the original leading message again after a switch to another model and back, with nothing else changed', async () => {
    const env = opusEnv();
    const { requests, session } = await bootRecording(env, 3);
    await session.prompt('first');
    await switchTo(session, env, 'claude-haiku-5-5');
    await session.prompt('second');
    await switchTo(session, env, 'claude-opus-5-5');
    await session.prompt('third');

    expect(requests[1]![0]!.sections?.['damocles_model']).toContain('Haiku 5.5');
    expect(requests[2]).toHaveLength(1);
    expect(rendered(requests[2]![0]!)).toBe(rendered(requests[0]![0]!));
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
      registerModelSwitchPromptFold(pi);
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

  /** A real pi session with Damocles' prompt and the fold, recording the system messages of each request. */
  async function bootRecording(env: SystemPromptEnv, turns: number): Promise<{ requests: SystemEntry[][]; session: AgentSession; damocles: { off: boolean } }> {
    const requests: SystemEntry[][] = [];
    const damocles = { off: false };
    const answer: FauxResponseStep = (context) => {
      requests.push((context.messages as unknown as { role: string }[]).filter((m): m is SystemEntry => m.role === 'system'));
      return fauxAssistantMessage('ok');
    };
    const { session } = await boot(blockingShell().definition, Array.from({ length: turns }, () => answer), (pi) => {
      pi.on('before_agent_start', async (event, ctx) =>
        damocles.off ? undefined : buildAgentStartResult(event, panelStub(env), ctx.sessionManager.getSessionId(), ctx.sessionManager, () => true),
      );
      registerModelSwitchPromptFold(pi);
    });
    session.setThinkingLevel('high');
    return { requests, session, damocles };
  }

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
