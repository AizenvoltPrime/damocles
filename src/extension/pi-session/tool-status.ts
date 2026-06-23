import type { ToolsSnapshot, ToolGroupStatus, ToolStatusInfo, ToolGroup } from '../../shared/types/tools';
import type { MemoryService } from '../memory';
import type { CompassService } from '../compass';
import { PI_NATIVE_ACTIVE_TOOLS, WEB_TOOLS } from './pi-models';
import { CUSTOM_TOOL_NAMES, moduleToolNames } from './tools';
import { TEAM_MAIN_PI_TOOL_NAMES } from './tools/team-tools';
import { FULL_TOOL_CATALOG } from './tools/tool-catalog';

/**
 * The Tools-panel snapshot + full-active-set name assembly (US-017/Tools panel). Both are near-pure:
 * they read live config flags and tool catalogs and produce deterministic arrays/objects. The live
 * tool-application path (`session.setActiveToolsByName`) stays in `PiSession` — only this pure
 * name/snapshot computation moves here.
 */
export interface ToolStatusDeps {
  /** `isWebSearchEnabled()`. */
  webEnabled: boolean;
  /** `this.isTeamEnabled()` — the live team master flag. The active-set membership additionally
   *  requires `teamAvailable` (the team tools gate on `teamService && isTeamEnabled()`), while the
   *  panel's team-group `enabled` reflects this raw flag. */
  teamEnabled: boolean;
  /** `!!this.options.teamService` — whether the team subsystem is wired at all (panel availability). */
  teamAvailable: boolean;
  /** `this.options.memoryService`. */
  memoryService?: MemoryService;
  /** `this.options.compassService`. */
  compassService?: CompassService;
  /** `!!this.options.browserService`. */
  browserAvailable: boolean;
  /** `this.isBrowserEnabled()`. */
  browserEnabled: boolean;
  /** `this.isMcpEnabled()`. */
  mcpEnabled: boolean;
  /** `this.mcpToolNames()`. */
  mcpToolNames: string[];
  /** `this.disabledToolSet()`. */
  disabled: Set<string>;
}

/**
 * The full active tool set: native pi tools + (web tools when enabled) + Damocles custom tools + the
 * live-enabled module tools, minus the per-tool disabled set. Membership is read live every call, so
 * `refreshActiveTools()` re-applies a master/per-tool toggle change on the next turn.
 */
export function fullActiveToolNames(deps: ToolStatusDeps): string[] {
  const names = [
    ...PI_NATIVE_ACTIVE_TOOLS,
    ...(deps.webEnabled ? WEB_TOOLS : []),
    ...CUSTOM_TOOL_NAMES,
    ...(deps.teamAvailable && deps.teamEnabled ? TEAM_MAIN_PI_TOOL_NAMES : []),
    ...moduleToolNames({
      ...(deps.memoryService ? { memoryService: deps.memoryService } : {}),
      ...(deps.compassService ? { compassService: deps.compassService } : {}),
      browserEnabled: deps.browserEnabled,
    }),
    ...(deps.mcpEnabled ? deps.mcpToolNames : []),
  ];
  // pi's setActiveToolsByName pushes one definition per name occurrence (no internal de-dup), so a
  // duplicate name would make the provider reject the request ("Tool names must be unique"). De-dup
  // defensively, mirroring pi's own `[...new Set(...)]` active-set contract.
  return [...new Set(names.filter((name) => !deps.disabled.has(name)))];
}

/**
 * Build the Tools-panel snapshot: each subsystem's master + availability, and every tool's live enabled
 * state. Layered: Core is always on; a toggleable module/web tool is on iff its group master is enabled
 * AND it is not in the per-tool disabled set.
 */
export function buildToolStatus(deps: ToolStatusDeps): ToolsSnapshot {
  const disabled = deps.disabled;
  const groupEnabled: Record<ToolGroup, boolean> = {
    core: true,
    memory: !!deps.memoryService?.isEnabled,
    compass: !!deps.compassService?.isEnabled,
    browser: deps.browserEnabled,
    web: deps.webEnabled,
    subagents: true,
    team: deps.teamEnabled,
  };
  const groups: ToolGroupStatus[] = [
    { group: 'memory', enabled: groupEnabled.memory, available: !!deps.memoryService },
    { group: 'compass', enabled: groupEnabled.compass, available: !!deps.compassService },
    { group: 'browser', enabled: groupEnabled.browser, available: deps.browserAvailable },
    { group: 'web', enabled: groupEnabled.web, available: true },
    { group: 'subagents', enabled: groupEnabled.subagents, available: true },
    { group: 'team', enabled: groupEnabled.team, available: deps.teamAvailable },
    { group: 'core', enabled: true, available: true },
  ];
  const tools: ToolStatusInfo[] = FULL_TOOL_CATALOG.map((entry) => ({
    ...entry,
    enabled: entry.toggleable ? groupEnabled[entry.group] && !disabled.has(entry.name) : true,
  }));
  return { groups, tools };
}
