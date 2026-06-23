import { describe, it, expect } from 'vitest';
import type { MemoryService } from '../../memory';
import type { CompassService } from '../../compass';
import { PI_NATIVE_ACTIVE_TOOLS, WEB_TOOLS } from '../pi-models';
import { CUSTOM_TOOL_NAMES } from '../tools';
import { TEAM_MAIN_PI_TOOL_NAMES } from '../tools/team-tools';
import { MEMORY_PI_TOOL_NAMES } from '../tools/memory-tools';
import { fullActiveToolNames, buildToolStatus, type ToolStatusDeps } from '../tool-status';

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
