<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

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
  <AlertDialog :open="open" @update:open="handleOpenUpdate">
    <AlertDialogContent class="bg-card border-border max-w-md">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('compactMarker.rewindBeforeConfirm.title') }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ t('compactMarker.rewindBeforeConfirm.description') }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="outline" @click="emit('cancel')">
          {{ t('compactMarker.rewindBeforeConfirm.cancel') }}
        </Button>
        <Button @click="emit('confirm')">
          {{ t('compactMarker.rewindBeforeConfirm.confirm') }}
        </Button>
      </div>
    </AlertDialogContent>
  </AlertDialog>
</template>
