<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import {
  AlertDialog,
  AlertDialogContent,
} from '@/components/ui/alert-dialog';
import { Trash2 } from 'lucide-vue-next';
import ConfirmDialogLayout from './ConfirmDialogLayout.vue';

const { t } = useI18n();

defineProps<{
  visible: boolean;
  sessionName?: string;
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

function handleConfirm() {
  emit('confirm');
}

function handleCancel() {
  emit('cancel');
}
</script>

<template>
  <AlertDialog
    :open="visible"
    @update:open="(open: boolean) => !open && handleCancel()"
  >
    <AlertDialogContent class="max-h-[85vh] max-w-md gap-0 overflow-hidden p-0">
      <ConfirmDialogLayout
        :icon="Trash2"
        tone="danger"
        :title="t('deleteSession.title')"
        :description="t('deleteSession.warning')"
        :cancel-label="t('common.cancel')"
        :confirm-label="t('common.delete')"
        danger
        @cancel="handleCancel"
        @confirm="handleConfirm"
      >
        <div
          v-if="sessionName"
          class="rounded-10 border border-(--d-border) bg-(--d-bg) px-3 py-2"
        >
          <div class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint) uppercase">
            {{ t('deleteSession.sessionLabel') }}
          </div>
          <div class="max-h-40 overflow-y-auto text-12.5 wrap-break-word whitespace-pre-wrap">
            {{ sessionName }}
          </div>
        </div>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
</template>
