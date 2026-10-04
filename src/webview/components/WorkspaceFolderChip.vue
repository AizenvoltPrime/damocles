<script setup lang="ts">
import { computed, ref } from "vue";
import type { AcceptableValue } from "reka-ui";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { ChevronDown, Folder, LoaderCircle } from "lucide-vue-next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_CONTENT, MENU_ITEM } from "@/components/chat-header/menuStyles";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { remPx } from "@/composables/useRemPx";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { workspaceFolders, panelWorkspaceFolderKey, isMultiRoot, workspaceFolderSwitchPending, hostCapabilities } = storeToRefs(settingsStore);

// A desktop chat's folder list is the Projects list, which already picks the project (folderPickerInPanel false).
const isPicker = computed(() => hostCapabilities.value.folderPickerInPanel && isMultiRoot.value);

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
  <DropdownMenu
    v-if="isPicker"
    :open="open"
    @update:open="setOpen"
  >
    <DropdownMenuTrigger
      class="-ms-1 inline-flex min-w-0 items-center gap-1 rounded-5 px-1 text-(--d-muted) transition-colors hover:bg-(--d-hover) hover:text-(--d-text) data-[state=open]:bg-(--d-hover) data-[state=open]:text-(--d-text)"
      :title="chipTitle"
      :aria-label="chipTitle"
      :aria-busy="workspaceFolderSwitchPending ? 'true' : undefined"
      :aria-disabled="workspaceFolderSwitchPending ? 'true' : undefined"
      data-testid="workspace-folder-chip"
    >
      <LoaderCircle
        v-if="workspaceFolderSwitchPending"
        class="size-2.75 d-spinning shrink-0"
        aria-hidden="true"
      />
      <Folder
        v-else
        class="size-2.75 shrink-0"
        aria-hidden="true"
      />
      <span class="truncate">{{ panelFolder?.label }}</span>
      <ChevronDown
        class="size-2.5 shrink-0 opacity-70"
        aria-hidden="true"
      />
    </DropdownMenuTrigger>
    <DropdownMenuContent
      side="bottom"
      align="start"
      :side-offset="remPx(0.375)"
      :class="['w-64', MENU_CONTENT]"
    >
      <DropdownMenuLabel class="px-2.25 pb-1 pt-1.5 text-10.5 font-normal uppercase tracking-[.06em] text-(--d-faint)">
        {{ t("settings.workspaceFolder") }}
      </DropdownMenuLabel>
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
          :class="[MENU_ITEM, 'ps-8']"
          data-testid="workspace-folder-option"
        >
          <span class="truncate">{{ folder.label }}</span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
  <span
    v-else-if="panelFolder"
    class="inline-flex min-w-0 items-center gap-1"
    :title="panelFolder.path"
    data-testid="chat-header-folder"
  >
    <Folder
      class="size-2.75 shrink-0"
      aria-hidden="true"
    />
    <span class="truncate">{{ panelFolder.label }}</span>
  </span>
</template>
