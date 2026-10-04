import { computed } from 'vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { folderRelativePath } from '@/utils/folder-relative-path';

/** Shows a file path relative to this chat's working folder, as the reference's cards do; callers keep the full path in a tooltip. */
export function useFolderRelativePath(): (filePath: string) => string {
  const settings = useSettingsStore();
  const folder = computed(() => settings.workspaceFolders.find((f) => f.key === settings.panelWorkspaceFolderKey)?.path);
  return (filePath) => folderRelativePath(filePath, folder.value);
}
