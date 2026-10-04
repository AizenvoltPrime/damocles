<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { AlertDialogContent, AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot } from 'reka-ui';
import { TriangleAlert } from 'lucide-vue-next';
import ConfirmDialogLayout from '../ConfirmDialogLayout.vue';
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
        class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-xs"
        :style="{ zIndex }"
      />
      <!-- Escape belongs to the overlay stack, so it closes this dialog and leaves the editor under it open. -->
      <AlertDialogContent
        data-overlay-layer
        data-testid="settings-json-overwrite-confirm"
        class="d-dialog fixed top-1/2 left-1/2 grid w-[calc(100%-2rem)] max-w-md -translate-1/2 overflow-hidden rounded-2xl border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
        :style="{ zIndex }"
        @escape-key-down="(e: KeyboardEvent) => e.preventDefault()"
      >
        <ConfirmDialogLayout
          :icon="TriangleAlert"
          tone="warning"
          :title="t('settingsEditor.overwriteTitle')"
        >
          <template #description>
            {{ t('settingsEditor.overwriteDescription') }}
          </template>
          <span
            class="block rounded-10 border border-(--d-border) bg-(--d-bg) px-3 py-2 font-mono text-xs break-all"
            data-testid="settings-json-overwrite-path"
          >{{ path }}</span>
          <template #footer>
            <button
              type="button"
              class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
              data-testid="settings-json-overwrite-cancel"
              @click="emit('cancel')"
            >
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="d-press flex h-7.5 items-center rounded-9 bg-(--d-danger) px-3.5 text-12.5 font-semibold text-(--d-on-danger) transition-[filter] hover:brightness-110"
              data-testid="settings-json-overwrite-confirm-button"
              @click="emit('confirm')"
            >
              {{ t('settingsEditor.overwrite') }}
            </button>
          </template>
        </ConfirmDialogLayout>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
