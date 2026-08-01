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
import { type NestedMcpToolset } from '../../pi-session/tools/mcp-tools';
import { teamAgentToolset } from './team-mcp-fixture';
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

/** Every agentId whose parent-panel dialogs the runner withdrew (Slice 2 §F, lead teardown path). */
const cancelledDialogs: string[] = [];

function makeConfig(): TeamConfig {
  cancelledDialogs.length = 0;
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
      // The REAL `TeamEngine` shape: ONE call per spawn returning names + customTools + the frozen MCP
      // snapshot, and `buildExtensionFactory` receiving that SAME snapshot as its third argument. The
      // snapshot is NON-EMPTY and built by the real builder — see `team-mcp-fixture.ts` for why an
      // empty one made every spawn-site mutation unobservable.
      buildAgentToolset: () => {
        const { toolNames, customTools, mcp } = teamAgentToolset();
        return { toolNames, customTools, mcp };
      },
      buildExtensionFactory: (_agentName: string, _agentId: string, _mcp: NestedMcpToolset) => (() => undefined) as never,
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: (agentId: string) => cancelledDialogs.push(agentId),
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

  it('Slice 2 §F: the LEAD settle path withdraws the lead’s parent-panel dialogs', async () => {
    // The lead has MCP tools and an attributed dialog bridge exactly like a specialist, and its
    // teardown lives in a different branch of the runner. Covering only the specialist path would
    // leave a modal naming a finished lead on screen with nobody able to answer it.
    const runner = new TeamRunner(makeConfig(), () => undefined);
    let leadAgentId = '';
    (runner as unknown as { agentRunner: { startAgent: (c: AgentRunConfig) => Promise<AgentResult> } }).agentRunner = {
      startAgent: async (cfg: AgentRunConfig) => {
        leadAgentId = cfg.agentId;
        return completedResult(cfg.agentId);
      },
    };

    await runner.run();

    expect(leadAgentId).not.toBe('');
    expect(cancelledDialogs).toContain(leadAgentId);
    // …and the end-of-run sweep covers the specialist that never ran (status 'pending'): an agent that
    // never reached its own settle handler is exactly the one whose modal would otherwise outlive the
    // team. One entry per agent, so every agentId in the roster is accounted for.
    expect(cancelledDialogs).toHaveLength(2);
    expect(new Set(cancelledDialogs).size).toBe(2);

    // The swept agent's id asserted BY VALUE, and the scope id excluded. The sweep sits next to
    // `disposeBrowserScope(browserScopeIdFor(agent), …)`, and the two keys are different strings for
    // the same agent — so `cancelAgentDialogs(browserScopeIdFor(agent))` still produces two distinct
    // entries containing the lead's id and passes every count-and-uniqueness check. It would also
    // strand that specialist's modal permanently, since this sweep is the only place a pending agent's
    // dialogs are ever released.
    const specialist = (runner as unknown as { agents: Map<string, { name: string; agentId: string }> }).agents;
    const spec = [...specialist.values()].find((a) => a.agentId !== leadAgentId)!;
    expect(cancelledDialogs).toContain(spec.agentId);
    expect(cancelledDialogs).not.toContain(`${spec.agentId}#0`);
  });

  it('Slice 2 §F: a THROWN lead run still withdraws its dialogs (the lead catch branch)', async () => {
    // The lead's catch branch is a separate teardown site from its settle branch, and a crashed lead is
    // the likeliest one to have left a modal up. Nothing else in the suite reaches this branch.
    const runner = new TeamRunner(makeConfig(), () => undefined);
    let leadAgentId = '';
    (runner as unknown as { agentRunner: { startAgent: (c: AgentRunConfig) => Promise<AgentResult> } }).agentRunner = {
      startAgent: async (cfg: AgentRunConfig) => {
        leadAgentId = cfg.agentId;
        throw new Error('lead crashed');
      },
    };

    await runner.run();

    expect(leadAgentId).not.toBe('');
    expect(cancelledDialogs).toContain(leadAgentId);
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
