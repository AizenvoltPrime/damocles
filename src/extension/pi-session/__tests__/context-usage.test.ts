import { describe, it, expect } from 'vitest';
import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { McpClientManager } from '../mcp/mcp-client-manager';
import type { AgentRegistry } from '../subagents/agent-types';
import { buildContextUsage, estimateToolTokens, type ContextUsageDeps } from '../context-usage';
import { BROWSER_PI_TOOL_NAMES } from '../tools/browser-tools';
import { COMPASS_PI_TOOL_NAMES } from '../tools/compass-tools';
import { WEB_PI_TOOL_NAMES } from '../web-access/web-tool-specs';

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
  /** Registered tools (`getAllTools()`); a function is invoked, so it can throw. */
  allTools?: ToolInfo[] | (() => never);
  /** The live active set (`getActiveToolNames()`); a function is invoked, so it can throw. */
  activeTools?: string[] | (() => never);
}): AgentSession {
  const branch = opts.branch ?? [];
  return {
    getContextUsage: typeof opts.contextUsage === 'function' ? opts.contextUsage : () => opts.contextUsage,
    getSessionStats: opts.stats ? () => opts.stats : () => undefined,
    getAllTools: typeof opts.allTools === 'function' ? opts.allTools : () => opts.allTools ?? [],
    getActiveToolNames: typeof opts.activeTools === 'function' ? opts.activeTools : () => opts.activeTools ?? [],
    sessionManager: {
      getLeafId: () => 'leaf',
      getBranch: () => branch,
    },
  } as unknown as AgentSession;
}

/** `Pick<ToolDefinition,'name'|'description'|'parameters'>` — the shape `getAllTools()` returns. */
interface ToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
}

const tool = (name: string, description: string, parameters?: unknown): ToolInfo =>
  parameters === undefined ? { name, description } : { name, description, parameters };

/** A category's tokens by name — the number the overlay draws. */
const categoryTokens = (data: ReturnType<typeof buildContextUsage>, name: string): number =>
  data.categories.find((c) => c.name === name)!.tokens;

function deps(overrides: Partial<ContextUsageDeps>): ContextUsageDeps {
  return {
    maxTokens: 1000,
    modelValue: 'claude-opus-4-8',
    resourceLoader: null,
    mcpEnabled: false,
    mcpClientManager: null,
    agentRegistry: null,
    eligibleToolNames: [],
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

  // §4.1 ADAPTATION: the row is now description + serialized schema, not description alone, and
  // `isLoaded` comes from the live active set instead of a hard-coded `true`. `dddd` (1 token) plus
  // `JSON.stringify(undefined ?? {})` = `{}` (1 token) = 2.
  it('mcp enabled → mcpTools mapped from descriptors, costed with the schema', () => {
    const manager = { getAllToolDescriptors: () => [{ piName: 'mcp__s__a', serverName: 's', description: 'dddd' }] } as unknown as McpClientManager;
    // ADAPTATION: the tool is now also listed in `allTools`, because an ACTIVE tool is by definition a
    // registered one; the previous fixture described a state pi cannot produce.
    const session = fakeSession({ contextUsage: { tokens: 0 }, activeTools: ['mcp__s__a'], allTools: [tool('mcp__s__a', 'dddd')] });
    const data = buildContextUsage(session, '', deps({ mcpEnabled: true, mcpClientManager: manager }));
    expect(data.mcpTools).toEqual([{ name: 'mcp__s__a', serverName: 's', tokens: 2, isLoaded: true }]);
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

/**
 * Slice 4 — per-tool token accounting. The rows and the pie must reconcile: every tool token lands in
 * exactly ONE of `Tools` / `Tools (deferred)` / `MCP tools`, and a section whose source read failed is
 * OMITTED rather than emitted as zeros, because a fabricated 0 reads as "this costs nothing".
 */

const BROWSER_A = BROWSER_PI_TOOL_NAMES[0]!;
const BROWSER_B = BROWSER_PI_TOOL_NAMES[1]!;
const COMPASS_A = COMPASS_PI_TOOL_NAMES[0]!;
const WEB_A = WEB_PI_TOOL_NAMES[0]!;

describe('estimateToolTokens — the single cost formula', () => {
  it('is description tokens plus serialized-schema tokens', () => {
    // 'Read a file' = 11 chars -> 3; '{"path":"string"}' = 17 chars -> 5.
    expect(estimateToolTokens('Read a file', { path: 'string' })).toBe(8);
  });

  it('counts an absent schema as `{}`, never as the string "undefined"', () => {
    // The `?? {}` guard is load-bearing: JSON.stringify(undefined) is the VALUE undefined, and
    // stringifying it naively would charge 3 tokens for a schema that does not exist.
    expect(estimateToolTokens('Read a file', undefined)).toBe(3 + 1);
    expect(estimateToolTokens('Read a file', {})).toBe(3 + 1);
    expect(estimateToolTokens(undefined, undefined)).toBe(1);
  });

  it('charges a schema-heavy descriptor strictly more than its description alone', () => {
    const description = 'Search the index';
    const schema = {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' }, limit: { type: 'number' } },
      required: ['query'],
    };
    // The description-only figure is what the pre-slice estimator charged for this row.
    const descriptionOnly = estimateToolTokens(description, '');
    expect(estimateToolTokens(description, schema)).toBeGreaterThan(descriptionOnly);
    expect(estimateToolTokens(description, schema)).toBe(39);
  });
});

describe('buildContextUsage — systemTools + deferredBuiltinTools sections', () => {
  const session = () =>
    fakeSession({
      contextUsage: { tokens: 0 },
      activeTools: ['Read', 'Bash', 'ToolSearch'],
      allTools: [
        tool('Read', 'Read a file', { path: 'string' }),
        tool('Bash', 'Run a shell command', { command: 'string' }),
        tool('ToolSearch', 'Find tools'),
        tool(BROWSER_A, 'Open a URL', { url: 'string' }),
        tool(COMPASS_A, 'Find code entities', { query: 'string' }),
      ],
    });

  it('rows the active non-MCP, non-deferrable tools with their real per-tool cost', () => {
    const data = buildContextUsage(session(), '', deps({ eligibleToolNames: [BROWSER_A, COMPASS_A] }));
    expect(data.systemTools).toEqual([
      { name: 'Read', tokens: 8 },
      { name: 'Bash', tokens: 10 },
      { name: 'ToolSearch', tokens: 4 },
    ]);
  });

  it('excludes MCP tools from systemTools — the MCP section owns them', () => {
    const data = buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: ['Read', 'mcp__srv__thing'],
        allTools: [tool('Read', 'Read a file', { path: 'string' }), tool('mcp__srv__thing', 'Thing')],
      }),
      '',
      deps({}),
    );
    expect(data.systemTools).toEqual([{ name: 'Read', tokens: 8 }]);
  });

  it('excludes deferrable built-ins from systemTools even once they are active', () => {
    const data = buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: ['Read', BROWSER_A],
        allTools: [tool('Read', 'Read a file', { path: 'string' }), tool(BROWSER_A, 'Open a URL', { url: 'string' })],
      }),
      '',
      deps({ eligibleToolNames: [BROWSER_A] }),
    );
    expect(data.systemTools).toEqual([{ name: 'Read', tokens: 8 }]);
    expect(data.deferredBuiltinTools).toEqual([{ name: BROWSER_A, tokens: 7, isLoaded: true }]);
  });

  it('lists only the deferrable built-ins this panel is ELIGIBLE for', () => {
    const data = buildContextUsage(session(), '', deps({ eligibleToolNames: [BROWSER_A, COMPASS_A] }));
    expect(data.deferredBuiltinTools).toEqual([
      { name: BROWSER_A, tokens: 7, isLoaded: false },
      { name: COMPASS_A, tokens: 10, isLoaded: false },
    ]);
  });

  // The badge flip is the slice's demoable acceptance criterion: same fixture, only the active set
  // moves, and the tokens must travel from `Tools (deferred)` into `Tools` with nothing created or lost.
  it('flips isLoaded false -> true when ToolSearch activates the tool, moving its tokens', () => {
    const eligible = [BROWSER_A, COMPASS_A];
    const allTools = [
      tool('Read', 'Read a file', { path: 'string' }),
      tool(BROWSER_A, 'Open a URL', { url: 'string' }),
      tool(COMPASS_A, 'Find code entities', { query: 'string' }),
    ];

    const before = buildContextUsage(
      fakeSession({ contextUsage: { tokens: 0 }, activeTools: ['Read'], allTools }),
      '',
      deps({ eligibleToolNames: eligible }),
    );
    expect(before.deferredBuiltinTools).toEqual([
      { name: BROWSER_A, tokens: 7, isLoaded: false },
      { name: COMPASS_A, tokens: 10, isLoaded: false },
    ]);
    expect(categoryTokens(before, 'Tools')).toBe(8);
    expect(categoryTokens(before, 'Tools (deferred)')).toBe(17);

    const after = buildContextUsage(
      fakeSession({ contextUsage: { tokens: 0 }, activeTools: ['Read', COMPASS_A], allTools }),
      '',
      deps({ eligibleToolNames: eligible }),
    );
    expect(after.deferredBuiltinTools).toEqual([
      { name: BROWSER_A, tokens: 7, isLoaded: false },
      { name: COMPASS_A, tokens: 10, isLoaded: true },
    ]);
    expect(categoryTokens(after, 'Tools')).toBe(18);
    expect(categoryTokens(after, 'Tools (deferred)')).toBe(7);
    // Conserved: activation MOVES tokens between categories, it does not mint or destroy them.
    expect(categoryTokens(after, 'Tools') + categoryTokens(after, 'Tools (deferred)')).toBe(
      categoryTokens(before, 'Tools') + categoryTokens(before, 'Tools (deferred)'),
    );
  });

  it('marks the deferred category isDeferred, in the fixed 6-entry legend order', () => {
    const data = buildContextUsage(session(), '', deps({ eligibleToolNames: [BROWSER_A] }));
    expect(data.categories.find((c) => c.name === 'Tools (deferred)')!.isDeferred).toBe(true);
    expect(data.categories.find((c) => c.name === 'Tools')!.isDeferred).toBeUndefined();
    expect(data.categories.map((c) => c.name)).toEqual([
      'System prompt',
      'Messages & tools',
      'Skills',
      'MCP tools',
      'Tools',
      'Tools (deferred)',
    ]);
  });

  // The demoable claim, restated for this slice: 38 badged rows (browser 25 + compass 8 + web 5) on a
  // fully-enabled panel. The count is spelled out rather than derived from the arrays because it is the
  // number a user sees in `/context` — deriving it would make the assertion agree with any regression
  // that dropped a whole group from `BUILTIN_DEFERRED_GROUPS`.
  it('rows every eligible deferrable built-in — 38 on a fully-enabled panel', () => {
    const names = [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...WEB_PI_TOOL_NAMES];
    const data = buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: [],
        allTools: names.map((n) => tool(n, 'A deferrable tool', { arg: 'string' })),
      }),
      '',
      deps({ eligibleToolNames: names }),
    );
    expect(data.deferredBuiltinTools).toHaveLength(38);
    expect(data.deferredBuiltinTools!.every((r) => r.isLoaded === false)).toBe(true);
    expect(data.systemTools).toEqual([]);
  });
});

describe('buildContextUsage — MCP tokens split by loaded state', () => {
  const manager = {
    getAllToolDescriptors: () => [
      { piName: 'mcp__s__loaded', serverName: 's', description: 'Alpha', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
      { piName: 'mcp__s__deferred', serverName: 's', description: 'Beta', inputSchema: { type: 'object', properties: { b: { type: 'number' } } } },
    ],
  } as unknown as McpClientManager;

  // ADAPTATION: `allTools` now carries both MCP tools. A descriptor absent from pi's registry was never
  // registered, and its tokens are ABSENT rather than deferred — so an empty registry here would (now
  // correctly) drop both rows. Production always registers a connected server's tools, so listing them
  // is what makes this fixture faithful; the unregistered case is covered by its own test below.
  const built = () =>
    buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: ['mcp__s__loaded'],
        allTools: [tool('mcp__s__loaded', 'Alpha'), tool('mcp__s__deferred', 'Beta')],
      }),
      '',
      deps({ mcpEnabled: true, mcpClientManager: manager }),
    );

  it('costs an MCP row by description PLUS input schema, strictly more than description alone', () => {
    const loaded = built().mcpTools.find((t) => t.name === 'mcp__s__loaded')!;
    expect(loaded.tokens).toBe(estimateToolTokens('Alpha', { type: 'object', properties: { a: { type: 'string' } } }));
    // §4.1's acceptance criterion: strictly larger than the pre-slice description-only figure.
    expect(loaded.tokens).toBeGreaterThan(estimateToolTokens('Alpha', ''));
  });

  it('counts only LOADED descriptors in the MCP tools category', () => {
    const data = built();
    const loaded = data.mcpTools.find((t) => t.name === 'mcp__s__loaded')!;
    const deferred = data.mcpTools.find((t) => t.name === 'mcp__s__deferred')!;
    expect(loaded.isLoaded).toBe(true);
    expect(deferred.isLoaded).toBe(false);
    expect(categoryTokens(data, 'MCP tools')).toBe(loaded.tokens);
  });

  it('drops a descriptor pi never registered, instead of billing it as a realizable saving', () => {
    // The orphaned-runtime case (`missingMcpRegistryNames`): the manager still hands over descriptors
    // for a server whose tools never reached pi's registry. Those tokens are ABSENT, not deferred —
    // counting them under `Tools (deferred)` promises the user a reduction that loading could never
    // deliver, because there is nothing to load.
    const data = buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: ['mcp__s__loaded'],
        allTools: [tool('mcp__s__loaded', 'Alpha')],
      }),
      '',
      deps({ mcpEnabled: true, mcpClientManager: manager }),
    );

    // `mcp__s__deferred` has a descriptor but no registry entry, so it is gone rather than deferred.
    expect(data.mcpTools.map((t) => t.name)).toEqual(['mcp__s__loaded']);
    expect(data.mcpTools.some((t) => t.isLoaded === false)).toBe(false);
  });

  it('keeps every row when the registry read itself fails — degradation, not silent loss', () => {
    // `allTools` throwing means "unknown", not "absent". Dropping rows there would under-report a real
    // cost, so the filter must stand down entirely rather than treat an unreadable registry as empty.
    const data = buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: ['mcp__s__loaded'],
        allTools: () => { throw new Error('registry unavailable'); },
      }),
      '',
      deps({ mcpEnabled: true, mcpClientManager: manager }),
    );

    expect(data.mcpTools.map((t) => t.name)).toEqual(['mcp__s__loaded', 'mcp__s__deferred']);
  });

  it('rolls unloaded MCP tokens into Tools (deferred), not into MCP tools', () => {
    const data = built();
    const deferred = data.mcpTools.find((t) => t.name === 'mcp__s__deferred')!;
    expect(categoryTokens(data, 'Tools (deferred)')).toBe(deferred.tokens);
    expect(deferred.tokens).toBeGreaterThan(0);
  });
});

describe('buildContextUsage — the no-double-count invariant (§D)', () => {
  // Mixed fixture: active built-ins, one loaded + one deferred browser tool, a deferred compass tool, a
  // LOADED web tool, and one loaded + one deferred MCP tool. Every row must be counted once, across all
  // three categories — no token counted twice, none dropped.
  //
  // The web row is deliberately the LOADED one rather than a fourth deferred row. A loaded deferrable
  // built-in is the case where the two sections can double-count: it is active, so a `systemTools` that
  // filtered by "is it active and non-MCP" would bill it there as well as under `deferredBuiltinTools`.
  // That exclusion rests on the name being in `BUILTIN_DEFERRED_GROUPS`, so pinning it for the newest
  // group is what catches a group that was added to the resolver but not to the accounting.
  const mixed = () =>
    buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: ['Read', 'Bash', BROWSER_A, WEB_A, 'mcp__s__on'],
        allTools: [
          tool('Read', 'Read a file', { path: 'string' }),
          tool('Bash', 'Run a shell command', { command: 'string' }),
          tool(BROWSER_A, 'Open a URL', { url: 'string' }),
          tool(BROWSER_B, 'Navigate to a URL', { url: 'string' }),
          tool(COMPASS_A, 'Find code entities', { query: 'string' }),
          tool(WEB_A, 'Search the web', { query: 'string' }),
          // ADAPTATION: MCP rows are now costed through the registry, so a descriptor with no ToolInfo
          // is treated as never-registered and dropped. Both belong here — one active, one deferred.
          tool('mcp__s__on', 'Loaded thing'),
          tool('mcp__s__off', 'Deferred thing'),
        ],
      }),
      '',
      deps({
        eligibleToolNames: [BROWSER_A, BROWSER_B, COMPASS_A, WEB_A],
        mcpEnabled: true,
        mcpClientManager: {
          getAllToolDescriptors: () => [
            { piName: 'mcp__s__on', serverName: 's', description: 'Loaded thing', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
            { piName: 'mcp__s__off', serverName: 's', description: 'Deferred thing', inputSchema: { type: 'object', properties: { b: { type: 'number' } } } },
          ],
        } as unknown as McpClientManager,
      }),
    );

  it('accounts for every tool row exactly once across the three tool categories', () => {
    const data = mixed();
    const rowTotal =
      data.systemTools!.reduce((s, r) => s + r.tokens, 0) +
      data.deferredBuiltinTools!.reduce((s, r) => s + r.tokens, 0) +
      data.mcpTools.reduce((s, r) => s + r.tokens, 0);
    const categoryTotal =
      categoryTokens(data, 'Tools') + categoryTokens(data, 'Tools (deferred)') + categoryTokens(data, 'MCP tools');
    expect(categoryTotal).toBe(rowTotal);
    expect(rowTotal).toBeGreaterThan(0);
  });

  it('places each row in the ONE category its loaded state dictates', () => {
    const data = mixed();
    const byName = (rows: readonly { name: string; tokens: number }[], name: string) =>
      rows.find((r) => r.name === name)!.tokens;

    const read = byName(data.systemTools!, 'Read');
    const bash = byName(data.systemTools!, 'Bash');
    const browserLoaded = byName(data.deferredBuiltinTools!, BROWSER_A);
    const browserDeferred = byName(data.deferredBuiltinTools!, BROWSER_B);
    const compassDeferred = byName(data.deferredBuiltinTools!, COMPASS_A);
    const webLoaded = byName(data.deferredBuiltinTools!, WEB_A);
    const mcpLoaded = byName(data.mcpTools, 'mcp__s__on');
    const mcpDeferred = byName(data.mcpTools, 'mcp__s__off');

    expect(categoryTokens(data, 'Tools')).toBe(read + bash + browserLoaded + webLoaded);
    expect(categoryTokens(data, 'Tools (deferred)')).toBe(browserDeferred + compassDeferred + mcpDeferred);
    expect(categoryTokens(data, 'MCP tools')).toBe(mcpLoaded);
    // Neither the active MCP tool nor the LOADED web tool is double-billed through systemTools: an
    // eligible deferrable built-in belongs to the deferred section in both states, loaded or not.
    expect(data.systemTools!.map((r) => r.name)).toEqual(['Read', 'Bash']);
  });
});

describe('buildContextUsage — omission, not fabrication, when the tool read fails', () => {
  const throwing = () => {
    throw new Error('pi session tree unavailable');
  };

  const mcpDeps = {
    mcpEnabled: true,
    mcpClientManager: {
      getAllToolDescriptors: () => [
        { piName: 'mcp__s__on', serverName: 's', description: 'Loaded thing', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
        { piName: 'mcp__s__off', serverName: 's', description: 'Deferred thing', inputSchema: { type: 'object', properties: { b: { type: 'number' } } } },
      ],
    } as unknown as McpClientManager,
  };

  it('omits both sections entirely when getAllTools() throws', () => {
    const data = buildContextUsage(
      fakeSession({ contextUsage: { tokens: 0 }, allTools: throwing, activeTools: ['Read'] }),
      '',
      deps({ eligibleToolNames: [BROWSER_A] }),
    );
    // Not `[]`, not rows-with-0 — a fabricated zero reads as "this costs nothing".
    expect(data.systemTools).toBeUndefined();
    expect(data.deferredBuiltinTools).toBeUndefined();
  });

  it('omits both sections entirely when getActiveToolNames() throws', () => {
    const data = buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: throwing,
        allTools: [tool('Read', 'Read a file', { path: 'string' })],
      }),
      '',
      deps({ eligibleToolNames: [BROWSER_A] }),
    );
    expect(data.systemTools).toBeUndefined();
    expect(data.deferredBuiltinTools).toBeUndefined();
  });

  // The two pi reads are guarded INDEPENDENTLY. A single combined try/catch would satisfy the two
  // tests above while silently killing MCP deferral, so pin the surviving half explicitly.
  it('still badges MCP rows and still defers their tokens when only getAllTools() throws', () => {
    const data = buildContextUsage(
      fakeSession({ contextUsage: { tokens: 0 }, allTools: throwing, activeTools: ['mcp__s__on'] }),
      '',
      deps({ ...mcpDeps, eligibleToolNames: [BROWSER_A] }),
    );
    const on = data.mcpTools.find((t) => t.name === 'mcp__s__on')!;
    const off = data.mcpTools.find((t) => t.name === 'mcp__s__off')!;
    expect(on.isLoaded).toBe(true);
    expect(off.isLoaded).toBe(false);
    expect(categoryTokens(data, 'MCP tools')).toBe(on.tokens);
    expect(categoryTokens(data, 'Tools (deferred)')).toBe(off.tokens);
  });

  // An unknown loaded-state must count as CONSUMED, never as a saving: over-reporting spend is
  // recoverable, inventing a saving that does not exist is the lie §4.2 exists to prevent.
  it('counts MCP tokens as consumed, not deferred, when the active-set read fails', () => {
    const data = buildContextUsage(
      fakeSession({ contextUsage: { tokens: 0 }, allTools: [], activeTools: throwing }),
      '',
      deps({ ...mcpDeps, eligibleToolNames: [BROWSER_A] }),
    );
    expect(data.mcpTools.every((t) => t.isLoaded === undefined)).toBe(true);
    expect(categoryTokens(data, 'MCP tools')).toBe(data.mcpTools.reduce((s, t) => s + t.tokens, 0));
    expect(categoryTokens(data, 'Tools (deferred)')).toBe(0);
  });

  it('keeps the fixed 6-category legend shape even when both reads fail', () => {
    const data = buildContextUsage(
      fakeSession({ contextUsage: { tokens: 0 }, allTools: throwing, activeTools: throwing }),
      '',
      deps({ eligibleToolNames: [BROWSER_A] }),
    );
    expect(data.categories.map((c) => c.name)).toEqual([
      'System prompt',
      'Messages & tools',
      'Skills',
      'MCP tools',
      'Tools',
      'Tools (deferred)',
    ]);
    expect(categoryTokens(data, 'Tools')).toBe(0);
    expect(categoryTokens(data, 'Tools (deferred)')).toBe(0);
  });

  // A row whose cost is unknowable is dropped, not charged 0 — the section stays honest about what it
  // could measure rather than claiming a tool is free.
  it('drops a row pi holds no definition for rather than costing it at zero', () => {
    const data = buildContextUsage(
      fakeSession({
        contextUsage: { tokens: 0 },
        activeTools: ['Read', 'Ghost'],
        allTools: [tool('Read', 'Read a file', { path: 'string' })],
      }),
      '',
      deps({ eligibleToolNames: [BROWSER_A] }),
    );
    expect(data.systemTools).toEqual([{ name: 'Read', tokens: 8 }]);
    expect(data.deferredBuiltinTools).toEqual([]);
  });
});
