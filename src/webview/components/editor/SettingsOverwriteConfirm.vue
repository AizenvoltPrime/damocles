<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { AlertDialogContent, AlertDialogDescription, AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot, AlertDialogTitle } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { useOverlayEscape } from '@/composables/useOverlayEscape';

defineProps<{ path: string }>();
const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const { t } = useI18n();
const { zIndex } = useOverlayEscape(() => emit('cancel'));
</script>

<template>
  <AlertDialogRoot :open="true">
    <AlertDialogPortal>
      <AlertDialogOverlay
        class="fixed inset-0 bg-black/80 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        :style="{ zIndex }"
      />
      <!-- Escape belongs to the overlay stack, so it closes this dialog and leaves the editor under it open. -->
      <AlertDialogContent
        data-overlay-layer
        data-testid="settings-json-overwrite-confirm"
        class="fixed left-1/2 top-1/2 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 border border-border bg-card p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:rounded-lg"
        :style="{ zIndex }"
        @escape-key-down="(e: KeyboardEvent) => e.preventDefault()"
      >
        <AlertDialogTitle class="text-lg font-semibold text-foreground">
          {{ t('settingsEditor.overwriteTitle') }}
        </AlertDialogTitle>
        <AlertDialogDescription class="space-y-2 text-sm text-muted-foreground">
          <span class="block">{{ t('settingsEditor.overwriteDescription') }}</span>
          <code class="block font-mono text-xs text-foreground break-all">{{ path }}</code>
        </AlertDialogDescription>
        <div class="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            data-testid="settings-json-overwrite-cancel"
            @click="emit('cancel')"
          >
            {{ t('common.cancel') }}
          </Button>
          <Button
            variant="destructive"
            data-testid="settings-json-overwrite-confirm-button"
            @click="emit('confirm')"
          >
            {{ t('settingsEditor.overwrite') }}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
