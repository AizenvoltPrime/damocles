import { describe, it, expect } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import { buildTeamMainPiTools, type TeamServiceRef } from '../team-tools';

type PiTool = { name: string; description: string };

function build(): Map<string, PiTool> {
  const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  const teamService = {} as unknown as TeamServiceRef;
  const tools = buildTeamMainPiTools(pi, teamService) as unknown as PiTool[];
  return new Map(tools.map((t) => [t.name, t]));
}

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
});
