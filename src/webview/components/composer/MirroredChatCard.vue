<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { CloudOff } from 'lucide-vue-next';

/** A remote chat shown from its session mirror while its host is not connected is read-only; this card takes the composer's place. */
defineProps<{ hostName: string }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="flex items-center gap-2.5 rounded-2xl border border-(--d-border2) bg-(--d-card) py-2.5 ps-3.5 pe-2.5"
    role="status"
    data-testid="composer-offline"
  >
    <CloudOff
      aria-hidden="true"
      class="size-4 shrink-0 text-(--d-faint)"
    />
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="font-medium">{{ t('remote.offline', { host: hostName }) }}</span>
      <span class="text-11.5 text-(--d-faint-text)">{{ t('remote.offlineNote', { host: hostName }) }}</span>
    </div>
  </div>
</template>
