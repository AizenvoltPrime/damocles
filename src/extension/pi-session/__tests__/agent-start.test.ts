import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import type { BeforeAgentStartEvent, NormalizedBuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';

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

// The skills section is only reachable through pi's own formatter, which is null until the harness
// loads; the stub stands in for it and deliberately returns pi's leading blank lines so the trim shows.
// It echoes the `fileReadTool` argument the way pi's formatter names it in its prose, so a caller that
// drops the argument is visible in the rendered section rather than silently defaulting to `read`.
vi.mock('../pi-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-loader')>();
  return {
    ...actual,
    getPiCodingAgent: () => ({
      formatSkillsForPrompt: (skills: Array<{ name: string }>, fileReadTool?: string) =>
        `\n\nThe following skills provide specialized instructions.\nfileReadTool=${String(fileReadTool)}\n<available_skills>\n${skills
          .map((s) => s.name)
          .join(',')}\n</available_skills>`,
    }),
  };
});

import {
  assembleDamoclesSystemPrompt,
  buildAgentStartResult,
  renderSections,
  resolveSkillFileReadTool,
  CONTEXT_INJECTION_CUSTOM_TYPE,
  type DamoclesSystemPromptInputs,
} from '../agent-start';
import { computePlanFilePath, DAMOCLES_PLANS_DIR } from '../../paths';
import type { PanelGateContext } from '../permission-gate';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

/** Mirrors what `normalizeBuildSystemPromptOptions` hands a handler, defaults included: every
 *  collection field is present, and `selectedTools` defaults to pi's four built-ins. */
function promptOptions(over: Partial<NormalizedBuildSystemPromptOptions> = {}): NormalizedBuildSystemPromptOptions {
  return {
    selectedTools: ['read', 'bash', 'edit', 'write'],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: '',
    sections: {},
    cwd: '/repo',
    contextFiles: [],
    skills: [],
    ...over,
  };
}

function event(over: Partial<BeforeAgentStartEvent> = {}): BeforeAgentStartEvent {
  return {
    type: 'before_agent_start',
    prompt: 'do the thing',
    systemPrompt: 'PI BASE — operating inside pi',
    systemPromptOptions: promptOptions(),
    ...over,
  };
}

const skillsFixture = [{ name: 'demo' }] as unknown as NormalizedBuildSystemPromptOptions['skills'];

/** The prompt text pi will render from the options the handler mutated. */
function renderedPrompt(ev: BeforeAgentStartEvent): string {
  return renderSections({ preamble: ev.systemPromptOptions.customPrompt ?? '', sections: ev.systemPromptOptions.sections });
}

/** Run the handler and return the text pi will render, so prompt assertions read the mutated options
 *  rather than a return value the handler must no longer produce. */
async function promptTextFor(ev: BeforeAgentStartEvent, panel: PanelGateContext, sessionId = 'sess-1'): Promise<string> {
  await buildAgentStartResult(ev, panel, sessionId);
  return renderedPrompt(ev);
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
  thinkingDisabled?: boolean;
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
    budgetStopRequested: () => false,
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
      thinkingDisabled: Boolean(opts.thinkingDisabled),
    }),
    getPlanFilePath: () => opts.planFilePath ?? '/home/.damocles/plans/do-the-thing-sess1234.md',
    isTeamEnabled: () => Boolean(opts.teamEnabled),
    postMessage: (m) => messages.push(m),
    currentPromptIndex: () => 3,
  };
  return { panel, messages, persist, markFirst };
}

function inputs(over: Partial<DamoclesSystemPromptInputs> = {}): DamoclesSystemPromptInputs {
  return {
    env: makePanel().panel.getSystemPromptEnv(),
    memoryEnabled: false,
    planMode: false,
    teamEnabled: false,
    webSearchEnabled: false,
    planFilePath: '/home/.damocles/plans/plan-cafe.md',
    existingPlanFile: undefined,
    contextFiles: [],
    skills: [],
    skillFileReadTool: 'read',
    ...over,
  };
}

beforeEach(() => {
  fs.rmSync(DAMOCLES_PLANS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DAMOCLES_PLANS_DIR, { recursive: true });
});

describe('assembleDamoclesSystemPrompt — section map', () => {
  it('builds the contract key order for a representative set of inputs', () => {
    expect(Object.keys(assembleDamoclesSystemPrompt(inputs()).sections)).toEqual(['damocles_tone']);

    expect(Object.keys(assembleDamoclesSystemPrompt(inputs({ memoryEnabled: true, planMode: true })).sections)).toEqual([
      'damocles_memory',
      'damocles_plan_mode',
      'damocles_tone',
    ]);

    expect(
      Object.keys(assembleDamoclesSystemPrompt(inputs({ existingPlanFile: '/p/plan.md', teamEnabled: true })).sections),
    ).toEqual(['damocles_plan_file', 'damocles_team_directive', 'damocles_tone']);

    expect(
      Object.keys(
        assembleDamoclesSystemPrompt(
          inputs({
            memoryEnabled: true,
            planMode: true,
            contextFiles: [{ path: 'CLAUDE.md', content: 'RULES' }],
            skills: skillsFixture,
          }),
        ).sections,
      ),
    ).toEqual(['damocles_memory', 'damocles_plan_mode', 'project_context', 'skills', 'damocles_tone']);
  });

  it('keeps plan mode and the plan-file reminder mutually exclusive', () => {
    const keys = Object.keys(
      assembleDamoclesSystemPrompt(inputs({ planMode: true, existingPlanFile: '/p/plan.md', teamEnabled: true })).sections,
    );
    expect(keys).toEqual(['damocles_plan_mode', 'damocles_tone']);
  });

  it('omits a toggled-off key entirely instead of emitting an empty value', () => {
    const on = assembleDamoclesSystemPrompt(inputs({ memoryEnabled: true })).sections;
    const off = assembleDamoclesSystemPrompt(inputs({ memoryEnabled: false })).sections;
    expect(on.damocles_memory).toBeTruthy();
    expect('damocles_memory' in off).toBe(false);
    expect(Object.values(off).every((content) => content.length > 0)).toBe(true);
  });

  // pi wraps every non-preamble section itself, so a wrapper here would nest one inside another.
  it('leaves project_context unwrapped and byte-identical to pi renderProjectContext', () => {
    const { sections } = assembleDamoclesSystemPrompt(
      inputs({ contextFiles: [{ path: 'CLAUDE.md', content: 'RULES' }, { path: 'AGENTS.md', content: 'MORE' }] }),
    );
    expect(sections.project_context).not.toContain('<project_context>');
    expect(sections.project_context).not.toContain('</project_context>');
    expect(sections.project_context).toBe(
      'Project-specific instructions and guidelines:\n\n' +
        '<project_instructions path="CLAUDE.md">\nRULES\n</project_instructions>\n\n' +
        '<project_instructions path="AGENTS.md">\nMORE\n</project_instructions>',
    );
  });

  it('trims the skills section the way pi trims its own', () => {
    const { sections } = assembleDamoclesSystemPrompt(inputs({ skills: skillsFixture }));
    const skills = sections.skills ?? '';
    expect(skills.startsWith('The following skills')).toBe(true);
    expect(skills.endsWith('</available_skills>')).toBe(true);
  });

  it('omits skills when no tool can read a skill file', () => {
    const { sections } = assembleDamoclesSystemPrompt(inputs({ skills: skillsFixture, skillFileReadTool: undefined }));
    expect('skills' in sections).toBe(false);
  });

  // pi's formatter writes "Use the read tool" or "Use bash" from this argument, so passing the wrong one
  // (or none) hands a bash-only session prose naming a tool it does not have.
  it('passes the resolved file-read tool to pi own formatter', () => {
    expect(assembleDamoclesSystemPrompt(inputs({ skills: skillsFixture })).sections.skills).toContain('fileReadTool=read');
    expect(
      assembleDamoclesSystemPrompt(inputs({ skills: skillsFixture, skillFileReadTool: 'bash' })).sections.skills,
    ).toContain('fileReadTool=bash');
  });

  it('never uses preamble or an integer-like name as a section key', () => {
    const { sections } = assembleDamoclesSystemPrompt(
      inputs({ memoryEnabled: true, planMode: true, contextFiles: [{ path: 'CLAUDE.md', content: 'RULES' }], skills: skillsFixture }),
    );
    for (const name of Object.keys(sections)) {
      expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(name).not.toBe('preamble');
      expect(Number.isNaN(Number(name))).toBe(true);
    }
  });
});

describe('resolveSkillFileReadTool', () => {
  it('mirrors pi own precedence over the selected tools', () => {
    expect(resolveSkillFileReadTool(['read', 'bash', 'edit', 'write'])).toBe('read');
    expect(resolveSkillFileReadTool(['bash', 'read'])).toBe('read');
    expect(resolveSkillFileReadTool(['bash'])).toBe('bash');
    expect(resolveSkillFileReadTool(['edit', 'write'])).toBeUndefined();
    expect(resolveSkillFileReadTool([])).toBeUndefined();
  });
});

describe('renderSections', () => {
  it('renders the preamble untagged and wraps every section, joined by a blank line', () => {
    expect(renderSections({ preamble: 'BASE', sections: { damocles_memory: 'M', damocles_tone: 'T' } })).toBe(
      'BASE\n\n<damocles_memory>\nM\n</damocles_memory>\n\n<damocles_tone>\nT\n</damocles_tone>',
    );
  });
});

describe('buildAgentStartResult — system prompt (US-007)', () => {
  it('writes the prompt into systemPromptOptions and returns no systemPrompt', async () => {
    const ev = event();
    const result = await buildAgentStartResult(ev, makePanel({ memoryEnabled: true }).panel, 'sess-1');
    expect(result).not.toHaveProperty('systemPrompt');
    expect(ev.systemPromptOptions.customPrompt).toContain('AI coding agent');
    expect(Object.keys(ev.systemPromptOptions.sections)).toEqual(['damocles_memory', 'damocles_tone']);
  });

  it('drops a section that this build did not produce rather than emptying it', async () => {
    const ev = event();
    await buildAgentStartResult(ev, makePanel({ memoryEnabled: true }).panel, 'sess-1');
    expect(ev.systemPromptOptions.sections.damocles_memory).toBeTruthy();
    // pi removes a section by absence; an empty value would be dropped and the stale key would survive.
    await buildAgentStartResult(ev, makePanel({}).panel, 'sess-1');
    expect('damocles_memory' in ev.systemPromptOptions.sections).toBe(false);
  });

  it('removes a stale key left by anything else in the options', async () => {
    const ev = event({ systemPromptOptions: promptOptions({ sections: { damocles_plan_mode: 'stale' } }) });
    await buildAgentStartResult(ev, makePanel({}).panel, 'sess-1');
    expect('damocles_plan_mode' in ev.systemPromptOptions.sections).toBe(false);
  });

  it('drops pi boilerplate', async () => {
    const text = await promptTextFor(event(), makePanel({ memoryEnabled: true }).panel);
    expect(text).toContain('AI coding agent');
    expect(text).not.toContain('operating inside pi');
    expect(text).not.toContain('PI BASE');
  });

  // Everything appended after the tone rules is what makes the tail restatement load-bearing, so it has
  // to be the last section in every assembly, including the longest one.
  it('closes on the tail conciseness reminder, whatever else was appended', async () => {
    for (const opts of [{}, { memoryEnabled: true }, { memoryEnabled: true, plan: true, teamEnabled: true }]) {
      const ev = event();
      const text = await promptTextFor(ev, makePanel(opts).panel);
      expect(Object.keys(ev.systemPromptOptions.sections).at(-1)).toBe('damocles_tone');
      // pi supplies the only wrapper, so the section body carries no tag of its own.
      expect(text.trimEnd().endsWith('<damocles_tone>\nKeep outputs reasonably concise.\n</damocles_tone>')).toBe(true);
    }
  });

  it('gates the thinking-off output-form guidance on thinking actually being off', async () => {
    const off = await promptTextFor(event(), makePanel({ thinkingDisabled: true }).panel);
    expect(off).toContain('Do not include internal or system XML tags in your response.');
    const on = await promptTextFor(event(), makePanel({}).panel);
    expect(on).not.toContain('Do not include internal or system XML tags in your response.');
  });

  it('includes the static MEMORY_SYSTEM_PROMPT in the system prompt only when memory is enabled', async () => {
    const on = await promptTextFor(event(), makePanel({ memoryEnabled: true }).panel);
    expect(on).toContain('persistent memory system');
    const off = await promptTextFor(event(), makePanel({}).panel);
    expect(off).not.toContain('persistent memory system');
  });

  it('appends the shared plan-mode guidance (naming the plan file) only in plan mode', async () => {
    const planning = await promptTextFor(event(), makePanel({ plan: true }).panel);
    expect(planning).toContain('Plan mode is active');
    expect(planning).toContain('/home/.damocles/plans/do-the-thing-sess1234.md');
    // Shared adaptive-guidance markers (must match the EnterPlanMode tool path — same builder).
    expect(planning).toContain('Clarify continuously');
    expect(planning).toContain('Explore subagent');
    expect(planning).toContain('Verification');
    expect(planning).toContain('ExitPlanMode');
    const normal = await promptTextFor(event(), makePanel({}).panel);
    expect(normal).not.toContain('Plan mode is active');
  });

  it('outside plan mode, names the existing plan file every turn so the model never hunts for it', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const text = await promptTextFor(event(), makePanel({}).panel);
    expect(text).toContain(planFilePath);
    expect(text).toContain('do not search for it');
    expect(text).not.toContain('Plan mode is active');
  });

  it('outside plan mode with teams enabled + a bound plan, injects the binding team directive', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const ev = event();
    const text = await promptTextFor(ev, makePanel({ teamEnabled: true }).panel);
    expect(text).toContain(planFilePath); // existing reminder still present
    expect(text).toContain('binding');
    expect(text).toContain('create_team');
    expect(text).toContain("isn't parallelizable");
    // Routes intent through `brief`; the title/brief mechanics live in the create_team description.
    expect(text).toContain('create_team `brief` argument');
    expect(Object.keys(ev.systemPromptOptions.sections)).toEqual([
      'damocles_plan_file',
      'damocles_team_directive',
      'damocles_tone',
    ]);
  });

  it('outside plan mode with teams disabled + a bound plan, emits the reminder but NOT the team directive', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const text = await promptTextFor(event(), makePanel({ teamEnabled: false }).panel);
    expect(text).toContain(planFilePath);
    expect(text).not.toContain('treat its orchestration directives as binding');
  });

  it('outside plan mode with teams enabled but NO plan file, injects no team directive (raw-paste boundary)', async () => {
    const text = await promptTextFor(event(), makePanel({ teamEnabled: true }).panel, 'sess-never-planned');
    expect(text).not.toContain('treat its orchestration directives as binding');
  });

  it('in plan mode with teams enabled, emits plan-mode guidance but NOT the execution-time team directive', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const text = await promptTextFor(event(), makePanel({ plan: true, teamEnabled: true }).panel);
    expect(text).toContain('Plan mode is active');
    expect(text).not.toContain('treat its orchestration directives as binding');
  });

  it('finds the plan by id suffix even when the slug differs (drift-proof — the bug this fixes)', async () => {
    // A plan bound before the first message lands under the empty-slug fallback; the reminder must still
    // name it once the user prompts and the recomputed slug no longer matches the on-disk filename.
    const orphan = computePlanFilePath('sess-1', ''); // plan-<id8>.md
    fs.writeFileSync(orphan, '# Plan');
    const text = await promptTextFor(event(), makePanel({}).panel);
    expect(text).toContain(orphan);
    expect(text).toContain('do not search for it');
  });

  it('does not name a plan file that does not exist (a session that never planned)', async () => {
    const text = await promptTextFor(event(), makePanel({}).panel, 'sess-never-planned');
    expect(text).not.toContain('plan file at');
  });

  it('in plan mode, names the plan file via the plan-mode instruction (not the reminder), even before it exists', async () => {
    const text = await promptTextFor(event(), makePanel({ plan: true, planFilePath: '/no/such/plan-cafe.md' }).panel);
    expect(text).toContain('/no/such/plan-cafe.md');
    expect(text).toContain('Plan mode is active');
  });

  it('re-appends pi project-context files (CLAUDE.md) under pi own section name', async () => {
    const ev = event({ systemPromptOptions: promptOptions({ contextFiles: [{ path: 'CLAUDE.md', content: 'PROJECT RULES' }] }) });
    const text = await promptTextFor(ev, makePanel({}).panel);
    expect(ev.systemPromptOptions.sections.project_context).not.toContain('<project_context>');
    expect(text).toContain('<project_context>');
    expect(text).toContain('PROJECT RULES');
    expect(text).toContain('path="CLAUDE.md"');
  });

  it('emits the skills section for a bash-only session, matching pi own read-or-bash gate', async () => {
    const withBash = event({ systemPromptOptions: promptOptions({ selectedTools: ['bash'], skills: skillsFixture }) });
    await buildAgentStartResult(withBash, makePanel({}).panel, 'sess-1');
    expect(withBash.systemPromptOptions.sections.skills).toContain('<available_skills>');
    // The section overwrites the one pi built, so its prose must name bash, not the absent read tool.
    expect(withBash.systemPromptOptions.sections.skills).toContain('fileReadTool=bash');

    const withNeither = event({ systemPromptOptions: promptOptions({ selectedTools: ['edit', 'write'], skills: skillsFixture }) });
    await buildAgentStartResult(withNeither, makePanel({}).panel, 'sess-1');
    expect('skills' in withNeither.systemPromptOptions.sections).toBe(false);
  });

  it('names read whenever read is selected, whatever else the session carries', async () => {
    const both = event({ systemPromptOptions: promptOptions({ selectedTools: ['bash', 'read'], skills: skillsFixture }) });
    await buildAgentStartResult(both, makePanel({}).panel, 'sess-1');
    expect(both.systemPromptOptions.sections.skills).toContain('fileReadTool=read');
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
    const ev = event();
    const result = await buildAgentStartResult(ev, makePanel({}).panel, 'sess-1');
    expect(result?.message).toBeUndefined();
    expect(ev.systemPromptOptions.customPrompt).toBeTruthy();
  });

  it('re-injects fresh context on a second turn (message present each turn)', async () => {
    const { panel } = makePanel({ memoryEnabled: true });
    const first = await buildAgentStartResult(event(), panel, 'sess-1');
    const second = await buildAgentStartResult(event(), panel, 'sess-1');
    expect(first?.message).toBeDefined();
    expect(second?.message).toBeDefined();
  });
});
