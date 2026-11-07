<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import {
  AlertDialog,
  AlertDialogContent,
} from '@/components/ui/alert-dialog';
import { History } from 'lucide-vue-next';
import ConfirmDialogLayout from './ConfirmDialogLayout.vue';

const { t } = useI18n();

defineProps<{
  open: boolean;
  /** In a design chat the fork is a separate, unlinked design (PD-36), started from a copy of the current files. */
  design?: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

function handleOpenUpdate(next: boolean): void {
  if (!next) emit('cancel');
}
</script>

<template>
  <AlertDialog
    :open="open"
    @update:open="handleOpenUpdate"
  >
    <AlertDialogContent class="max-w-md gap-0 overflow-hidden p-0">
      <ConfirmDialogLayout
        :icon="History"
        :title="design ? t('compactMarker.rewindBeforeConfirm.design.title') : t('compactMarker.rewindBeforeConfirm.title')"
        :description="design ? t('compactMarker.rewindBeforeConfirm.design.description') : t('compactMarker.rewindBeforeConfirm.description')"
        :cancel-label="t('compactMarker.rewindBeforeConfirm.cancel')"
        :confirm-label="design ? t('compactMarker.rewindBeforeConfirm.design.confirm') : t('compactMarker.rewindBeforeConfirm.confirm')"
        @cancel="emit('cancel')"
        @confirm="emit('confirm')"
      />
    </AlertDialogContent>
  </AlertDialog>
</template>
