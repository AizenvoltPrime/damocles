<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Cherry, ChevronDown, CloudUpload, GitMerge, GitPullRequestArrow, LoaderCircle, PencilLine, Sparkles, TriangleAlert } from 'lucide-vue-next';
import type { Component } from 'vue';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ScmCommitFailure, ScmCommitRequest, ScmCommitVariant, ScmOperation, ScmRepoSnapshot } from '../../preload/scm-channels';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import { SCM_STORE, type BoxText } from './scm-store';
import { visibleText } from '@shared/visible-text';
import { actionOf, COMMIT_VARIANTS, splitButtonMenu, toOverlayMenu, type ScmAction } from './scm-menus';

const props = defineProps<{ snapshot: ScmRepoSnapshot; platform: ShellPlatform; api: DamoclesShellApi }>();
const { t } = useI18n();
const store = inject(SCM_STORE)!;

// ms the commit button keeps its check after a commit landed
const DONE_MS = 1200;
const BUSY_DELAY_MS = 120;
const FEEDBACK: ReadonlySet<ScmCommitFailure> = new Set(['emptyMessage', 'nothingToCommit', 'unresolvedConflicts', 'missingUserConfig']);
const OPERATION_ICONS: Readonly<Record<ScmOperation, Component>> = { merge: GitMerge, rebase: GitPullRequestArrow, cherryPick: Cherry };
// The one-shot text motions (design-spec 4 and 5); each restarts by removing it, forcing a reflow and adding it back.
const TEXT_MOTIONS = ['d-fade-in', 'd-msg-older', 'd-msg-newer', 'd-msg-return'] as const;
type TextMotion = (typeof TEXT_MOTIONS)[number];
type GhostMotion = 'd-msg-ghost-down' | 'd-msg-ghost-up' | 'd-msg-sent' | 'd-msg-replaced';

const field = ref<InstanceType<typeof Textarea> | null>(null);
const textarea = (): HTMLTextAreaElement | undefined => field.value?.$el as HTMLTextAreaElement | undefined;
const feedback = ref<ScmCommitFailure | null>(null);
// the caret's line, whose length VS Code's input validation reports
const caretLine = ref(0);
// repositories whose commit outlasted BUSY_DELAY_MS and shows the loader, so an instant refusal never flickers it
const slow = reactive(new Set<string>());
// repositories whose commit just landed, for DONE_MS
const done = reactive(new Set<string>());
const busyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Only a landed commit or a change of variant twists its icon in; a refusal and the return to idle swap without motion.
const twist = ref(false);
const menuOpen = ref(false);

const repoId = computed(() => props.snapshot.repoId);
const phase = computed(() => (store.committing.value.has(repoId.value) ? 'busy' : done.has(repoId.value) ? 'done' : 'idle'));
const showBusy = computed(() => slow.has(repoId.value));
const generating = computed(() => store.generating.value.has(repoId.value));
const message = computed({
  get: () => store.draftOf(repoId.value),
  set: (text: string) => {
    store.setDraft(repoId.value, text);
    feedback.value = null;
  },
});
const operation = computed(() => props.snapshot.operation);
const staged = computed(() => props.snapshot.groups.index.length);
const unstaged = computed(() => props.snapshot.groups.workingTree.length + props.snapshot.groups.untracked.length);
const conflicts = computed(() => props.snapshot.groups.merge.length);
// Amend mode (the split button's Commit (Amend)), in which every commit action amends.
const amending = computed(() => store.amendingIn(repoId.value));
const isMac = computed(() => props.platform === 'darwin');
const shortcut = computed(() => (isMac.value ? '⌘Enter' : 'Ctrl+Enter'));
const branch = computed(() => {
  const head = props.snapshot.head;
  if (!head) return '';
  return visibleText(head.type === 'detached' ? head.commit.slice(0, 8) : head.name);
});
const placeholder = computed(() => (generating.value ? t('scm.commit.generating') : operation.value
  ? t(`scm.commit.placeholder.${operation.value}`, { shortcut: shortcut.value })
  : t('scm.commit.placeholder.branch', { shortcut: shortcut.value, branch: branch.value })));
const label = computed(() => (operation.value ? t(`scm.commit.continue.${operation.value}`) : amending.value ? t('scm.commit.amend') : t('scm.commit.commit')));
const subject = computed(() => visibleText(props.snapshot.commit?.subject ?? ''));
// Ready reads as the accent fill; the button stays enabled either way, so a click always answers. With nothing staged main
// asks the smart-commit question, and an empty amend reuses HEAD's message.
const ready = computed(() => operation.value === 'rebase' || (
  (message.value.trim() !== '' || amending.value)
  && (staged.value > 0 || unstaged.value > 0 || operation.value !== null || amending.value)
  && conflicts.value === 0
));
const hint = computed(() => {
  if (conflicts.value > 0) return t('scm.commit.hint.conflicts', conflicts.value, { named: { count: conflicts.value } });
  if (operation.value === 'rebase') return t('scm.commit.hint.rebase');
  if (staged.value > 0) return t('scm.commit.hint.staged', staged.value, { named: { count: staged.value } });
  return t('scm.commit.hint.nothingStaged');
});
// VS Code's action button: Publish Branch takes the commit button's place on a branch with no upstream and nothing to commit.
const showPublish = computed(() => {
  const snapshot = props.snapshot;
  return snapshot.head?.type === 'branch' && snapshot.commit !== null && snapshot.upstream === null && snapshot.remotes.length > 0
    && operation.value === null && !amending.value && staged.value + unstaged.value + conflicts.value === 0 && phase.value === 'idle';
});
// repositories whose publish this button started, until main answers it; Push Tags runs as push too, so running alone cannot say
const publishStarted = reactive(new Set<string>());
const publishing = computed(() => publishStarted.has(repoId.value) && props.snapshot.running === 'push');
// main runs one remote operation per repository, so Publish waits while any runs, as the sync button does
const publishBlocked = computed(() => publishStarted.has(repoId.value) || props.snapshot.running !== null);
const publishTitle = computed(() => {
  if (publishing.value) return t('scm.commit.publishing', { branch: branch.value });
  return publishBlocked.value ? t('scm.sync.running') : t('scm.commit.publishTitle', { branch: branch.value });
});

async function publish(): Promise<void> {
  const id = repoId.value;
  if (publishBlocked.value) return;
  publishStarted.add(id);
  try {
    await store.api.run({ op: 'publish', repoId: id });
  } finally {
    publishStarted.delete(id);
  }
}

// The Publish and commit controls swap in one cell; focus on the leaving one moves to the one that takes its place.
let swapHadFocus = false;

function retireControl(element: Element): void {
  swapHadFocus = element.contains(document.activeElement);
  for (const node of [element, ...element.querySelectorAll('[data-testid]')]) node.removeAttribute('data-testid');
  element.setAttribute('aria-hidden', 'true');
}

function focusSwapped(element: Element): void {
  if (!swapHadFocus) return;
  swapHadFocus = false;
  (element instanceof HTMLButtonElement ? element : element.querySelector('button'))?.focus();
}

const iconKey = computed(() => (showBusy.value ? 'busy' : phase.value === 'done' ? 'done' : amending.value ? 'amend' : 'commit'));
watch(amending, () => {
  twist.value = true;
});

// VS Code's git.inputValidation: the caret line over its threshold (the subject's for the first line).
const lengthWarning = computed(() => {
  const settings = store.settings.value;
  if (!settings.inputValidation || generating.value) return '';
  const line = message.value.split('\n')[caretLine.value] ?? '';
  const threshold = caretLine.value === 0 ? settings.inputValidationSubjectLength : settings.inputValidationLength;
  const over = line.length - threshold;
  return over > 0 ? t('scm.commit.lengthWarning', over, { named: { count: over, threshold } }) : '';
});

function trackCaret(): void {
  const element = textarea();
  if (element) caretLine.value = element.value.slice(0, element.selectionStart).split('\n').length - 1;
}

// A text swap: the outgoing text leaves as an aria-hidden copy while the box's own text enters.
const ghost = ref<{ seq: number; text: string; motion: GhostMotion; height: number; scrollTop: number } | null>(null);
let ghostSeq = 0;

function playText(motion: TextMotion): void {
  const element = textarea();
  if (!element) return;
  element.classList.remove(...TEXT_MOTIONS);
  void element.offsetWidth;
  element.classList.add(motion);
}

/** Puts `text` in the box of `id`, the outgoing text leaving with `leave` and the new one entering with `enter`. */
function swapText(id: string, text: string, enter: TextMotion, leave: GhostMotion | null): void {
  const element = textarea();
  const outgoing = store.draftOf(id);
  store.setDraft(id, text);
  if (id !== repoId.value || !element) return;
  feedback.value = null;
  if (leave && outgoing !== '' && outgoing !== text) {
    ghost.value = { seq: ++ghostSeq, text: outgoing, motion: leave, height: element.clientHeight, scrollTop: element.scrollTop };
  }
  playText(enter);
}

// VS Code's scm input history, the draft being its newest entry. -1: the draft; otherwise an index into commitInput.history,
// newest first.
let historyIndex = -1;
let savedDraft = '';

function resetHistory(): void {
  historyIndex = -1;
  savedDraft = '';
}

// Up recalls an older message with the caret at the very start (or anywhere on the first line of an unedited recalled entry),
// Down a newer one with the caret at the very end; Alt forces either, as VS Code's forceViewPreviousCommit does.
function recall(older: boolean, force: boolean): boolean {
  const element = textarea();
  const history = store.inputs.value.get(repoId.value)?.history ?? [];
  if (!element) return false;
  const text = message.value;
  const entry = historyIndex >= 0 ? history[historyIndex] : undefined;
  const unedited = entry !== undefined && entry === text;
  const { selectionStart: start, selectionEnd: end } = element;
  const edge = older
    ? (start === 0 && end === 0) || (unedited && !text.slice(0, start).includes('\n'))
    : (start === text.length && end === text.length) || (unedited && !text.slice(end).includes('\n'));
  if (!force && text !== '' && !edge) return false;
  if (!unedited) {
    savedDraft = text;
    historyIndex = -1;
  }
  const next = historyIndex + (older ? 1 : -1);
  if (next >= history.length || next < -1) return false;
  historyIndex = next;
  swapText(repoId.value, next === -1 ? savedDraft : history[next]!, older ? 'd-msg-older' : 'd-msg-newer', older ? 'd-msg-ghost-down' : 'd-msg-ghost-up');
  void nextTick(() => {
    const length = message.value.length;
    textarea()?.setSelectionRange(length, length);
    trackCaret();
  });
  return true;
}

watch(repoId, () => {
  feedback.value = null;
  caretLine.value = 0;
  ghost.value = null;
  resetHistory();
});

// Main's commit input (template, history, HEAD's message): read for each repository and again whenever HEAD's commit changes.
watch([repoId, () => props.snapshot.commit?.hash], ([id]) => {
  void store.loadCommitInput(id);
}, { immediate: true });

const stopSetInput = store.onSetInput((input: BoxText, previous: string) => {
  if (input.repoId !== repoId.value) return;
  resetHistory();
  caretLine.value = 0;
  feedback.value = null;
  const element = textarea();
  if (element && previous !== '' && previous !== input.message) {
    const motion: GhostMotion = input.cause === 'commit' ? 'd-msg-sent' : 'd-msg-replaced';
    ghost.value = { seq: ++ghostSeq, text: previous, motion, height: element.clientHeight, scrollTop: element.scrollTop };
  }
  playText(input.cause === 'undo' ? 'd-msg-return' : 'd-fade-in');
});

async function enterAmend(): Promise<void> {
  const id = repoId.value;
  const draft = store.draftOf(id);
  store.setAmending(id, draft);
  if (draft.trim() !== '') return;
  const input = await store.loadCommitInput(id);
  // The box may have changed while main answered: amend cancelled, or the user typed.
  if (input.headMessage !== null && store.amending.value.has(id) && store.draftOf(id) === draft) swapText(id, input.headMessage, 'd-msg-return', null);
}

function cancelAmend(): void {
  const id = repoId.value;
  const previous = store.amending.value.get(id);
  if (previous === undefined) return;
  const hadFocus = document.activeElement?.closest('[data-testid="scm-amend-banner"]') !== null;
  store.setAmending(id, undefined);
  swapText(id, previous, 'd-fade-in', 'd-msg-replaced');
  if (hadFocus) textarea()?.focus();
}

/**
 * Commits the draft of `id` (the shown repository unless named); no variant is the primary button's. In amend mode every
 * variant amends.
 */
async function commit(variant?: ScmCommitVariant, id: string = repoId.value, postCommit?: ScmCommitRequest['postCommit']): Promise<void> {
  if (store.committing.value.has(id) || store.generating.value.has(id)) return;
  const chosen: ScmCommitVariant = { ...(variant ?? COMMIT_VARIANTS.commit), ...(store.amendingIn(id) ? { amend: true } : {}) };
  if (id === repoId.value) {
    feedback.value = null;
    twist.value = false;
  }
  store.setCommitting(id, true);
  done.delete(id);
  clearTimeout(doneTimers.get(id));
  busyTimers.set(id, setTimeout(() => slow.add(id), BUSY_DELAY_MS));
  let ok = false;
  try {
    const result = await store.api.commit({ repoId: id, message: store.draftOf(id), variant: chosen, ...(postCommit ? { postCommit } : {}) });
    ok = result.ok;
    // applied before the box leaves its busy state, so nothing typed meanwhile can be replaced
    if (result.ok) store.applyCommitted(id, result.message, result.commitInput);
    else if (FEEDBACK.has(result.reason) && id === repoId.value) feedback.value = result.reason;
  } finally {
    clearTimeout(busyTimers.get(id));
    busyTimers.delete(id);
    slow.delete(id);
    store.setCommitting(id, false);
    if (id === repoId.value) twist.value = ok;
  }
  if (!ok) return;
  done.add(id);
  doneTimers.set(id, setTimeout(() => {
    doneTimers.delete(id);
    done.delete(id);
    if (id === repoId.value) twist.value = false;
  }, DONE_MS));
}

async function openCommitMenu(event: MouseEvent): Promise<void> {
  if (menuOpen.value) return;
  const rect = (event.currentTarget as HTMLElement).closest('[data-split-button]')!.getBoundingClientRect();
  const items = toOverlayMenu(
    splitButtonMenu({
      operation: operation.value,
      hasCommit: props.snapshot.commit !== null,
      amending: amending.value,
      head: props.snapshot.head?.type ?? null,
      hasRemotes: props.snapshot.remotes.length > 0,
    }),
    (key) => t(`scm.${key}`),
  );
  menuOpen.value = true;
  let action: ScmAction | undefined;
  try {
    const answer = await props.api.requestOverlay({ kind: 'menu', label: t('scm.commit.moreActions'), anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, items });
    action = answer.kind === 'menu' ? actionOf(answer.itemId) : undefined;
  } finally {
    menuOpen.value = false;
  }
  if (action === 'toggleAmend') {
    if (amending.value) cancelAmend();
    else await enterAmend();
  } else if (action === 'commit' || action === 'commitSigned') {
    await commit(COMMIT_VARIANTS[action]);
  } else if (action === 'commitPush' || action === 'commitSync') {
    await commit(COMMIT_VARIANTS.commit, repoId.value, action === 'commitPush' ? 'push' : 'sync');
  }
}

// D24: a failure leaves the box as it is; main posts "Couldn't generate a commit message" with the reason.
async function generate(): Promise<void> {
  const id = repoId.value;
  if (store.generating.value.has(id)) return;
  store.setGenerating(id, true);
  try {
    const result = await store.api.generateMessage(id);
    if (!result.ok) return;
    if (id === repoId.value) resetHistory();
    swapText(id, result.message, 'd-fade-in', null);
  } finally {
    store.setGenerating(id, false);
  }
}

// Ctrl+Enter (Cmd+Enter on macOS), Up and Down, and Escape in amend mode are the box's own keys, never menu accelerators (AD11).
function onKeydown(event: KeyboardEvent): void {
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing) {
    if (recall(event.key === 'ArrowUp', event.altKey)) event.preventDefault();
    return;
  }
  if (event.key === 'Escape' && amending.value) {
    event.preventDefault();
    cancelAmend();
    return;
  }
  const modifier = isMac.value ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.key !== 'Enter' || !modifier || event.altKey || event.shiftKey) return;
  event.preventDefault();
  void commit();
}

onBeforeUnmount(() => {
  for (const timer of [...busyTimers.values(), ...doneTimers.values()]) clearTimeout(timer);
  stopSetInput();
});

defineExpose({
  commit,
  focus: (): void => {
    textarea()?.focus();
    void nextTick(trackCaret);
  },
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <Transition name="t-pop">
      <div
        v-if="operation"
        data-testid="scm-operation"
        :data-operation="operation"
        class="flex min-h-7 flex-wrap items-center gap-x-1.5 rounded-7 border border-(--d-border2) bg-(--d-card) py-0.75 pr-0.75 pl-2"
      >
        <!-- The status text wraps and Abort drops below it when the sidebar is narrow, so the state always reads in full. -->
        <span class="flex min-w-0 flex-[1_1_7rem] items-center gap-1.5">
          <component
            :is="OPERATION_ICONS[operation]"
            aria-hidden="true"
            class="size-3.25 shrink-0 text-(--d-warning-text)"
          />
          <span
            role="status"
            class="min-w-0 text-11.5/snug text-pretty wrap-break-word text-(--d-text)"
          >{{ t(`scm.operation.${operation}`) }}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="scm-abort"
          class="d-press ml-auto h-5.5 shrink-0 rounded-5 px-2 text-11.5 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-danger-text)"
          :disabled="snapshot.busy"
          @click="store.api.run({ op: 'abortOperation', repoId: snapshot.repoId })"
        >
          {{ t(`scm.operation.abort.${operation}`) }}
        </Button>
      </div>
    </Transition>

    <!-- overflow-hidden: swapped text moves inside the box and never crosses its border. -->
    <div
      class="relative overflow-hidden rounded-9 border bg-(--d-input) transition-colors duration-200"
      :class="lengthWarning ? 'border-(--d-warning)' : 'border-(--d-border2) focus-within:border-(--d-accent)'"
    >
      <!-- The box's own field; shadcn's Textarea, sized by its content up to a cap. -->
      <Textarea
        ref="field"
        v-model="message"
        data-testid="scm-commit-message"
        rows="2"
        spellcheck="false"
        :readonly="generating || phase === 'busy'"
        :aria-busy="generating || phase === 'busy' || undefined"
        :aria-label="t('scm.commit.label')"
        :aria-describedby="lengthWarning ? `scm-length-${snapshot.repoId}` : undefined"
        :placeholder="placeholder"
        class="block max-h-50 min-h-[round(calc(2lh+0.75rem),0.0625rem)] w-full resize-none rounded-none border-0 bg-transparent pt-2 pr-7.5 pb-1 pl-2.5 text-12.5 text-(--d-text) field-sizing-content placeholder:text-(--d-faint) focus-visible:ring-0 focus-visible:ring-offset-0"
        @keydown="onKeydown"
        @keyup="trackCaret"
        @click="trackCaret"
        @input="trackCaret"
        @focus="trackCaret"
      />
      <div
        v-if="ghost"
        :key="ghost.seq"
        aria-hidden="true"
        data-testid="scm-commit-ghost"
        class="d-msg-ghost inset-x-0 top-0 overflow-hidden pt-2 pr-7.5 pl-2.5 text-12.5 whitespace-pre-wrap wrap-break-word text-(--d-text)"
        :class="ghost.motion"
        :style="{ height: `${ghost.height}px` }"
        @animationend="ghost = null"
      >
        <div
          :style="{ marginTop: `${-ghost.scrollTop}px` }"
          v-text="ghost.text"
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="scm-generate"
        class="absolute top-1.5 right-1.5 size-5.5 rounded-6 text-(--d-accent-text) hover:bg-(--d-accent-soft) hover:text-(--d-accent-text) [&_svg]:size-3.25"
        :aria-label="t('scm.commit.generate')"
        :title="t('scm.commit.generate')"
        :aria-busy="generating || undefined"
        @click="generate"
      >
        <LoaderCircle
          v-if="generating"
          aria-hidden="true"
          class="d-spinning"
        />
        <Sparkles
          v-else
          aria-hidden="true"
        />
      </Button>
      <Transition name="t-tuck">
        <div
          v-if="amending"
          data-testid="scm-amend-banner"
          class="mx-2.5 mb-0.5 flex items-center gap-1.5 text-10.5 text-(--d-warning-text)"
        >
          <PencilLine
            aria-hidden="true"
            class="size-2.75 shrink-0"
          />
          <span
            role="status"
            class="min-w-0 truncate"
          >{{ t('scm.commit.amending', { subject }) }}</span>
          <button
            type="button"
            data-testid="scm-amend-cancel"
            class="ml-auto shrink-0 cursor-pointer rounded-xs underline underline-offset-2 outline-none hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent)"
            :aria-label="t('scm.commit.cancelAmendAria')"
            @click="cancelAmend"
          >
            {{ t('scm.commit.cancelAmend') }}
          </button>
        </div>
      </Transition>
      <!-- One row, laid out right to left: the hint shows whole beside the button or wraps onto a second row the clip
           hides (gap-y exceeds pb), so no font, language or label cuts it; screen readers still read it. -->
      <div
        data-testid="scm-commit-footer"
        class="flex h-9 flex-row-reverse flex-wrap items-center gap-x-1.5 gap-y-2 overflow-hidden px-1.5 pt-1 pb-1.5"
      >
        <div class="inline-grid shrink-0 justify-items-end">
          <Transition
            name="t-morph"
            @before-leave="retireControl"
            @enter="focusSwapped"
          >
            <Button
              v-if="showPublish"
              type="button"
              data-testid="scm-publish"
              class="d-press h-6.5 gap-1.5 rounded-7 bg-(--d-accent) px-2.75 py-0 text-xs font-semibold text-(--d-on-accent) [grid-area:1/1] hover:bg-(--d-accent) hover:brightness-[1.08] focus-visible:ring-2 focus-visible:ring-(--d-on-accent)/70 focus-visible:ring-offset-0 focus-visible:ring-inset aria-disabled:cursor-default aria-disabled:hover:brightness-100 [&_svg]:size-3.25"
              :title="publishTitle"
              :aria-disabled="publishBlocked || undefined"
              :aria-busy="publishing || undefined"
              @click="publish"
            >
              <LoaderCircle
                v-if="publishing"
                aria-hidden="true"
                class="d-spinning"
              />
              <CloudUpload
                v-else
                aria-hidden="true"
              />
              {{ t('scm.commit.publish') }}
            </Button>
            <!-- One pill of two buttons: d-press on the wrapper scales both halves together. -->
            <div
              v-else
              data-split-button
              data-testid="scm-commit-split"
              class="d-press inline-flex h-6.5 shrink-0 overflow-hidden rounded-7 text-xs font-semibold transition-colors duration-200 [grid-area:1/1]"
              :class="ready ? 'bg-(--d-accent) text-(--d-on-accent)' : 'bg-(--d-hover) text-(--d-muted)'"
            >
              <button
                type="button"
                data-testid="scm-commit"
                :data-ready="ready || undefined"
                :data-variant="amending ? 'amend' : 'commit'"
                class="flex cursor-pointer items-center gap-1.5 px-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset"
                :class="ready ? 'hover:bg-(--d-on-accent)/10 focus-visible:ring-(--d-on-accent)/70' : 'hover:bg-(--d-border2) hover:text-(--d-text) focus-visible:ring-(--d-accent)'"
                :aria-busy="phase === 'busy' || undefined"
                :title="t('scm.commit.withShortcut', { label, shortcut })"
                @click="commit()"
              >
                <span class="inline-flex size-3.25">
                  <Transition
                    name="t-icon"
                    :css="twist"
                  >
                    <LoaderCircle
                      v-if="iconKey === 'busy'"
                      key="busy"
                      aria-hidden="true"
                      class="d-spinning size-3.25"
                    />
                    <PencilLine
                      v-else-if="iconKey === 'amend'"
                      key="amend"
                      aria-hidden="true"
                      class="size-3.25"
                    />
                    <Check
                      v-else
                      :key="iconKey"
                      aria-hidden="true"
                      class="size-3.25"
                    />
                  </Transition>
                </span>
                <Transition
                  name="t-swap"
                  mode="out-in"
                >
                  <span :key="label">{{ label }}</span>
                </Transition>
              </button>
              <button
                type="button"
                data-testid="scm-commit-menu"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :aria-label="t('scm.commit.moreActions')"
                :title="t('scm.commit.moreActions')"
                class="flex w-5.5 cursor-pointer items-center justify-center border-l border-current/20 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset"
                :class="ready ? 'hover:bg-(--d-on-accent)/10 focus-visible:ring-(--d-on-accent)/70' : 'hover:bg-(--d-border2) hover:text-(--d-text) focus-visible:ring-(--d-accent)'"
                @click="openCommitMenu"
              >
                <ChevronDown
                  aria-hidden="true"
                  class="size-3"
                />
              </button>
            </div>
          </Transition>
        </div>
        <span class="relative mr-auto min-w-0 pl-1 text-10.5 whitespace-nowrap text-(--d-faint)">
          <Transition
            name="t-swap"
            mode="out-in"
          >
            <span
              :key="hint"
              data-testid="scm-commit-hint"
            >{{ hint }}</span>
          </Transition>
        </span>
      </div>
      <span
        v-if="generating"
        class="d-sheen text-(--d-accent)"
        aria-hidden="true"
      />
    </div>

    <Transition name="t-fade">
      <p
        v-if="lengthWarning"
        :id="`scm-length-${snapshot.repoId}`"
        data-testid="scm-length-warning"
        class="-mt-1 px-1 text-11 text-(--d-warning-text)"
      >
        {{ lengthWarning }}
      </p>
    </Transition>
    <Transition name="t-pop">
      <p
        v-if="feedback"
        role="alert"
        data-testid="scm-commit-feedback"
        :data-reason="feedback"
        class="-mt-1 flex items-start gap-1.5 px-1 text-11"
        :class="feedback === 'unresolvedConflicts' || feedback === 'missingUserConfig' ? 'text-(--d-danger-text)' : 'text-(--d-warning-text)'"
      >
        <TriangleAlert
          aria-hidden="true"
          class="mt-0.5 size-3 shrink-0"
        />{{ t(`scm.commit.feedback.${feedback}`) }}
      </p>
    </Transition>
  </div>
</template>
