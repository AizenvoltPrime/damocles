import { describe, it, expect } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { AgentManager } from '../../subagents/agent-manager';
import { buildSubagentTools } from '../subagent-tools';
import { TOOL_AGENT, TOOL_GET_SUBAGENT_RESULT, TOOL_STEER_SUBAGENT } from '../../../../shared/tool-names';

type PiTool = {
  name: string;
  label: string;
  executionMode?: string;
  parameters: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
};

function build(): Map<string, PiTool> {
  const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  // buildSubagentTools reads the spawnable-agent list to advertise subagent_type values.
  const mgr = { getSpawnableAgents: () => [] } as unknown as AgentManager;
  const tools = buildSubagentTools(pi, mgr) as unknown as PiTool[];
  return new Map(tools.map((t) => [t.name, t]));
}

describe('subagent tools — schema shape', () => {
  const tools = build();

  it('defines exactly the three PascalCase subagent tools', () => {
    expect([...tools.keys()].sort()).toEqual([TOOL_AGENT, TOOL_GET_SUBAGENT_RESULT, TOOL_STEER_SUBAGENT].sort());
  });

  it('Agent: runs in parallel, requires {description,prompt,subagent_type}, optional model/thinking/run_in_background (no max_turns — turn caps are template-only)', () => {
    const t = tools.get(TOOL_AGENT)!;
    expect(t.executionMode).toBe('parallel');
    const props = Object.keys(t.parameters.properties ?? {}).sort();
    expect(props).toEqual(['description', 'model', 'prompt', 'run_in_background', 'subagent_type', 'thinking']);
    expect((t.parameters.required ?? []).sort()).toEqual(['description', 'prompt', 'subagent_type']);
    expect(t.parameters.additionalProperties).toBe(false);
  });

  it('GetSubagentResult: requires agent_id, optional wait/verbose', () => {
    const t = tools.get(TOOL_GET_SUBAGENT_RESULT)!;
    expect(Object.keys(t.parameters.properties ?? {}).sort()).toEqual(['agent_id', 'verbose', 'wait']);
    expect(t.parameters.required ?? []).toEqual(['agent_id']);
  });

  it('SteerSubagent: requires agent_id and message', () => {
    const t = tools.get(TOOL_STEER_SUBAGENT)!;
    expect(Object.keys(t.parameters.properties ?? {}).sort()).toEqual(['agent_id', 'message']);
    expect((t.parameters.required ?? []).sort()).toEqual(['agent_id', 'message']);
  });
});
