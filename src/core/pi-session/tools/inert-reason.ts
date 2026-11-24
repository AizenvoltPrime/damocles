import type { ToolGroupUnavailableReason } from '../../../shared/types/tools';

/**
 * Why ToolSearch cannot load a built-in deferred group: this host has no such tools, its setting is off (on a daemon's core
 * the theme switch is the turn's device's), every tool of it is in TOOLS_DISABLED_SETTING, a design chat's rules leave out
 * the tools it does not list there, a service it needs is missing, its eligible tools are neither deferred nor active, or (a
 * nested agent only) the agent's tool list leaves it out.
 */
export type ToolGroupInertReason =
  | { kind: 'host' }
  | { kind: 'off'; setting: string }
  | { kind: 'themeOffOnDevice' }
  | { kind: 'toolsOff'; tools: readonly string[] }
  | { kind: 'design'; disabled: readonly string[] }
  | { kind: 'unavailable'; reason: Extract<ToolGroupUnavailableReason, 'noModel' | 'unknownModel' | 'noOpenRouterKey'> | 'noResourceServer' }
  | { kind: 'notLoaded' }
  | { kind: 'agent' };

/** Why one tool of a built-in deferred group is out while the group itself loads: a design chat's rules, or the user's TOOLS_DISABLED_SETTING. */
export type ToolExclusion = 'design' | 'disabled';
