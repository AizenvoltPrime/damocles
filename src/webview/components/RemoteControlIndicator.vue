<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRemoteControlStore } from '@/stores/useRemoteControlStore';
import { useVSCode } from '@/composables/useVSCode';
import { useCopyToClipboard } from '@/composables/useCopyToClipboard';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { IconGlobe, IconCopy, IconCheck } from '@/components/icons';

const { t } = useI18n();
const store = useRemoteControlStore();
const { postMessage } = useVSCode();

const connectUrlCopy = useCopyToClipboard();
const sessionUrlCopy = useCopyToClipboard();
const envIdCopy = useCopyToClipboard();

const iconColor = computed(() => {
  switch (store.connectionState) {
    case 'connected': return 'text-success';
    case 'connecting': return 'text-primary';
    case 'error': return 'text-destructive';
    default: return 'text-muted-foreground';
  }
});

const isConnecting = computed(() => store.connectionState === 'connecting');

function handleToggle(enabled: boolean): void {
  if (enabled) {
    postMessage({ type: 'remoteControlEnable' });
  } else {
    postMessage({ type: 'remoteControlDisable' });
  }
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="icon-sm"
        class="relative"
        :class="iconColor"
        :title="t('remoteControl.title')"
      >
        <span
          v-if="isConnecting"
          class="absolute inset-0 m-auto h-6 w-6 rounded-full border-2 border-transparent border-t-primary animate-spin"
        />
        <IconGlobe :size="16" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-72 p-3" align="end">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium">{{ t('remoteControl.title') }}</span>
        <Switch
          :checked="store.enabled"
          @update:checked="handleToggle"
        />
      </div>

      <Separator class="my-2" />

      <div class="text-xs text-muted-foreground">
        <template v-if="store.connectionState === 'disconnected'">
          {{ t('remoteControl.statusDisconnected') }}
        </template>
        <template v-else-if="store.connectionState === 'connecting'">
          <span class="flex items-center gap-1.5">
            <span class="h-3 w-3 rounded-full border-2 border-transparent border-t-primary animate-spin" />
            {{ t('remoteControl.statusConnecting') }}
          </span>
        </template>
        <template v-else-if="store.connectionState === 'connected'">
          <span class="flex items-center gap-1.5 text-success">
            <span class="h-2 w-2 rounded-full bg-current" />
            {{ t('remoteControl.statusConnected') }}
          </span>
        </template>
        <template v-else-if="store.connectionState === 'error'">
          <span class="text-destructive">{{ store.error }}</span>
        </template>
      </div>

      <template v-if="store.connectionState === 'connected'">
        <div v-if="store.connectUrl" class="mt-3 space-y-1">
          <div class="text-xs text-muted-foreground">{{ t('remoteControl.connectUrl') }}</div>
          <div class="flex items-center gap-1">
            <code class="flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">{{ store.connectUrl }}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              class="h-6 w-6 shrink-0"
              :title="t('remoteControl.copy')"
              @click="connectUrlCopy.copyToClipboard(store.connectUrl!)"
            >
              <component :is="connectUrlCopy.hasCopied.value ? IconCheck : IconCopy" :size="12" />
            </Button>
          </div>
        </div>

        <div v-if="store.sessionUrl" class="mt-2 space-y-1">
          <div class="text-xs text-muted-foreground">{{ t('remoteControl.sessionUrl') }}</div>
          <div class="flex items-center gap-1">
            <code class="flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">{{ store.sessionUrl }}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              class="h-6 w-6 shrink-0"
              :title="t('remoteControl.copy')"
              @click="sessionUrlCopy.copyToClipboard(store.sessionUrl!)"
            >
              <component :is="sessionUrlCopy.hasCopied.value ? IconCheck : IconCopy" :size="12" />
            </Button>
          </div>
        </div>

        <div v-if="store.environmentId" class="mt-2 space-y-1">
          <div class="text-xs text-muted-foreground">{{ t('remoteControl.environmentId') }}</div>
          <div class="flex items-center gap-1">
            <code class="flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">{{ store.environmentId }}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              class="h-6 w-6 shrink-0"
              :title="t('remoteControl.copy')"
              @click="envIdCopy.copyToClipboard(store.environmentId!)"
            >
              <component :is="envIdCopy.hasCopied.value ? IconCheck : IconCopy" :size="12" />
            </Button>
          </div>
        </div>
      </template>
    </PopoverContent>
  </Popover>
</template>
