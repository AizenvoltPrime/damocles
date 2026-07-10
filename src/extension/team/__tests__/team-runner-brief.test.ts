import { describe, it, expect, vi } from 'vitest';

const { tmpHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-team-brief-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

import { TeamRunner } from '../team-runner';
import type { TeamConfig, AgentResult, AgentRunConfig, TeamRole } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

const BRIEF = 'AUTHORITATIVE SPEC: build the async pipeline exactly as specified. Acceptance: golden parity test passes.';

function completedResult(agentId: string): AgentResult {
  return {
    agentId,
    status: 'completed',
    finalResponse: 'lead done',
    toolCallCount: 0,
    durationMs: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
}

function makeConfig(): TeamConfig {
  return {
    teamId: 'team-brief-1',
    toolUseId: 'tool-1',
    title: 'Async pipeline slice',
    brief: BRIEF,
    cwd: tmpHome,
    persistenceSessionId: 'sess-brief',
    permissionMode: 'default',
    agents: [
      { name: 'Lead', role: 'lead' },
      { name: 'Dev', role: 'specialist' },
    ],
    resolveRoleModel: (role: TeamRole) => ({ modelLabel: role === 'lead' ? 'lead-model' : 'spec-model' }),
    engine: {
      createSession: async () => ({}) as never,
      forgetSession: () => undefined,
      agentToolNames: () => [],
      buildAgentCustomTools: () => [],
      buildExtensionFactory: () => (() => undefined) as never,
      onAgentCost: () => undefined,
    },
  } as unknown as TeamConfig;
}

describe('TeamRunner.run — seeds the immutable mission-brief section', () => {
  it('emits a teamScratchpadUpdate for mission-brief (system author, v1, brief verbatim) after team start', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const runner = new TeamRunner(makeConfig(), (m) => messages.push(m));

    // Stub the AgentRunner: the lead "completes" immediately, so run()'s leadPromise.then falls through
    // to synthesizeResult and the run resolves — but only AFTER the synchronous seed has emitted.
    (runner as unknown as { agentRunner: { startAgent: (c: AgentRunConfig) => Promise<AgentResult> } }).agentRunner = {
      startAgent: async (cfg: AgentRunConfig) => completedResult(cfg.agentId),
    };

    await runner.run();

    const teamStartedIdx = messages.findIndex((m) => m.type === 'teamStarted');
    const seedIdx = messages.findIndex(
      (m) => m.type === 'teamScratchpadUpdate' && m.entry.section === 'mission-brief',
    );
    expect(teamStartedIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeGreaterThan(teamStartedIdx); // seeded AFTER the webview registers the team

    const seed = messages[seedIdx];
    if (seed.type !== 'teamScratchpadUpdate') throw new Error('unreachable');
    expect(seed.entry.content).toBe(BRIEF);
    expect(seed.entry.agentName).toBe('system');
    expect(seed.entry.version).toBe(1);
  });

  it('fails team creation when the lead role resolution returns a blocking error (no silent degrade)', async () => {
    const config = makeConfig();
    (config as unknown as { resolveRoleModel: (role: TeamRole) => { error?: string; modelLabel?: string } }).resolveRoleModel =
      (role: TeamRole) =>
        role === 'lead'
          ? { error: 'Team role "lead" is configured to model "gpt-5.6-sol" (damocles.team.leadModel), but that model is not available or its provider is not signed in. Sign in or change the setting.' }
          : { modelLabel: 'spec-model' };
    const runner = new TeamRunner(config, () => undefined);

    await expect(runner.run()).rejects.toThrow('damocles.team.leadModel');
  });
});
