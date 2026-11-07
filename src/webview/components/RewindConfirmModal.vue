<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { ArrowLeftRight, Diamond, FolderOpen, Info, Link, MessageSquare, RotateCcw, TriangleAlert } from 'lucide-vue-next';
import ConfirmDialogLayout from './ConfirmDialogLayout.vue';
import RewindCheckpointNotes from '@/components/RewindCheckpointNotes.vue';
import RewindFilesSummary from '@/components/RewindFilesSummary.vue';
import DesignDecisionChip from '@/components/design/DesignDecisionChip.vue';
import type { RewindOption, RewindHistoryItem, SkippedFilesTarget } from '@shared/types/session';
import type { DesignChatStateView } from '@shared/types/design';
import { restoreFocus } from '@/composables/useOverlayDialog';

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
  canFork: boolean;
  kind?: RewindHistoryItem['kind'];
  messagePreview?: string | undefined;
  filesAffected?: number | undefined;
  files?: Array<{ path: string; displayName: string }> | undefined;
  linesChanged?: { added: number; removed: number } | undefined;
  loadingMetadata?: boolean | undefined;
  skipped?: RewindHistoryItem['skipped'] | undefined;
  notRewindable?: RewindHistoryItem['notRewindable'] | undefined;
  /** D61: a hand-off came after this turn, so its files are in the other folder and only the conversation goes back. */
  crossesHandOff?: boolean | undefined;
  /** The checkpoint's key, so the full "not restored" list can be loaded on demand. */
  checkpointId?: string | undefined;
  /** Set in a design chat: the dock names what goes back in the design and offers the design's actions. */
  design?: DesignChatStateView | null | undefined;
  designDecisionsAfter?: RewindHistoryItem['designDecisionsAfter'];
}>();

const emit = defineEmits<{
  confirm: [option: RewindOption];
  cancel: [];
  openRewindDiff: [path: string];
}>();

// The control that opened the modal; reka returns focus only to a DialogTrigger, which this modal has none of.
let opener: HTMLElement | null = null;

type ModalView = 'options' | 'confirm-rewind';

const selectedIndex = ref(-1);
const optionList = ref<HTMLElement | null>(null);
let entryFocusPending = props.visible;
const view = ref<ModalView>('options');
const pendingFileRewindOption = ref<RewindOption | null>(null);
const skippedTarget = computed<SkippedFilesTarget | undefined>(() => (props.checkpointId ? { kind: 'turn', userEntryId: props.checkpointId } : undefined));

interface Option {
  key: RewindOption;
  label: string;
  description: string;
  shortcut: string;
  needsCodeConfirm: boolean;
  requiresFork: boolean;
}

const genericOptions = computed<Option[]>(() => [
  {
    key: 'fork-conversation',
    label: t('rewind.options.forkConversation.label'),
    description: t('rewind.options.forkConversation.description'),
    shortcut: '1',
    needsCodeConfirm: false,
    requiresFork: true,
  },
  {
    key: 'code-only',
    label: t('rewind.options.codeOnly.label'),
    description: t('rewind.options.codeOnly.description'),
    shortcut: '2',
    needsCodeConfirm: true,
    requiresFork: false,
  },
  {
    key: 'fork-and-rewind-code',
    label: t('rewind.options.forkAndRewindCode.label'),
    description: t('rewind.options.forkAndRewindCode.description'),
    shortcut: '3',
    needsCodeConfirm: true,
    requiresFork: true,
  },
  {
    key: 'cancel',
    label: t('rewind.options.cancel.label'),
    description: t('rewind.options.cancel.description'),
    shortcut: '4',
    needsCodeConfirm: false,
    requiresFork: false,
  },
]);

// PD-36: Fork from here is a new unlinked design, Rewind a takeover in a new chat, Files only an in-place restore.
const designOptions = computed<Option[]>(() => [
  {
    key: 'cancel',
    label: t('rewind.options.cancel.label'),
    description: t('rewind.design.options.cancel'),
    shortcut: '1',
    needsCodeConfirm: false,
    requiresFork: false,
  },
  {
    key: 'fork-conversation',
    label: t('rewind.design.options.fork.label'),
    description: t('rewind.design.options.fork.description'),
    shortcut: '2',
    needsCodeConfirm: false,
    requiresFork: true,
  },
  {
    key: 'fork-and-rewind-code',
    label: t('rewind.design.options.rewind.label'),
    description: t('rewind.design.options.rewind.description'),
    shortcut: '3',
    needsCodeConfirm: true,
    requiresFork: true,
  },
  {
    key: 'code-only',
    label: t('rewind.design.options.filesOnly.label'),
    description: t('rewind.design.options.filesOnly.description'),
    shortcut: '4',
    needsCodeConfirm: true,
    requiresFork: false,
  },
]);

const options = computed(() => (props.design ? designOptions.value : genericOptions.value));

// The design rows share the list's two columns, so every label and value lines up; a narrow dock stacks each row.
const ROW = 'col-span-full grid grid-cols-subgrid items-baseline gap-y-1 border-t border-(--d-border) px-3 py-2.25 first:border-t-0 animate-[d-swap-in_.28s_var(--ease-out)_both]';
const ROW_LABEL = 'flex items-center gap-1.5 text-10.5 font-semibold tracking-[.06em] whitespace-nowrap text-(--d-faint-text) uppercase';
const ROW_ICON = 'size-3.25 flex-none text-(--d-design)';

// A turn with no usable checkpoint can still be forked, but its files cannot be restored.
function isDisabled(option: Option): boolean {
  return (option.requiresFork && !props.canFork) || (option.needsCodeConfirm && (!!props.notRewindable || props.crossesHandOff === true));
}

watch(() => props.visible, (visible) => {
  if (visible) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    entryFocusPending = true;
    selectedIndex.value = -1;
    view.value = 'options';
    pendingFileRewindOption.value = null;
  }
});

function handleDialogOpenUpdate(open: boolean) {
  if (open) return;
  if (view.value === 'confirm-rewind') {
    view.value = 'options';
    pendingFileRewindOption.value = null;
    return;
  }
  emit('cancel');
}

function handleKeyDown(event: KeyboardEvent) {
  if (!props.visible) return;

  const target = event.target as HTMLElement;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable) return;
  if (target.closest('[data-no-keyboard-shortcuts]')) return;

  if (view.value === 'confirm-rewind') {
    if (event.key === 'Escape') {
      event.preventDefault();
      backToOptions();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      confirmFileRewind();
    }
    return;
  }

  switch (event.key) {
    case '1':
    case '2':
    case '3':
    case '4': {
      event.preventDefault();
      const index = parseInt(event.key) - 1;
      selectOption(index);
      break;
    }
    case 'ArrowUp':
      event.preventDefault();
      selectedIndex.value = previousEnabledIndex(selectedIndex.value);
      focusSelectedOption();
      break;
    case 'ArrowDown':
      event.preventDefault();
      selectedIndex.value = nextEnabledIndex(selectedIndex.value);
      focusSelectedOption();
      break;
    case 'Enter':
      event.preventDefault();
      if (selectedIndex.value >= 0) {
        selectOption(selectedIndex.value);
      }
      break;
    case 'Escape':
      event.preventDefault();
      emit('cancel');
      break;
  }
}

function nextEnabledIndex(current: number): number {
  const len = options.value.length;
  for (let step = 1; step <= len; step++) {
    const candidate = (current < 0 ? -1 : current) + step;
    const wrapped = ((candidate % len) + len) % len;
    if (!isDisabled(options.value[wrapped]!)) return wrapped;
  }
  return current;
}

function previousEnabledIndex(current: number): number {
  const len = options.value.length;
  for (let step = 1; step <= len; step++) {
    const start = current < 0 ? len : current;
    const candidate = start - step;
    const wrapped = ((candidate % len) + len) % len;
    if (!isDisabled(options.value[wrapped]!)) return wrapped;
  }
  return current;
}

function selectOption(index: number) {
  const option = options.value[index];
  if (!option) return;
  if (isDisabled(option)) return;

  if (option.key === 'cancel') {
    emit('cancel');
    return;
  }

  if (option.needsCodeConfirm) {
    pendingFileRewindOption.value = option.key;
    view.value = 'confirm-rewind';
    return;
  }

  emit('confirm', option.key);
}

function confirmFileRewind() {
  const option = pendingFileRewindOption.value;
  if (!option) return;
  emit('confirm', option);
}

function backToOptions() {
  pendingFileRewindOption.value = null;
  view.value = 'options';
}

function focusFirstOption() {
  optionList.value?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')?.focus();
}

// Focus follows the arrow keys, so the focus ring and the arrows' highlight mark the same option.
function focusSelectedOption() {
  optionList.value?.querySelectorAll<HTMLElement>('[role="option"]')[selectedIndex.value]?.focus();
}

// The first tabbable can be the files toggle, whose row takes no shortcuts, so the options take focus instead.
function onOpenAutoFocus(event: Event) {
  event.preventDefault();
  focusFirstOption();
}

// reka focuses the content itself, and then skips open-auto-focus, when a child changes before anything inside took focus (a
// design decision chip does), so until a control inside takes focus the content passes its focus to the options.
function onContentFocusIn(event: FocusEvent) {
  if (event.target !== event.currentTarget) entryFocusPending = false;
  else if (entryFocusPending) focusFirstOption();
}

function onCloseAutoFocus(event: Event) {
  event.preventDefault();
  restoreFocus(opener);
  opener = null;
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <AlertDialog
    :open="visible"
    @update:open="handleDialogOpenUpdate"
  >
    <AlertDialogContent
      class="max-h-[90vh] max-w-lg gap-0 overflow-hidden p-0"
      @open-auto-focus="onOpenAutoFocus"
      @close-auto-focus="onCloseAutoFocus"
      @focusin="onContentFocusIn"
    >
      <ConfirmDialogLayout
        v-if="view === 'options'"
        :icon="RotateCcw"
        :title="design ? t('rewind.design.title') : t('rewind.title')"
        :description="design ? t('rewind.design.description') : t('rewind.description')"
      >
        <template v-if="design">
          <div
            class="@container"
            data-testid="rewind-design-rows"
          >
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 overflow-hidden rounded-10 border border-[color-mix(in_srgb,var(--d-design)_22%,var(--d-border))] bg-(--d-bg) text-12.5 @max-[24rem]:grid-cols-1">
              <div
                :class="ROW"
                style="animation-delay: 40ms"
                data-row="conversation"
              >
                <dt :class="ROW_LABEL">
                  <MessageSquare
                    :class="ROW_ICON"
                    aria-hidden="true"
                  />{{ t('rewind.design.rows.conversation') }}
                </dt>
                <dd class="min-w-0">
                  <span
                    v-if="kind === 'compaction'"
                    class="block text-10.5 font-semibold tracking-[.06em] text-(--d-info) uppercase"
                  >{{ t('rewindBrowser.compactionPoint') }}</span>
                  <span
                    v-if="messagePreview"
                    class="line-clamp-2 wrap-break-word"
                  >“{{ messagePreview }}”</span>
                  <span
                    v-if="kind === 'compaction'"
                    class="mt-1 block text-xs text-(--d-warning)"
                  >{{ t('rewind.compactionCaveat') }}</span>
                </dd>
              </div>

              <div
                :class="ROW"
                style="animation-delay: 80ms"
                data-row="decisions"
              >
                <dt :class="ROW_LABEL">
                  <Diamond
                    :class="ROW_ICON"
                    aria-hidden="true"
                  />{{ t('rewind.design.rows.decisions') }}
                </dt>
                <dd class="min-w-0">
                  <span
                    v-if="loadingMetadata"
                    class="flex gap-1"
                    aria-hidden="true"
                  >
                    <span
                      v-for="n in 2"
                      :key="n"
                      class="h-5.5 w-24 animate-[d-pulse_1.4s_ease-in-out_infinite] rounded-full bg-(--d-design)/12"
                    />
                  </span>
                  <template v-else-if="designDecisionsAfter?.length">
                    <ul
                      class="flex flex-wrap gap-1"
                      :aria-label="t('rewind.design.decisionsLeaving', { n: designDecisionsAfter.length }, designDecisionsAfter.length)"
                      data-testid="rewind-design-decisions"
                    >
                      <li
                        v-for="(decision, index) in designDecisionsAfter"
                        :key="decision.id"
                        class="flex min-w-0 animate-[d-pop_.26s_var(--ease-spring)_both]"
                        :style="{ animationDelay: `${140 + Math.min(index, 8) * 35}ms` }"
                      >
                        <DesignDecisionChip
                          :decision="decision"
                          leaving
                        />
                      </li>
                    </ul>
                    <span
                      class="mt-1 block text-11 text-(--d-faint-text)"
                      data-testid="rewind-design-decisions-files-only"
                    >{{ t('rewind.design.decisionsFilesOnly') }}</span>
                  </template>
                  <span
                    v-else
                    class="text-(--d-muted)"
                    data-testid="rewind-design-decisions-none"
                  >{{ t('rewind.design.decisionsNone') }}</span>
                </dd>
              </div>

              <div
                :class="ROW"
                style="animation-delay: 120ms"
                data-row="files"
              >
                <dt :class="ROW_LABEL">
                  <FolderOpen
                    :class="ROW_ICON"
                    aria-hidden="true"
                  />{{ t('rewind.design.rows.files') }}
                </dt>
                <dd
                  class="min-w-0 text-xs text-(--d-muted)"
                  data-no-keyboard-shortcuts
                >
                  <span
                    v-if="loadingMetadata"
                    role="status"
                  >{{ t('rewind.loadingMetadata') }}</span>
                  <RewindFilesSummary
                    v-else-if="filesAffected"
                    :files-affected="filesAffected"
                    :files="files"
                    :lines-changed="linesChanged"
                    @open-rewind-diff="(path: string) => emit('openRewindDiff', path)"
                  />
                  <span v-else>{{ t('rewind.design.filesNone') }}</span>
                </dd>
              </div>

              <div
                :class="ROW"
                style="animation-delay: 160ms"
                data-row="main-chat"
              >
                <dt :class="ROW_LABEL">
                  <Link
                    :class="ROW_ICON"
                    aria-hidden="true"
                  />{{ t('rewind.design.rows.mainChat') }}
                </dt>
                <dd class="flex min-w-0 flex-wrap items-center gap-1.5 text-(--d-muted)">
                  <template v-if="design.parentSessionId === null">
                    {{ t('design.header.noParent') }}
                  </template>
                  <template v-else-if="design.version === null">
                    {{ t('rewind.design.mainChatNoVersion') }}
                  </template>
                  <template v-else>
                    <span>{{ t('rewind.design.mainChatKeeps') }}</span>
                    <span
                      class="d-tone-design rounded-full bg-(--tone)/14 px-1.5 font-mono text-10.5 font-semibold"
                      data-testid="rewind-design-version"
                    >{{ t('design.header.version', { version: design.version }) }}</span>
                  </template>
                </dd>
              </div>
            </dl>
          </div>

          <p
            class="flex items-start gap-2 text-xs text-pretty text-(--d-design-text)"
            data-testid="rewind-design-hint"
          >
            <Info
              class="mt-0.5 size-3.25 flex-none"
              aria-hidden="true"
            />
            <span>{{ t('rewind.design.hint') }}</span>
          </p>
        </template>

        <template v-else>
          <div
            v-if="kind === 'compaction'"
            class="rounded-10 border border-(--d-border) bg-(--d-bg) px-3 py-2 text-12.5"
          >
            <div class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-info) uppercase">
              {{ t('rewindBrowser.compactionPoint') }}
            </div>
            <div
              v-if="messagePreview"
              class="wrap-break-word text-(--d-muted) italic"
            >
              {{ messagePreview }}
            </div>
            <div class="mt-2 text-xs text-(--d-warning)">
              {{ t('rewind.compactionCaveat') }}
            </div>
          </div>
          <div
            v-else-if="messagePreview"
            class="rounded-10 border border-(--d-border) bg-(--d-bg) px-3 py-2 text-12.5"
          >
            <div class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint) uppercase">
              {{ t('rewind.rewindToAfter') }}
            </div>
            <div class="line-clamp-3 wrap-break-word">
              “{{ messagePreview }}”
            </div>
          </div>

          <div
            v-if="!crossesHandOff && (loadingMetadata || filesAffected)"
            data-no-keyboard-shortcuts
            class="text-xs text-(--d-muted)"
          >
            <span
              v-if="loadingMetadata"
              role="status"
            >{{ t('rewind.loadingMetadata') }}</span>
            <RewindFilesSummary
              v-else
              :files-affected="filesAffected!"
              :files="files"
              :lines-changed="linesChanged"
              @open-rewind-diff="(path: string) => emit('openRewindDiff', path)"
            />
          </div>
        </template>

        <p
          v-if="crossesHandOff"
          class="flex items-start gap-2 text-xs text-pretty text-(--d-info-text)"
          data-testid="rewind-confirm-hand-off-note"
        >
          <ArrowLeftRight
            class="mt-0.5 size-3.5 flex-none"
            aria-hidden="true"
          />
          <span>{{ t('worktree.rewindNote') }}</span>
        </p>
        <RewindCheckpointNotes
          v-if="!loadingMetadata"
          :skipped="skipped"
          :not-rewindable="notRewindable"
          :target="skippedTarget"
        />

        <div
          ref="optionList"
          class="-mx-1.5 flex flex-col"
          role="listbox"
          :aria-label="t('rewind.title')"
        >
          <button
            v-for="(option, index) in options"
            :key="option.key"
            type="button"
            role="option"
            :aria-selected="index === selectedIndex"
            class="group flex items-start gap-2.5 rounded-9 px-2.5 py-1.75 text-left transition-colors disabled:opacity-40"
            :class="index === selectedIndex && !isDisabled(option) ? 'bg-(--d-accent-soft) text-(--d-accent-text)' : ''"
            :disabled="isDisabled(option)"
            @click="selectOption(index)"
            @mouseenter="!isDisabled(option) && (selectedIndex = index)"
          >
            <span
              class="mt-px flex size-5 flex-none items-center justify-center rounded-md border font-mono text-11"
              :class="index === selectedIndex && !isDisabled(option) ? 'border-(--d-accent)' : 'border-(--d-border2)'"
              aria-hidden="true"
            >{{ option.shortcut }}</span>
            <span class="min-w-0 flex-1">
              <span class="block font-medium">{{ option.label }}</span>
              <span class="block text-xs text-(--d-muted)">{{ option.description }}</span>
            </span>
          </button>
        </div>

        <p class="flex items-start gap-2 rounded-10 bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] px-3 py-2.25 text-xs text-(--d-warning-text)">
          <TriangleAlert
            class="size-3.25 mt-0.5 flex-none"
            aria-hidden="true"
          />
          <span class="text-pretty">{{ t('rewind.checkpointWarning') }}</span>
        </p>

        <template #footer>
          <span
            class="flex flex-1 items-center gap-1.5 font-mono text-11 text-(--d-faint)"
            aria-hidden="true"
          >
            <kbd>1-4</kbd>
            <span class="font-sans">{{ t('common.or') }}</span>
            <kbd>↑↓</kbd>
            <kbd>Enter</kbd>
          </span>
        </template>
      </ConfirmDialogLayout>

      <ConfirmDialogLayout
        v-else
        :icon="TriangleAlert"
        tone="danger"
        :title="design ? t('rewind.design.confirmFiles.title') : t('rewind.confirmCodeRewind.title')"
        :description="design ? t('rewind.design.confirmFiles.description') : t('rewind.confirmCodeRewind.description')"
        :cancel-label="t('rewind.confirmCodeRewind.cancel')"
        :confirm-label="design ? t('rewind.design.confirmFiles.confirm') : t('rewind.confirmCodeRewind.confirm')"
        danger
        @cancel="backToOptions"
        @confirm="confirmFileRewind"
      />
    </AlertDialogContent>
  </AlertDialog>
</template>
