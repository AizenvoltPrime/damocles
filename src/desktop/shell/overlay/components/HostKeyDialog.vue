<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Copy, ShieldAlert, ShieldQuestion } from 'lucide-vue-next';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import { visibleText } from '@shared/visible-text';

// ssh's host key questions. unknown: ssh waits for the answer to its own confirm prompt, and accepting lets ssh itself record
// the key. changed: ssh refused the connection; Damocles writes nothing and offers no retry, only the command that removes the
// old key. Both stay mounted while closed, so their exit plays after the answer.
const props = defineProps<{
  unknown?: { readonly host: string; readonly keyType: string; readonly fingerprint: string } | undefined;
  // host: the known_hosts name; command: the removal command main quoted for this computer's shell and copies verbatim,
  // absent when main names no host
  changed?: { readonly host?: string | undefined; readonly command?: string | undefined } | undefined;
  hostName: string;
  // false: the dialog is closing
  copyCommand: () => Promise<boolean>;
}>();
const emit = defineEmits<{ answer: [answer: 'connect' | 'cancel']; close: [] }>();
const { t } = useI18n();

// The last question asked keeps showing while its dialog plays its exit.
const shownUnknown = ref(props.unknown);
const shownChanged = ref(props.changed);
watch(() => props.unknown, (next) => next && (shownUnknown.value = next));
watch(() => props.changed, (next) => next && (shownChanged.value = next));
const command = computed(() => shownChanged.value?.command);
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
const closeButton = ref<InstanceType<typeof Button> | null>(null);

async function copy(): Promise<void> {
  try {
    if (await props.copyCommand()) copyState.value = 'copied';
  } catch {
    copyState.value = 'failed';
  }
}

// A danger dialog focuses its safe action first, so Enter alone never acts on the risky one.
function focusClose(event: Event): void {
  event.preventDefault();
  (closeButton.value?.$el as HTMLElement | undefined)?.focus();
}
</script>

<template>
  <AlertDialog
    :open="unknown !== undefined"
    @update:open="(open: boolean) => !open && emit('answer', 'cancel')"
  >
    <AlertDialogContent
      data-testid="host-key-unknown"
      class="max-w-md gap-0 overflow-hidden p-0"
    >
      <ConfirmDialogLayout
        v-if="shownUnknown"
        :icon="ShieldQuestion"
        tone="warning"
        :title="t('remote.hostKey.unknownTitle', { name: hostName })"
        :description="t('remote.hostKey.unknownBody', { host: visibleText(shownUnknown.host), keyType: visibleText(shownUnknown.keyType) })"
        :cancel-label="t('remote.hostKey.cancel')"
        :confirm-label="t('remote.hostKey.connect')"
        @cancel="emit('answer', 'cancel')"
        @confirm="emit('answer', 'connect')"
      >
        <code
          data-testid="host-key-fingerprint"
          dir="ltr"
          class="block rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-11.5 break-all text-(--d-text) select-all"
        >{{ visibleText(shownUnknown.keyType) }} {{ visibleText(shownUnknown.fingerprint) }}</code>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
  <AlertDialog
    :open="changed !== undefined"
    @update:open="(open: boolean) => !open && emit('close')"
  >
    <AlertDialogContent
      data-testid="host-key-changed"
      class="max-w-lg gap-0 overflow-hidden border-(--d-danger)/50 p-0"
      @open-auto-focus="focusClose"
    >
      <ConfirmDialogLayout
        v-if="shownChanged"
        :icon="ShieldAlert"
        tone="danger"
        :title="t('remote.hostKey.changedTitle', { name: hostName })"
        :description="t('remote.hostKey.changedBody', { host: visibleText(shownChanged.host ?? hostName) })"
      >
        <p class="text-12.5 text-(--d-muted)">
          {{ command === undefined ? t('remote.hostKey.changedFixNoHost') : t('remote.hostKey.changedFix') }}
        </p>
        <span
          v-if="command !== undefined"
          class="flex items-center gap-2"
        >
          <code
            data-testid="host-key-command"
            dir="ltr"
            class="min-w-0 flex-1 rounded-8 border border-(--d-border) bg-(--d-code) px-2.5 py-2 font-mono text-11.5 break-all text-(--d-text) select-all"
          >{{ visibleText(command) }}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="h-7.5 shrink-0 rounded-8 border-(--d-border2) bg-(--d-card) px-2.5 text-12"
            @click="copy"
          >
            <Copy aria-hidden="true" />
            {{ t('remote.hostKey.copy') }}
          </Button>
        </span>
        <p
          v-if="command !== undefined"
          role="status"
          class="min-h-lh text-11.5"
          :class="copyState === 'failed' ? 'text-(--d-danger-text)' : 'text-(--d-success-text)'"
        >
          {{ copyState === 'idle' ? '' : t(`remote.hostKey.${copyState}`) }}
        </p>
        <template #footer>
          <Button
            ref="closeButton"
            type="button"
            variant="outline"
            size="sm"
            class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5"
            @click="emit('close')"
          >
            {{ t('remote.hostKey.close') }}
          </Button>
        </template>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
</template>
