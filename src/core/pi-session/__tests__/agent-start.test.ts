import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import type { BeforeAgentStartEvent, NormalizedBuildSystemPromptOptions, SessionEntry } from '@earendil-works/pi-coding-agent';

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
  buildCompassContext,
  type ProjectionReader,
  renderSections,
  resolveSkillFileReadTool,
  type DamoclesSystemPromptInputs,
} from '../agent-start';
import { installFakePlatform } from '../../../__mocks__/fake-platform';
import { CONTEXT_INJECTION_CUSTOM_TYPE } from '../live-injections';
import { DAMOCLES_MID_STREAM_ENTRY } from '../session-store/constants';
import { computePlanFilePath, DAMOCLES_PLANS_DIR } from '../../paths';
import type { PanelGateContext } from '../permission-gate';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { CANCEL_NOTE_DETAIL_KEY, CANCELLED_TOOL_DETAIL_KEY } from '../../../shared/types/session';
import type { MemoryInjectionDisplay } from '../../../shared/types/context-injection';
import type { ContextInjectionDetailsV1 } from '../../memory/injection/details';
import type { InjectionBuildResult } from '../../memory/managers/injection-manager';
import { formatIdeContextBlock } from '../../../shared/ide-context';
import { ShellCancelStore } from '../tools/shell-cancel-registry';

/** The opening of the execution-time plan directive, used for both its presence and its absence. */
const PLAN_EXECUTION_MARKER = 'treat the delivery mechanism it assigns each slice as the default';

/** Mirrors what `normalizeBuildSystemPromptOptions` hands a handler, defaults included: every
 *  collection field is present, and `selectedTools` defaults to pi's four built-ins. */
function promptOptions(over: Partial<NormalizedBuildSystemPromptOptions> = {}): NormalizedBuildSystemPromptOptions {
  return {
    selectedTools: ['read', 'bash', 'edit', 'write'],
    hiddenTools: [],
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

const userEntry = (id: string): SessionEntry =>
  ({ id, type: 'message', message: { role: 'user', content: [{ type: 'text', text: id }] } }) as unknown as SessionEntry;

/** A branch holding prompts 0 to 2, so the prompt being dispatched on it is prompt 3. */
const BRANCH_BEFORE_PROMPT_3: readonly SessionEntry[] = [userEntry('u0'), userEntry('u1'), userEntry('u2')];

/** A session manager whose projection holds exactly `messages`. */
function projectionOf(messages: unknown[] = [], branch: readonly SessionEntry[] = BRANCH_BEFORE_PROMPT_3): ProjectionReader {
  return { buildSessionProjection: () => ({ messages }), getBranch: () => [...branch] } as unknown as ProjectionReader;
}

function runAgentStart(
  ev: BeforeAgentStartEvent,
  panel: PanelGateContext,
  sessionId: string,
  sessionManager: ProjectionReader = projectionOf(),
  isLive: () => boolean = () => true,
): ReturnType<typeof buildAgentStartResult> {
  return buildAgentStartResult(ev, panel, sessionId, sessionManager, isLive);
}

function emptyDisplay(): MemoryInjectionDisplay {
  return {
    version: 3,
    promptIndex: 3,
    added: [],
    notices: [],
    carried: [],
    profile: { state: 'empty', tokens: 0, text: '' },
    compass: { state: 'disabled', text: '' },
    query: { terms: [], dropped: [], mentionedIds: [], files: [] },
    gate: { considered: 0, passed: 0, unmatchedSkipped: 0, alreadyInContext: 0, overBudget: 0, preferencesDeferred: 0 },
    tokens: { memories: 12, notices: 0, profile: 0, compass: 0, total: 12, budget: 2000 },
    storeCounts: { session: 0, project: 1, global: 0, observations: 0, total: 1 },
    rerankApplied: false,
    exactText: '',
  };
}

const MEMORY_DETAILS: ContextInjectionDetailsV1 = {
  v: 1,
  promptIndex: 3,
  memories: [{ id: 'm1', hash: 'h1', tier: 'full' }],
  notices: [],
  profile: false,
  compassKey: null,
};

/** The prompt text pi will render from the options the handler mutated. */
function renderedPrompt(ev: BeforeAgentStartEvent): string {
  return renderSections({ preamble: ev.systemPromptOptions.customPrompt ?? '', sections: ev.systemPromptOptions.sections });
}

/** Run the handler and return the text pi will render, so prompt assertions read the mutated options
 *  rather than a return value the handler must no longer produce. */
async function promptTextFor(ev: BeforeAgentStartEvent, panel: PanelGateContext, sessionId = 'sess-1'): Promise<string> {
  await runAgentStart(ev, panel, sessionId);
  return renderedPrompt(ev);
}

interface PanelStub {
  panel: PanelGateContext;
  messages: ExtensionToWebviewMessage[];
  persist: ReturnType<typeof vi.fn>;
  build: ReturnType<typeof vi.fn>;
}

function makePanel(opts: {
  memoryEnabled?: boolean;
  compassEnabled?: boolean;
  thinkingDisabled?: boolean;
  plan?: boolean;
  /** The memory block this prompt adds; '' when nothing is new. */
  catalog?: string;
  planFilePath?: string;
  teamEnabled?: boolean;
} = {}): PanelStub {
  const messages: ExtensionToWebviewMessage[] = [];
  const persist = vi.fn(async () => undefined);
  const build = vi.fn(async (): Promise<InjectionBuildResult> => {
    const text = opts.catalog ?? '<damocles_memory>catalog</damocles_memory>';
    return { text, details: text ? { ...MEMORY_DETAILS } : null, display: emptyDisplay(), mentionedIds: [] };
  });
  const memoryService = opts.memoryEnabled
    ? ({
        isEnabled: true,
        ensureInitialized: async () => undefined,
        buildInjectionContext: build,
        persistMemoryInjection: persist,
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
    shellCancel: new ShellCancelStore().forContext(() => undefined),
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
  };
  return { panel, messages, persist, build };
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
    ).toEqual(['damocles_plan_file', 'damocles_plan_execution', 'damocles_tone']);

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
    const result = await runAgentStart(ev, makePanel({ memoryEnabled: true }).panel, 'sess-1');
    expect(result).not.toHaveProperty('systemPrompt');
    expect(ev.systemPromptOptions.customPrompt).toContain('AI coding agent');
    expect(Object.keys(ev.systemPromptOptions.sections)).toEqual(['damocles_memory', 'damocles_tone']);
  });

  it('drops a section that this build did not produce rather than emptying it', async () => {
    const ev = event();
    await runAgentStart(ev, makePanel({ memoryEnabled: true }).panel, 'sess-1');
    expect(ev.systemPromptOptions.sections.damocles_memory).toBeTruthy();
    // pi removes a section by absence; an empty value would be dropped and the stale key would survive.
    await runAgentStart(ev, makePanel({}).panel, 'sess-1');
    expect('damocles_memory' in ev.systemPromptOptions.sections).toBe(false);
  });

  it('removes a stale key left by anything else in the options', async () => {
    const ev = event({ systemPromptOptions: promptOptions({ sections: { damocles_plan_mode: 'stale' } }) });
    await runAgentStart(ev, makePanel({}).panel, 'sess-1');
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

  it('outside plan mode with teams enabled + a bound plan, names all three delivery mechanisms', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const ev = event();
    const text = await promptTextFor(ev, makePanel({ teamEnabled: true }).panel);
    expect(text).toContain(planFilePath); // existing reminder still present
    expect(text).toContain(PLAN_EXECUTION_MARKER);
    // The labels are the ones the planner is told to write, so the two surfaces cannot disagree.
    expect(text).toContain('Each slice is marked direct, specialist or team');
    expect(text).toContain('implement a slice marked direct yourself');
    expect(text).toContain('spawn one specialist subagent (the Agent tool) for a slice marked specialist');
    expect(text).toContain('and start a team with create_team for a slice marked team');
    // Routes intent through `brief`; the title/brief mechanics live in the create_team description.
    expect(text).toContain('create_team `brief` argument');
    // The mechanism is the plan's call, not a fixed answer, and a deviation is announced, not approved.
    expect(text).toContain('You may pick a different mechanism for a slice');
    expect(text).toContain('which slice, which mechanism, and why, in your next message');
    expect(Object.keys(ev.systemPromptOptions.sections)).toEqual([
      'damocles_plan_file',
      'damocles_plan_execution',
      'damocles_tone',
    ]);
  });

  // A plan can assign a specialist subagent with the team feature off, so the directive is needed there
  // too; only the team rung drops, because `create_team` is not in that session's toolset.
  it('outside plan mode with teams disabled + a bound plan, emits the directive without the team rung', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    const ev = event();
    const text = await promptTextFor(ev, makePanel({ teamEnabled: false }).panel);
    expect(text).toContain(planFilePath);
    expect(text).toContain(PLAN_EXECUTION_MARKER);
    // No `team` label offered here: the planner writing for this session was not offered that rung.
    expect(text).toContain('Each slice is marked direct or specialist');
    // Two clauses joined by "and", not a comma splice, which is what the team clause supplied before.
    expect(text).toContain('implement a slice marked direct yourself and spawn one specialist subagent (the Agent tool) for a slice marked specialist.');
    expect(text).toContain('You may pick a different mechanism for a slice');
    expect(text).not.toContain('create_team');
    expect(Object.keys(ev.systemPromptOptions.sections)).toEqual([
      'damocles_plan_file',
      'damocles_plan_execution',
      'damocles_tone',
    ]);
  });

  it('outside plan mode but with NO plan file, injects no execution directive (raw-paste boundary)', async () => {
    for (const teamEnabled of [true, false]) {
      const ev = event();
      const text = await promptTextFor(ev, makePanel({ teamEnabled }).panel, 'sess-never-planned');
      expect(text).not.toContain(PLAN_EXECUTION_MARKER);
      expect('damocles_plan_execution' in ev.systemPromptOptions.sections).toBe(false);
    }
  });

  it('in plan mode, emits plan-mode guidance but NOT the execution-time directive', async () => {
    const planFilePath = computePlanFilePath('sess-1', 'Implement the plan');
    fs.writeFileSync(planFilePath, '# Plan');
    for (const teamEnabled of [true, false]) {
      const ev = event();
      const text = await promptTextFor(ev, makePanel({ plan: true, teamEnabled }).panel);
      expect(text).toContain('Plan mode is active');
      expect(text).not.toContain(PLAN_EXECUTION_MARKER);
      expect('damocles_plan_execution' in ev.systemPromptOptions.sections).toBe(false);
    }
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
    await runAgentStart(withBash, makePanel({}).panel, 'sess-1');
    expect(withBash.systemPromptOptions.sections.skills).toContain('<available_skills>');
    // The section overwrites the one pi built, so its prose must name bash, not the absent read tool.
    expect(withBash.systemPromptOptions.sections.skills).toContain('fileReadTool=bash');

    const withNeither = event({ systemPromptOptions: promptOptions({ selectedTools: ['edit', 'write'], skills: skillsFixture }) });
    await runAgentStart(withNeither, makePanel({}).panel, 'sess-1');
    expect('skills' in withNeither.systemPromptOptions.sections).toBe(false);
  });

  it('names read whenever read is selected, whatever else the session carries', async () => {
    const both = event({ systemPromptOptions: promptOptions({ selectedTools: ['bash', 'read'], skills: skillsFixture }) });
    await runAgentStart(both, makePanel({}).panel, 'sess-1');
    expect(both.systemPromptOptions.sections.skills).toContain('fileReadTool=read');
  });
});

describe('buildAgentStartResult — injection (US-005)', () => {
  function liveMessage(details: Partial<ContextInjectionDetailsV1>): unknown {
    return {
      role: 'custom',
      customType: CONTEXT_INJECTION_CUSTOM_TYPE,
      content: 'earlier',
      display: false,
      details: { ...MEMORY_DETAILS, memories: [], ...details },
      timestamp: 0,
    };
  }

  it('injects memory + compass as one non-displayed custom message whose details record both', async () => {
    const { panel, persist } = makePanel({ memoryEnabled: true, compassEnabled: true });
    const result = await runAgentStart(event(), panel, 'sess-1');
    expect(result?.message?.customType).toBe(CONTEXT_INJECTION_CUSTOM_TYPE);
    expect(result?.message?.display).toBe(false);
    const content = result?.message?.content as string;
    expect(content).toContain('<damocles_memory>');
    expect(content).toContain('<damocles_compass');
    const compassKey = buildCompassContext(panel)!.key;
    expect(result?.message?.details).toEqual({ ...MEMORY_DETAILS, compassKey });
    expect(persist).toHaveBeenCalledWith('sess-1', 3, expect.objectContaining({ exactText: content }));
  });

  it('sets exactText, the compass state and its tokens after the join', async () => {
    const { panel, messages } = makePanel({ memoryEnabled: true, compassEnabled: true });
    const result = await runAgentStart(event(), panel, 'sess-1');
    const update = messages.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'memoryInjectionUpdate' }> => m.type === 'memoryInjectionUpdate');
    expect(update?.data.exactText).toBe(result?.message?.content);
    expect(update?.data.compass.state).toBe('injected');
    expect(update?.data.tokens.compass).toBeGreaterThan(0);
    expect(update?.data.tokens.total).toBe(12 + update!.data.tokens.compass);
  });

  it('passes the projection live state to the memory build and reads the projection once', async () => {
    const { panel, build } = makePanel({ memoryEnabled: true, compassEnabled: true });
    const buildSessionProjection = vi.fn(() => ({
      messages: [liveMessage({ memories: [{ id: 'old', hash: 'h', tier: 'compact' }], profile: true })],
    }));
    await runAgentStart(event(), panel, 'sess-1', { buildSessionProjection, getBranch: () => [...BRANCH_BEFORE_PROMPT_3] } as unknown as ProjectionReader);
    expect(buildSessionProjection).toHaveBeenCalledTimes(1);
    const args = build.mock.calls[0]![0] as { live: { memories: Map<string, unknown>; profileInContext: boolean }; promptIndex: number };
    expect([...args.live.memories.keys()]).toEqual(['old']);
    expect(args.live.profileInContext).toBe(true);
    expect(args.promptIndex).toBe(3);
  });

  it('re-sends the compass status only when its change key differs from the live one', async () => {
    const { panel } = makePanel({ memoryEnabled: true, compassEnabled: true });
    const key = buildCompassContext(panel)!.key;
    const unchanged = await runAgentStart(event(), panel, 'sess-1', projectionOf([liveMessage({ compassKey: key })]));
    expect(unchanged?.message?.content).not.toContain('<damocles_compass');
    expect(unchanged?.message?.details).toEqual({ ...MEMORY_DETAILS, compassKey: null });

    const changed = await runAgentStart(event(), panel, 'sess-1', projectionOf([liveMessage({ compassKey: 'ready|1|1||' })]));
    expect(changed?.message?.content).toContain('<damocles_compass');
  });

  it('sends no message when nothing is new, but still posts and persists the display', async () => {
    const { panel, persist, messages } = makePanel({ memoryEnabled: true, compassEnabled: true, catalog: '' });
    const key = buildCompassContext(panel)!.key;
    const result = await runAgentStart(event(), panel, 'sess-1', projectionOf([liveMessage({ compassKey: key })]));
    expect(result?.message).toBeUndefined();
    expect(persist).toHaveBeenCalledWith('sess-1', 3, expect.objectContaining({ exactText: '', compass: { state: 'unchanged', text: '' } }));
    expect(messages.some(m => m.type === 'memoryInjectionUpdate')).toBe(true);
  });

  it('keeps the compass key out of the relative indexed age', () => {
    const { panel } = makePanel({ compassEnabled: true });
    const key = buildCompassContext(panel)!.key;
    expect(key).toBe('ready|12|30||');
  });

  it('escapes the compass error attribute like every other injected attribute', () => {
    const compassService = {
      isEnabled: true,
      getStatus: () => ({ state: 'error', nodeCount: 0, edgeCount: 0, lastIndexedAt: 0, error: 'C:\\a&b "x" <memory>\r\nnext' }),
    } as unknown as PanelGateContext['compassService'];
    const { text } = buildCompassContext({ compassService } as unknown as PanelGateContext)!;
    expect(text.split('\n')[0]).toBe(
      '<damocles_compass state="error" nodes="0" edges="0" indexed="never" error="C:\\a&amp;b &quot;x&quot; &lt;memory> next"/>',
    );
  });

  it('emits contextInjectionStarted before memoryInjectionUpdate + contextInjectionComplete keyed by prompt index', async () => {
    const { panel, messages } = makePanel({ memoryEnabled: true });
    await runAgentStart(event(), panel, 'sess-1');
    const types = messages.map((m) => m.type);
    expect(types).toEqual(['contextInjectionStarted', 'memoryInjectionUpdate', 'contextInjectionComplete']);
    expect(messages).toContainEqual({ type: 'contextInjectionStarted', promptIndex: 3 });
    expect(messages).toContainEqual({ type: 'contextInjectionComplete', promptIndex: 3 });
  });

  it('queries memory with the user text only and feeds the IDE block file to the file gate as the editor', async () => {
    const { panel, build } = makePanel({ memoryEnabled: true });
    const filePath = 'c:\\GameDev\\iemis\\app\\Scopes\\OrganizationScope.php';
    const typed = 'What should I watch out for in the file I have open?';
    const prompt = `${formatIdeContextBlock({ type: 'opened_file', filePath })}\n${typed}`;
    await runAgentStart(event({ prompt }), panel, 'sess-1');
    const args = build.mock.calls[0]![0] as { prompt: string; activeFile: string | null };
    expect(args.prompt).toBe(typed);
    expect(args.activeFile).toBe(filePath);
  });

  // The user chose not to attach the editor, and it may have changed since they pressed Send.
  it('gives the file gate no editor file when the message carries no IDE block, whatever editor is open', async () => {
    installFakePlatform().editor.setActiveContext({ filePath: '/repo/open-in-editor.ts', selection: undefined });
    const { panel, build } = makePanel({ memoryEnabled: true });
    await runAgentStart(event({ prompt: 'what does this do?' }), panel, 'sess-1');
    const args = build.mock.calls[0]![0] as { prompt: string; activeFile: string | null };
    expect(args.prompt).toBe('what does this do?');
    expect(args.activeFile).toBeNull();
  });

  it('keys the injection to the prompt the dispatch precedes, counted from the branch', async () => {
    const { panel, messages, persist } = makePanel({ memoryEnabled: true });
    const midStream = { id: 'ms', type: 'custom', customType: DAMOCLES_MID_STREAM_ENTRY, data: { userEntryId: 'u-note' } } as unknown as SessionEntry;
    // A cancel note marked mid-stream is not a prompt, so the dispatch is still prompt 3.
    await runAgentStart(event(), panel, 'sess-1', projectionOf([], [...BRANCH_BEFORE_PROMPT_3, userEntry('u-note'), midStream]));
    expect(messages).toContainEqual({ type: 'contextInjectionStarted', promptIndex: 3 });
    expect(persist).toHaveBeenCalledWith('sess-1', 3, expect.anything());

    const first = makePanel({ memoryEnabled: true });
    await runAgentStart(event(), first.panel, 'sess-1', projectionOf([], []));
    expect(first.messages).toContainEqual({ type: 'contextInjectionStarted', promptIndex: 0 });
  });

  describe('a run a cancel note started', () => {
    const NOTE = 'skip it';
    // Prompt 2 ran the command, the user stopped it with a note, and the run ended before pi took the note.
    const BRANCH_AFTER_CANCEL: readonly SessionEntry[] = [
      ...BRANCH_BEFORE_PROMPT_3,
      { id: 'a-call', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'powershell', arguments: {} }] } },
      {
        id: 'tr',
        type: 'message',
        message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'Command aborted' }], details: { [CANCELLED_TOOL_DETAIL_KEY]: true, [CANCEL_NOTE_DETAIL_KEY]: NOTE } },
      },
      { id: 'a-reply', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'I will wait for your reason.' }] } },
    ] as unknown as SessionEntry[];

    it('belongs to the prompt the note annotates, builds no memory and leaves that prompt\'s record alone', async () => {
      const { panel, messages, persist, build } = makePanel({ memoryEnabled: true, compassEnabled: true });
      const result = await runAgentStart(event({ prompt: NOTE }), panel, 'sess-1', projectionOf([], BRANCH_AFTER_CANCEL));

      expect(build).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(messages.filter((m) => m.type.startsWith('contextInjection') || m.type === 'memoryInjectionUpdate')).toEqual([]);
      // Run context that changed is still sent, keyed to prompt 2 rather than the next prompt's slot.
      expect(result?.message?.details).toMatchObject({ promptIndex: 2, memories: [], compassKey: buildCompassContext(panel)!.key });
    });

    it('keeps the next slot for a prompt whose text is not the pending note', async () => {
      const { panel, messages, build } = makePanel({ memoryEnabled: true });
      await runAgentStart(event({ prompt: 'ok, continue' }), panel, 'sess-1', projectionOf([], BRANCH_AFTER_CANCEL));

      expect(build).toHaveBeenCalledTimes(1);
      expect(messages).toContainEqual({ type: 'contextInjectionStarted', promptIndex: 3 });
      expect(messages).toContainEqual({ type: 'contextInjectionComplete', promptIndex: 3 });
    });
  });

  it('sends a changed Compass line with memory disabled, recording it in fallback details and posting no injection chips', async () => {
    const { panel, messages } = makePanel({ compassEnabled: true });
    const result = await runAgentStart(event(), panel, 'sess-1');
    expect(result?.message?.content).toContain('<damocles_compass');
    expect(result?.message?.details).toEqual({
      v: 1,
      promptIndex: 3,
      memories: [],
      notices: [],
      profile: false,
      compassKey: buildCompassContext(panel)!.key,
    });
    expect(messages.filter((m) => m.type.startsWith('contextInjection') || m.type === 'memoryInjectionUpdate')).toEqual([]);
  });

  it('completes the chip and still sends a changed Compass line when the memory build fails', async () => {
    const { panel, messages, persist, build } = makePanel({ memoryEnabled: true, compassEnabled: true });
    build.mockRejectedValueOnce(new Error('store unavailable'));
    const result = await runAgentStart(event(), panel, 'sess-1');
    expect(result?.message?.content).toContain('<damocles_compass');
    expect(result?.message?.content).not.toContain('<damocles_memory>');
    expect(result?.message?.details).toMatchObject({ promptIndex: 3, memories: [], profile: false, compassKey: buildCompassContext(panel)!.key });
    expect(messages.map((m) => m.type)).toEqual(['contextInjectionStarted', 'contextInjectionComplete']);
    expect(persist).not.toHaveBeenCalled();
  });

  it('writes nothing for a session deleted while the memory build ran', async () => {
    const { panel, messages, persist, build } = makePanel({ memoryEnabled: true, compassEnabled: true });
    let live = true;
    build.mockImplementationOnce(async () => {
      live = false;
      return { text: '<damocles_memory>catalog</damocles_memory>', details: { ...MEMORY_DETAILS }, display: emptyDisplay(), mentionedIds: [] };
    });
    const result = await runAgentStart(event(), panel, 'sess-1', projectionOf(), () => live);
    expect(persist).not.toHaveBeenCalled();
    expect(result?.message).toBeUndefined();
    expect(messages.map((m) => m.type)).toEqual(['contextInjectionStarted']);
  });

  it('does not fold the static memory instructions into the injected message (cache-stable split)', async () => {
    const { panel } = makePanel({ memoryEnabled: true });
    const result = await runAgentStart(event(), panel, 'sess-1');
    expect((result?.message?.content as string) ?? '').not.toContain('persistent memory system');
  });

  it('injects nothing and reads no projection when both services are disabled', async () => {
    const ev = event();
    const buildSessionProjection = vi.fn(() => ({ messages: [] }));
    const getBranch = vi.fn(() => []);
    const result = await runAgentStart(ev, makePanel({}).panel, 'sess-1', { buildSessionProjection, getBranch } as unknown as ProjectionReader);
    expect(result?.message).toBeUndefined();
    expect(buildSessionProjection).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();
    expect(ev.systemPromptOptions.customPrompt).toBeTruthy();
  });
});
