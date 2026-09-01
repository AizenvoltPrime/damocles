import { describe, it, expect } from 'vitest';
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { PiCodingAgentModule } from '../../pi-loader';
import { buildTeamMainPiTools, TEAM_AGENT_PI_TOOL_NAMES, TEAM_AGENT_SPECS, TEAM_TOOL_CATALOG, type TeamServiceRef } from '../team-tools';

type PiTool = { name: string; description: string; parameters: TSchema };

function build(): Map<string, PiTool> {
  const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  const teamService = {} as unknown as TeamServiceRef;
  const tools = buildTeamMainPiTools(pi, teamService) as unknown as PiTool[];
  return new Map(tools.map((t) => [t.name, t]));
}

const AGENTS = [
  { name: 'lead', role: 'lead' },
  { name: 'dev', role: 'specialist' },
];

describe('team_* tool catalog — team_redispatch_specialist registration (Slice C)', () => {
  it('lists team_redispatch_specialist in TEAM_AGENT_PI_TOOL_NAMES, right after team_spawn_specialist', () => {
    expect(TEAM_AGENT_PI_TOOL_NAMES).toContain('team_redispatch_specialist');
    const spawnIdx = TEAM_AGENT_PI_TOOL_NAMES.indexOf('team_spawn_specialist');
    const redispatchIdx = TEAM_AGENT_PI_TOOL_NAMES.indexOf('team_redispatch_specialist');
    expect(redispatchIdx).toBe(spawnIdx + 1);
  });

  it('team agent tool set has unique names and derives from the spec list (no hard-coded count)', () => {
    // A hard-coded numeral drifts every time a tool is added — the count was already wrong in five source
    // files before this assertion was rewritten. Derive it from the single source of truth instead; the
    // per-tool catalog assertions below are the meaningful check.
    expect(new Set(TEAM_AGENT_PI_TOOL_NAMES).size).toBe(TEAM_AGENT_PI_TOOL_NAMES.length);
    expect(TEAM_AGENT_PI_TOOL_NAMES).toHaveLength(TEAM_AGENT_SPECS.length);
  });

  it('exposes team_redispatch_specialist in TEAM_TOOL_CATALOG under the team group', () => {
    const entry = TEAM_TOOL_CATALOG.find((e) => e.name === 'team_redispatch_specialist');
    expect(entry).toBeDefined();
    expect(entry!.group).toBe('team');
    expect(entry!.label).toBe('Redispatch specialist');
    expect(entry!.toggleable).toBe(true);
  });
});

/**
 * `access` is where registration states the role, so the Tools panel derives its prefix from that field
 * instead of a second copy in the blurb which can disagree with it.
 */
describe('TEAM_TOOL_CATALOG takes the role prefix from access', () => {
  const byName = new Map(TEAM_TOOL_CATALOG.map((e) => [e.name, e]));
  const PREFIX = { lead: 'Lead-only: ', specialist: 'Specialist-only: ', both: '' } as const;

  it('prefixes every agent tool according to the role that may call it', () => {
    for (const spec of TEAM_AGENT_SPECS) {
      expect(byName.get(spec.name)!.description, spec.name).toBe(`${PREFIX[spec.access]}${spec.description}`);
    }
  });

  it('marks team_standby and team_report_complete specialist-only, like every other specialist tool', () => {
    expect(byName.get('team_standby')!.description).toMatch(/^Specialist-only: /);
    expect(byName.get('team_report_complete')!.description).toMatch(/^Specialist-only: /);
    expect(byName.get('team_flag_brief_conflict')!.description).toMatch(/^Specialist-only: /);
  });

  it('leaves the three main coordination tools unprefixed, since no role gates them', () => {
    for (const name of ['create_team', 'get_team_status', 'cancel_team']) {
      expect(byName.get(name)!.description, name).not.toMatch(/-only: /);
    }
  });

  it('holds no hand-written role prefix in the registration blurbs themselves', () => {
    const doubled = TEAM_AGENT_SPECS.filter((s) => /-only:/.test(s.description));
    expect(doubled.map((s) => s.name)).toEqual([]);
  });

  it('keeps every registration blurb to the one-clause line the Tools panel renders', () => {
    for (const spec of TEAM_AGENT_SPECS) {
      expect(spec.description.length, spec.name).toBeLessThanOrEqual(100);
      expect(spec.description.replace(/\.$/, ''), spec.name).not.toContain('. ');
    }
  });
});

describe('create_team — model-facing description', () => {
  const description = build().get('create_team')!.description;

  it('is collaboration-first (work together, message each other, shared scratchpad)', () => {
    expect(description).toContain('collaborative');
    expect(description).toContain('work together');
    expect(description).toContain('message each other');
    expect(description).toContain('share a scratchpad');
    expect(description).toContain('whether or not the work can run in parallel');
  });

  it('drops the "parallelizable implementation" off-ramp', () => {
    expect(description).not.toContain('parallelizable implementation');
  });

  it('states models/effort are user-configured in settings, not chosen by the AI', () => {
    expect(description).toContain('user-configured in settings');
    expect(description).toContain('you do not choose them');
    expect(description).toContain('Blocks until team completes.');
  });

  it('drops the old auto-selected lead / session-default specialist wording', () => {
    expect(description).not.toContain('auto-selected');
    expect(description).not.toContain('current session model');
  });

  it('directs authoritative intent into `brief`, keeping `title` a short label', () => {
    expect(description).toContain('Put the authoritative spec');
    expect(description).toContain('`brief`');
    expect(description).toContain('Keep `title` a short label');
  });
});

describe('create_team — schema (brief required, title capped)', () => {
  const schema = build().get('create_team')!.parameters;

  it('accepts a call with title, brief, and agents', () => {
    expect(Value.Check(schema, { title: 'Auth refactor', brief: 'Extract AuthValidator. Tests pass.', agents: AGENTS })).toBe(true);
  });

  it('rejects a call with no brief', () => {
    expect(Value.Check(schema, { title: 'Auth refactor', agents: AGENTS })).toBe(false);
  });

  it('rejects an empty brief', () => {
    expect(Value.Check(schema, { title: 'Auth refactor', brief: '', agents: AGENTS })).toBe(false);
  });

  it('rejects a title longer than 200 chars (blocks the cram-brief-into-title workaround)', () => {
    expect(Value.Check(schema, { title: 'x'.repeat(201), brief: 'real spec', agents: AGENTS })).toBe(false);
    expect(Value.Check(schema, { title: 'x'.repeat(200), brief: 'real spec', agents: AGENTS })).toBe(true);
  });

  it('rejects an agent carrying a `model` field (the model arg is gone)', () => {
    const withModel = [
      { name: 'lead', role: 'lead' },
      { name: 'dev', role: 'specialist', model: 'claude-opus-4-8' },
    ];
    expect(Value.Check(schema, { title: 'Auth refactor', brief: 'real spec', agents: withModel })).toBe(false);
  });

  it('exposes NO `model` property on the agents item schema', () => {
    const agentItem = (schema as unknown as { properties: { agents: { items: { properties: Record<string, unknown> } } } }).properties.agents.items;
    expect(Object.keys(agentItem.properties)).toEqual(['name', 'role']);
    expect(agentItem.properties).not.toHaveProperty('model');
  });
});

describe('create_team — blocking resolveRoleModel error surfaces to the model', () => {
  it('wraps a TeamService.createTeam throw (unauthed role slot) into the tool error text', async () => {
    const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
    const teamService = {
      setPendingToolUseId: () => undefined,
      cancelActiveTeam: () => undefined,
      createTeam: async () => {
        throw new Error(
          'Team role "reviewer" is configured to model "deepseek-v4-pro" (damocles.team.reviewerModel), but that model is not available or its provider is not signed in. Sign in or change the setting.',
        );
      },
    } as unknown as TeamServiceRef;
    const tools = buildTeamMainPiTools(pi, teamService) as unknown as Array<{ name: string; execute: (id: string, input: Record<string, unknown>) => Promise<unknown> }>;
    const createTeam = tools.find((t) => t.name === 'create_team')!;
    await expect(
      createTeam.execute('call-1', { title: 'T', brief: 'spec', agents: AGENTS }),
    ).rejects.toThrow(/damocles\.team\.reviewerModel/);
  });
});
