<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowUpFromLine, Bot, SquareTerminal } from 'lucide-vue-next';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import { visibleText } from '@shared/visible-text';
import type { RemovalRun } from '../../../preload/overlay-channels';

// Convert to WSL 2: the running work the conversion stops, then Cancel or Convert. Open while runs is set, and mounted while
// closed so its exit plays. Cancel is focused first, so Enter alone never stops anything.
const props = defineProps<{ hostName: string; distro: string; runs: readonly RemovalRun[] | undefined }>();
const emit = defineEmits<{ choose: [convert: boolean]; closeAutoFocus: [event: Event] }>();
const { t } = useI18n();

// The last list asked about keeps showing while the dialog plays its exit.
const shown = ref(props.runs);
watch(() => props.runs, (next) => {
  if (next) shown.value = next;
});
const cancelButton = ref<InstanceType<typeof Button> | null>(null);

function focusCancel(event: Event): void {
  event.preventDefault();
  (cancelButton.value?.$el as HTMLElement | undefined)?.focus();
}
</script>

<template>
  <AlertDialog
    :open="runs !== undefined"
    @update:open="(open: boolean) => !open && emit('choose', false)"
  >
    <AlertDialogContent
      data-testid="convert-wsl2-dialog"
      class="max-w-lg gap-0 overflow-hidden p-0"
      @open-auto-focus="focusCancel"
      @close-auto-focus="(event: Event) => emit('closeAutoFocus', event)"
    >
      <ConfirmDialogLayout
        v-if="shown"
        :icon="ArrowUpFromLine"
        tone="accent"
        :title="t('remote.wsl.dialogTitle', { distro })"
        :description="t('remote.wsl.dialogBody', { name: hostName, distro })"
      >
        <ul
          v-if="shown.length > 0"
          :aria-label="t('remote.wsl.runs', { name: hostName })"
          class="flex flex-col gap-px rounded-9 bg-(--d-hover) px-2.5 py-1.5"
        >
          <li
            v-for="run in shown"
            :key="`${run.kind}:${run.id}`"
            data-testid="convert-wsl2-run"
            :data-kind="run.kind"
            class="flex h-7 items-center gap-2 text-12.5"
          >
            <component
              :is="run.kind === 'chat' ? Bot : SquareTerminal"
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-muted)"
            />
            <span class="min-w-0 flex-1 truncate">{{ visibleText(run.title) }}</span>
            <span class="text-11 text-(--d-faint-text)">{{ t(`remote.removeServer.kind.${run.kind}`) }}</span>
          </li>
        </ul>
        <p
          v-else
          class="text-12.5 text-(--d-muted)"
        >
          {{ t('remote.wsl.nothingRuns', { name: hostName }) }}
        </p>
        <p class="text-12.5/relaxed text-(--d-muted)">
          {{ t('remote.wsl.gain') }}
        </p>
        <template #footer>
          <Button
            ref="cancelButton"
            type="button"
            variant="outline"
            size="sm"
            data-testid="convert-wsl2-cancel"
            class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5"
            @click="emit('choose', false)"
          >
            {{ t('remote.wsl.cancel') }}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="convert-wsl2-confirm"
            class="h-7.5 gap-1.5 rounded-9 px-3.5 text-12.5 font-semibold [&_svg]:size-3.25"
            @click="emit('choose', true)"
          >
            <ArrowUpFromLine aria-hidden="true" />
            {{ t('remote.wsl.confirm') }}
          </Button>
        </template>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
</template>
