import { computed, type ComputedRef } from 'vue';
import { TOOL_GROUP_SETTINGS, type SwitchableToolGroup, type ToolGroupStatus } from '@shared/types/tools';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSettingWrite } from './settings-writes';

export type { SwitchableToolGroup };

export interface ToolGroupSwitch {
  /** Undefined until the host's first toolStatus. */
  readonly status: ComputedRef<ToolGroupStatus | undefined>;
  set(enabled: boolean): void;
}

export function useToolGroupSwitch(group: SwitchableToolGroup): ToolGroupSwitch {
  const settingsStore = useSettingsStore();
  const write = useSettingWrite();
  const status = computed(() => settingsStore.toolsSnapshot.groups.find((entry) => entry.group === group));

  function withGroup(enabled: boolean): void {
    const snapshot = settingsStore.toolsSnapshot;
    settingsStore.setToolsSnapshot({ ...snapshot, groups: snapshot.groups.map((entry) => (entry.group === group ? { ...entry, enabled } : entry)) });
  }

  return {
    status,
    set(enabled) {
      write(TOOL_GROUP_SETTINGS[group], { type: 'toggleToolGroup', group, enabled }, {
        apply: () => withGroup(enabled),
        revert: () => withGroup(!enabled),
      });
    },
  };
}
