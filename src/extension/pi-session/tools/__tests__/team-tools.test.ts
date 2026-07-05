import { describe, it, expect } from 'vitest';
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { PiCodingAgentModule } from '../../pi-loader';
import { buildTeamMainPiTools, type TeamServiceRef } from '../team-tools';

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

  it('keeps the operational lead/specialist model-selection sentences', () => {
    expect(description).toContain('The lead model is auto-selected');
    expect(description).toContain('Specialists default to the current session model');
    expect(description).toContain('Blocks until team completes.');
  });

  it('directs authoritative intent into `brief`, keeping `title` a short label', () => {
    expect(description).toContain('Put the authoritative spec');
    expect(description).toContain('`brief`');
    expect(description).toContain('keep `title` a short label');
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
});
