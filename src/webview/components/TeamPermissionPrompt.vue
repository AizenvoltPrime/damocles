<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconCheck, IconBan } from '@/components/icons';
import { useTeamStore } from '@/stores/useTeamStore';
import { useVSCode } from '@/composables/useVSCode';
import { isShellTool } from '@shared/tool-names';

const { t } = useI18n();

const { postMessage } = useVSCode();
const teamStore = useTeamStore();
const { activePermission } = storeToRefs(teamStore);

const toolDisplay = computed(() => {
  if (!activePermission.value) return '';
  const { toolName, toolInput } = activePermission.value;
  if (isShellTool(toolName) && typeof toolInput['command'] === 'string') {
    return toolInput['command'];
  }
  return JSON.stringify(toolInput, null, 2);
});

function approve(): void {
  if (!activePermission.value) return;
  postMessage({
    type: 'teamAgentPermissionResponse',
    requestId: activePermission.value.requestId,
    behavior: 'allow',
  });
  teamStore.shiftPermissionQueue();
}

function deny(): void {
  if (!activePermission.value) return;
  postMessage({
    type: 'teamAgentPermissionResponse',
    requestId: activePermission.value.requestId,
    behavior: 'deny',
  });
  teamStore.shiftPermissionQueue();
}
</script>

<template>
  <div
    v-if="activePermission"
    class="mx-3 my-2 p-3 rounded-lg border border-warning/30 bg-warning/5 space-y-2"
  >
    <div class="flex items-center gap-2 text-xs">
      <Badge variant="secondary" class="bg-warning/20 text-warning border-warning/30">
        {{ t('team.permission.request') }}
      </Badge>
      <span class="font-medium text-foreground">{{ activePermission.agentName }}</span>
      <span class="text-foreground/40">{{ t('team.permission.wantsToRun') }}</span>
      <Badge variant="secondary" class="font-mono text-[10px] px-1.5 py-0">
        {{ activePermission.toolName }}
      </Badge>
    </div>

    <pre class="text-xs text-foreground/70 bg-foreground/5 rounded px-2 py-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono">{{ toolDisplay }}</pre>

    <div class="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs gap-1 border-success/30 text-success hover:bg-success/10"
        @click="approve"
      >
        <IconCheck :size="12" />
        {{ t('team.permission.approve') }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="h-7 text-xs gap-1 border-error/30 text-error hover:bg-error/10"
        @click="deny"
      >
        <IconBan :size="12" />
        {{ t('team.permission.deny') }}
      </Button>
    </div>
  </div>
</template>
