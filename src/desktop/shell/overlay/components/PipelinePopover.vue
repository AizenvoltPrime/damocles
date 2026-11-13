<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWindowSize } from '@vueuse/core';
import { CircleStop, ExternalLink, LoaderCircle, RotateCcw, ScrollText, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { CI_ACTIVE_STATES, plainCiTarget, type CiAction, type CiJobView, type CiPipelineView, type CiStatusView, type CiTarget } from '@shared/forge/ci';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { answerOf } from '../popup-answer';
import { placePanel } from '../placement';
import { trapTab } from '../focus-trap';
import { ciDuration, ciJobKeys, ciJobLook, ciJobStateWord, ciLook, ciOtherCommit, ciPipelineName, ciStageName, ciStateWord, jobsByStage } from '../../forge/ci-view';

// The CI job list: the pipeline of the repository's CI chip, end-aligned under it, with its jobs by stage and their actions,
// kept live by main's pushes while it is open. Custom markup: the reference's popover is no shadcn part.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'pipeline' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();
const translate = (key: string, values?: Record<string, unknown>): string => (values ? t(key, values) : t(key));

// rem: the panel's widest, and the room it keeps from the window's edges (22rem, the window less 1rem)
const WIDTH_REM = 22;
const EDGE_REM = 1;
// Jobs waiting for a start (or never started) have no log to open yet.
const NO_LOG_STATES: ReadonlySet<CiJobView['state']> = new Set(['created', 'pending', 'scheduled', 'manual', 'skipped']);

const titleId = useId();
const panel = ref<HTMLElement | null>(null);
const status = shallowRef<CiStatusView | null | undefined>(undefined);
const loadFailed = ref(false);
const announcement = ref('');
const alert = ref('');

const pipeline = computed<CiPipelineView | undefined>(() => (status.value?.status === 'ready' ? status.value.pipeline : undefined));
// GitHub: each workflow's heading carries its run's actions
const stages = computed(() => jobsByStage(pipeline.value?.jobs ?? []).map((group) => ({ ...group, run: pipeline.value?.runs?.find((run) => run.stage === group.stage) })));
const pipelineName = computed(() => (pipeline.value ? ciPipelineName(pipeline.value, translate) : t('forge.ci.pipeline.unknown')));
const progress = computed(() => {
  const shown = pipeline.value;
  if (!shown) return '';
  return shown.state === 'running' ? t('forge.ci.pipeline.progress', { done: shown.jobsDone, total: shown.jobsTotal }) : ciStateWord(shown.state, translate);
});
const meta = computed(() => {
  const shown = pipeline.value;
  if (!shown) return '';
  return [shown.ref, shown.durationSeconds === undefined ? undefined : ciDuration(shown.durationSeconds, translate)].filter((part) => part !== undefined).join(' · ');
});
const otherCommit = computed(() => (status.value?.status === 'ready' ? ciOtherCommit(status.value) : undefined));
const jobKeys = computed(() => ciJobKeys(pipeline.value?.jobs ?? []));
const keyOf = (job: CiJobView): string => jobKeys.value.get(job.id) ?? `id:${job.id}`;
const stageId = (at: number): string => `${titleId}-stage-${at}`;
// the targets whose action runs: a second press waits for the first, so a double click never retries twice
const pending = reactive(new Set<string>());
const targetKey = (target: CiTarget): string => JSON.stringify(plainCiTarget(target));
const isPending = (target: CiTarget): boolean => pending.has(targetKey(target));

const viewport = useWindowSize();
const placed = computed(() => {
  const width = Math.min(remPx(WIDTH_REM), viewport.width.value - remPx(EDGE_REM));
  const place = placePanel(props.request.anchor, width, { width: viewport.width.value, height: viewport.height.value }, 'end');
  return {
    style: {
      left: `${place.left}px`,
      width: `${width}px`,
      ...('top' in place ? { top: `${place.top}px` } : { bottom: `${place.bottom}px` }),
      maxHeight: `${place.maxHeight}px`,
    },
    above: !('top' in place),
  };
});

const hasOpenLog = (job: CiJobView): boolean => job.hasLog && !NO_LOG_STATES.has(job.state);

function say(text: string): void {
  announcement.value = '';
  // the region empties first, so the same sentence twice is announced twice
  void nextTick(() => {
    announcement.value = text;
  });
}

// Finished and restarted jobs between two views, in words for the polite region.
function changesBetween(before: CiPipelineView, after: CiPipelineView): string[] {
  const beforeKeys = ciJobKeys(before.jobs);
  const afterKeys = ciJobKeys(after.jobs);
  const previous = new Map(before.jobs.map((job) => [beforeKeys.get(job.id), job.state]));
  const lines: string[] = [];
  for (const job of after.jobs) {
    const was = previous.get(afterKeys.get(job.id));
    if (was === undefined || was === job.state) continue;
    if (CI_ACTIVE_STATES.has(was) && !CI_ACTIVE_STATES.has(job.state)) {
      lines.push(t('forge.ci.announce.jobFinished', { job: job.name, state: ciJobStateWord(job, translate), done: after.jobsDone, total: after.jobsTotal }));
    } else if (!CI_ACTIVE_STATES.has(was) && CI_ACTIVE_STATES.has(job.state)) {
      lines.push(t('forge.ci.announce.jobRestarted', { job: job.name }));
    }
  }
  if (CI_ACTIVE_STATES.has(before.state) && !CI_ACTIVE_STATES.has(after.state)) lines.push(t('forge.ci.announce.pipelineFinished', { name: ciPipelineName(after, translate), state: ciStateWord(after.state, translate) }));
  return lines;
}

// The control focus was on, by its group (the pipeline or one job) and role, so a re-render that replaces it (Retry by
// Cancel) hands focus to its replacement: the group's action for an action, the same control otherwise.
function focusedControl(): { readonly group: string; readonly role: string } | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !panel.value?.contains(active)) return undefined;
  const group = active.closest<HTMLElement>('[data-control-group]')?.dataset['controlGroup'];
  const role = active.dataset['role'];
  return group === undefined || role === undefined ? undefined : { group, role };
}

function show(next: CiStatusView | null): void {
  const before = pipeline.value;
  const control = focusedControl();
  status.value = next;
  const after = pipeline.value;
  if (before && after && before.id === after.id && before.sha === after.sha) {
    const lines = changesBetween(before, after);
    if (lines.length > 0) say(lines.join(' '));
  }
  if (control === undefined) return;
  void nextTick(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && panel.value?.contains(active) && active !== panel.value) return;
    const group = [...(panel.value?.querySelectorAll<HTMLElement>('[data-control-group]') ?? [])].find((each) => each.dataset['controlGroup'] === control.group);
    const role = control.role === 'log' ? 'log' : 'action';
    (group?.querySelector<HTMLElement>(`[data-role="${role}"]`) ?? group?.querySelector<HTMLElement>('[data-role]') ?? panel.value)?.focus();
  });
}

async function load(): Promise<void> {
  loadFailed.value = false;
  try {
    const next = await answerOf(props.api.forgePipeline(props.request.repoId));
    // undefined: the popover is on its way out
    if (next !== undefined && status.value === undefined) show(next);
  } catch (error) {
    console.error('[ci] main refused the pipeline read', error);
    loadFailed.value = true;
  }
}

async function act(target: CiTarget, action: CiAction, name: string): Promise<void> {
  const key = targetKey(target);
  if (pending.has(key)) return;
  pending.add(key);
  alert.value = '';
  let done: boolean | undefined;
  try {
    done = await answerOf(props.api.forgeJobAction(props.request.repoId, target, action));
  } catch (error) {
    console.error(`[ci] main refused ${action}`, error);
    done = false;
  } finally {
    pending.delete(key);
  }
  if (done === false) alert.value = t(`forge.ci.actionFailed.${action}`, { name });
}

async function openLog(job: CiJobView): Promise<void> {
  try {
    await answerOf(props.api.forgeJobLogOpen(props.request.repoId, job.id));
  } catch (error) {
    console.error('[ci] main refused to open the job log', error);
    alert.value = t('forge.ci.openLogFailed', { job: job.name });
    return;
  }
  emit('answer', { kind: 'dismissed' });
}

async function openOnServer(): Promise<void> {
  const shown = pipeline.value;
  if (!shown) return;
  let server: string | null | undefined;
  try {
    // GitHub's checks are the commit's, which its checks page shows
    const target: CiTarget = shown.kind === 'github' && shown.sha !== undefined ? { sha: shown.sha } : { pipelineId: shown.id };
    server = await answerOf(props.api.forgeOpenOnServer(props.request.repoId, target));
  } catch (error) {
    console.error('[ci] main refused to open the pipeline', error);
    server = null;
  }
  if (server === undefined) return;
  if (server === null) alert.value = t('forge.ci.openFailed');
  else say(t('forge.ci.opened', { thing: pipelineName.value, server }));
}

function onKeydown(event: KeyboardEvent): void {
  if (panel.value) trapTab(event, panel.value);
}

const stops: Array<() => void> = [];
onMounted(async () => {
  // Subscribed before the first read, so a change between the two is not lost; a push is always the newer status.
  stops.push(props.api.onForgeCiChanged((changed) => {
    if (changed.repoId === props.request.repoId) show(changed.status);
  }));
  await nextTick();
  panel.value?.focus();
  await load();
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
});

const ACTION = 'd-press size-5.5 shrink-0 rounded-6 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:bg-transparent [&_svg]:size-3.5';
</script>

<template>
  <section
    ref="panel"
    role="dialog"
    tabindex="-1"
    data-testid="forge-pipeline"
    :aria-label="pipelineName"
    :data-placement="placed.above ? 'above' : 'below'"
    class="pipeline-popover fixed flex flex-col overflow-hidden rounded-11 border border-(--d-border2) bg-(--d-card) text-(--d-text) shadow-(--d-shadow) outline-none"
    :style="placed.style"
    @keydown="onKeydown"
  >
    <template v-if="pipeline">
      <header class="flex shrink-0 items-center gap-2 border-b border-(--d-border) py-2.5 ps-3 pe-2">
        <span
          aria-hidden="true"
          class="inline-flex size-3.5 shrink-0 [&_svg]:size-3.5"
          :class="ciLook(pipeline.state).spin ? 'd-spinning' : ''"
        >
          <Transition
            name="t-icon"
            mode="out-in"
          >
            <component
              :is="ciLook(pipeline.state).icon"
              :key="pipeline.state"
              :class="ciLook(pipeline.state).tone"
            />
          </Transition>
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span
            :id="titleId"
            data-testid="forge-pipeline-title"
            class="truncate text-12.5 font-semibold"
          >{{ pipelineName }} · {{ progress }}</span>
          <span
            v-if="meta || otherCommit"
            class="flex min-w-0 items-center gap-1.5"
          >
            <span
              v-if="meta"
              dir="ltr"
              data-testid="forge-pipeline-meta"
              class="truncate text-start font-mono text-11 text-(--d-faint-text)"
            >{{ meta }}</span>
            <span
              v-if="otherCommit"
              data-testid="forge-pipeline-other-commit"
              class="d-fade-in shrink-0 rounded-5 bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] px-1 font-mono text-10.5 text-(--d-warning-text)"
              :title="t('forge.ci.otherCommit', { sha: otherCommit })"
            ><span aria-hidden="true">{{ otherCommit }}</span><span class="sr-only">{{ t('forge.ci.otherCommit', { sha: otherCommit }) }}</span></span>
          </span>
        </span>
        <span
          class="flex shrink-0"
          data-control-group="pipeline"
        >
          <Button
            v-if="pipeline.canCancel"
            key="cancel"
            type="button"
            variant="ghost"
            size="icon"
            data-role="action"
            data-testid="forge-pipeline-cancel"
            :class="ACTION"
            :aria-disabled="isPending({ pipelineId: pipeline.id }) || undefined"
            :aria-label="t('forge.ci.pipeline.cancel')"
            :title="t('forge.ci.pipeline.cancel')"
            @click="act({ pipelineId: pipeline.id }, 'cancel', pipelineName)"
          >
            <LoaderCircle
              v-if="isPending({ pipelineId: pipeline.id })"
              aria-hidden="true"
              class="d-spinning"
            />
            <CircleStop
              v-else
              aria-hidden="true"
            />
          </Button>
          <Button
            v-else-if="pipeline.canRetry"
            key="retry"
            type="button"
            variant="ghost"
            size="icon"
            data-role="action"
            data-testid="forge-pipeline-retry"
            :class="ACTION"
            :aria-disabled="isPending({ pipelineId: pipeline.id }) || undefined"
            :aria-label="t('forge.ci.pipeline.retry')"
            :title="t('forge.ci.pipeline.retry')"
            @click="act({ pipelineId: pipeline.id }, 'retry', pipelineName)"
          >
            <LoaderCircle
              v-if="isPending({ pipelineId: pipeline.id })"
              aria-hidden="true"
              class="d-spinning"
            />
            <RotateCcw
              v-else
              aria-hidden="true"
            />
          </Button>
        </span>
      </header>
      <!-- One labelled group per stage, its heading holding the run's actions, then the stage's jobs as a list. -->
      <div
        data-testid="forge-pipeline-jobs"
        class="min-h-0 max-h-72 flex-1 overflow-y-auto pb-1"
      >
        <div
          v-for="(group, at) in stages"
          :key="`${at}\u0000${group.stage}`"
          role="group"
          :aria-labelledby="stageId(at)"
          data-testid="forge-pipeline-group"
        >
          <div
            data-testid="forge-pipeline-stage"
            :data-control-group="group.run ? `run:${group.run.id}` : undefined"
            class="flex min-h-6 items-center gap-2 ps-3 pe-1.5 pt-2 pb-0.5 text-10.5 text-(--d-faint-text)"
          >
            <span
              :id="stageId(at)"
              class="min-w-0 flex-1 truncate"
            >{{ ciStageName(group.stage, translate) }}</span>
            <Button
              v-if="group.run?.canCancel"
              key="cancel"
              type="button"
              variant="ghost"
              size="icon"
              data-role="action"
              data-testid="forge-pipeline-run-action"
              data-action="cancel"
              :class="ACTION"
              :aria-disabled="isPending({ runId: group.run.id }) || undefined"
              :aria-label="t('forge.ci.run.cancel', { run: group.stage })"
              :title="t('forge.ci.run.cancel', { run: group.stage })"
              @click="act({ runId: group.run.id }, 'cancel', group.stage)"
            >
              <LoaderCircle
                v-if="isPending({ runId: group.run.id })"
                aria-hidden="true"
                class="d-spinning"
              />
              <CircleStop
                v-else
                aria-hidden="true"
              />
            </Button>
            <Button
              v-else-if="group.run?.canRetry"
              key="retry"
              type="button"
              variant="ghost"
              size="icon"
              data-role="action"
              data-testid="forge-pipeline-run-action"
              data-action="retry"
              :class="ACTION"
              :aria-disabled="isPending({ runId: group.run.id }) || undefined"
              :aria-label="t('forge.ci.run.retry', { run: group.stage })"
              :title="t('forge.ci.run.retry', { run: group.stage })"
              @click="act({ runId: group.run.id }, 'retry', group.stage)"
            >
              <LoaderCircle
                v-if="isPending({ runId: group.run.id })"
                aria-hidden="true"
                class="d-spinning"
              />
              <RotateCcw
                v-else
                aria-hidden="true"
              />
            </Button>
          </div>
          <ul>
            <li
              v-for="job in group.jobs"
              :key="keyOf(job)"
              data-testid="forge-pipeline-job"
              :data-job="job.name"
              :data-state="job.state"
              :data-control-group="`job:${keyOf(job)}`"
              class="flex min-h-7 items-center gap-2 ps-3 pe-1.5 text-12 hover:bg-(--d-hover) focus-within:bg-(--d-hover)"
            >
              <span
                aria-hidden="true"
                class="inline-flex size-3.25 shrink-0 [&_svg]:size-3.25"
                :class="ciJobLook(job).spin ? 'd-spinning' : ''"
              >
                <Transition
                  name="t-icon"
                  mode="out-in"
                >
                  <component
                    :is="ciJobLook(job).icon"
                    :key="job.allowedFailure ? 'allowedFailure' : job.state"
                    data-testid="forge-pipeline-job-icon"
                    :data-icon="job.allowedFailure ? 'allowedFailure' : job.state"
                    :class="ciJobLook(job).tone"
                  />
                </Transition>
              </span>
              <span class="min-w-0 flex-1 truncate">{{ job.name }}<span class="sr-only">, {{ ciJobStateWord(job, translate) }}</span></span>
              <!-- a job that never ran shows its state where the others show their time, as the design's "manual" -->
              <span
                v-if="job.durationSeconds !== undefined"
                class="shrink-0 font-mono text-10.5 text-(--d-faint)"
              >{{ ciDuration(job.durationSeconds, translate) }}</span>
              <span
                v-else-if="NO_LOG_STATES.has(job.state)"
                aria-hidden="true"
                class="shrink-0 font-mono text-10.5 text-(--d-faint)"
              >{{ ciStateWord(job.state, translate) }}</span>
              <Button
                v-if="job.canCancel"
                key="cancel"
                type="button"
                variant="ghost"
                size="icon"
                data-role="action"
                data-testid="forge-pipeline-job-action"
                data-action="cancel"
                :class="ACTION"
                :aria-disabled="isPending({ jobId: job.id }) || undefined"
                :aria-label="t('forge.ci.job.cancel', { job: job.name })"
                :title="t('forge.ci.job.cancel', { job: job.name })"
                @click="act({ jobId: job.id }, 'cancel', job.name)"
              >
                <LoaderCircle
                  v-if="isPending({ jobId: job.id })"
                  aria-hidden="true"
                  class="d-spinning"
                />
                <CircleStop
                  v-else
                  aria-hidden="true"
                />
              </Button>
              <Button
                v-else-if="job.canRetry"
                key="retry"
                type="button"
                variant="ghost"
                size="icon"
                data-role="action"
                data-testid="forge-pipeline-job-action"
                data-action="retry"
                :class="ACTION"
                :aria-disabled="isPending({ jobId: job.id }) || undefined"
                :aria-label="t('forge.ci.job.retry', { job: job.name })"
                :title="t('forge.ci.job.retry', { job: job.name })"
                @click="act({ jobId: job.id }, 'retry', job.name)"
              >
                <LoaderCircle
                  v-if="isPending({ jobId: job.id })"
                  aria-hidden="true"
                  class="d-spinning"
                />
                <RotateCcw
                  v-else
                  aria-hidden="true"
                />
              </Button>
              <Button
                v-if="hasOpenLog(job)"
                type="button"
                variant="ghost"
                size="icon"
                data-role="log"
                data-testid="forge-pipeline-open-log"
                :class="ACTION"
                :aria-label="t('forge.ci.job.openLog', { job: job.name })"
                :title="t('forge.ci.job.openLog', { job: job.name })"
                @click="openLog(job)"
              >
                <ScrollText aria-hidden="true" />
              </Button>
            </li>
          </ul>
        </div>
      </div>
      <p
        v-if="pipeline.truncated"
        data-testid="forge-pipeline-truncated"
        class="shrink-0 border-t border-(--d-border) px-3 py-2 text-11.5 text-(--d-muted)"
      >
        {{ t('forge.ci.pipeline.truncated', { server: pipeline.serverName }) }}
      </p>
      <footer class="flex shrink-0 items-center gap-2 border-t border-(--d-border) px-3 py-2 text-11.5">
        <button
          type="button"
          data-testid="forge-pipeline-open"
          class="inline-flex items-center gap-1 text-(--d-accent-text) underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          @click="openOnServer"
        >
          {{ t(pipeline.kind === 'github' ? 'forge.ci.checks.openOn' : 'forge.ci.pipeline.openOn', { server: pipeline.serverName }) }}<ExternalLink
            aria-hidden="true"
            class="size-3"
          />
        </button>
      </footer>
    </template>
    <div
      v-else-if="status?.status === 'error' || loadFailed"
      role="alert"
      data-testid="forge-pipeline-error"
      class="flex flex-col items-start gap-2 px-3 py-4 text-12 text-(--d-muted)"
    >
      <span class="flex items-start gap-1.5">
        <TriangleAlert
          aria-hidden="true"
          class="mt-0.5 size-3.5 shrink-0 text-(--d-warning-text)"
        />{{ status?.status === 'error' ? status.message : t('forge.ci.readFailed') }}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="forge-pipeline-retry-read"
        class="d-press h-7 gap-1.5 rounded-8 border-(--d-border2) bg-transparent px-2.75 text-12 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
        @click="status = undefined; load()"
      >
        <RotateCcw aria-hidden="true" />{{ t('forge.ci.tryAgain') }}
      </Button>
    </div>
    <p
      v-else-if="status === null || status?.status === 'none'"
      data-testid="forge-pipeline-none"
      class="px-3 py-4 text-12 text-(--d-muted)"
    >
      {{ t('forge.ci.pipeline.none') }}
    </p>
    <div
      v-else
      role="status"
      aria-busy="true"
      data-testid="forge-pipeline-loading"
      :aria-label="t('forge.ci.chip.loading')"
      class="flex flex-col gap-2.5 px-3 py-3.5"
    >
      <span
        v-for="width in ['w-40', 'w-56', 'w-32']"
        :key="width"
        aria-hidden="true"
        class="relative block h-2 max-w-full overflow-hidden rounded-full bg-(--d-border2) text-(--d-text)"
        :class="width"
      ><span class="d-sheen" /></span>
    </div>
    <p
      v-if="alert"
      role="alert"
      data-testid="forge-pipeline-alert"
      class="border-t border-(--d-border) px-3 py-2 text-11.5 text-(--d-danger-text)"
    >
      {{ alert }}
    </p>
    <p
      role="status"
      aria-live="polite"
      data-testid="forge-pipeline-status"
      class="sr-only"
    >
      {{ announcement }}
    </p>
  </section>
</template>
