<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { EyeOff, Pin, PinOff } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconExternalLink } from '@/components/icons';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useUIStore } from '@/stores/useUIStore';
import type { MemoryKind } from '@shared/types/memory';

const props = defineProps<{
  id: string;
  kind: MemoryKind;
  label: string;
  isPinned: boolean;
  forgotten: boolean;
}>();

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const uiStore = useUIStore();

const confirmOpen = ref(false);

function togglePin(): void {
  postMessage({ type: props.isPinned ? 'unpinMemory' : 'pinMemory', id: props.id });
}

function confirmForget(): void {
  confirmOpen.value = false;
  postMessage({ type: 'forgetMemory', id: props.id, scope: 'chain' });
}

function openInPanel(): void {
  uiStore.openMemoryPanel({ id: props.id, kind: props.kind });
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-0.5">
    <Button
      v-if="!forgotten"
      variant="ghost"
      size="icon-sm"
      class="size-6"
      :class="isPinned && 'text-warning'"
      :aria-label="t(isPinned ? 'contextInjection.action.unpinFor' : 'contextInjection.action.pinFor', { label })"
      :title="t(isPinned ? 'contextInjection.action.unpinHint' : 'contextInjection.action.pinHint')"
      :data-action="isPinned ? 'unpin' : 'pin'"
      @click="togglePin"
    >
      <PinOff v-if="isPinned" :size="12" />
      <Pin v-else :size="12" />
    </Button>

    <Popover v-if="!forgotten" v-model:open="confirmOpen">
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-6"
          :aria-label="t('contextInjection.action.forgetFor', { label })"
          :title="t('contextInjection.action.forget')"
          data-action="forget"
        >
          <EyeOff :size="12" />
        </Button>
      </PopoverTrigger>
      <PopoverContent class="w-64 space-y-3 p-3 text-xs leading-relaxed" align="end">
        <p>{{ t('contextInjection.action.forgetConfirm') }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" data-action="forget-cancel" @click="confirmOpen = false">
            {{ t('contextInjection.action.cancel') }}
          </Button>
          <Button variant="destructive" size="sm" class="h-7 px-2 text-xs" data-action="forget-confirm" @click="confirmForget">
            {{ t('contextInjection.action.forget') }}
          </Button>
        </div>
      </PopoverContent>
    </Popover>

    <Button
      variant="ghost"
      size="icon-sm"
      class="size-6"
      :aria-label="t('contextInjection.action.openInPanelFor', { label })"
      :title="t('contextInjection.action.openInPanel')"
      data-action="open-in-panel"
      @click="openInPanel"
    >
      <IconExternalLink :size="12" />
    </Button>
  </div>
</template>
