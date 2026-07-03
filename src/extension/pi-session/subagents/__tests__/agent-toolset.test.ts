import { describe, it, expect } from 'vitest';
import { resolveAgentToolset } from '../agent-toolset';
import { DEFAULT_AGENTS } from '../default-agents';
import type { AgentConfig } from '../types';

function cfg(over: Partial<AgentConfig>): AgentConfig {
  return { name: 'x', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'replace', ...over };
}

const PARENT = ['read', 'bash', 'write', 'grep', 'find', 'ls', 'Edit', 'PowerShell', 'SaveMemory', 'Agent', 'GetSubagentResult', 'SteerSubagent'];

describe('resolveAgentToolset', () => {
  it('undefined builtinToolNames ("all") mirrors the parent set MINUS the three subagent tools', () => {
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: undefined }), PARENT);
    expect(names).toContain('Edit');
    expect(names).toContain('SaveMemory');
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('GetSubagentResult');
    expect(names).not.toContain('SteerSubagent');
  });

  it('maps pi-native frontmatter names to Damocles active-set names (edit → Edit)', () => {
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'grep', 'edit', 'write'] }), PARENT);
    expect(names.sort()).toEqual(['Edit', 'grep', 'read', 'write'].sort());
  });

  it('read-only set stays read-only (no Edit/Write leak)', () => {
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'bash', 'grep', 'find', 'ls'] }), PARENT);
    expect(names.sort()).toEqual(['bash', 'find', 'grep', 'ls', 'read'].sort());
    expect(names).not.toContain('Edit');
    expect(names).not.toContain('write');
  });

  it('disallowed_tools subtracts (mapped) from the resolved set', () => {
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'edit'], disallowedTools: ['edit'] }), PARENT);
    expect(names).toEqual(['read']);
  });

  it('an empty builtinToolNames yields no tools (tools: none)', () => {
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: [] }), PARENT);
    expect(names).toEqual([]);
  });

  it('strips the plan-mode tools whether inherited ("all") or named explicitly — subagents never plan', () => {
    // Inherited via the `*`-case while the panel is in plan mode (parent set carries them).
    const inherited = resolveAgentToolset(cfg({ builtinToolNames: undefined }), [...PARENT, 'EnterPlanMode', 'ExitPlanMode']);
    expect(inherited.names).not.toContain('EnterPlanMode');
    expect(inherited.names).not.toContain('ExitPlanMode');
    // Named explicitly in frontmatter (and present in the parent set) — still stripped.
    const explicit = resolveAgentToolset(
      cfg({ builtinToolNames: ['read', 'EnterPlanMode', 'ExitPlanMode'] }),
      [...PARENT, 'EnterPlanMode', 'ExitPlanMode'],
    );
    expect(explicit.names).toEqual(['read']);
  });

  it('strips inherited mcp__ tools — subagents have no MCP registrar (US-014.9 boundary)', () => {
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: undefined }), [...PARENT, 'mcp__git__status', 'mcp__git__commit']);
    expect(names).toContain('Edit');
    expect(names.some((n) => n.startsWith('mcp__'))).toBe(false);
  });

  it('gates an explicit opt-in tool by parent availability (web off → dropped, web on → kept)', () => {
    const off = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'WebSearch'] }), PARENT);
    expect(off.names).toEqual(['read']);
    const on = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'WebSearch'] }), [...PARENT, 'WebSearch']);
    expect(on.names.sort()).toEqual(['WebSearch', 'read'].sort());
  });

  it('Plan subagent carries the fewest-slices consolidation guidance alongside the anti-horizontal rule', () => {
    const plan = DEFAULT_AGENTS.get('Plan')!;
    expect(plan.systemPrompt).toContain('vertical slices, not horizontal layers');
    expect(plan.systemPrompt).toContain('Prefer the **fewest** slices that each deliver a demoable behavior');
    expect(plan.systemPrompt).toContain('Consolidate closely-related behaviors into a single slice');
    expect(plan.systemPrompt).toContain('do not manufacture slices to appear thorough');
  });

  it('Explore default resolves the read-only web tools only when the panel has them active', () => {
    const explore = DEFAULT_AGENTS.get('Explore')!;
    const webOff = resolveAgentToolset(explore, ['read', 'bash', 'grep', 'find', 'ls', 'Edit']);
    expect(webOff.names.sort()).toEqual(['bash', 'find', 'grep', 'ls', 'read'].sort());
    const webOn = resolveAgentToolset(explore, ['read', 'bash', 'grep', 'find', 'ls', 'WebSearch', 'WebFetch', 'CodeSearch']);
    expect(webOn.names).toContain('WebSearch');
    expect(webOn.names).toContain('WebFetch');
    expect(webOn.names).toContain('CodeSearch');
    expect(webOn.names).not.toContain('Edit');
  });
});
