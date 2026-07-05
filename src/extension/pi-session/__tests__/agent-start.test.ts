import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';

const { tmpHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dam-agentstart-home-')) };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

import { buildAgentStartResult, CONTEXT_INJECTION_CUSTOM_TYPE } from '../agent-start';
import { computePlanFilePath, DAMOCLES_PLANS_DIR } from '../../paths';
import type { PanelGateContext } from '../permission-gate';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

function event(over: Partial<BeforeAgentStartEvent> = {}): BeforeAgentStartEvent {
  return {
    type: 'before_agent_start',
    prompt: 'do the thing',
    systemPrompt: 'PI BASE — operating inside pi',
    systemPromptOptions: { cwd: '/repo' },
    ...over,
  } as BeforeAgentStartEvent;
}

interface PanelStub {
  panel: PanelGateContext;
  messages: ExtensionToWebviewMessage[];
  persist: ReturnType<typeof vi.fn>;
  markFirst: ReturnType<typeof vi.fn>;
}

function makePanel(opts: {
  memoryEnabled?: boolean;
  compassEnabled?: boolean;
  plan?: boolean;
  catalog?: string;
  metadata?: unknown;
  planFilePath?: string;
  teamEnabled?: boolean;
} = {}): PanelStub {
  const messages: ExtensionToWebviewMessage[] = [];
  const persist = vi.fn(async () => undefined);
  const markFirst = vi.fn(() => undefined);
  const memoryService = opts.memoryEnabled
    ? ({
        isEnabled: true,
        ensureInitialized: async () => undefined,
        buildInjectionContext: async () => ({
          context: opts.catalog ?? '<damocles_memory>catalog</damocles_memory>',
          metadata: opts.metadata ?? { items: [] },
        }),
        persistMemoryInjection: persist,
        markFirstMessageSent: markFirst,
        isFirstMessageOfSession: () => true,
      } as unknown as PanelGateContext['memoryService'])
    : undefined;
  const compassService = opts.compassEnabled
    ? ({
        isEnabled: true,
        getStatus: () => ({ state: 'ready', nodeCount: 12, edgeCount: 30, lastIndexedAt: Date.now(), error: undefined }),
      } as unknown as PanelGateContext['compassService'])
    : undefined;

  const panel: PanelGateContext = {
    permissionHandler: {} as PanelGateContext['permissionHandler'],
    isPlanMode: () => Boolean(opts.plan),
    ...(memoryService ? { memoryService } : {}),
    ...(compassService ? { compassService } : {}),
    getSessionModel: () => 'claude-opus-4-8',
    getSystemPromptEnv: () => ({
      cwd: '/repo',
      model: 'claude-opus-4-8',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: Boolean(opts.compassEnabled),
    }),
    getPlanFilePath: () => opts.planFilePath ?? '/home/.damocles/plans/do-the-thing-sess1234.md',
    isTeamEnabled: () => Boolean(opts.teamEnabled),
    postMessage: (m) => messages.push(m),
    currentPromptIndex: () => 3,
  };
  return { panel, messages, persist, markFirst };
}

beforeEach(() => {
  fs.rmSync(DAMOCLES_PLANS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DAMOCLES_PLANS_DIR, { recursive: true });
});

describe('buildAgentStartResult — system prompt (US-007)', () => {
  it('returns the Damocles prompt and drops pi boilerplate', async () => {
    const { panel } = makePanel({ memoryEnabled: true });
    const result = await buildAgentStartResult(event(), panel, 'sess-1');
    expect(result?.systemPrompt).toContain('AI coding agent');
    expect(result?.systemPrompt).not.toContain('operating inside pi');
    expect(result?.systemPrompt).not.toContain('PI BASE');
  });

  it('includes the static MEMORY_SYSTEM_PROMPT in the system prompt only when memory is enabled', async () => {
    const on = await buildAgentStartResult(event(), makePanel({ memoryEnabled: true }).panel, 'sess-1');
    expect(on?.systemPrompt).toContain('persistent memory system');
    const off = await buildAgentStartResult(event(), makePanel({}).panel, 'sess-1');
    expect(off?.systemPrompt).not.toContain('persistent memory system');
  });

  it('appends the shared plan-mode guidance (naming the plan file) only in plan mode', async () => {
    const planning = await buildAgentStartResult(event(), makePanel({ plan: true }).panel, 'sess-1');
    expect(planning?.systemPrompt).toContain('Plan mode is active');
    expect(planning?.systemPrompt).toContain('/home/.damocles/plans/do-the-thing-sess1234.md');
    // Shared adaptive-guidance markers (must match the EnterPlanMode tool path — same builder).
    expect(planning?.systemPrompt).toContain('Clarify continuously');
    expect(planning?.systemPrompt).toContain('Explore subagent');
    expect(planning?.systemPrompt).toContain('Verification');
    expect(planning?.systemPrompt).toContain('ExitPlanMode');
    const normal = await buildAgentStartResult(event(), makePanel({}).panel, 'sess-1');
    expect(normal?.systemPrompt).not.toContain('Plan mode is active');
  });

  it('outside plan mode, names the existing plan file every turn so the model never hunts for it', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const result = await buildAgentStartResult(event(), makePanel({}).panel, 'sess-1');
    expect(result?.systemPrompt).toContain(planFilePath);
    expect(result?.systemPrompt).toContain('do not search for it');
    expect(result?.systemPrompt).not.toContain('Plan mode is active');
  });

  it('outside plan mode with teams enabled + a bound plan, injects the binding team directive', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const result = await buildAgentStartResult(event(), makePanel({ teamEnabled: true }).panel, 'sess-1');
    expect(result?.systemPrompt).toContain(planFilePath); // existing reminder still present
    expect(result?.systemPrompt).toContain('binding');
    expect(result?.systemPrompt).toContain('create_team');
    expect(result?.systemPrompt).toContain("isn't parallelizable");
    // Routes intent through `brief`, never `title`.
    expect(result?.systemPrompt).toContain('create_team `brief` argument');
    expect(result?.systemPrompt).toContain('never cram the detailed intent into `title`');
  });

  it('outside plan mode with teams disabled + a bound plan, emits the reminder but NOT the team directive', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const result = await buildAgentStartResult(event(), makePanel({ teamEnabled: false }).panel, 'sess-1');
    expect(result?.systemPrompt).toContain(planFilePath);
    expect(result?.systemPrompt).not.toContain('treat its orchestration directives as binding');
  });

  it('outside plan mode with teams enabled but NO plan file, injects no team directive (raw-paste boundary)', async () => {
    const result = await buildAgentStartResult(event(), makePanel({ teamEnabled: true }).panel, 'sess-never-planned');
    expect(result?.systemPrompt).not.toContain('treat its orchestration directives as binding');
  });

  it('in plan mode with teams enabled, emits plan-mode guidance but NOT the execution-time team directive', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const result = await buildAgentStartResult(event(), makePanel({ plan: true, teamEnabled: true }).panel, 'sess-1');
    expect(result?.systemPrompt).toContain('Plan mode is active');
    expect(result?.systemPrompt).not.toContain('treat its orchestration directives as binding');
  });

  it('finds the plan by id suffix even when the slug differs (drift-proof — the bug this fixes)', async () => {
    // A plan bound before the first message lands under the empty-slug fallback; the reminder must still
    // name it once the user prompts and the recomputed slug no longer matches the on-disk filename.
    const orphan = computePlanFilePath('sess-1', ''); // plan-<id8>.md
    fs.writeFileSync(orphan, '# Plan');
    const result = await buildAgentStartResult(event(), makePanel({}).panel, 'sess-1');
    expect(result?.systemPrompt).toContain(orphan);
    expect(result?.systemPrompt).toContain('do not search for it');
  });

  it('does not name a plan file that does not exist (a session that never planned)', async () => {
    const result = await buildAgentStartResult(event(), makePanel({}).panel, 'sess-never-planned');
    expect(result?.systemPrompt).not.toContain('plan file at');
  });

  it('in plan mode, names the plan file via the plan-mode instruction (not the reminder), even before it exists', async () => {
    const result = await buildAgentStartResult(event(), makePanel({ plan: true, planFilePath: '/no/such/plan-cafe.md' }).panel, 'sess-1');
    expect(result?.systemPrompt).toContain('/no/such/plan-cafe.md');
    expect(result?.systemPrompt).toContain('Plan mode is active');
  });

  it('re-appends pi project-context files (CLAUDE.md) into the prompt', async () => {
    const ev = event({ systemPromptOptions: { cwd: '/repo', contextFiles: [{ path: 'CLAUDE.md', content: 'PROJECT RULES' }] } });
    const result = await buildAgentStartResult(ev, makePanel({}).panel, 'sess-1');
    expect(result?.systemPrompt).toContain('<project_context>');
    expect(result?.systemPrompt).toContain('PROJECT RULES');
    expect(result?.systemPrompt).toContain('path="CLAUDE.md"');
  });
});

describe('buildAgentStartResult — injection (US-005)', () => {
  it('injects memory catalog + compass status as one non-displayed custom message', async () => {
    const { panel, persist, markFirst } = makePanel({ memoryEnabled: true, compassEnabled: true });
    const result = await buildAgentStartResult(event(), panel, 'sess-1');
    expect(result?.message?.customType).toBe(CONTEXT_INJECTION_CUSTOM_TYPE);
    expect(result?.message?.display).toBe(false);
    const content = result?.message?.content as string;
    expect(content).toContain('<damocles_memory>');
    expect(content).toContain('<damocles_compass');
    expect(persist).toHaveBeenCalledWith('sess-1', 3, { items: [] });
    expect(markFirst).toHaveBeenCalledWith('sess-1');
  });

  it('emits contextInjectionStarted before memoryInjectionUpdate + contextInjectionComplete keyed by prompt index', async () => {
    const { panel, messages } = makePanel({ memoryEnabled: true });
    await buildAgentStartResult(event(), panel, 'sess-1');
    expect(messages).toContainEqual({ type: 'contextInjectionStarted', promptIndex: 3 });
    expect(messages).toContainEqual({ type: 'memoryInjectionUpdate', promptIndex: 3, data: { items: [] } });
    expect(messages).toContainEqual({ type: 'contextInjectionComplete', promptIndex: 3 });
    const started = messages.findIndex((m) => m.type === 'contextInjectionStarted');
    const update = messages.findIndex((m) => m.type === 'memoryInjectionUpdate');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(update);
  });

  it('does not fold the static memory instructions into the injected message (cache-stable split)', async () => {
    const { panel } = makePanel({ memoryEnabled: true });
    const result = await buildAgentStartResult(event(), panel, 'sess-1');
    expect((result?.message?.content as string) ?? '').not.toContain('persistent memory system');
  });

  it('injects nothing into the message when both services are disabled', async () => {
    const { panel } = makePanel({});
    const result = await buildAgentStartResult(event(), panel, 'sess-1');
    expect(result?.message).toBeUndefined();
    expect(result?.systemPrompt).toBeTruthy();
  });

  it('re-injects fresh context on a second turn (message present each turn)', async () => {
    const { panel } = makePanel({ memoryEnabled: true });
    const first = await buildAgentStartResult(event(), panel, 'sess-1');
    const second = await buildAgentStartResult(event(), panel, 'sess-1');
    expect(first?.message).toBeDefined();
    expect(second?.message).toBeDefined();
  });
});
