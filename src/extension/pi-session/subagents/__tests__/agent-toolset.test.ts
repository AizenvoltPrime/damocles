import { describe, it, expect } from 'vitest';
import { resolveAgentToolset } from '../agent-toolset';
import { DEFAULT_AGENTS } from '../default-agents';
import { BROWSER_PI_TOOL_NAMES } from '../../tools/browser-tools';
import { COMPASS_PI_TOOL_NAMES } from '../../tools/compass-tools';
import { deferredToolNames } from '../../tools/deferred-tools';
import { mapPiToolName, toolCategory } from '../../tool-normalization';
import { TOOL_TOOL_SEARCH, TOOL_EDIT } from '../../../../shared/tool-names';
import type { AgentConfig } from '../types';

function cfg(over: Partial<AgentConfig>): AgentConfig {
  return { name: 'x', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'replace', ...over };
}

const PARENT = ['read', 'bash', 'write', 'grep', 'find', 'ls', 'Edit', 'PowerShell', 'SaveMemory', 'Agent', 'GetSubagentResult', 'SteerSubagent'];

/** A parent panel that has ToolSearch eligible — i.e. every real panel since Slice 2. */
const PARENT_WITH_SEARCH = [...PARENT, TOOL_TOOL_SEARCH];

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
    const webOn = resolveAgentToolset(explore, ['read', 'bash', 'grep', 'find', 'ls', 'WebSearch', 'WebFetch', 'CodeSearch', 'FeedRead', 'YouTubeTranscript']);
    expect(webOn.names).toContain('WebSearch');
    expect(webOn.names).toContain('WebFetch');
    expect(webOn.names).toContain('CodeSearch');
    expect(webOn.names).toContain('FeedRead');
    expect(webOn.names).toContain('YouTubeTranscript');
    expect(webOn.names).not.toContain('Edit');
  });

  it('Explore/Plan resolve the browser tools only when the panel has them active', () => {
    for (const name of ['Explore', 'Plan']) {
      const agent = DEFAULT_AGENTS.get(name)!;
      const off = resolveAgentToolset(agent, PARENT);
      for (const tool of BROWSER_PI_TOOL_NAMES) expect(off.names, `${name}/${tool}`).not.toContain(tool);
      const on = resolveAgentToolset(agent, [...PARENT, ...BROWSER_PI_TOOL_NAMES]);
      for (const tool of BROWSER_PI_TOOL_NAMES) expect(on.names, `${name}/${tool}`).toContain(tool);
    }
  });

  it('stays readOnly with browser tools resolved (browser names are not write-category)', () => {
    const parent = [...PARENT, ...BROWSER_PI_TOOL_NAMES];
    expect(resolveAgentToolset(DEFAULT_AGENTS.get('Explore')!, parent).readOnly).toBe(true);
    expect(resolveAgentToolset(DEFAULT_AGENTS.get('Plan')!, parent).readOnly).toBe(true);
  });

  it('flags a toolset with no write tool as readOnly (the shell hardening trigger)', () => {
    expect(resolveAgentToolset(cfg({ builtinToolNames: ['read', 'bash', 'grep', 'find', 'ls'] }), PARENT).readOnly).toBe(true);
    expect(resolveAgentToolset(DEFAULT_AGENTS.get('Explore')!, PARENT).readOnly).toBe(true);
    expect(resolveAgentToolset(DEFAULT_AGENTS.get('Plan')!, PARENT).readOnly).toBe(true);
  });

  it('is NOT readOnly once any write tool survives resolution', () => {
    expect(resolveAgentToolset(cfg({ builtinToolNames: ['read', 'bash', 'write'] }), PARENT).readOnly).toBe(false);
    expect(resolveAgentToolset(cfg({ builtinToolNames: ['read', 'bash', 'edit'] }), PARENT).readOnly).toBe(false);
    // general-purpose inherits the parent's full set, which includes Edit/write.
    expect(resolveAgentToolset(DEFAULT_AGENTS.get('general-purpose')!, PARENT).readOnly).toBe(false);
  });

  it('treats an agent whose only write tool was disallowed as readOnly', () => {
    const c = cfg({ builtinToolNames: ['read', 'bash', 'write'], disallowedTools: ['write'] });
    expect(resolveAgentToolset(c, PARENT).readOnly).toBe(true);
  });
});

/**
 * Slice 3 §3.1 — ToolSearch is a CAPABILITY OF THE HARNESS, not a tool an agent opts into.
 *
 * The gap this closes: `Explore`/`Plan` declare an explicit `EXPLORE_TOOL_NAMES` that spells out all 25
 * browser names and does NOT name `ToolSearch`, and users can write explicit `tools:` lists in their own
 * agent markdown. Without an unconditional rule here, exactly the two most-used subagents — and every
 * user agent with an explicit list — would get ZERO deferral benefit while the feature looked like it
 * worked. The rule's POSITION in the pipeline is the contract: after the explicit-list intersection (so
 * an agent need not name it) and before the `disallowed_tools` subtraction (so an agent can opt out).
 */
describe('resolveAgentToolset — ToolSearch injection (Slice 3 §3.1)', () => {
  it('injects ToolSearch into an EXPLICIT tools: list that never named it (the Explore gap)', () => {
    // Explore's own list, verbatim from default-agents.ts, against a parent that has the browser tools
    // and ToolSearch. It names 25 browser tools and no ToolSearch — and must still get ToolSearch.
    const explore = DEFAULT_AGENTS.get('Explore')!;
    expect(explore.builtinToolNames).toBeDefined();
    expect(explore.builtinToolNames).not.toContain(TOOL_TOOL_SEARCH);

    const { names } = resolveAgentToolset(explore, [...PARENT_WITH_SEARCH, ...BROWSER_PI_TOOL_NAMES]);

    expect(names).toContain(TOOL_TOOL_SEARCH);
    // Constraint 1 (§3.2): the browser names STAY in the allowlist. Deferral narrows the ACTIVE set,
    // never the eligible set — dropping them here would remove them from pi's registry for good.
    for (const n of BROWSER_PI_TOOL_NAMES) expect(names, n).toContain(n);
  });

  it('injects ToolSearch into an arbitrary user agent with a short explicit list', () => {
    // Not an Explore special case: the rule lives in the one function that owns toolset resolution, so
    // any user-authored `tools:` list picks it up with no per-agent edit.
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'grep'] }), PARENT_WITH_SEARCH);
    expect([...names].sort()).toEqual([TOOL_TOOL_SEARCH, 'grep', 'read'].sort());
  });

  it('does NOT inject ToolSearch when the parent set lacks it (the guard is on `available`)', () => {
    // A panel with ToolSearch disabled must propagate that to its agents — an agent can never resolve a
    // tool its parent does not have, and this rule is no exception to that invariant.
    const explicit = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'grep'] }), PARENT);
    expect(explicit.names).not.toContain(TOOL_TOOL_SEARCH);
    const inheritAll = resolveAgentToolset(cfg({ builtinToolNames: undefined }), PARENT);
    expect(inheritAll.names).not.toContain(TOOL_TOOL_SEARCH);
    // Not even an agent that asks for it by name gets it — the intersection with `available` runs first.
    const asked = resolveAgentToolset(cfg({ builtinToolNames: ['read', TOOL_TOOL_SEARCH] }), PARENT);
    expect(asked.names).not.toContain(TOOL_TOOL_SEARCH);
  });

  it('an agent CAN opt out via disallowed_tools — the rule runs BEFORE the subtraction', () => {
    // This is what makes the runtime's §3.2 `opts.tools.includes(TOOL_TOOL_SEARCH)` guard a real edge
    // case rather than dead code: after this slice, `disallowed_tools` is the ONLY way to lack it.
    const explicit = resolveAgentToolset(
      cfg({ builtinToolNames: ['read', 'grep'], disallowedTools: [TOOL_TOOL_SEARCH] }),
      PARENT_WITH_SEARCH,
    );
    expect(explicit.names).not.toContain(TOOL_TOOL_SEARCH);
    expect([...explicit.names].sort()).toEqual(['grep', 'read']);

    // Same for a `tools: *` agent — the subtraction is downstream of BOTH resolution branches.
    const inheritAll = resolveAgentToolset(
      cfg({ builtinToolNames: undefined, disallowedTools: [TOOL_TOOL_SEARCH] }),
      PARENT_WITH_SEARCH,
    );
    expect(inheritAll.names).not.toContain(TOOL_TOOL_SEARCH);
  });

  it('appears exactly once in the `tools: *` case despite the unconditional append', () => {
    // The rule is a single unbranched line, so the inherit-all case appends a name that is already
    // there. Harmless ONLY because of the final `[...new Set(names)]` — and that dedupe is load-bearing
    // downstream: pi's `setActiveToolsByName` pushes one definition per occurrence with no internal
    // de-dup, and a repeated tool name makes the provider reject the request outright.
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: undefined }), PARENT_WITH_SEARCH);
    expect(names.filter((n) => n === TOOL_TOOL_SEARCH)).toHaveLength(1);
    expect(names).toHaveLength(new Set(names).size);
  });

  it('an empty tools: list still gets ToolSearch, and nothing else', () => {
    // `tools: []` means "no tools", but ToolSearch is a harness capability rather than a tool the agent
    // chose — the same reasoning that makes the subagent/plan-mode STRIPS unconditional.
    expect(resolveAgentToolset(cfg({ builtinToolNames: [] }), PARENT_WITH_SEARCH).names).toEqual([TOOL_TOOL_SEARCH]);
  });

  it('does not disturb the strip-rules that run after it', () => {
    // Ordering regression guard: injecting before the strips must not smuggle a stripped tool back in,
    // and the strips must not eat ToolSearch.
    const parent = [...PARENT_WITH_SEARCH, 'EnterPlanMode', 'ExitPlanMode', 'mcp__git__status'];
    const { names } = resolveAgentToolset(cfg({ builtinToolNames: undefined }), parent);
    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of ['Agent', 'GetSubagentResult', 'SteerSubagent', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(names, n).not.toContain(n);
    }
    expect(names.some((n) => n.startsWith('mcp__'))).toBe(false);
  });
});

/**
 * Slice 3 §3.4 — the read-only guarantee, stated as the two tests the brief explicitly demands.
 *
 * `readOnly` drives `readOnlyShell`, which holds a read-only agent's `Bash`/`PowerShell` to the
 * fail-closed classifier so a denied `Edit` cannot be worked around with `echo > file`. The derivation
 * reads the RESOLVED NAME LIST — the eligible set, which deferral never touches — so the property to
 * lock is that §3.1's injection cannot flip it, and that what DOES flip it is a write-category tool.
 */
describe('resolveAgentToolset — readOnly is unaffected by ToolSearch (Slice 3 §3.4)', () => {
  it('an Explore-style toolset derives readOnly: true WITH ToolSearch present', () => {
    const parent = [...PARENT_WITH_SEARCH, ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES];
    for (const agent of ['Explore', 'Plan']) {
      const { names, readOnly } = resolveAgentToolset(DEFAULT_AGENTS.get(agent)!, parent);
      expect(names, agent).toContain(TOOL_TOOL_SEARCH); // the precondition — not a vacuous pass
      expect(readOnly, agent).toBe(true);
    }
    // And a plain read-only user agent, so this is not a defaults-only property.
    const custom = resolveAgentToolset(cfg({ builtinToolNames: ['read', 'bash', 'grep'] }), parent);
    expect(custom.names).toContain(TOOL_TOOL_SEARCH);
    expect(custom.readOnly).toBe(true);
  });

  it('a tools: * toolset is readOnly: false ONLY because of Edit — not ToolSearch, not any deferrable', () => {
    // Stated as a causal claim, not a coincidence: remove exactly the write-category tools and the same
    // set flips to read-only, which proves nothing ELSE in it (ToolSearch, 25 browser, 8 compass) is
    // what carries the write classification.
    const parent = [...PARENT_WITH_SEARCH, ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES];
    const all = resolveAgentToolset(cfg({ builtinToolNames: undefined }), parent);
    expect(all.readOnly).toBe(false);
    expect(all.names).toContain(TOOL_TOOL_SEARCH);

    const writers = all.names.filter((n) => toolCategory(mapPiToolName(n)) === 'write');
    expect([...writers].sort()).toEqual([TOOL_EDIT, 'write'].sort()); // WRITE_TOOLS is exactly {Write, Edit}

    const withoutWriters = resolveAgentToolset(
      cfg({ builtinToolNames: undefined, disallowedTools: writers }),
      parent,
    );
    expect(withoutWriters.readOnly).toBe(true);
    // …with ToolSearch and the whole deferrable catalog still present. If any of them were
    // write-category, this would still be false.
    expect(withoutWriters.names).toContain(TOOL_TOOL_SEARCH);
    for (const n of [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES]) expect(withoutWriters.names, n).toContain(n);
  });

  it('every name a read-only agent could activate via ToolSearch is non-write by category', () => {
    // §3.4's "safe by construction, no extra guard": the deferrable universe an Explore agent can reach
    // is bounded by its OWN allowlist, and no member of it classifies as write. An extra runtime guard
    // would be cargo-cult precisely because this holds statically.
    const parent = [...PARENT_WITH_SEARCH, ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES];
    const explore = resolveAgentToolset(DEFAULT_AGENTS.get('Explore')!, parent);
    const deferrable = deferredToolNames(explore.names, []);
    expect(deferrable.length).toBeGreaterThan(0);
    for (const n of deferrable) expect(toolCategory(mapPiToolName(n)), n).not.toBe('write');
    expect(toolCategory(mapPiToolName(TOOL_TOOL_SEARCH))).toBe('read');
  });
});
