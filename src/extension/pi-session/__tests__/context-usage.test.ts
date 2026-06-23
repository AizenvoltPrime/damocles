import { describe, it, expect } from 'vitest';
import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { McpClientManager } from '../mcp/mcp-client-manager';
import type { AgentRegistry } from '../subagents/agent-types';
import { buildContextUsage, type ContextUsageDeps } from '../context-usage';

/**
 * The `/context` usage breakdown extracted from pi-session.ts. A fake `AgentSession` plus a deps
 * snapshot drive the percentage math, category assembly, per-message breakdown, and the independent
 * degradation of each discovered-resource section.
 */

const userEntry = (content: unknown) => ({ type: 'message', message: { role: 'user', content } });
const assistantEntry = (content: unknown) => ({ type: 'message', message: { role: 'assistant', content } });
const toolResultEntry = (content: unknown) => ({ type: 'message', message: { role: 'toolResult', content } });

function fakeSession(opts: {
  branch?: unknown[];
  contextUsage?: { tokens: number | null } | (() => never);
  stats?: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } };
}): AgentSession {
  const branch = opts.branch ?? [];
  return {
    getContextUsage: typeof opts.contextUsage === 'function' ? opts.contextUsage : () => opts.contextUsage,
    getSessionStats: opts.stats ? () => opts.stats : () => undefined,
    sessionManager: {
      getLeafId: () => 'leaf',
      getBranch: () => branch,
    },
  } as unknown as AgentSession;
}

function deps(overrides: Partial<ContextUsageDeps>): ContextUsageDeps {
  return {
    maxTokens: 1000,
    modelValue: 'claude-opus-4-8',
    resourceLoader: null,
    mcpEnabled: false,
    mcpClientManager: null,
    agentRegistry: null,
    ...overrides,
  };
}

describe('buildContextUsage — headline math', () => {
  it('uses getContextUsage tokens and computes the percentage against maxTokens', () => {
    const session = fakeSession({ contextUsage: { tokens: 250 } });
    const data = buildContextUsage(session, '', deps({ maxTokens: 1000 }));
    expect(data.totalTokens).toBe(250);
    expect(data.maxTokens).toBe(1000);
    expect(data.percentage).toBe(25);
    expect(data.model).toBe('claude-opus-4-8');
  });

  it('falls back to the stats snapshot when context usage is unavailable', () => {
    const session = fakeSession({
      contextUsage: { tokens: null },
      stats: { tokens: { input: 100, output: 5, cacheRead: 50, cacheWrite: 50 } },
    });
    const data = buildContextUsage(session, '', deps({ maxTokens: 1000 }));
    // occupied = input + cacheRead + cacheWrite = 200
    expect(data.totalTokens).toBe(200);
    expect(data.apiUsage).toEqual({
      input_tokens: 100,
      output_tokens: 5,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 50,
    });
  });

  it('survives getContextUsage throwing → degrades to stats fallback', () => {
    const session = fakeSession({
      contextUsage: () => {
        throw new Error('boom');
      },
      stats: { tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } },
    });
    const data = buildContextUsage(session, '', deps({}));
    expect(data.totalTokens).toBe(10);
  });

  it('percentage is 0 when maxTokens is 0', () => {
    const session = fakeSession({ contextUsage: { tokens: 100 } });
    expect(buildContextUsage(session, '', deps({ maxTokens: 0 })).percentage).toBe(0);
  });
});

describe('buildContextUsage — system prompt + categories', () => {
  it('estimates the system prompt at chars/4 and exposes it as a section', () => {
    const session = fakeSession({ contextUsage: { tokens: 0 } });
    const data = buildContextUsage(session, 'a'.repeat(40), deps({}));
    const sysCategory = data.categories.find((c) => c.name === 'System prompt')!;
    expect(sysCategory.tokens).toBe(10);
    expect(data.systemPromptSections).toEqual([{ name: 'Damocles system prompt', tokens: 10 }]);
  });

  it('omits the system-prompt section when the prompt is empty', () => {
    const session = fakeSession({ contextUsage: { tokens: 0 } });
    const data = buildContextUsage(session, '', deps({}));
    expect(data.systemPromptSections).toBeUndefined();
  });
});

describe('buildContextUsage — message breakdown', () => {
  it('buckets user / assistant / toolCall / toolResult tokens', () => {
    const session = fakeSession({
      contextUsage: { tokens: 0 },
      branch: [
        userEntry('aaaa'), // 4 chars → 1 token
        assistantEntry([
          { type: 'text', text: 'bbbb' }, // 1 token
          { type: 'toolCall', name: 'read', arguments: { path: 'x' } },
        ]),
        toolResultEntry('cccccccc'), // 8 chars → 2 tokens
      ],
    });
    const data = buildContextUsage(session, '', deps({}));
    const breakdown = data.messageBreakdown!;
    expect(breakdown.userMessageTokens).toBe(1);
    expect(breakdown.assistantMessageTokens).toBe(1);
    expect(breakdown.toolResultTokens).toBe(2);
    expect(breakdown.toolCallTokens).toBeGreaterThan(0);
    expect(breakdown.toolCallsByType.find((t) => t.name === 'read')).toBeTruthy();
  });

  it('omits messageBreakdown when the branch has no token-bearing messages', () => {
    const session = fakeSession({ contextUsage: { tokens: 0 }, branch: [] });
    expect(buildContextUsage(session, '', deps({})).messageBreakdown).toBeUndefined();
  });
});

describe('buildContextUsage — independent section degradation', () => {
  it('loader null → empty skills/commands sections', () => {
    const session = fakeSession({ contextUsage: { tokens: 0 } });
    const data = buildContextUsage(session, '', deps({ resourceLoader: null }));
    expect(data.skills).toBeUndefined();
    expect(data.slashCommands).toBeUndefined();
  });

  it('populates skills + slashCommands from the loader', () => {
    const loader = {
      getSkills: () => ({
        skills: [{ name: 'simplify', description: 'xxxx', sourceInfo: { scope: 'user' }, filePath: '/s/SKILL.md', disableModelInvocation: false }],
      }),
      getPrompts: () => ({
        prompts: [{ name: 'review', description: 'rev', content: 'body', sourceInfo: { scope: 'project' }, filePath: '/c/review.md' }],
      }),
    } as unknown as ResourceLoader;
    const data = buildContextUsage(fakeSession({ contextUsage: { tokens: 0 } }), '', deps({ resourceLoader: loader }));
    expect(data.skills?.totalSkills).toBe(1);
    expect(data.skills?.includedSkills).toBe(1);
    expect(data.slashCommands?.totalCommands).toBe(1);
  });

  it('mcp disabled → empty mcpTools even when a manager is present', () => {
    const manager = { getAllToolDescriptors: () => [{ piName: 'mcp__s__a', serverName: 's', description: 'dddd' }] } as unknown as McpClientManager;
    const data = buildContextUsage(fakeSession({ contextUsage: { tokens: 0 } }), '', deps({ mcpEnabled: false, mcpClientManager: manager }));
    expect(data.mcpTools).toEqual([]);
  });

  it('mcp enabled → mcpTools mapped from descriptors', () => {
    const manager = { getAllToolDescriptors: () => [{ piName: 'mcp__s__a', serverName: 's', description: 'dddd' }] } as unknown as McpClientManager;
    const data = buildContextUsage(fakeSession({ contextUsage: { tokens: 0 } }), '', deps({ mcpEnabled: true, mcpClientManager: manager }));
    expect(data.mcpTools).toEqual([{ name: 'mcp__s__a', serverName: 's', tokens: 1, isLoaded: true }]);
  });

  it('registry null → empty agents; populated → non-default agents mapped', () => {
    const session = fakeSession({ contextUsage: { tokens: 0 } });
    expect(buildContextUsage(session, '', deps({ agentRegistry: null })).agents).toEqual([]);

    const registry = {
      getAvailableConfigs: () => [
        { name: 'general-purpose', isDefault: true, source: 'default', systemPrompt: 'p' },
        { name: 'custom', isDefault: false, source: 'global', systemPrompt: 'xxxx', filePath: '/a/custom.md' },
      ],
    } as unknown as AgentRegistry;
    const agents = buildContextUsage(session, '', deps({ agentRegistry: registry })).agents;
    expect(agents).toEqual([{ agentType: 'custom', source: 'user', tokens: 1, filePath: '/a/custom.md' }]);
  });
});
