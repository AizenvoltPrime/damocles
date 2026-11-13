<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDownToLine, CircleStop, Clock, ExternalLink, ListCollapse, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { CI_ACTIVE_STATES, type CiAction, type CiJobView } from '@shared/forge/ci';
import type { DamoclesShellApi, ShellEditorTab } from '../../preload/shell-channels';
import { ciDuration, ciLook, ciStateWord } from './ci-view';
import { jobLogSession, type JobLogApplied } from './job-log-session';
import JobLogView from './JobLogView.vue';

/**
 * The job log tab: the toolbar and the log's states over the tab's session, which keeps the parser and the log while the
 * tab is open, so showing the tab again parses nothing.
 */
const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab & { jobLog: NonNullable<ShellEditorTab['jobLog']> } }>();
const { t } = useI18n();
const translate = (key: string, values?: Record<string, unknown>): string => (values ? t(key, values) : t(key));

// ms a burst of new lines keeps its arrival animation armed
const ARRIVE_MS = 600;

const { session, created } = jobLogSession(props.api, props.tab.id, () => t('forge.log.readFailed'));
const { view, log, parser, provisional, revision, generation } = session;
const arrivedFrom = ref<number | null>(null);
let arriveTimer: ReturnType<typeof setTimeout> | undefined;
const follow = ref(true);
const timestamps = ref(true);
const status = ref('');
const alert = ref('');
// the action and the read under way: a second press waits for the first, so a double click never retries twice
const acting = ref<CiAction | null>(null);
const reading = ref(false);
const logView = ref<InstanceType<typeof JobLogView> | null>(null);
const toolbar = ref<HTMLElement | null>(null);

const job = computed<CiJobView | undefined>(() => ('job' in view.value ? view.value.job : undefined) ?? log.value?.job);
const jobName = computed(() => job.value?.name ?? props.tab.jobLog.jobName);
const serverName = computed(() => ('serverName' in view.value ? view.value.serverName : undefined) ?? log.value?.serverName);
// a later read's failure over the log the tab holds
const failure = computed(() => {
  if (!log.value) return undefined;
  return view.value.status === 'error' ? view.value.message : view.value.status === 'ready' ? view.value.error : undefined;
});
const live = computed(() => log.value?.live === true);
const action = computed<CiAction | undefined>(() => (job.value?.canCancel ? 'cancel' : job.value?.canRetry ? 'retry' : undefined));
const meta = computed(() => {
  const shown = job.value;
  if (!shown) return '';
  return [
    shown.stage,
    log.value?.pipeline.ref,
    shown.durationSeconds === undefined ? undefined : ciDuration(shown.durationSeconds, translate),
    shown.runner === undefined ? undefined : t('forge.log.runner', { runner: shown.runner }),
  ].filter((part) => part !== undefined && part !== '').join(' · ');
});
const tail = computed(() => {
  const shown = job.value;
  if (!log.value || live.value || !shown) return undefined;
  const duration = shown.durationSeconds === undefined ? undefined : ciDuration(shown.durationSeconds, translate);
  const word = shown.state === 'passed' || shown.state === 'failed' || shown.state === 'canceled' ? shown.state : 'finished';
  const tone = shown.state === 'passed' ? 'text-(--d-success-text)' : shown.state === 'failed' ? 'text-(--d-danger-text)' : 'text-(--d-faint-text)';
  return { text: duration === undefined ? t(`forge.log.tail.${word}`) : t(`forge.log.tail.${word}In`, { duration }), tone };
});
// The view's list rows are fixed px, so 1rem changing remounts it, as a new log does.
const viewKey = computed(() => `${generation.value}:${Math.round(remPx(1.25))}`);

// The toolbar's one tab stop (roving tabindex): the control last focused while it shows, else the first.
type Tool = 'follow' | 'timestamps' | 'foldAll' | 'action' | 'open';
const tools = computed<Tool[]>(() => [
  ...(log.value ? (['follow', 'timestamps', 'foldAll'] as const) : []),
  ...(action.value ? (['action'] as const) : []),
  ...(log.value ? (['open'] as const) : []),
]);
const lastTool = ref<Tool>('follow');
const tabStop = computed(() => (tools.value.includes(lastTool.value) ? lastTool.value : tools.value[0]));
const tabindexOf = (tool: Tool): number => (tool === tabStop.value ? 0 : -1);

function onToolFocus(event: FocusEvent): void {
  const tool = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-tool]')?.dataset['tool'] as Tool | undefined;
  if (tool !== undefined) lastTool.value = tool;
}

// Arrow keys move along the toolbar in reading order, wrapping; Home and End go to its ends.
function onToolKeydown(event: KeyboardEvent): void {
  const list = tools.value;
  const at = tabStop.value === undefined ? -1 : list.indexOf(tabStop.value);
  if (at < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
  const rtl = toolbar.value !== null && getComputedStyle(toolbar.value).direction === 'rtl';
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = rtl ? 'ArrowRight' : 'ArrowLeft';
  let next: number;
  if (event.key === forward) next = (at + 1) % list.length;
  else if (event.key === back) next = (at - 1 + list.length) % list.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = list.length - 1;
  else return;
  event.preventDefault();
  lastTool.value = list[next]!;
  toolbar.value?.querySelector<HTMLElement>(`[data-tool="${list[next]!}"]`)?.focus();
}

function announce(text: string): void {
  status.value = '';
  // the region empties first, so the same sentence twice is announced twice
  void nextTick(() => {
    status.value = text;
  });
}

function arrive(from: number): void {
  clearTimeout(arriveTimer);
  if (prefersReducedMotion()) return;
  arrivedFrom.value = from;
  arriveTimer = setTimeout(() => {
    arrivedFrom.value = null;
  }, ARRIVE_MS);
}

// focus on the job's action when its replacement (Cancel by Retry) renders
const actionFocused = (): boolean => toolbar.value?.querySelector('[data-role="job-action"]') === document.activeElement;

// Runs as the session applies a view, before the tab renders it, so the focus it reads is the one the view may replace.
function applied({ before, next, arrivedFrom: from }: JobLogApplied): void {
  if (next.status === 'ready' && next.reset) arrivedFrom.value = null;
  else if (from !== undefined) arrive(from);
  const was = 'job' in before ? before.job : undefined;
  const now = 'job' in next ? next.job : undefined;
  if (was && now && was.id === now.id && CI_ACTIVE_STATES.has(was.state) && !CI_ACTIVE_STATES.has(now.state)) {
    announce(t('forge.log.finished', { job: now.name, state: ciStateWord(now.state, translate) }));
  }
  if (!actionFocused()) return;
  void nextTick(() => {
    if (!actionFocused()) toolbar.value?.querySelector<HTMLElement>('[data-role="job-action"]')?.focus();
  });
}

async function act(chosen: CiAction): Promise<void> {
  const shown = job.value;
  if (!shown || acting.value !== null) return;
  acting.value = chosen;
  alert.value = '';
  let done: boolean;
  try {
    done = await props.api.forge.jobAction(props.tab.jobLog.repoId, { jobId: shown.id }, chosen);
  } catch (error) {
    console.error(`[ci] main refused ${chosen}`, error);
    done = false;
  } finally {
    acting.value = null;
  }
  if (!done) alert.value = t(`forge.ci.actionFailed.${chosen}`, { name: shown.name });
}

// Try again over a kept log: what the read brings comes as an update, which replaces the failure
async function readAgain(): Promise<void> {
  if (reading.value) return;
  reading.value = true;
  alert.value = '';
  try {
    await props.api.forge.jobLogRead(props.tab.id);
  } catch (error) {
    console.error('[ci] main refused to read the job log', error);
    alert.value = t('forge.log.readFailed');
  } finally {
    reading.value = false;
  }
}

async function openOnServer(): Promise<void> {
  alert.value = '';
  let server: string | null;
  try {
    server = await props.api.forge.openOnServer(props.tab.jobLog.repoId, { jobId: job.value?.id ?? props.tab.jobLog.jobId });
  } catch (error) {
    console.error('[ci] main refused to open the job', error);
    server = null;
  }
  if (server === null) alert.value = t('forge.ci.openFailed');
  else announce(t('forge.ci.opened', { thing: jobName.value, server }));
}

// Find in log (Ctrl+F) from anywhere in the tab, its toolbar included.
function onKeydown(event: KeyboardEvent): void {
  if (!logView.value || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.code !== 'KeyF') return;
  event.preventDefault();
  logView.value.openFind();
}

const stopApplied = session.onApplied(applied);
onMounted(() => {
  props.api.forge.jobLogVisible(props.tab.id, true);
  // a log that could not be read is read again when the tab shows again; a log the tab holds stays as it is
  if (!created && view.value.status === 'error' && !log.value) void session.load();
});
onBeforeUnmount(() => {
  stopApplied();
  clearTimeout(arriveTimer);
  props.api.forge.jobLogVisible(props.tab.id, false);
});

const TOOL = 'd-press h-6.5 gap-1.5 rounded-7 px-2 text-12 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 aria-pressed:text-(--d-accent-text) aria-disabled:cursor-default aria-disabled:opacity-60 [&_svg]:size-3.25';
const OUTLINE = 'd-press h-7 gap-1.5 rounded-8 border-(--d-border2) bg-transparent px-2.75 text-12 font-normal hover:bg-(--d-hover) aria-disabled:cursor-default aria-disabled:opacity-60 [&_svg]:size-3';
</script>

<template>
  <div
    data-testid="job-log-tab"
    :data-state="view.status"
    class="@container/joblog absolute inset-0 flex min-h-0 flex-col"
    @keydown="onKeydown"
  >
    <div class="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-(--d-border) bg-(--d-bg) py-1 ps-3.5 pe-2">
      <div class="flex min-w-0 flex-[1_1_14rem] items-center gap-2 text-12">
        <span
          class="max-w-1/2 shrink-0 truncate font-semibold"
          data-testid="job-log-name"
        >{{ jobName }}</span>
        <span
          v-if="meta"
          dir="ltr"
          data-testid="job-log-meta"
          class="truncate font-mono text-11 text-(--d-faint-text)"
        >{{ meta }}</span>
        <span
          v-if="log?.truncated"
          data-testid="job-log-truncated"
          class="shrink-0 text-11 text-(--d-warning-text)"
        >{{ t('forge.log.truncated') }}</span>
      </div>
      <div
        v-if="tools.length > 0"
        ref="toolbar"
        role="toolbar"
        :aria-label="t('forge.log.toolbar')"
        class="flex flex-wrap items-center gap-0.5"
        @focusin="onToolFocus"
        @keydown="onToolKeydown"
      >
        <template v-if="log">
          <Button
            type="button"
            variant="ghost"
            data-tool="follow"
            data-testid="job-log-follow"
            :class="TOOL"
            :tabindex="tabindexOf('follow')"
            :aria-pressed="follow"
            :aria-label="t('forge.log.follow')"
            :title="t('forge.log.followTitle')"
            @click="follow = !follow"
          >
            <ArrowDownToLine aria-hidden="true" /><span
              aria-hidden="true"
              class="@max-[40rem]/joblog:hidden"
            >{{ t('forge.log.follow') }}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-tool="timestamps"
            data-testid="job-log-timestamps"
            :class="TOOL"
            :tabindex="tabindexOf('timestamps')"
            :aria-pressed="timestamps"
            :aria-label="t('forge.log.timestamps')"
            :title="t('forge.log.timestamps')"
            @click="timestamps = !timestamps"
          >
            <Clock aria-hidden="true" /><span
              aria-hidden="true"
              class="@max-[40rem]/joblog:hidden"
            >{{ t('forge.log.timestamps') }}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-tool="foldAll"
            data-testid="job-log-fold-all"
            :class="TOOL"
            :tabindex="tabindexOf('foldAll')"
            :aria-label="t('forge.log.foldAll')"
            :title="t('forge.log.foldAll')"
            @click="logView?.foldAll()"
          >
            <ListCollapse aria-hidden="true" /><span
              aria-hidden="true"
              class="@max-[40rem]/joblog:hidden"
            >{{ t('forge.log.foldAllShort') }}</span>
          </Button>
          <span
            aria-hidden="true"
            class="mx-1 h-4 w-px bg-(--d-border2)"
          />
        </template>
        <Button
          v-if="action === 'cancel'"
          key="cancel"
          type="button"
          variant="ghost"
          data-tool="action"
          data-role="job-action"
          data-testid="job-log-cancel"
          :class="TOOL"
          :tabindex="tabindexOf('action')"
          :aria-disabled="acting !== null || undefined"
          :aria-label="t('forge.log.cancel')"
          :title="t('forge.log.cancel')"
          @click="act('cancel')"
        >
          <LoaderCircle
            v-if="acting === 'cancel'"
            aria-hidden="true"
            class="d-spinning"
          />
          <CircleStop
            v-else
            aria-hidden="true"
          /><span
            aria-hidden="true"
            class="@max-[40rem]/joblog:hidden"
          >{{ t('forge.log.cancel') }}</span>
        </Button>
        <Button
          v-else-if="action === 'retry'"
          key="retry"
          type="button"
          variant="ghost"
          data-tool="action"
          data-role="job-action"
          data-testid="job-log-retry"
          :class="TOOL"
          :tabindex="tabindexOf('action')"
          :aria-disabled="acting !== null || undefined"
          :aria-label="t('forge.log.retry')"
          :title="t('forge.log.retry')"
          @click="act('retry')"
        >
          <LoaderCircle
            v-if="acting === 'retry'"
            aria-hidden="true"
            class="d-spinning"
          />
          <RotateCcw
            v-else
            aria-hidden="true"
          /><span
            aria-hidden="true"
            class="@max-[40rem]/joblog:hidden"
          >{{ t('forge.log.retry') }}</span>
        </Button>
        <Button
          v-if="log"
          type="button"
          variant="ghost"
          data-tool="open"
          data-testid="job-log-open"
          :class="TOOL"
          :tabindex="tabindexOf('open')"
          :aria-label="t('forge.log.openOn', { server: log.serverName })"
          :title="t('forge.log.openOn', { server: log.serverName })"
          @click="openOnServer"
        >
          <ExternalLink aria-hidden="true" /><span
            aria-hidden="true"
            class="@max-[40rem]/joblog:hidden"
          >{{ t('forge.log.openOn', { server: log.serverName }) }}</span>
        </Button>
      </div>
    </div>
    <p
      v-if="alert"
      role="alert"
      data-testid="job-log-alert"
      class="shrink-0 border-b border-(--d-border) px-3.5 py-1.5 text-12 text-(--d-danger-text)"
    >
      {{ alert }}
    </p>
    <Transition name="t-banner">
      <div
        v-if="failure !== undefined"
        role="alert"
        data-testid="job-log-banner"
        class="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-(--d-border) bg-[color-mix(in_srgb,var(--d-warning)_10%,var(--d-bg))] py-1.5 ps-3.5 pe-2 text-12 text-(--d-muted)"
      >
        <TriangleAlert
          aria-hidden="true"
          class="size-3.5 shrink-0 text-(--d-warning-text)"
        />
        <span class="min-w-0 flex-[1_1_16rem]"><span class="font-semibold text-(--d-text)">{{ t('forge.log.stale') }}</span> {{ failure }}</span>
        <Button
          type="button"
          variant="outline"
          data-testid="job-log-banner-try-again"
          :class="[OUTLINE, 'h-6.5 text-(--d-text)']"
          :aria-disabled="reading || undefined"
          @click="readAgain"
        >
          <LoaderCircle
            v-if="reading"
            aria-hidden="true"
            class="d-spinning"
          />
          <RotateCcw
            v-else
            aria-hidden="true"
          />{{ t('forge.ci.tryAgain') }}
        </Button>
      </div>
    </Transition>

    <JobLogView
      v-if="log && parser"
      ref="logView"
      :key="viewKey"
      v-model:follow="follow"
      v-model:timestamps="timestamps"
      :rows="parser.rows"
      :provisional="provisional"
      :sections="parser.sections"
      :revision="revision"
      :name="jobName"
      :live="live"
      :tail="tail"
      :arrived-from="arrivedFrom"
    />
    <div
      v-else-if="view.status === 'loading'"
      role="status"
      aria-busy="true"
      data-testid="job-log-loading"
      :aria-label="t('forge.log.loading', { job: jobName })"
      class="flex min-h-0 flex-1 flex-col gap-3 pt-3.5 ps-17 pe-4"
    >
      <span
        v-for="width in ['max-w-72', 'max-w-[min(26rem,60%)]', 'max-w-48', 'max-w-[min(22rem,55%)]', 'max-w-60']"
        :key="width"
        aria-hidden="true"
        class="relative block h-2 w-full overflow-hidden rounded-5 bg-(--d-border2) text-(--d-text)"
        :class="width"
      ><span class="d-sheen" /></span>
    </div>
    <div
      v-else-if="view.status === 'error'"
      role="alert"
      data-testid="job-log-error"
      class="d-fade-in mx-auto my-6 flex w-full max-w-120 flex-col items-start gap-2 px-4 text-12.5 text-(--d-muted)"
    >
      <span class="flex items-center gap-1.5 text-13.5 font-semibold text-(--d-text)">
        <TriangleAlert
          aria-hidden="true"
          class="size-3.5 text-(--d-warning-text)"
        />{{ t('forge.log.errorTitle') }}
      </span>
      <span>{{ view.message }}</span>
      <span class="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="job-log-try-again"
          :class="[OUTLINE, 'text-(--d-muted) hover:text-(--d-text)']"
          @click="session.load()"
        >
          <RotateCcw aria-hidden="true" />{{ t('forge.ci.tryAgain') }}
        </Button>
        <Button
          v-if="serverName"
          type="button"
          variant="outline"
          data-testid="job-log-error-open"
          :class="[OUTLINE, 'text-(--d-accent-text)']"
          @click="openOnServer"
        >
          {{ t('forge.log.openOn', { server: serverName }) }}<ExternalLink aria-hidden="true" />
        </Button>
      </span>
    </div>
    <div
      v-else-if="view.status === 'githubRunning'"
      data-testid="job-log-github-running"
      class="d-fade-in mx-auto my-6 flex w-full max-w-120 flex-col items-start gap-2 px-4 text-12.5 text-(--d-muted)"
    >
      <span class="text-13.5 font-semibold text-(--d-text)">{{ t('forge.log.githubRunning.title') }}</span>
      <span>{{ t('forge.log.githubRunning.text', { job: view.job.name }) }}</span>
      <ul
        :aria-label="t('forge.log.githubRunning.steps', { job: view.job.name })"
        data-testid="job-log-steps"
        class="flex w-full flex-col overflow-hidden rounded-10 border border-(--d-border)"
      >
        <li
          v-for="step in view.job.steps ?? []"
          :key="step.number"
          data-testid="job-log-step"
          :data-state="step.state"
          class="flex h-8 items-center gap-2 px-3 text-12 text-(--d-text) not-first:border-t not-first:border-(--d-border)"
        >
          <span
            aria-hidden="true"
            class="inline-flex size-3.25 shrink-0 [&_svg]:size-3.25"
            :class="ciLook(step.state).spin ? 'd-spinning' : ''"
          ><component
            :is="ciLook(step.state).icon"
            :class="ciLook(step.state).tone"
          /></span>
          <span class="min-w-0 truncate">{{ step.name }}<span class="sr-only">, {{ ciStateWord(step.state, translate) }}</span></span>
        </li>
      </ul>
      <Button
        type="button"
        variant="link"
        data-testid="job-log-open-github"
        class="h-auto gap-1 p-0 text-12.5 font-normal text-(--d-accent-text) underline-offset-2 focus-visible:underline focus-visible:ring-0 focus-visible:ring-offset-0 [&_svg]:size-3"
        @click="openOnServer"
      >
        {{ t('forge.log.githubRunning.open') }}<ExternalLink aria-hidden="true" />
      </Button>
    </div>
    <p
      role="status"
      aria-live="polite"
      data-testid="job-log-status"
      class="sr-only"
    >
      {{ status }}
    </p>
  </div>
</template>
