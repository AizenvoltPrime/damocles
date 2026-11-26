<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ArrowDownToLine, CloudOff } from 'lucide-vue-next';

/**
 * A remote chat shown from its session mirror while its host is not connected is read-only; this card takes the composer's
 * place. outdated: this app must update first, since the host runs a newer Damocles ('runs') or its minimum is above this
 * app ('floor').
 */
defineProps<{ hostName: string; outdated?: 'runs' | 'floor' | undefined }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="flex items-center gap-2.5 rounded-2xl border border-(--d-border2) bg-(--d-card) py-2.5 ps-3.5 pe-2.5"
    role="status"
    :data-testid="outdated ? 'composer-outdated' : 'composer-offline'"
  >
    <ArrowDownToLine
      v-if="outdated"
      aria-hidden="true"
      class="size-4 shrink-0 text-(--d-faint)"
    />
    <CloudOff
      v-else
      aria-hidden="true"
      class="size-4 shrink-0 text-(--d-faint)"
    />
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="font-medium">{{ outdated ? t(outdated === 'floor' ? 'remote.outdatedFloorTitle' : 'remote.outdatedTitle', { host: hostName }) : t('remote.offline', { host: hostName }) }}</span>
      <span class="text-11.5 text-(--d-faint-text)">{{ outdated ? t('remote.outdatedNote') : t('remote.offlineNote', { host: hostName }) }}</span>
    </div>
  </div>
</template>
