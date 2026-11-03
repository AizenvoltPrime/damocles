import { computed, type ComputedRef } from 'vue';
import { TOOL_GROUP_SETTINGS, TOOLS_DISABLED_SETTING, type SwitchableToolGroup, type ToolGroupStatus } from '@shared/types/tools';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import { useSettingsStore, type ToolSwitch } from '@/stores/useSettingsStore';
import { useSettingWrite } from './settings-writes';

export type { SwitchableToolGroup };

export interface ToolSwitchWrites {
  setGroup(group: SwitchableToolGroup, enabled: boolean): void;
  setTool(toolName: string, enabled: boolean): void;
}

/**
 * The Tools switches' writes. A switch shows its own value while its write is in flight, whatever toolStatus arrives, and
 * only its own row: core's next toolStatus says what else changed. After a failed write it shows core's last status, and
 * `failed` runs.
 */
export function useToolSwitchWrites(failed: () => void = () => undefined): ToolSwitchWrites {
  const settingsStore = useSettingsStore();
  const write = useSettingWrite();

  function send(key: string, message: WebviewToExtensionMessage, target: ToolSwitch, enabled: boolean, partial: boolean): void {
    let settle: (saved: boolean) => void = () => undefined;
    write(key, message, {
      apply: () => {
        settle = settingsStore.holdToolSwitch(target, enabled);
      },
      settled: (saved) => settle(saved),
      revert: failed,
      partial,
    });
  }

  return {
    setGroup: (group, enabled) => send(TOOL_GROUP_SETTINGS[group], { type: 'toggleToolGroup', group, enabled }, { group }, enabled, false),
    // every tool's switch writes one element of the same list
    setTool: (toolName, enabled) => send(TOOLS_DISABLED_SETTING, { type: 'toggleTool', toolName, enabled }, { tool: toolName }, enabled, true),
  };
}

export interface ToolGroupSwitch {
  /** Undefined until the host's first toolStatus. */
  readonly status: ComputedRef<ToolGroupStatus | undefined>;
  set(enabled: boolean): void;
}

export function useToolGroupSwitch(group: SwitchableToolGroup): ToolGroupSwitch {
  const settingsStore = useSettingsStore();
  const writes = useToolSwitchWrites();
  const status = computed(() => settingsStore.toolsSnapshot.groups.find((entry) => entry.group === group));

  return {
    status,
    set: (enabled) => writes.setGroup(group, enabled),
  };
}
