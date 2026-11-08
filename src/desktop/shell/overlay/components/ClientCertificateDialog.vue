<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, KeyRound } from 'lucide-vue-next';
import type { ClientCertificateRow, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';

// The certificates a site accepts, as Chrome would offer them; the one chosen is what the browser sends the site until the app
// quits. Arrow keys move, Enter or Use Certificate chooses, Escape, the scrim and Cancel answer dismissed. A row Chrome could
// not tell from another one cannot be chosen.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'clientCertificate' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t, locale } = useI18n();

const CANCEL = 0;
const USE = 1;
const active = ref(Math.max(0, props.request.certificates.findIndex((row) => row.distinct)));
const activeRow = computed(() => props.request.certificates[active.value]);
const buttons = computed((): DialogButton[] => [
  { label: t('clientCertificate.cancel'), variant: 'plain', testId: 'client-certificate-cancel' },
  { label: t('clientCertificate.use'), variant: 'fill', testId: 'client-certificate-use', disabled: activeRow.value?.distinct !== true },
]);

const listId = useId();
const optionId = (index: number): string => `${listId}-${index}`;
const dates = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }));
// read once: the dialog is short-lived, and a row must not change its state under the pointer
const nowSeconds = Date.now() / 1000;

function validity(row: ClientCertificateRow): string {
  return t('clientCertificate.validity', { start: dates.value.format(row.validStart * 1000), end: dates.value.format(row.validExpiry * 1000) });
}

function standing(row: ClientCertificateRow): string | undefined {
  if (row.validExpiry < nowSeconds) return t('clientCertificate.expired');
  if (row.validStart > nowSeconds) return t('clientCertificate.notYetValid');
  return undefined;
}

function choose(index: number): void {
  const row = props.request.certificates[index];
  if (row?.distinct) emit('answer', { kind: 'clientCertificate', id: row.id });
}

function onChoose(button: number): void {
  if (button === USE) choose(active.value);
  else emit('answer', { kind: 'dismissed' });
}

function moveTo(index: number): void {
  const last = props.request.certificates.length - 1;
  active.value = Math.min(Math.max(index, 0), last);
  void nextTick(() => document.getElementById(optionId(active.value))?.scrollIntoView({ block: 'nearest' }));
}

function onKeydown(event: KeyboardEvent): void {
  const moves: Readonly<Record<string, () => number>> = {
    ArrowDown: () => active.value + 1,
    ArrowUp: () => active.value - 1,
    Home: () => 0,
    End: () => props.request.certificates.length - 1,
  };
  const move = moves[event.key];
  if (move) {
    event.preventDefault();
    moveTo(move());
  } else if (event.key === 'Enter') {
    event.preventDefault();
    choose(active.value);
  }
}
</script>

<template>
  <!-- initial-focus marks Use Certificate, but the list, earlier in the dialog, carries its own mark and takes focus first. -->
  <OverlayDialog
    severity="accent"
    :icon="KeyRound"
    :title="t('clientCertificate.title', { site: request.site })"
    :message="t('clientCertificate.body', { site: request.site })"
    :buttons="buttons"
    :initial-focus="USE"
    :cancel-index="CANCEL"
    wide
    test-id="client-certificate"
    @choose="onChoose"
  >
    <!-- Custom markup: src/webview/components/ui has no single-select listbox; its command part is a filtered combobox. -->
    <ul
      :id="listId"
      role="listbox"
      tabindex="0"
      data-overlay-initial-focus
      data-testid="client-certificate-list"
      :aria-label="t('clientCertificate.listLabel', { site: request.site })"
      :aria-activedescendant="optionId(active)"
      class="flex max-h-72 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-9 border border-(--d-border) p-1 outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent)"
      @keydown="onKeydown"
    >
      <li
        v-for="(row, index) in request.certificates"
        :id="optionId(index)"
        :key="row.id"
        role="option"
        data-testid="client-certificate-option"
        :aria-selected="index === active"
        :aria-disabled="row.distinct ? undefined : 'true'"
        class="flex items-start gap-2 rounded-7 px-2 py-1.5 transition-colors duration-150 ease-out"
        :class="[index === active ? 'bg-(--d-accent-soft)' : 'hover:bg-(--d-hover)', row.distinct ? 'cursor-pointer' : 'cursor-not-allowed opacity-60']"
        @mousedown.prevent
        @click="moveTo(index)"
        @dblclick="choose(index)"
      >
        <span class="flex size-4 shrink-0 items-center justify-center pt-0.5">
          <!-- v-show: the alert dialog's focus scope moves focus to the panel on a child list change; its animation replays as it shows -->
          <Check
            v-show="index === active"
            aria-hidden="true"
            class="client-certificate-check size-3.5 text-(--d-accent-text)"
          />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            class="truncate text-12.5 font-medium text-(--d-text)"
            data-testid="client-certificate-subject"
          >{{ row.subject || t('clientCertificate.noName') }}</span>
          <span
            class="truncate text-11.5 text-(--d-muted)"
            data-testid="client-certificate-issuer"
          >{{ t('clientCertificate.issuedBy', { issuer: row.issuer || t('clientCertificate.noName') }) }}</span>
          <span
            class="flex flex-wrap items-center gap-1.5 text-11.5 text-(--d-faint-text)"
            data-testid="client-certificate-validity"
          >
            {{ validity(row) }}
            <span
              v-if="standing(row)"
              class="rounded-5 bg-(--d-warning)/12 px-1.5 text-(--d-warning-text)"
            >{{ standing(row) }}</span>
          </span>
          <span
            v-if="!row.distinct"
            class="text-11.5 text-(--d-warning-text)"
            data-testid="client-certificate-indistinct"
          >{{ t('clientCertificate.indistinct') }}</span>
        </span>
      </li>
    </ul>
  </OverlayDialog>
</template>
