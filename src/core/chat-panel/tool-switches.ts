import { isSwitchableToolGroup, isToolSwitchName, MAX_DISABLED_TOOLS, toolsDisabledWith, type SwitchableToolGroup, type ToolGroup } from "../../shared/types/tools";
import { LocalizedError } from "../../shared/localized-text";
import { l } from "../l10n";

// A Tools switch's arguments arrive from a renderer: each setter checks them before it writes anything.

export function toolSwitchOf(toolName: unknown, enabled: unknown): { readonly toolName: string; readonly enabled: boolean } {
  if (!isToolSwitchName(toolName) || typeof enabled !== "boolean") throw new Error("Malformed tool setting");
  return { toolName, enabled };
}

export function toolGroupSwitchOf(group: unknown, enabled: unknown): { readonly group: SwitchableToolGroup; readonly enabled: boolean } {
  if (typeof group !== "string" || !isSwitchableToolGroup(group as ToolGroup) || typeof enabled !== "boolean") throw new Error("Malformed tool group setting");
  return { group: group as SwitchableToolGroup, enabled };
}

/** The damocles.tools.disabled value `held` becomes with the tool switched; refused past MAX_DISABLED_TOOLS. */
export function rewriteToolsDisabled(held: unknown, toolName: string, enabled: boolean): unknown[] {
  const next = toolsDisabledWith(held, toolName, enabled);
  if (next === undefined) throw new LocalizedError(l("At most {0} tools can be turned off. Turn one back on first.", MAX_DISABLED_TOOLS));
  return next;
}
