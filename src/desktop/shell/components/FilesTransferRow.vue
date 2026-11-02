<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleAlert, Copy, Download, FolderInput } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, FilesTransferProgress } from '../../preload/shell-channels';
import { fileSize } from '../editor/file-size';

// The progress row under the Files title: the shown project's running transfer, with Cancel. A transfer that ends within
// SHOW_DELAY_MS never shows one; main's summary notice reports every transfer either way.
const props = defineProps<{ api: DamoclesShellApi; projectKey: string | undefined }>();
// the row's Cancel held focus as it went away; Files puts focus back in the tree
const emit = defineEmits<{ releaseFocus: [] }>();
const { t, locale } = useI18n();
const labelId = useId();

const SHOW_DELAY_MS = 150;
// ms a finished row holds its check, or a failed one its danger tint, before it leaves
const DONE_MS = 900;
const FAILED_MS = 1400;

type Op = FilesTransferProgress['op'];
interface Row {
  readonly transferId: number;
  readonly op: Op;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
  // preparing: main is still walking the sources and asking about clashes, so the totals grow and the bar sweeps
  readonly phase: 'preparing' | 'running' | 'done' | 'failed';
  readonly cancelling: boolean;
}

const ICONS: Readonly<Record<Op, Component>> = { copy: Copy, move: FolderInput, download: Download };

// Every unfinished transfer of this window by id, whichever project it belongs to, so a project shown again shows its row.
const active = new Map<number, FilesTransferProgress>();
const row = ref<Row | null>(null);
// One polite region for start and finish only; it exists before any text reaches it.
const status = ref('');
let waiting: { readonly transferId: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;

const phaseOf = (progress: FilesTransferProgress): Row['phase'] => (progress.state === 'preparing' ? 'preparing' : 'running');
const started = (progress: FilesTransferProgress): string => (progress.state === 'preparing'
  ? t(`files.transfer.preparingStarted.${progress.op}`)
  : t(`files.transfer.started.${progress.op}`, progress.filesTotal, { named: { count: progress.filesTotal } }));

const rowOf = (progress: FilesTransferProgress, phase: Row['phase'] = phaseOf(progress), cancelling = false): Row => ({
  transferId: progress.transferId,
  op: progress.op,
  filesDone: progress.filesDone,
  filesTotal: progress.filesTotal,
  bytesDone: progress.bytesDone,
  bytesTotal: progress.bytesTotal,
  phase,
  cancelling,
});

function stopWaiting(): void {
  if (waiting) clearTimeout(waiting.timer);
  waiting = undefined;
}

// The oldest unfinished transfer of the shown project waits out SHOW_DELAY_MS, unless a row already shows.
function next(): void {
  if (row.value || waiting || props.projectKey === undefined) return;
  const candidate = [...active.values()].filter((progress) => progress.projectKey === props.projectKey).sort((a, b) => a.transferId - b.transferId)[0];
  if (!candidate) return;
  const transferId = candidate.transferId;
  waiting = {
    transferId,
    timer: setTimeout(() => {
      waiting = undefined;
      const progress = active.get(transferId);
      if (!progress) return next();
      row.value = rowOf(progress);
      status.value = started(progress);
    }, SHOW_DELAY_MS),
  };
}

function leave(after: number): void {
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    leaveTimer = undefined;
    row.value = null;
    next();
  }, after);
}

function finish(progress: FilesTransferProgress): void {
  const shown = row.value;
  if (!shown) return;
  const named = { count: progress.filesDone };
  if (progress.state === 'cancelled') {
    status.value = t(`files.transfer.cancelled.${progress.op}`);
    row.value = null;
    next();
    return;
  }
  const failed = progress.state === 'failed';
  status.value = failed ? t(`files.transfer.failed.${progress.op}`) : t(`files.transfer.done.${progress.op}`, progress.filesDone, { named });
  row.value = rowOf(progress, failed ? 'failed' : 'done');
  leave(failed ? FAILED_MS : DONE_MS);
}

const stopProgress = props.api.onFilesTransferProgress((progress) => {
  const ended = progress.state === 'done' || progress.state === 'failed' || progress.state === 'cancelled';
  if (ended) active.delete(progress.transferId);
  else active.set(progress.transferId, progress);
  const shown = row.value;
  if (shown?.transferId === progress.transferId) {
    if (ended) finish(progress);
    else if (shown.phase === 'preparing' || shown.phase === 'running') {
      row.value = rowOf(progress, phaseOf(progress), shown.cancelling);
      // planning ended: the totals are known now, so the start is told again with them
      if (shown.phase === 'preparing' && row.value.phase === 'running' && !shown.cancelling) status.value = started(progress);
    }
    return;
  }
  if (ended && waiting?.transferId === progress.transferId) stopWaiting();
  next();
});

// Another project's row leaves with its project; that project's transfer shows again when it does.
watch(() => props.projectKey, () => {
  stopWaiting();
  clearTimeout(leaveTimer);
  leaveTimer = undefined;
  row.value = null;
  next();
});

onBeforeUnmount(() => {
  stopProgress();
  stopWaiting();
  clearTimeout(leaveTimer);
});

const fraction = computed(() => {
  const shown = row.value;
  if (!shown) return 0;
  if (shown.phase === 'done') return 1;
  if (shown.bytesTotal > 0) return Math.min(1, shown.bytesDone / shown.bytesTotal);
  return shown.filesTotal > 0 ? Math.min(1, shown.filesDone / shown.filesTotal) : 0;
});

const counts = (shown: Row) => ({
  done: shown.filesDone,
  total: shown.filesTotal,
  bytesDone: fileSize(shown.bytesDone, locale.value),
  bytesTotal: fileSize(shown.bytesTotal, locale.value),
});

const label = computed(() => {
  const shown = row.value;
  if (!shown) return '';
  if (shown.phase === 'done') return t(`files.transfer.done.${shown.op}`, shown.filesDone, { named: { count: shown.filesDone } });
  if (shown.phase === 'failed') return t(`files.transfer.failed.${shown.op}`);
  if (shown.phase === 'preparing') return t('files.transfer.preparing', shown.filesTotal, { named: { count: shown.filesTotal } });
  return t(`files.transfer.running.${shown.op}`, counts(shown));
});
// The bytes under the bar, kept through the check so the row never changes height; empty files and folders count no bytes.
const bytes = computed(() => {
  const shown = row.value;
  if (!shown || shown.bytesTotal === 0) return '';
  return shown.phase === 'preparing' ? t('files.transfer.preparingBytes', { bytes: fileSize(shown.bytesTotal, locale.value) }) : t('files.transfer.bytes', counts(shown));
});
const valueText = computed(() => (row.value ? t(row.value.bytesTotal > 0 ? 'files.transfer.valueText' : 'files.transfer.valueTextFiles', counts(row.value)) : ''));

function cancel(): void {
  const shown = row.value;
  if (!shown || (shown.phase !== 'preparing' && shown.phase !== 'running') || shown.cancelling) return;
  row.value = { ...shown, cancelling: true };
  void props.api.cancelFilesTransfer(shown.transferId);
}

// A Cancel that goes away with focus on it would drop focus to the page.
function releaseFocus(element: Element): void {
  if (element.contains(document.activeElement)) emit('releaseFocus');
}
</script>

<template>
  <div class="shrink-0">
    <p
      role="status"
      aria-live="polite"
      data-testid="files-transfer-status"
      class="sr-only"
    >
      {{ status }}
    </p>
    <Transition
      name="t-banner"
      @before-leave="releaseFocus"
    >
      <div
        v-if="row"
        :key="row.transferId"
        class="px-1.5 pt-0.5 pb-1.5"
      >
        <div
          data-testid="files-transfer"
          :data-op="row.op"
          :data-phase="row.phase"
          class="relative overflow-hidden rounded-7 border border-(--d-border2) bg-(--d-card) pt-1 pr-0.75 pb-1.75 pl-2"
        >
          <Transition name="t-fade">
            <span
              v-if="row.phase === 'failed'"
              aria-hidden="true"
              class="absolute inset-0 bg-(--d-danger)/12"
            />
          </Transition>
          <div class="relative flex h-5.5 items-center gap-1.5">
            <span class="relative inline-flex size-3.25 shrink-0">
              <Transition name="t-icon">
                <Check
                  v-if="row.phase === 'done'"
                  key="done"
                  aria-hidden="true"
                  data-testid="files-transfer-check"
                  class="size-3.25 text-(--d-success-text)"
                />
                <CircleAlert
                  v-else-if="row.phase === 'failed'"
                  key="failed"
                  aria-hidden="true"
                  class="size-3.25 text-(--d-danger-text)"
                />
                <component
                  :is="ICONS[row.op]"
                  v-else
                  key="running"
                  aria-hidden="true"
                  class="size-3.25 text-(--d-accent-text)"
                />
              </Transition>
            </span>
            <span
              :id="labelId"
              data-testid="files-transfer-label"
              class="min-w-0 flex-1 truncate text-11.5 text-(--d-text) tabular-nums"
            >{{ label }}</span>
            <!-- aria-disabled, not disabled, while the cancel is under way: disabling the focused button would drop focus. -->
            <Transition
              name="t-fade"
              @before-leave="releaseFocus"
            >
              <Button
                v-if="row.phase === 'preparing' || row.phase === 'running'"
                type="button"
                variant="ghost"
                size="sm"
                data-testid="files-transfer-cancel"
                class="d-press h-5.5 shrink-0 rounded-5 px-2 text-11.5 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 aria-disabled:cursor-default aria-disabled:opacity-50"
                :aria-describedby="labelId"
                :aria-disabled="row.cancelling || undefined"
                @click="cancel"
              >
                {{ t('files.transfer.cancel') }}
              </Button>
            </Transition>
          </div>
          <!-- While preparing the bar is indeterminate: no value, and a band sweeps it. -->
          <div
            role="progressbar"
            data-testid="files-transfer-bar"
            :aria-labelledby="labelId"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="row.phase === 'preparing' ? undefined : Math.round(fraction * 100)"
            :aria-valuetext="row.phase === 'preparing' ? undefined : valueText"
            class="relative mt-1 mr-1.25 h-1 overflow-hidden rounded-full bg-(--d-border)"
            :class="row.phase === 'preparing' ? 'd-sweep-bar text-(--d-accent)' : ''"
          >
            <span
              v-if="row.phase !== 'preparing'"
              class="files-transfer-fill block h-full rounded-full"
              :class="row.phase === 'failed' ? 'bg-(--d-danger)' : row.phase === 'done' ? 'bg-(--d-success)' : 'bg-(--d-accent)'"
              :style="{ transform: `scaleX(${fraction})` }"
            />
          </div>
          <p
            v-if="bytes"
            aria-hidden="true"
            data-testid="files-transfer-bytes"
            class="relative mt-0.75 truncate text-11 text-(--d-faint-text) tabular-nums"
          >
            {{ bytes }}
          </p>
        </div>
      </div>
    </Transition>
  </div>
</template>
