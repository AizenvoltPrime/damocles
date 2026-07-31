import { describe, it, expect } from 'vitest';
import type { MemoryService } from '../../memory';
import type { CompassService } from '../../compass';
import { PI_NATIVE_ACTIVE_TOOLS, WEB_TOOLS } from '../pi-models';
import { CUSTOM_TOOL_NAMES } from '../tools';
import { TEAM_MAIN_PI_TOOL_NAMES } from '../tools/team-tools';
import { MEMORY_PI_TOOL_NAMES } from '../tools/memory-tools';
import { BROWSER_PI_TOOL_NAMES } from '../tools/browser-tools';
import { COMPASS_PI_TOOL_NAMES } from '../tools/compass-tools';
import { TOOL_TOOL_SEARCH } from '../../../shared/tool-names';
import { fullActiveToolNames, activeToolNamesWithDeferral, buildToolStatus, type ToolStatusDeps } from '../tool-status';

/**
 * The Tools-panel snapshot + full-active-set assembly extracted from pi-session.ts. Fabricated
 * `ToolStatusDeps` drive the gating/de-dup/disabled-filter logic.
 */

const memEnabled = { isEnabled: true } as unknown as MemoryService;
const memDisabled = { isEnabled: false } as unknown as MemoryService;
const compassEnabled = { isEnabled: true } as unknown as CompassService;

function deps(overrides: Partial<ToolStatusDeps>): ToolStatusDeps {
  return {
    webEnabled: false,
    teamEnabled: false,
    teamAvailable: false,
    browserAvailable: false,
    browserEnabled: false,
    mcpEnabled: false,
    mcpToolNames: [],
    disabled: new Set<string>(),
    ...overrides,
  };
}

describe('fullActiveToolNames', () => {
  it('always includes the native pi tools + custom tools', () => {
    const names = fullActiveToolNames(deps({}));
    for (const n of PI_NATIVE_ACTIVE_TOOLS) expect(names).toContain(n);
    for (const n of CUSTOM_TOOL_NAMES) expect(names).toContain(n);
  });

  it('gates web tools on webEnabled', () => {
    expect(fullActiveToolNames(deps({ webEnabled: false }))).not.toContain(WEB_TOOLS[0]);
    expect(fullActiveToolNames(deps({ webEnabled: true }))).toContain(WEB_TOOLS[0]);
  });

  it('includes team tools only when team is available AND enabled', () => {
    expect(fullActiveToolNames(deps({ teamEnabled: true, teamAvailable: false }))).not.toContain(TEAM_MAIN_PI_TOOL_NAMES[0]);
    expect(fullActiveToolNames(deps({ teamEnabled: false, teamAvailable: true }))).not.toContain(TEAM_MAIN_PI_TOOL_NAMES[0]);
    expect(fullActiveToolNames(deps({ teamEnabled: true, teamAvailable: true }))).toContain(TEAM_MAIN_PI_TOOL_NAMES[0]);
  });

  it('includes memory tools only when the service is enabled', () => {
    expect(fullActiveToolNames(deps({ memoryService: memDisabled }))).not.toContain(MEMORY_PI_TOOL_NAMES[0]);
    expect(fullActiveToolNames(deps({ memoryService: memEnabled }))).toContain(MEMORY_PI_TOOL_NAMES[0]);
  });

  it('includes MCP tool names only when mcpEnabled', () => {
    expect(fullActiveToolNames(deps({ mcpEnabled: false, mcpToolNames: ['mcp__srv__a'] }))).not.toContain('mcp__srv__a');
    expect(fullActiveToolNames(deps({ mcpEnabled: true, mcpToolNames: ['mcp__srv__a'] }))).toContain('mcp__srv__a');
  });

  it('subtracts the per-tool disabled set', () => {
    const names = fullActiveToolNames(deps({ disabled: new Set([PI_NATIVE_ACTIVE_TOOLS[0]]) }));
    expect(names).not.toContain(PI_NATIVE_ACTIVE_TOOLS[0]);
  });

  it('de-dups names (pi requires unique tool names)', () => {
    // An MCP name colliding with a native name must appear once.
    const collide = PI_NATIVE_ACTIVE_TOOLS[0];
    const names = fullActiveToolNames(deps({ mcpEnabled: true, mcpToolNames: [collide] }));
    expect(names.filter((n) => n === collide)).toHaveLength(1);
  });

  it('includes ToolSearch — the only way back to a deferred tool, so it is never itself deferred', () => {
    expect(fullActiveToolNames(deps({}))).toContain(TOOL_TOOL_SEARCH);
  });
});

/**
 * Slice 2: the deferral split. `fullActiveToolNames` is the ELIGIBLE universe (every tool this panel may
 * ever use); `activeToolNamesWithDeferral` is what the session actually activates for a turn — eligible
 * minus the deferred set, plus whatever ToolSearch has loaded.
 *
 * The load-bearing property is that the union is recomputed from `activated` INSIDE this function on
 * every call, so eligibility is authoritative and a loaded tool survives an unrelated recompute.
 */
describe('activeToolNamesWithDeferral', () => {
  const MCP_NAMES = ['mcp__ctx7__resolve', 'mcp__ctx7__docs'];
  const everything: Partial<ToolStatusDeps> = {
    webEnabled: false,
    teamEnabled: true,
    teamAvailable: true,
    memoryService: memEnabled,
    compassService: compassEnabled,
    browserAvailable: true,
    browserEnabled: true,
    mcpEnabled: true,
    mcpToolNames: MCP_NAMES,
  };
  const DEFERRABLE = [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...MCP_NAMES];
  const none = new Set<string>();

  it('with nothing activated, drops exactly the browser/compass/MCP names and keeps everything else', () => {
    const d = deps(everything);
    const active = activeToolNamesWithDeferral(d, none);

    // Stated as a set difference rather than a handful of `toContain`s: this fails both if a deferrable
    // name leaks into the baseline AND if the deferral over-reaches and strips a non-deferrable tool
    // (memory, web, team, natives, custom) that has nothing to do with this feature.
    const expected = fullActiveToolNames(d).filter((n) => !DEFERRABLE.includes(n));
    expect([...active].sort()).toEqual([...expected].sort());
    expect(active).toContain(TOOL_TOOL_SEARCH);
    for (const n of MEMORY_PI_TOOL_NAMES) expect(active, n).toContain(n);
  });

  it('keeps activated names across a recompute driven by a DIFFERENT deps snapshot', () => {
    // The real clobber scenario: ToolSearch loads the browser group, then an unrelated settings toggle
    // (`damocles.pi.webSearch.enabled`) fires refreshActiveTools with a NEW deps object. Recomputing with
    // the SAME deps would pass even if the function ignored `activated` and simply returned a cached
    // array, so the second snapshot must genuinely differ — and the result must reflect BOTH the new
    // deps (web tools appear) and the still-loaded set (browser tools stay).
    const before = deps({ ...everything, webEnabled: false });
    const activated = new Set(BROWSER_PI_TOOL_NAMES);
    const first = activeToolNamesWithDeferral(before, activated);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(first, n).toContain(n);
    expect(first).not.toContain(WEB_TOOLS[0]);

    const after = deps({ ...everything, webEnabled: true });
    const second = activeToolNamesWithDeferral(after, activated);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(second, n).toContain(n);
    expect(second).toContain(WEB_TOOLS[0]); // proves the recompute read the new snapshot, not a cache
    // Compass stayed unactivated through both — activation is per-name, never "all deferred tools".
    for (const n of COMPASS_PI_TOOL_NAMES) expect(second, n).not.toContain(n);
  });

  it('drops an activated tool once its subsystem is disabled (eligibility wins over the preference)', () => {
    // The activated set is a PREFERENCE. Turning the browser off must remove its tools even though
    // ToolSearch loaded them — a mutation that unions `activated` in after the eligibility filter, or
    // that persists loaded names independently of `eligible`, fails here.
    const activated = new Set(BROWSER_PI_TOOL_NAMES);
    const active = activeToolNamesWithDeferral(deps({ ...everything, browserEnabled: false }), activated);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(active, n).not.toContain(n);
    // The rest of the session is untouched — this is a targeted drop, not a reset of the loaded set.
    const stillActivated = new Set([...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES]);
    const withCompass = activeToolNamesWithDeferral(deps({ ...everything, browserEnabled: false }), stillActivated);
    for (const n of COMPASS_PI_TOOL_NAMES) expect(withCompass, n).toContain(n);
  });

  it('never resurrects a tool the user disabled via damocles.tools.disabled, even when activated', () => {
    // `deferredToolNames` intersects with `eligible`, and `disabled` is subtracted BEFORE deferral — so a
    // user-disabled tool is not deferrable and ToolSearch cannot bring it back. Reversing that
    // composition order (defer first, subtract later) would let this name through.
    const banned = BROWSER_PI_TOOL_NAMES[0];
    const d = deps({ ...everything, disabled: new Set([banned]) });
    expect(fullActiveToolNames(d)).not.toContain(banned);

    const active = activeToolNamesWithDeferral(d, new Set(BROWSER_PI_TOOL_NAMES));
    expect(active).not.toContain(banned);
    for (const n of BROWSER_PI_TOOL_NAMES.slice(1)) expect(active, n).toContain(n);
  });

  it('defers MCP names too, and activates one by exact name without pulling in its siblings', () => {
    const d = deps(everything);
    expect(activeToolNamesWithDeferral(d, none)).not.toContain(MCP_NAMES[0]);
    const active = activeToolNamesWithDeferral(d, new Set([MCP_NAMES[0]]));
    expect(active).toContain(MCP_NAMES[0]);
    expect(active).not.toContain(MCP_NAMES[1]);
  });
});

describe('buildToolStatus', () => {
  it('emits exactly the 7 expected groups (guards against a group silently dropping)', () => {
    // The webview GROUP_ORDER has historically dropped the team group; this is the cheap structural
    // guard so a future extraction can't quietly omit a subsystem and still pass every other test.
    const snap = buildToolStatus(deps({}));
    const groups = snap.groups.map((g) => g.group).sort();
    expect(groups).toEqual(['browser', 'compass', 'core', 'memory', 'subagents', 'team', 'web']);
    expect(snap.groups).toHaveLength(7);
  });

  it('marks group masters from the deps flags', () => {
    const snap = buildToolStatus(
      deps({ memoryService: memEnabled, compassService: compassEnabled, webEnabled: true, teamEnabled: true, teamAvailable: true }),
    );
    const byGroup = Object.fromEntries(snap.groups.map((g) => [g.group, g]));
    expect(byGroup.memory.enabled).toBe(true);
    expect(byGroup.compass.enabled).toBe(true);
    expect(byGroup.web.enabled).toBe(true);
    expect(byGroup.team.enabled).toBe(true);
    expect(byGroup.core.enabled).toBe(true);
  });

  it('reflects availability from service presence', () => {
    const snap = buildToolStatus(deps({ teamAvailable: false, browserAvailable: true }));
    const byGroup = Object.fromEntries(snap.groups.map((g) => [g.group, g]));
    expect(byGroup.team.available).toBe(false);
    expect(byGroup.browser.available).toBe(true);
    expect(byGroup.memory.available).toBe(false);
  });

  it('team group enabled reflects the raw flag even without availability', () => {
    const snap = buildToolStatus(deps({ teamEnabled: true, teamAvailable: false }));
    const team = snap.groups.find((g) => g.group === 'team')!;
    expect(team.enabled).toBe(true);
    expect(team.available).toBe(false);
  });

  it('core tools are always enabled; a toggleable tool is off when its group master is off', () => {
    const snap = buildToolStatus(deps({ memoryService: memDisabled }));
    const core = snap.tools.find((t) => !t.toggleable)!;
    expect(core.enabled).toBe(true);
    const memTool = snap.tools.find((t) => t.group === 'memory');
    if (memTool) expect(memTool.enabled).toBe(false);
  });

  it('a toggleable tool is off when its group is on but the tool is per-tool disabled', () => {
    const memName = MEMORY_PI_TOOL_NAMES[0];
    const snap = buildToolStatus(deps({ memoryService: memEnabled, disabled: new Set([memName]) }));
    const memTool = snap.tools.find((t) => t.name === memName);
    if (memTool) expect(memTool.enabled).toBe(false);
  });
});
