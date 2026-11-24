import { TOOL_GROUP_SETTINGS, TOOLS_DISABLED_SETTING, type ToolsSnapshot, type ToolGroupStatus, type ToolStatusInfo, type ToolGroup, isSwitchableToolGroup } from '../../shared/types/tools';
import type { SettingsStore } from '../../platform/settings-store';
import type { ImageAvailability } from './tools/image-tools';
import type { MemoryService } from '../memory';
import type { CompassService } from '../compass';
import { PI_NATIVE_ACTIVE_TOOLS, WEB_TOOLS } from './pi-models';
import { CUSTOM_TOOL_NAMES, moduleToolNames } from './tools';
import { TEAM_MAIN_PI_TOOL_NAMES } from './tools/team-tools';
import { FULL_TOOL_CATALOG } from './tools/tool-catalog';
import { BUILTIN_DEFERRED_GROUPS, deferredToolNames, initialActiveToolNames, type BuiltinDeferredGroup } from './tools/deferred-tools';
import { MCP_RESOURCE_TOOL_NAMES, TOOL_DESIGN_PARITY, TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE, TOOL_START_DESIGN, TOOL_TOOL_SEARCH } from '../../shared/tool-names';
import { designBrowserAllows } from './tools/browser-tools';
import { MEMORY_WRITE_PI_TOOL_NAMES } from './tools/memory-tools';
import { BUILT_DESIGN_TOOL_NAMES } from '../design/tools/design-tool-specs';
import { THEME_PI_TOOL_NAMES } from './tools/theme-tool-specs';
import type { ToolExclusion, ToolGroupInertReason } from './tools/inert-reason';
import type { DesignRuleSet } from '../design/rule-set';

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
  /** `this.options.browser` is set: the session has a browser and a chat for its pages. */
  browserAvailable: boolean;
  /** `this.isBrowserEnabled()`. */
  browserEnabled: boolean;
  /** `damocles.imageGeneration.enabled`, a user-scope setting. */
  imageEnabled: boolean;
  /** The chosen model resolves in pi's image catalog and pi holds an OpenRouter credential. */
  imageAvailability: ImageAvailability;
  /** The chat has GitHub and GitLab tools: a desktop core's chat. */
  forgeAvailable: boolean;
  /** `damocles.desktop.forge.agentTools`. */
  forgeEnabled: boolean;
  /** Why no account is known where the tools run, else undefined (`forgeGroupUnavailable()`). */
  forgeUnavailable: 'noForgeAccount' | 'forgeServersUnread' | undefined;
  /** The chat has the theme tools: a main chat of this computer's desktop core (HostCapabilities.damoclesTheme). */
  themeAvailable: boolean;
  /** `damocles.desktop.themes.agentTools`. */
  themeEnabled: boolean;
  /** A daemon's core: `themeEnabled` is the switch of the device the turn is pinned to, not this host's. */
  themeSwitchOnDevice: boolean;
  /** Why the tools cannot reach the app they change, else undefined (`themeGroupUnavailable()`). */
  themeUnavailable: 'themeAppClosed' | 'themeAppOutdated' | undefined;
  /** `this.isMcpEnabled()`. */
  mcpEnabled: boolean;
  /** `this.mcpToolNames()`: every MCP tool, whatever its exposure; `disabled` removes the `off` ones. */
  mcpToolNames: string[];
  /** The MCP tools whose exposure is `deferred`; Always-loaded ones are active from the first turn. */
  mcpDeferrableToolNames: string[];
  /**
   * How the MCP resource tools reach the model: `direct` when an eligible resource server is Always
   * loaded, `deferred` otherwise, null when no visible server offers resources with exposure on.
   */
  mcpResourceExposure: 'direct' | 'deferred' | null;
  /** `this.disabledToolSet()`. */
  disabled: Set<string>;
  /**
   * A daemon's core only: its settings, whose machineValue marks a switch the host's own file holds (setOnHost).
   * A client-only key (application scope, voice) never reports a machineValue.
   */
  hostSettings?: Pick<SettingsStore, 'inspect'>;
  /** `damocles.design.enabled`, a user-scope setting. */
  designEnabled: boolean;
  /** The session is a design chat (its branch holds a role entry, readable or not), which keeps its role while the setting is off. */
  designRole: boolean;
  /** The host's rule set (`designRuleSet`), a design chat's recorded one. */
  ruleSet: DesignRuleSet;
}

/**
 * What a design chat never has: plan mode, parent design tools, teams, memory writes, which reach outside its folder (PD-4,
 * PD-25), and the theme tools, which change the app's look.
 */
const DESIGN_CHAT_EXCLUDED: ReadonlySet<string> = new Set([TOOL_ENTER_PLAN_MODE, TOOL_EXIT_PLAN_MODE, TOOL_START_DESIGN, TOOL_DESIGN_PARITY, ...TEAM_MAIN_PI_TOOL_NAMES, ...MEMORY_WRITE_PI_TOOL_NAMES, ...THEME_PI_TOOL_NAMES]);

/** The design tools a chat gets: its rule set's design chat tools in a design chat, its parent tools elsewhere; only those built. */
function designToolNames(deps: Pick<ToolStatusDeps, 'designEnabled' | 'designRole' | 'ruleSet'>): string[] {
  if (!deps.designEnabled) return [];
  return (deps.designRole ? deps.ruleSet.designTools : deps.ruleSet.parentTools).filter((name) => BUILT_DESIGN_TOOL_NAMES.has(name));
}

/**
 * The ELIGIBLE UNIVERSE: every tool this panel may ever use — native pi tools + (web tools when
 * enabled) + Damocles custom tools + `ToolSearch` + the live-enabled module tools, minus the per-tool
 * disabled set. Membership is read live every call, so `refreshActiveTools()` re-applies a master/
 * per-tool toggle change on the next turn.
 *
 * This is eligibility, NOT the live active set: with deferral, some eligible tools are registered but
 * inactive until `ToolSearch` loads them (see {@link activeToolNamesWithDeferral}). Its consumers —
 * nested-session allowlists, `resolveAgentToolset`'s parent set, `teamAgentToolNames()` and
 * `missingMcpRegistryNames()` — all want eligibility, which is why they keep calling this.
 */
export function fullActiveToolNames(deps: ToolStatusDeps): string[] {
  const names = [
    ...PI_NATIVE_ACTIVE_TOOLS,
    ...(deps.webEnabled ? WEB_TOOLS : []),
    ...CUSTOM_TOOL_NAMES,
    TOOL_TOOL_SEARCH,
    ...(deps.teamAvailable && deps.teamEnabled ? TEAM_MAIN_PI_TOOL_NAMES : []),
    ...moduleToolNames({
      ...(deps.memoryService ? { memoryService: deps.memoryService } : {}),
      ...(deps.compassService ? { compassService: deps.compassService } : {}),
      browserEnabled: deps.browserAvailable && deps.browserEnabled,
      imageEligible: deps.imageEnabled && deps.imageAvailability.available,
      forgeEligible: deps.forgeAvailable && deps.forgeEnabled,
      themeEligible: deps.themeAvailable && deps.themeEnabled,
    }),
    ...(deps.mcpEnabled ? deps.mcpToolNames : []),
    ...(deps.mcpEnabled && deps.mcpResourceExposure !== null ? MCP_RESOURCE_TOOL_NAMES : []),
    ...designToolNames(deps),
  ];
  // pi's setActiveToolsByName pushes one definition per name occurrence (no internal de-dup), so a
  // duplicate name would make the provider reject the request ("Tool names must be unique"). De-dup
  // defensively, mirroring pi's own `[...new Set(...)]` active-set contract.
  return [...new Set(names.filter((name) => toolExclusion(name, deps) === undefined))];
}

/**
 * Why a tool its subsystem offers is still not eligible: a design chat's least privilege (PD-25), which no setting lifts, or
 * the user's TOOLS_DISABLED_SETTING. `loadableToolNames` and the gate's `designWriteBlock` narrow a design chat too, and each
 * must hold on its own.
 */
function toolExclusion(name: string, deps: Pick<ToolStatusDeps, 'disabled' | 'designRole'>): ToolExclusion | undefined {
  if (deps.designRole && (DESIGN_CHAT_EXCLUDED.has(name) || !designBrowserAllows(name))) return 'design';
  return deps.disabled.has(name) ? 'disabled' : undefined;
}

/**
 * The live active set: the eligible universe with the deferrable tools (browser + compass + web + image + forge + deferred MCP) held
 * back until `ToolSearch` activates them. The union is computed HERE, from a freshly-derived eligible
 * set, which is what keeps eligibility authoritative: disabling the browser subsystem drops its tools
 * on the next recompute even though `activated` still names them. The activated set is a preference,
 * never an override.
 */
export function activeToolNamesWithDeferral(deps: ToolStatusDeps, activated: ReadonlySet<string>): string[] {
  const eligible = fullActiveToolNames(deps);
  const deferred = deferredToolNames(eligible, mcpDeferrableNames(deps));
  return initialActiveToolNames(eligible, deferred, activated);
}

const MCP_ENABLED_SETTING = 'damocles.mcp.enabled';

/** Why `group` holds no tool of `eligible` (`fullActiveToolNames(deps)`), read from the deps it reads; undefined while it has one. */
export function deferredGroupInert(group: BuiltinDeferredGroup, deps: ToolStatusDeps, eligible: ReadonlySet<string>): ToolGroupInertReason | undefined {
  const names = BUILTIN_DEFERRED_GROUPS.find((g) => g.group === group)?.names ?? [];
  if (names.some((name) => eligible.has(name))) return undefined;
  const switched = (on: boolean, setting: string): ToolGroupInertReason | undefined => (on ? undefined : { kind: 'off', setting });
  const gate = ((): ToolGroupInertReason | undefined => {
    switch (group) {
      case 'browser': return deps.browserAvailable ? switched(deps.browserEnabled, TOOL_GROUP_SETTINGS.browser) : { kind: 'host' };
      case 'compass': return deps.compassService ? switched(deps.compassService.isEnabled, TOOL_GROUP_SETTINGS.compass) : { kind: 'host' };
      case 'web': return switched(deps.webEnabled, TOOL_GROUP_SETTINGS.web);
      case 'image': return switched(deps.imageEnabled, TOOL_GROUP_SETTINGS.image);
      case 'forge': return deps.forgeAvailable ? switched(deps.forgeEnabled, TOOL_GROUP_SETTINGS.forge) : { kind: 'host' };
      case 'theme':
        if (!deps.themeAvailable) return { kind: 'host' };
        if (deps.themeEnabled) return undefined;
        return deps.themeSwitchOnDevice ? { kind: 'themeOffOnDevice' } : { kind: 'off', setting: TOOL_GROUP_SETTINGS.theme };
      case 'mcp_resources': return switched(deps.mcpEnabled, MCP_ENABLED_SETTING);
      default: {
        const unknown: never = group;
        throw new Error(`deferredGroupInert has no gate for the group ${String(unknown)}`);
      }
    }
  })();
  if (gate) return gate;
  // the subsystem offers the group, so each of its tools is excluded by name, or the group needs a service it lacks
  const byDesign = names.filter((name) => toolExclusion(name, deps) === 'design');
  const disabled = names.filter((name) => toolExclusion(name, deps) === 'disabled');
  if (byDesign.length + disabled.length === names.length) return byDesign.length > 0 ? { kind: 'design', disabled } : { kind: 'toolsOff', tools: disabled };
  if (group === 'image' && !deps.imageAvailability.available) return { kind: 'unavailable', reason: deps.imageAvailability.reason };
  if (group === 'mcp_resources' && deps.mcpResourceExposure === null) return { kind: 'unavailable', reason: 'noResourceServer' };
  // unreachable while these cases mirror fullActiveToolNames' conditions; tool-search.test.ts checks every combination
  return undefined;
}

/**
 * Every built-in deferred group with no eligible tool, and every eligible one with no tool deferred or `active`, with its
 * reason. `eligible` is `fullActiveToolNames(deps)`.
 */
export function deferredInertReasons(deps: ToolStatusDeps, eligible: readonly string[], active: ReadonlySet<string>): Map<BuiltinDeferredGroup, ToolGroupInertReason> {
  const eligibleSet = new Set(eligible);
  const deferred = new Set(deferredToolNames(eligible, mcpDeferrableNames(deps)));
  const reasons = new Map<BuiltinDeferredGroup, ToolGroupInertReason>();
  for (const { group, names } of BUILTIN_DEFERRED_GROUPS) {
    const reason = deferredGroupInert(group, deps, eligibleSet) ?? (names.some((name) => deferred.has(name) || active.has(name)) ? undefined : { kind: 'notLoaded' as const });
    if (reason) reasons.set(group, reason);
  }
  return reasons;
}

/** Each built-in deferred tool that is excluded by name, with why. A group with no eligible tool is answered by `deferredInertReasons` first. */
export function deferredToolExclusions(deps: Pick<ToolStatusDeps, 'disabled' | 'designRole'>): Map<string, ToolExclusion> {
  const excluded = new Map<string, ToolExclusion>();
  for (const { names } of BUILTIN_DEFERRED_GROUPS) {
    for (const name of names) {
      const why = toolExclusion(name, deps);
      if (why) excluded.set(name, why);
    }
  }
  return excluded;
}

/** The MCP names ToolSearch may load: the deferred MCP tools, plus the resource tools while no resource server is Always loaded. */
export function mcpDeferrableNames(deps: Pick<ToolStatusDeps, 'mcpEnabled' | 'mcpDeferrableToolNames' | 'mcpResourceExposure'>): string[] {
  if (!deps.mcpEnabled) return [];
  return deps.mcpResourceExposure === 'deferred' ? [...deps.mcpDeferrableToolNames, ...MCP_RESOURCE_TOOL_NAMES] : deps.mcpDeferrableToolNames;
}

/**
 * Build the Tools-panel snapshot: each subsystem's master + availability, and every tool's live enabled
 * state. Layered: Core is always on; a toggleable module/web tool is on iff its group master is enabled
 * AND it is not in the per-tool disabled set.
 *
 * Deliberately deferral-blind: a deferred browser tool still reports `enabled: true`. The panel answers
 * "did the user turn this on?", not "is it in this turn's request" — deferral is a transport
 * optimisation the user never asked for and should not have to reason about.
 */
export function buildToolStatus(deps: ToolStatusDeps): ToolsSnapshot {
  const disabled = deps.disabled;
  const groupEnabled: Record<ToolGroup, boolean> = {
    core: true,
    memory: !!deps.memoryService?.isEnabled,
    compass: !!deps.compassService?.isEnabled,
    browser: deps.browserEnabled,
    web: deps.webEnabled,
    image: deps.imageEnabled,
    forge: deps.forgeEnabled,
    theme: deps.themeEnabled,
    subagents: true,
    team: deps.teamEnabled,
    design: deps.designEnabled,
  };
  const heldOnHost = (key: string): boolean => deps.hostSettings?.inspect(key).machineValue !== undefined;
  const entries: ToolGroupStatus[] = [
    { group: 'memory', enabled: groupEnabled.memory, available: !!deps.memoryService },
    { group: 'compass', enabled: groupEnabled.compass, available: !!deps.compassService },
    { group: 'browser', enabled: groupEnabled.browser, available: deps.browserAvailable },
    { group: 'web', enabled: groupEnabled.web, available: true },
    {
      group: 'image',
      enabled: groupEnabled.image,
      available: deps.imageAvailability.available,
      ...(deps.imageAvailability.available ? {} : { unavailableReason: deps.imageAvailability.reason }),
    },
    ...(deps.forgeAvailable
      ? [{ group: 'forge' as const, enabled: groupEnabled.forge, available: deps.forgeUnavailable === undefined, ...(deps.forgeUnavailable === undefined ? {} : { unavailableReason: deps.forgeUnavailable }) }]
      : []),
    ...(deps.themeAvailable
      ? [{ group: 'theme' as const, enabled: groupEnabled.theme, available: deps.themeUnavailable === undefined, ...(deps.themeUnavailable === undefined ? {} : { unavailableReason: deps.themeUnavailable }) }]
      : []),
    { group: 'subagents', enabled: groupEnabled.subagents, available: true },
    { group: 'team', enabled: groupEnabled.team, available: deps.teamAvailable },
    // Settings' design switch renders from this entry, so it is sent while off too; the Tools panel hides a group with no tools (PD-22).
    { group: 'design', enabled: groupEnabled.design, available: true },
    { group: 'core', enabled: true, available: true },
  ];
  const groups = entries.map((entry) =>
    isSwitchableToolGroup(entry.group) && heldOnHost(TOOL_GROUP_SETTINGS[entry.group]) ? { ...entry, setOnHost: true as const } : entry,
  );
  const tools: ToolStatusInfo[] = FULL_TOOL_CATALOG.filter((entry) => (entry.group !== 'design' || deps.designEnabled) && (entry.group !== 'forge' || deps.forgeAvailable) && (entry.group !== 'theme' || deps.themeAvailable)).map((entry) => ({
    ...entry,
    enabled: entry.toggleable ? groupEnabled[entry.group] && !disabled.has(entry.name) : true,
  }));
  return { groups, tools, ...(heldOnHost(TOOLS_DISABLED_SETTING) ? { toolsSetOnHost: true as const } : {}) };
}
