<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bot, SquareTerminal, Trash2 } from 'lucide-vue-next';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import { visibleText } from '@shared/visible-text';
import type { RemovalInfo, RemoveServerOptions } from '../../../preload/overlay-channels';

// Remove Damocles server: what it stops on the host, and a box for each change Damocles made there, since an uninstaller
// undoes only what it did. Open while info is set, and mounted while closed so its exit plays. Cancel is focused first, so
// Enter alone never removes anything.
const props = defineProps<{ hostName: string; info: RemovalInfo | undefined }>();
const emit = defineEmits<{ choose: [options: RemoveServerOptions | null] }>();
const { t } = useI18n();

// The last facts asked about keep showing while the dialog plays its exit.
const shown = ref(props.info);
const removeKey = ref(props.info?.offerRemoveKey ?? false);
const disableLinger = ref(false);
watch(() => props.info, (next) => {
  if (!next) return;
  shown.value = next;
  removeKey.value = next.offerRemoveKey;
  disableLinger.value = false;
});
const keyId = useId();
const lingerId = useId();
const cancelButton = ref<InstanceType<typeof Button> | null>(null);

function confirm(): void {
  const info = shown.value;
  if (info) emit('choose', { removeKey: info.offerRemoveKey && removeKey.value, disableLinger: info.offerDisableLinger && disableLinger.value });
}

function focusCancel(event: Event): void {
  event.preventDefault();
  (cancelButton.value?.$el as HTMLElement | undefined)?.focus();
}

const CHECKBOX = 'size-3.75 shrink-0 rounded-xs border-(--d-border2) data-[state=checked]:border-(--d-accent) data-[state=checked]:bg-(--d-accent) data-[state=checked]:text-(--d-on-accent) [&_svg]:size-2.75';
</script>

<template>
  <AlertDialog
    :open="info !== undefined"
    @update:open="(open: boolean) => !open && emit('choose', null)"
  >
    <AlertDialogContent
      data-testid="remove-server-dialog"
      class="max-w-lg gap-0 overflow-hidden border-(--d-danger)/50 p-0"
      @open-auto-focus="focusCancel"
    >
      <ConfirmDialogLayout
        v-if="shown"
        :icon="Trash2"
        tone="danger"
        :title="t('remote.removeServer.title', { name: hostName })"
        :description="t('remote.removeServer.body', { name: hostName })"
      >
        <ul
          v-if="shown.runs.length > 0"
          :aria-label="t('remote.removeServer.runs', { name: hostName })"
          class="flex flex-col gap-px rounded-9 bg-(--d-hover) px-2.5 py-1.5"
        >
          <li
            v-for="run in shown.runs"
            :key="`${run.kind}:${run.id}`"
            data-testid="removal-run"
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
        <p class="text-12.5/relaxed text-(--d-muted)">
          {{ t('remote.removeServer.stays') }}
        </p>
        <div
          v-if="shown.offerRemoveKey"
          class="flex items-center gap-2"
        >
          <Checkbox
            :id="keyId"
            :checked="removeKey"
            data-testid="remove-server-key"
            :class="CHECKBOX"
            @update:checked="removeKey = $event"
          />
          <label
            :for="keyId"
            class="cursor-pointer text-12.5"
          >{{ t('remote.removeServer.removeKey') }}</label>
        </div>
        <div
          v-if="shown.offerDisableLinger"
          class="flex items-center gap-2"
        >
          <Checkbox
            :id="lingerId"
            :checked="disableLinger"
            data-testid="remove-server-linger"
            :class="CHECKBOX"
            @update:checked="disableLinger = $event"
          />
          <label
            :for="lingerId"
            class="cursor-pointer text-12.5"
          >{{ t('remote.removeServer.disableLinger') }}</label>
        </div>
        <template #footer>
          <Button
            ref="cancelButton"
            type="button"
            variant="outline"
            size="sm"
            data-testid="remove-server-cancel"
            class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5"
            @click="emit('choose', null)"
          >
            {{ t('remote.removeServer.cancel') }}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="remove-server-confirm"
            class="h-7.5 gap-1.5 rounded-9 px-3.5 text-12.5 font-semibold [&_svg]:size-3.25"
            @click="confirm"
          >
            <Trash2 aria-hidden="true" />
            {{ t('remote.removeServer.confirm') }}
          </Button>
        </template>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
</template>
