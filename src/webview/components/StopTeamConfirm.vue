<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Square } from 'lucide-vue-next';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { useOpenerFocus } from '@/composables/useOpenerFocus';
import ConfirmDialogLayout from './ConfirmDialogLayout.vue';

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  /** The members still working, which the question names. */
  workingCount: number;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const returnFocus = useOpenerFocus(() => props.open);
</script>

<template>
  <AlertDialog
    :open="open"
    @update:open="(next: boolean) => !next && emit('cancel')"
  >
    <AlertDialogContent
      class="max-w-md gap-0 overflow-hidden p-0"
      data-testid="stop-team-confirm"
      @close-auto-focus="returnFocus"
    >
      <ConfirmDialogLayout
        :icon="Square"
        tone="danger"
        :title="t('agentStop.confirmTitle')"
        :description="t('agentStop.confirmDescription', { n: workingCount }, workingCount)"
        :cancel-label="t('common.cancel')"
        :confirm-label="t('agentStop.stopTeam')"
        danger
        @cancel="emit('cancel')"
        @confirm="emit('confirm')"
      />
    </AlertDialogContent>
  </AlertDialog>
</template>
