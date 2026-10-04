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
        :title="t('compactMarker.rewindBeforeConfirm.title')"
        :description="t('compactMarker.rewindBeforeConfirm.description')"
        :cancel-label="t('compactMarker.rewindBeforeConfirm.cancel')"
        :confirm-label="t('compactMarker.rewindBeforeConfirm.confirm')"
        @cancel="emit('cancel')"
        @confirm="emit('confirm')"
      />
    </AlertDialogContent>
  </AlertDialog>
</template>
