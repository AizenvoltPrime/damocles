import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { buildAgentStartResult } from '../agent-start';
import type { PanelGateContext, SystemPromptEnv } from '../permission-gate';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { blockingShell, realPiSessions } from './real-pi-fixtures';

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
