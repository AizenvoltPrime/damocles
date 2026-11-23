<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Folder, Laptop } from 'lucide-vue-next';
import type { OverlaySettingsScope, OverlaySettingsScopes } from '../../../preload/overlay-channels';
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { hostColorLook } from '@shared/host-colors';
import { SETTINGS_TAB, SETTINGS_TAB_INDICATOR } from './settings-tabs';

// pending: the tab clicked while main attaches it, shown selected meanwhile
const props = defineProps<{ scopes: OverlaySettingsScopes; pending?: OverlaySettingsScope | undefined }>();
const emit = defineEmits<{ (e: 'select', scope: OverlaySettingsScope): void }>();
const { t } = useI18n();

const host = computed(() => props.scopes.host.name);

function select(value: unknown): void {
  if (value === 'user' || value === 'machine' || value === 'project') emit('select', value);
}
</script>

<template>
  <!-- manual activation: each tab re-attaches the modal to a core, so arrow keys only move focus -->
  <Tabs
    :model-value="pending ?? scopes.active"
    activation-mode="manual"
    class="gap-0"
    @update:model-value="select"
  >
    <TabsList
      :aria-label="t('settingsScope.label')"
      :aria-busy="pending !== undefined || undefined"
      class="relative h-auto w-full justify-start gap-1 rounded-none border-b border-(--d-border) bg-transparent p-0 pt-2.5 pr-4 pl-5"
      data-testid="settings-scope-tabs"
    >
      <TabsTrigger
        value="user"
        :class="SETTINGS_TAB"
        data-testid="settings-scope-user"
      >
        <Laptop aria-hidden="true" />
        {{ t('settingsScope.user') }}
      </TabsTrigger>
      <TabsTrigger
        value="machine"
        :class="SETTINGS_TAB"
        :title="host"
        data-testid="settings-scope-host"
      >
        <span
          aria-hidden="true"
          class="size-2 shrink-0 rounded-full bg-(--tone)"
          v-bind="hostColorLook(scopes.host.color)"
        />
        <span class="max-w-40 truncate">{{ host }}</span>
      </TabsTrigger>
      <TabsTrigger
        value="project"
        :class="SETTINGS_TAB"
        data-testid="settings-scope-project"
      >
        <Folder aria-hidden="true" />
        {{ t('settingsScope.project') }}
      </TabsTrigger>
      <TabsIndicator :class="SETTINGS_TAB_INDICATOR" />
    </TabsList>
  </Tabs>
</template>
