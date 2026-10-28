<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Trash2 } from 'lucide-vue-next';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';

// Forget host, which offers Remove Damocles server first while the host is reachable. Mounted while closed so its exit plays;
// Cancel is focused first, so Enter alone never forgets anything.
defineProps<{ open: boolean; hostName: string; offerRemoval: boolean }>();
const emit = defineEmits<{ choose: [choice: 'cancel' | 'removeFirst' | 'forget'] }>();
const { t } = useI18n();

const cancelButton = ref<InstanceType<typeof Button> | null>(null);

function focusCancel(event: Event): void {
  event.preventDefault();
  (cancelButton.value?.$el as HTMLElement | undefined)?.focus();
}
</script>

<template>
  <AlertDialog
    :open="open"
    @update:open="(next: boolean) => !next && emit('choose', 'cancel')"
  >
    <AlertDialogContent
      data-testid="forget-host-dialog"
      class="max-w-md gap-0 overflow-hidden border-(--d-danger)/50 p-0"
      @open-auto-focus="focusCancel"
    >
      <ConfirmDialogLayout
        :icon="Trash2"
        tone="danger"
        :title="t('remote.forget.title', { name: hostName })"
        :description="t('remote.forget.body', { name: hostName })"
      >
        <template #footer>
          <Button
            ref="cancelButton"
            type="button"
            variant="outline"
            size="sm"
            data-testid="forget-host-cancel"
            class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5"
            @click="emit('choose', 'cancel')"
          >
            {{ t('remote.forget.cancel') }}
          </Button>
          <Button
            v-if="offerRemoval"
            type="button"
            variant="outline"
            size="sm"
            data-testid="forget-host-remove-first"
            class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5"
            @click="emit('choose', 'removeFirst')"
          >
            {{ t('remote.forget.removeFirst') }}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="forget-host-confirm"
            class="h-7.5 gap-1.5 rounded-9 px-3.5 text-12.5 font-semibold [&_svg]:size-3.25"
            @click="emit('choose', 'forget')"
          >
            <Trash2 aria-hidden="true" />
            {{ t('remote.forget.confirm') }}
          </Button>
        </template>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
</template>
