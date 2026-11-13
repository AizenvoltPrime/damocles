/**
 * The Tools panel contract (webview ↔ extension). Every agent tool is grouped by subsystem and
 * carries a per-tool enable switch; each subsystem carries a master switch + availability flag.
 * The catalog (`ToolCatalogEntry`) is assembled in `pi-session/tools/tool-catalog.ts`; the live
 * snapshot (`ToolsSnapshot`) is produced by `ChatSession.getToolStatus()`.
 */

/** Subsystem a tool belongs to. `core` tools are always on; the rest gate on a subsystem flag. */
export type ToolGroup = 'core' | 'memory' | 'compass' | 'browser' | 'web' | 'image' | 'forge' | 'subagents' | 'team' | 'design';

/** The groups with a master switch. */
export type SwitchableToolGroup = Extract<ToolGroup, 'memory' | 'compass' | 'browser' | 'web' | 'team' | 'image' | 'forge' | 'design'>;

/** The damocles.* setting each group's master switch writes. */
export const TOOL_GROUP_SETTINGS: Readonly<Record<SwitchableToolGroup, string>> = {
  memory: 'damocles.memory.enabled',
  compass: 'damocles.compass.enabled',
  browser: 'damocles.browser.enabled',
  web: 'damocles.pi.webSearch.enabled',
  team: 'damocles.team.enabled',
  image: 'damocles.imageGeneration.enabled',
  // equals FORGE_AGENT_TOOLS_SETTING in desktop/local-services/desktop-configuration.ts, which takes no imports
  forge: 'damocles.desktop.forge.agentTools',
  design: 'damocles.design.enabled',
};

/** The per-tool switches' list: the active-set names (and URI-scoped entries) turned off. */
export const TOOLS_DISABLED_SETTING = 'damocles.tools.disabled';

export function isSwitchableToolGroup(group: ToolGroup): group is SwitchableToolGroup {
  return Object.hasOwn(TOOL_GROUP_SETTINGS, group);
}

/** The longest tool name a Tools switch writes into TOOLS_DISABLED_SETTING. */
export const MAX_TOOL_NAME_CHARS = 256;

/**
 * The most entries a Tools switch leaves in TOOLS_DISABLED_SETTING: far above any chat's tool count, MCP tools included, and
 * small enough for the clientUser every remote core gets.
 */
export const MAX_DISABLED_TOOLS = 1024;

export const isToolSwitchName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_TOOL_NAME_CHARS;

/**
 * `held`, the TOOLS_DISABLED_SETTING value a switch rewrites, with `toolName` on or off. Every other entry stays as it is, a
 * hand-edited one that is not a name included; undefined when turning it off would pass MAX_DISABLED_TOOLS.
 */
export function toolsDisabledWith(held: unknown, toolName: string, enabled: boolean): unknown[] | undefined {
  const list: readonly unknown[] = Array.isArray(held) ? held : [];
  if (enabled) return list.filter((entry) => entry !== toolName);
  if (list.includes(toolName)) return [...list];
  return list.length >= MAX_DISABLED_TOOLS ? undefined : [...list, toolName];
}

/**
 * Why a group cannot run. Image: no model chosen, a model pi's image catalog does not have, or no OpenRouter credential.
 * GitHub and GitLab: no account on the computer whose accounts the chat uses, or that computer's servers are not read yet.
 */
export type ToolGroupUnavailableReason = 'noModel' | 'unknownModel' | 'noOpenRouterKey' | 'noForgeAccount' | 'forgeServersUnread';

/** A tool's static identity: its active-set name, panel label, blurb, group, and whether it toggles. */
export interface ToolCatalogEntry {
  /** Active-set name: PascalCase for module tools, runtime name for web/core built-ins. */
  name: string;
  /** Human-friendly panel label. */
  label: string;
  /** One-line panel blurb. */
  description?: string;
  group: ToolGroup;
  /** Core built-ins are locked on (`false`); module + web tools toggle (`true`). */
  toggleable: boolean;
}

/** A catalog entry plus its live enabled state, sent to the webview. */
export interface ToolStatusInfo extends ToolCatalogEntry {
  enabled: boolean;
}

/** A subsystem's master state: whether it is enabled, and whether its tools are available at all. */
export interface ToolGroupStatus {
  group: ToolGroup;
  /** The subsystem's master switch (its enable config). */
  enabled: boolean;
  /** Whether the subsystem is wired into this session (always true for core). */
  available: boolean;
  /** Set only on the image and forge groups, and only when `available` is false. */
  unavailableReason?: ToolGroupUnavailableReason;
  /** Set only on a daemon's core, when the host's own settings file holds the group's key: the switch cannot change it there. */
  setOnHost?: true;
}

/** The full Tools-panel snapshot: per-group master state + every tool's live state. */
export interface ToolsSnapshot {
  groups: ToolGroupStatus[];
  tools: ToolStatusInfo[];
  /** Set only on a daemon's core, when the host's own settings file holds TOOLS_DISABLED_SETTING: no tool switch can change it there. */
  toolsSetOnHost?: true;
}

/** Every tool the session has on, core included; every enabled-tools summary uses this one count. */
export function enabledToolCount(snapshot: ToolsSnapshot): number {
  return snapshot.tools.filter((tool) => tool.enabled).length;
}
