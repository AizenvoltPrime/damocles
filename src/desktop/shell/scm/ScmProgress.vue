<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, useId, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDownToLine, ArrowUpFromLine, Check, CircleAlert, CloudDownload, CopyPlus, GitBranchMinus, RefreshCw, Tag, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { ScmRemoteOp, ScmRemoteOutcome } from '../../preload/scm-channels';
import { SCM_STORE } from './scm-store';
import { visibleText } from '@shared/visible-text';

// AD4's progress row under the section title: one for the clone, one for the shown repository's remote operation, each with
// Cancel. The default slot is the section's content, which glides by transform as a row comes or goes.
const props = defineProps<{ repoId: string | undefined; running: ScmRemoteOp | null; lastRemote: ScmRemoteOutcome | null }>();
// a row's Cancel held focus as it went away; the section puts focus back in its content
const emit = defineEmits<{ releaseFocus: [] }>();
const { t } = useI18n();
const store = inject(SCM_STORE)!;
const baseId = useId();

// ms an operation runs before its row shows, so a quick fetch never flashes one
const SHOW_DELAY_MS = 150;
// ms a finished row holds its check, or its warning or danger tint, before it leaves
const DONE_MS = 900;
const FAILED_MS = 1400;
// ms an ended row waits for main's outcome before it leaves without one
const OUTCOME_WAIT_MS = 1500;

type Kind = ScmRemoteOp | 'clone';
interface Row {
  // the repository, or null for the clone
  readonly key: string | null;
  readonly kind: Kind;
  // the folder a clone goes into, as its name only (never the URL)
  readonly name: string;
  // warning: the operation finished, but the changes stashed around its pull stay in the stash list
  readonly phase: 'running' | 'done' | 'warning' | 'failed';
  readonly cancelling: boolean;
}

type Outcome = Pick<ScmRemoteOutcome, 'outcome' | 'stashKept' | 'seq'>;
interface TrackState {
  // the repository shown (null: the clone's track), whose row alone may stay
  readonly key: string | null;
  readonly active: { readonly key: string | null; readonly kind: Kind; readonly name: string } | null;
  readonly last: Outcome | null;
}

const ICONS: Readonly<Record<Kind, Component>> = {
  fetch: CloudDownload,
  pull: ArrowDownToLine,
  push: ArrowUpFromLine,
  sync: RefreshCw,
  deleteRemoteBranch: GitBranchMinus,
  deleteRemoteTag: Tag,
  clone: CopyPlus,
};

const cloneRow = ref<Row | null>(null);
const opRow = ref<Row | null>(null);
// Two fixed slots, each its own Transition; a TransitionGroup would measure (and clone) its children on every list scroll.
const slots = computed(() => [cloneRow.value, opRow.value]);

const nameOf = (row: Row): { name: string } => ({ name: visibleText(row.name) });
const labelOf = (row: Row): string => t(`scm.progress.${row.kind}`, nameOf(row));
const endedText = (row: Row, { outcome, stashKept }: Outcome): string =>
  t(`scm.progress.${stashKept ? 'stashKept.' : ''}${outcome === 'ok' ? 'done' : outcome}.${row.kind}`, nameOf(row));
const endedPhase = ({ outcome, stashKept }: Outcome): Row['phase'] => (outcome !== 'ok' ? 'failed' : stashKept ? 'warning' : 'done');

// The one live region for both rows: it exists before any text reaches it, so a row's start and end are both announced.
const status = ref('');

/**
 * Keeps `slot` on the operation `source` names: shown once it has run SHOW_DELAY_MS, then, when it ends, with how main says it
 * ended (a `last` newer than the one seen as it started) for a moment before it leaves. A cancel, or no outcome within
 * OUTCOME_WAIT_MS, leaves without one.
 */
function track(source: () => TrackState, slot: typeof cloneRow): () => void {
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  // the outcome seq seen as the shown operation started; past it, an outcome is this operation's
  let baseline = -1;
  // the row ended and waits for main's outcome
  let awaiting = false;

  const leave = (after: number): void => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      slot.value = null;
    }, after);
  };

  const show = (row: Row): void => {
    slot.value = row;
    status.value = labelOf(row);
  };

  const finish = (last: Outcome): void => {
    awaiting = false;
    const row = slot.value;
    if (row) status.value = endedText(row, last);
    if (!row || last.outcome === 'cancelled') {
      slot.value = null;
      return;
    }
    const phase = endedPhase(last);
    slot.value = { ...row, phase };
    leave(phase === 'done' ? DONE_MS : FAILED_MS);
  };

  const stop = watch(source, ({ active, last, key }, previous) => {
    const was = previous?.active ?? null;
    if (active && was && active.key === was.key && active.kind === was.kind) return;
    if (active) {
      clearTimeout(showTimer);
      clearTimeout(leaveTimer);
      awaiting = false;
      baseline = last?.seq ?? -1;
      const row: Row = { ...active, phase: 'running', cancelling: false };
      // a row still finishing, or one of another repository, gives way to the new operation at once
      if (slot.value) show(row);
      else showTimer = setTimeout(() => show(row), SHOW_DELAY_MS);
      return;
    }
    if (was) {
      clearTimeout(showTimer);
      if (!slot.value) return;
      awaiting = true;
      leave(OUTCOME_WAIT_MS);
    }
    // a repository switch drops the row of the one left behind
    if (slot.value && slot.value.key !== key) {
      clearTimeout(leaveTimer);
      awaiting = false;
      slot.value = null;
      return;
    }
    if (awaiting && last && last.seq > baseline) finish(last);
  }, { immediate: true });

  return () => {
    stop();
    clearTimeout(showTimer);
    clearTimeout(leaveTimer);
  };
}

const stops = [
  track(() => {
    const { running, last } = store.clone.value;
    return { key: null, active: running ? { key: null, kind: 'clone', name: running.name } : null, last: last && { ...last, stashKept: false } };
  }, cloneRow),
  track(() => ({
    key: props.repoId ?? null,
    active: props.repoId !== undefined && props.running ? { key: props.repoId, kind: props.running, name: '' } : null,
    last: props.lastRemote,
  }), opRow),
];
onBeforeUnmount(() => {
  for (const stop of stops) stop();
});

const labelId = (index: number): string => `${baseId}-label-${index}`;

function cancel(row: Row): void {
  const slot = row.key === null ? cloneRow : opRow;
  if (row.phase !== 'running' || row.cancelling || slot.value !== row) return;
  slot.value = { ...row, cancelling: true };
  void store.api.run(row.key === null ? { op: 'cancelClone' } : { op: 'cancel', repoId: row.key });
}

// What stays in place while a row comes or goes starts where it stood and glides into place (FLIP, by transform only).
const root = ref<HTMLElement | null>(null);
// Where each staying child stood before the patch: taken at its first row change, since one patch can bring or take both rows.
let before: Map<HTMLElement, { top: number; offsetTop: number }> | null = null;
const moving = (element: Element): boolean => element.classList.contains('t-progress-enter-active') || element.classList.contains('t-progress-leave-active');

function measure(): void {
  if (before || !root.value) return;
  before = new Map();
  for (const child of root.value.children) {
    if (child instanceof HTMLElement && !moving(child)) before.set(child, { top: child.getBoundingClientRect().top, offsetTop: child.offsetTop });
  }
  // after the patch's last enter and leave hooks, which run within the flush
  queueMicrotask(glide);
}

function glide(): void {
  const tops = before;
  before = null;
  for (const [element, { top }] of tops ?? []) {
    if (!element.isConnected || moving(element)) continue;
    // measured without its glide, so a glide in progress continues from where it shows
    element.classList.remove('d-shift');
    const delta = top - element.getBoundingClientRect().top;
    if (delta === 0) continue;
    element.style.setProperty('--shift', `${delta}px`);
    void element.offsetWidth;
    element.classList.add('d-shift');
  }
}

// A leaving row is taken out of flow where it stood, so what follows can move up under it as it tucks away.
function beforeLeave(element: Element): void {
  measure();
  const row = element as HTMLElement;
  row.style.top = `${before?.get(row)?.offsetTop ?? row.offsetTop}px`;
  // its test id and label id belong to the live row; the copy on its way out is presentation only
  row.setAttribute('aria-hidden', 'true');
  row.querySelector('[data-testid="scm-progress"]')?.removeAttribute('data-testid');
  for (const labelled of row.querySelectorAll('[id]')) labelled.removeAttribute('id');
  releaseFocus(row);
}

// A Cancel that goes away with focus on it would drop focus to the page.
function releaseFocus(element: Element): void {
  if (element.contains(document.activeElement)) emit('releaseFocus');
}

function endShift(event: AnimationEvent): void {
  if (event.animationName !== 'd-shift' || event.target !== event.currentTarget) return;
  (event.currentTarget as HTMLElement).classList.remove('d-shift');
}
</script>

<template>
  <div
    ref="root"
    class="relative flex min-h-0 flex-1 flex-col"
  >
    <p
      role="status"
      aria-live="polite"
      data-testid="scm-progress-status"
      class="sr-only"
    >
      {{ status }}
    </p>
    <Transition
      v-for="(row, index) in slots"
      :key="index"
      name="t-progress"
      @before-enter="measure"
      @before-leave="beforeLeave"
    >
      <div
        v-if="row"
        :key="row.key ?? 'clone'"
        class="shrink-0 overflow-clip px-2.5 pt-0.5 pb-1.5"
        @animationend="endShift"
      >
        <div
          data-testid="scm-progress"
          :data-kind="row.kind"
          :data-phase="row.phase"
          class="d-progress-card relative flex h-7 items-center gap-1.5 overflow-hidden rounded-7 border border-(--d-border2) bg-(--d-card) pr-0.75 pl-2"
        >
          <Transition name="t-fade">
            <span
              v-if="row.phase === 'failed'"
              aria-hidden="true"
              class="absolute inset-0 bg-(--d-danger)/12"
            />
            <span
              v-else-if="row.phase === 'warning'"
              aria-hidden="true"
              class="absolute inset-0 bg-(--d-warning)/12"
            />
          </Transition>
          <span class="relative inline-flex size-3.25 shrink-0">
            <Transition name="t-icon">
              <Check
                v-if="row.phase === 'done'"
                key="done"
                aria-hidden="true"
                class="size-3.25 text-(--d-success-text)"
              />
              <TriangleAlert
                v-else-if="row.phase === 'warning'"
                key="warning"
                aria-hidden="true"
                class="size-3.25 text-(--d-warning-text)"
              />
              <CircleAlert
                v-else-if="row.phase === 'failed'"
                key="failed"
                aria-hidden="true"
                class="size-3.25 text-(--d-danger-text)"
              />
              <component
                :is="ICONS[row.kind]"
                v-else
                key="running"
                aria-hidden="true"
                class="size-3.25 text-(--d-accent-text)"
              />
            </Transition>
          </span>
          <span
            :id="labelId(index)"
            data-testid="scm-progress-label"
            class="relative min-w-0 flex-1 truncate text-11.5 text-(--d-text)"
          >{{ labelOf(row) }}</span>
          <!-- aria-disabled, not disabled, while the cancel is under way: disabling the focused button would drop focus. -->
          <Transition
            name="t-fade"
            @before-leave="releaseFocus"
          >
            <Button
              v-if="row.phase === 'running'"
              type="button"
              variant="ghost"
              size="sm"
              data-testid="scm-progress-cancel"
              class="d-press relative h-5.5 shrink-0 rounded-5 px-2 text-11.5 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 aria-disabled:cursor-default aria-disabled:opacity-50"
              :aria-describedby="labelId(index)"
              :aria-disabled="row.cancelling || undefined"
              @click="cancel(row)"
            >
              {{ t('scm.progress.cancel') }}
            </Button>
          </Transition>
          <Transition name="t-fade">
            <div
              v-if="row.phase === 'running'"
              role="progressbar"
              :aria-labelledby="labelId(index)"
              class="d-sweep-bar absolute inset-x-0 bottom-0 h-0.5 bg-(--d-accent)/15 text-(--d-accent)"
            />
          </Transition>
        </div>
      </div>
    </Transition>
    <div
      class="flex min-h-0 flex-1 flex-col"
      @animationend="endShift"
    >
      <slot />
    </div>
  </div>
</template>
