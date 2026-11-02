<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import McpStatusPanel from '@/components/McpStatusPanel.vue';
import { useMcpPanelWrites } from '@/composables/useMcpPanelWrites';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import SettingsRow from './SettingsRow.vue';
import SettingButton from './controls/SettingButton.vue';
import { MCP_HOST_SERVERS_ROW } from './settings-rows';
import type { SettingsMachineHost } from './settings-view';

// A remote chat's host tab: the servers of the host's own ~/.damocles/mcp.json, which its core edits only from here.
const props = defineProps<{ host: SettingsMachineHost }>();

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const settingsStore = useSettingsStore();
const { mcpServers, mcpConfigErrors, mcpLocalUnignored, mcpToolExposureScopes, mcpConfigRevision, mcpEnabled, mcpWriteRequestId, mcpWriteError } = storeToRefs(settingsStore);
const writes = useMcpPanelWrites();

const open = ref(false);
// the row names the host's ~/.damocles/mcp.json, so its Codex, Claude and pi imports are not counted
const machineCount = computed(() => mcpServers.value.filter((server) => server.placement === 'host' && server.source === 'damocles').length);

// The row counts the host's own servers, so it asks for them as it shows; the panel re-reads the files as it opens.
onMounted(() => postMessage({ type: 'requestMcpStatus' }));
</script>

<template>
  <SettingsRow
    :id="MCP_HOST_SERVERS_ROW"
    :label="t('settingsModal.rows.mcpHostServers.labelOn', { host: props.host.name })"
    :description="t('settingsModal.rows.mcpHostServers.descriptionOn', { host: props.host.name })"
  >
    <span class="flex items-center gap-2.5">
      <span
        v-if="machineCount > 0"
        class="text-11.5 whitespace-nowrap text-(--d-faint)"
        data-testid="mcp-host-servers-count"
      >{{ t('settingsModal.rows.mcpHostServers.count', { n: machineCount }, machineCount) }}</span>
      <SettingButton
        data-testid="mcp-host-servers-open"
        @click="open = true"
      >
        {{ t('settingsModal.rows.mcpHostServers.manage') }}
      </SettingButton>
    </span>
  </SettingsRow>
  <!-- Its own stack overlay over the settings modal; teleported so the modal's page does not clip it. -->
  <Teleport to="body">
    <Transition
      name="t-overlay"
      appear
    >
      <McpStatusPanel
        v-if="open"
        :servers="mcpServers"
        :config-errors="mcpConfigErrors"
        :local-mcp-unignored="mcpLocalUnignored"
        :tool-exposure-scopes="mcpToolExposureScopes"
        :config-revision="mcpConfigRevision"
        :mcp-enabled="mcpEnabled"
        :mcp-write-in-flight="mcpWriteRequestId !== null"
        :mcp-write-error="mcpWriteError"
        :host="props.host"
        context="hostSettings"
        @close="open = false"
        @toggle="writes.toggle"
        @toggle-enabled="writes.setEnabled"
        @set-tool-exposure="writes.setToolExposure"
        @set-resource-exposure="writes.setResourceExposure"
        @reload-config="writes.reloadConfig"
        @add-server="writes.addServer"
        @update-server="writes.updateServer"
        @delete-server="writes.deleteServer"
      />
    </Transition>
  </Teleport>
</template>
