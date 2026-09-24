<script setup lang="ts">
import { computed, ref } from "vue";
import type { AcceptableValue } from "reka-ui";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { Folder, Loader2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettingsStore } from "@/stores/useSettingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { workspaceFolders, panelWorkspaceFolderKey, isMultiRoot, workspaceFolderSwitchPending } = storeToRefs(settingsStore);

// The trigger stays focusable while a switch is pending, so closing the menu can hand focus back to it.
const open = ref(false);
function setOpen(next: boolean): void {
  open.value = next && !workspaceFolderSwitchPending.value;
}

function selectFolder(key: AcceptableValue): void {
  if (typeof key === "string") settingsStore.requestPanelWorkspaceFolder(key);
}

const panelFolder = computed(() => workspaceFolders.value.find((f) => f.key === panelWorkspaceFolderKey.value));
const chipTitle = computed(() =>
  panelFolder.value ? t("session.folderLabel", { folder: panelFolder.value.label }) : t("settings.workspaceFolder"),
);
</script>

<template>
  <DropdownMenu v-if="isMultiRoot" :open="open" @update:open="setOpen">
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        class="h-6 max-w-[40vw] gap-1.5 px-1.5 text-muted-foreground hover:text-foreground hover:bg-muted"
        :title="chipTitle"
        :aria-label="chipTitle"
        :aria-busy="workspaceFolderSwitchPending ? 'true' : undefined"
        :aria-disabled="workspaceFolderSwitchPending ? 'true' : undefined"
        data-testid="workspace-folder-chip"
      >
        <Loader2 v-if="workspaceFolderSwitchPending" class="w-3.5 h-3.5 shrink-0 animate-spin" />
        <Folder v-else class="w-3.5 h-3.5 shrink-0" />
        <span class="truncate">{{ panelFolder?.label }}</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="bottom" align="start" class="w-64 text-xs">
      <DropdownMenuLabel class="text-xs font-medium text-muted-foreground">{{ t("settings.workspaceFolder") }}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        :model-value="panelWorkspaceFolderKey"
        :aria-label="t('settings.workspaceFolder')"
        @update:model-value="selectFolder"
      >
        <DropdownMenuRadioItem
          v-for="folder in workspaceFolders"
          :key="folder.key"
          :value="folder.key"
          :title="folder.path"
          class="text-xs cursor-pointer"
          data-testid="workspace-folder-option"
        >
          <span class="truncate">{{ folder.label }}</span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
