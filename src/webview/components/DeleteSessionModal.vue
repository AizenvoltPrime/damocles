<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { IconWarning } from '@/components/icons';

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
  <AlertDialog :open="visible" @update:open="(open: boolean) => !open && handleCancel()">
    <AlertDialogContent class="bg-card border-border max-w-md max-h-[85vh] overflow-y-auto">
      <AlertDialogHeader>
        <AlertDialogTitle class="flex items-center gap-2">
          <IconWarning :size="20" class="text-error" />
          {{ t('deleteSession.title') }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          <p class="text-foreground">
            {{ t('deleteSession.warning') }}
          </p>
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div v-if="sessionName" class="p-3 rounded bg-muted text-sm">
        <div class="text-xs text-muted-foreground mb-1">{{ t('deleteSession.sessionLabel') }}</div>
        <div class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
          {{ sessionName }}
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-4">
        <Button variant="ghost" @click="handleCancel">
          {{ t('common.cancel') }}
        </Button>
        <Button
          class="bg-destructive hover:bg-destructive/80 text-destructive-foreground"
          @click="handleConfirm"
        >
          {{ t('common.delete') }}
        </Button>
      </div>
    </AlertDialogContent>
  </AlertDialog>
</template>
