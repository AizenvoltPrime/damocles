<script setup lang="ts">
import { computed } from 'vue';
import { I18nT, useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Ban, Check, Users } from 'lucide-vue-next';
import { useTeamStore } from '@/stores/useTeamStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useFolderRelativePath } from '@/composables/useFolderRelativePath';
import { isShellTool, TOOL_EDIT, TOOL_WRITE } from '@shared/tool-names';

const { t } = useI18n();
const displayPath = useFolderRelativePath();

const { postMessage } = usePlatformBridge();
const teamStore = useTeamStore();
const { activePermission } = storeToRefs(teamStore);

const filePath = computed(() => {
  const request = activePermission.value;
  if (!request || (request.toolName !== TOOL_EDIT && request.toolName !== TOOL_WRITE)) return undefined;
  const path = request.toolInput['file_path'];
  return typeof path === 'string' ? path : undefined;
});

// A file tool names its file in the subtitle rather than the input, relative to the chat's folder with the full path in the tooltip.
const subtitle = computed(() => [activePermission.value?.toolName, filePath.value && displayPath(filePath.value)].filter(Boolean).join(' · '));
const subtitleTitle = computed(() => [activePermission.value?.toolName, filePath.value].filter(Boolean).join(' · '));

const toolDisplay = computed(() => {
  if (!activePermission.value) return '';
  const { toolName, toolInput } = activePermission.value;
  if (isShellTool(toolName) && typeof toolInput['command'] === 'string') {
    return toolInput['command'];
  }
  if (filePath.value === undefined) return JSON.stringify(toolInput, null, 2);
  const { file_path: _named, ...rest } = toolInput;
  return JSON.stringify(rest, null, 2);
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
  <Transition name="t-up">
    <section
      v-if="activePermission"
      class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-warning)_45%,transparent)] bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
      role="region"
      :aria-label="t('team.permission.request')"
      data-dock-prompt
      data-testid="team-permission-card"
    >
      <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] to-transparent px-3 py-2">
        <span
          class="d-ring flex size-6.5 flex-none items-center justify-center rounded-8 bg-[color-mix(in_srgb,var(--d-warning)_16%,transparent)] text-(--d-warning)"
          aria-hidden="true"
        >
          <Users class="size-3.5" />
        </span>
        <div class="min-w-0 flex-1">
          <I18nT
            keypath="team.permission.wantsToRun"
            tag="div"
            class="truncate text-(--d-muted)"
            data-testid="team-permission-title"
          >
            <template #agent>
              <span class="font-semibold text-(--d-text)">{{ activePermission.agentName }}</span>
            </template>
          </I18nT>
          <div
            class="truncate font-mono text-xs text-(--d-muted)"
            :title="subtitleTitle"
            data-testid="team-permission-subtitle"
          >
            {{ subtitle }}
          </div>
        </div>
      </header>

      <pre
        class="mx-3 mt-2.5 max-h-24 overflow-y-auto rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap text-(--d-muted) focus-visible:outline-2 focus-visible:outline-(--d-accent)"
        role="region"
        tabindex="0"
        :aria-label="t('team.permission.input', { tool: activePermission.toolName })"
        data-testid="team-permission-input"
      >{{ toolDisplay }}</pre>

      <div class="flex items-center gap-2 px-3 pt-2.5 pb-3">
        <button
          type="button"
          class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent) px-3 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
          @click="approve"
        >
          <Check
            class="size-3.25"
            aria-hidden="true"
          />{{ t('team.permission.approve') }}
        </button>
        <button
          type="button"
          class="d-press flex h-7.5 items-center gap-1.5 rounded-9 border border-(--d-border2) px-3 text-12.5 font-medium transition-colors hover:bg-(--d-hover)"
          @click="deny"
        >
          <Ban
            class="size-3.25"
            aria-hidden="true"
          />{{ t('team.permission.deny') }}
        </button>
      </div>
    </section>
  </Transition>
</template>
