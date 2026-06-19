import { describe, it, expect } from 'vitest';
import { resolveAgentToolset } from '../agent-toolset';
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

  it('strips inherited mcp__ tools — subagents have no MCP registrar (US-014.9 boundary)', () => {
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: undefined }), [...PARENT, 'mcp__git__status', 'mcp__git__commit']);
    expect(names).toContain('Edit');
    expect(names.some((n) => n.startsWith('mcp__'))).toBe(false);
  });
});
