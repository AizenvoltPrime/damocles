<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { CircleArrowUp } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';

// A daemon of another protocol still runs agents on the host, whose chats show read-only meanwhile; the shell and the chat
// page show the same strip, so both bundles carry its hostUpdate keys and the one-line min-h-8 matches ConnectionBanner's.
defineProps<{
  hostName: string;
  update: { readonly serverVersion: string; readonly runningAgents: number; readonly phase: 'offer' | 'waiting' };
}>();
const emit = defineEmits<{ switchWhenIdle: []; switchNow: [] }>();
const { t } = useI18n();
</script>

<template>
  <div
    data-testid="host-update-banner"
    :data-phase="update.phase"
    class="@container/banner flex min-h-8 shrink-0 items-center gap-2 border-b border-(--d-info)/28 bg-[color-mix(in_srgb,var(--d-info)_11%,var(--d-bg))] py-1 ps-4 pe-2.5 text-12 text-(--d-info-text)"
  >
    <CircleArrowUp
      aria-hidden="true"
      class="size-3.5 shrink-0"
    />
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span
        class="min-w-0 grow @max-[24rem]/banner:basis-full"
        role="status"
        data-testid="host-update-banner-text"
      >{{ update.phase === 'waiting'
        ? t('hostUpdate.waiting', { host: hostName })
        : t('hostUpdate.running', update.runningAgents, { named: { host: hostName, count: update.runningAgents, version: update.serverVersion } }) }}</span>
      <div class="flex flex-wrap items-center gap-x-2">
        <Button
          v-if="update.phase === 'offer'"
          type="button"
          variant="link"
          size="sm"
          class="h-auto shrink-0 px-0 text-12 font-semibold text-current"
          data-testid="host-update-when-idle"
          @click="emit('switchWhenIdle')"
        >
          {{ t('hostUpdate.switchWhenIdle') }}
        </Button>
        <Button
          type="button"
          variant="link"
          size="sm"
          class="h-auto shrink-0 px-0 text-12 font-semibold text-current"
          data-testid="host-update-now"
          @click="emit('switchNow')"
        >
          {{ t('hostUpdate.switchNow') }}
        </Button>
      </div>
    </div>
  </div>
</template>
