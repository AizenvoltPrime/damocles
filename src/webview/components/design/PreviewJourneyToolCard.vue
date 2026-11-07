<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleAlert, FileCode, FileText, LoaderCircle, RotateCcw, Route, X } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import type { JourneyStep, JourneyStepResult, JourneyViewport, PreviewJourneyDetails } from '@shared/types/design';
import { JOURNEY_STEP_TIMEOUT_MS, MAX_JOURNEY_STEPS, parseJourneyStep } from '@shared/design-journey';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useReplayDesignJourney } from '@/composables/useReplayDesignJourney';
import { useUIStore } from '@/stores/useUIStore';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import ToolCardFrame from '../ToolCardFrame.vue';
import ToolErrorStrip from '../ToolErrorStrip.vue';
import ToolBlockedReason from '../ToolBlockedReason.vue';
import JourneyStepText from './JourneyStepText.vue';
import { DESIGN_TILE } from './design-tone';

// A PreviewJourney call: its steps, each width's results, the untested remainder, and Replay in preview (desktop).
const props = defineProps<{ toolCall: ToolCall }>();
const { t, te } = useI18n();
const { rt } = useLocalizedText();
const uiStore = useUIStore();
const { available: canReplay, replay, start: startReplay } = useReplayDesignJourney(() => props.toolCall.id);

/** How long a live result's active step shows before its outcome, in ms. */
const REVEAL_STEP_MS = 170;

type StepState = 'pending' | 'waiting' | 'active' | 'pass' | 'fail' | 'notRun';

const details = computed(() => {
  const value = props.toolCall.metadata as Partial<PreviewJourneyDetails> | undefined;
  return props.toolCall.status === 'completed' && Array.isArray(value?.steps) && Array.isArray(value?.results) && Array.isArray(value?.viewports)
    ? (value as PreviewJourneyDetails)
    : undefined;
});

// Until the result lands, the card shows what the call asked for; an aborted call's stored arguments may be partial, and a
// refused call's may be malformed, so each step passes the journey format or is left out.
const argSteps = computed(() => {
  const steps = props.toolCall.input['steps'];
  return Array.isArray(steps) ? steps.flatMap((step) => parseJourneyStep(step) ?? []) : [];
});
const steps = computed<readonly JourneyStep[]>(() => details.value?.steps ?? argSteps.value);
const untested = computed<readonly string[]>(() => {
  if (details.value) return details.value.untested;
  const value = props.toolCall.input['untested'];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
});
const awaiting = computed(() => props.toolCall.status === 'pending' || props.toolCall.status === 'running');

const viewports = computed<readonly JourneyViewport[]>(() => details.value?.viewports ?? []);
const firstFailing = computed(() => Math.max(0, details.value?.results.findIndex((result) => !result.passed) ?? 0));
const chosen = ref<number | null>(null);
const selected = computed(() => Math.min(chosen.value ?? firstFailing.value, Math.max(0, viewports.value.length - 1)));
const selectedRun = computed(() => details.value?.results[selected.value]);

const widthLabel = (viewport: JourneyViewport): string => (viewport.breakpoint
  ? t('design.check.atBreakpoint', { breakpoint: viewport.breakpoint, width: viewport.width })
  : t('design.check.atWidth', { width: viewport.width }));
const widthOf = (width: number): string => {
  const viewport = viewports.value.find((candidate) => candidate.width === width);
  return viewport ? widthLabel(viewport) : t('design.check.atWidth', { width });
};
const passedSteps = (run: { steps: readonly JourneyStepResult[] }, upTo = Number.POSITIVE_INFINITY): number => run.steps.slice(0, upTo).filter((step) => step.ok).length;
const widthChips = computed(() => viewports.value.map((viewport, index) => {
  const run = details.value?.results[index];
  return { width: viewport.width, label: widthLabel(viewport), passed: run?.passed === true, count: run ? passedSteps(run) : 0 };
}));

// A live result plays back step by step over the selected width; a history load and reduced motion show it at once.
const revealed = ref(Number.POSITIVE_INFINITY);
let revealTimer: ReturnType<typeof setTimeout> | undefined;
function stopReveal(): void {
  clearTimeout(revealTimer);
  revealTimer = undefined;
  revealed.value = Number.POSITIVE_INFINITY;
}
function revealNext(): void {
  const ran = selectedRun.value?.steps.length ?? 0;
  if (revealed.value >= ran) {
    stopReveal();
    return;
  }
  revealTimer = setTimeout(() => {
    revealed.value += 1;
    revealNext();
  }, REVEAL_STEP_MS);
}
watch(() => props.toolCall.status, (status, previous) => {
  const live = (previous === 'pending' || previous === 'running') && status === 'completed';
  if (!live || !details.value || prefersReducedMotion()) return;
  revealed.value = 0;
  revealNext();
});
onBeforeUnmount(() => clearTimeout(revealTimer));
const revealing = computed(() => Number.isFinite(revealed.value));

function stateOf(index: number): StepState {
  const run = selectedRun.value;
  if (!run) return awaiting.value ? 'pending' : 'notRun';
  if (index > revealed.value) return 'waiting';
  if (index === revealed.value && index < run.steps.length) return 'active';
  const result = run.steps[index];
  if (!result) return 'notRun';
  return result.ok ? 'pass' : 'fail';
}

const rows = computed(() => steps.value.map((step, index) => {
  const state = stateOf(index);
  const result = state === 'fail' ? selectedRun.value?.steps[index] : undefined;
  return { step, index, state, result };
}));

const failureText = (result: JourneyStepResult): string => {
  if (result.failure === 'hidden' && result.hiddenAt !== undefined) return t('design.journey.hiddenAt', { width: widthOf(result.hiddenAt) });
  const failure = result.failure !== undefined && te(`design.journey.failure.${result.failure}`) ? result.failure : 'error';
  return t(`design.journey.failure.${failure}`, { seconds: JOURNEY_STEP_TIMEOUT_MS / 1000 });
};

// The header counts the weakest width, so a failure at any width shows; while a live result plays it counts what showed.
const counter = computed(() => {
  const value = details.value;
  if (!value || steps.value.length === 0 || value.results.length === 0) return undefined;
  const passed = revealing.value && selectedRun.value
    ? passedSteps(selectedRun.value, revealed.value)
    : Math.min(...value.results.map((run) => passedSteps(run)));
  return { passed, total: steps.value.length };
});

const frameStatus = computed<ToolCall['status']>(() => {
  if (revealing.value) return 'running';
  if (details.value && !details.value.passed) return 'failed';
  return props.toolCall.status;
});

const arg = computed(() => {
  const value = details.value;
  if (value) return value.state === 'default' ? value.screen : `${value.screen} · ${value.state}`;
  const screen = props.toolCall.input['screen'];
  return typeof screen === 'string' ? screen : undefined;
});

const replaying = computed(() => replay.value?.state === 'replaying');
const refusal = computed(() => (replay.value?.state === 'refused' ? replay.value.error : undefined));
const refusalText = computed(() => {
  if (refusal.value === undefined) return '';
  return refusal.value === null ? t('design.journey.replayFailed') : rt(refusal.value);
});

function onWidth(value: unknown): void {
  const index = viewports.value.findIndex((viewport) => String(viewport.width) === value);
  if (index === -1) return;
  stopReveal();
  chosen.value = index;
}

const ICON_CLASS: Record<StepState, string> = {
  pending: 'border border-dashed border-(--d-border2)',
  waiting: 'border border-(--d-border2)',
  active: 'bg-[color-mix(in_srgb,var(--d-design)_16%,transparent)] text-(--d-design-text)',
  pass: 'bg-[color-mix(in_srgb,var(--d-success)_16%,transparent)] text-(--d-success-text)',
  fail: 'bg-[color-mix(in_srgb,var(--d-danger)_18%,transparent)] text-(--d-danger-text)',
  notRun: 'border border-(--d-border)',
};
const ROW_CLASS: Record<StepState, string> = {
  pending: 'text-(--d-muted)',
  waiting: 'text-(--d-muted)',
  active: 'bg-[color-mix(in_srgb,var(--d-design)_8%,transparent)] text-(--d-text)',
  pass: 'text-(--d-text)',
  fail: 'bg-[color-mix(in_srgb,var(--d-danger)_7%,transparent)] text-(--d-text)',
  notRun: 'text-(--d-faint-text)',
};
</script>

<template>
  <ToolCardFrame
    :icon="Route"
    :name="t('design.tools.previewJourney')"
    :arg="arg"
    :status="frameStatus"
    :tile-class="DESIGN_TILE"
    expandable
    :duration-ms="toolCall.durationMs"
    status-note
    :abandon-reason="toolCall.abandonReason"
    :data-tool="toolCall.name"
    data-testid="preview-journey-card"
    :data-passed="details ? String(details.passed) : undefined"
    :data-revealing="revealing || undefined"
    @expand="uiStore.expandTool(toolCall.id, 'session')"
  >
    <template #meta>
      <span
        v-if="counter"
        class="flex h-4.5 flex-none items-center rounded-full px-1.75 font-mono text-10.5 font-semibold tabular-nums"
        :class="counter.passed === counter.total ? 'bg-[color-mix(in_srgb,var(--d-success)_14%,transparent)] text-(--d-success-text)' : revealing ? 'bg-(--d-hover) text-(--d-muted)' : 'bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)] text-(--d-danger-text)'"
        data-testid="preview-journey-counter"
      >
        <span
          class="flex items-center"
          aria-hidden="true"
        >
          <Transition
            name="t-swap"
            mode="out-in"
          >
            <span :key="counter.passed">{{ counter.passed }}</span>
          </Transition>/{{ counter.total }}
        </span>
        <span class="sr-only">{{ t('design.journey.counterAria', { passed: counter.passed, total: counter.total }) }}</span>
      </span>
    </template>

    <!-- Stops the click so choosing a width or replaying does not open the tool overlay. -->
    <div
      v-if="steps.length > 0 || details"
      class="@container border-t border-(--d-border) text-xs"
      @click.stop
    >
      <ToggleGroup
        v-if="widthChips.length > 0"
        type="single"
        :model-value="String(widthChips[selected]?.width ?? '')"
        :aria-label="t('design.journey.widths')"
        class="flex flex-wrap justify-start gap-1 px-3 pt-2"
        data-testid="preview-journey-widths"
        @update:model-value="onWidth"
      >
        <ToggleGroupItem
          v-for="chip in widthChips"
          :key="chip.width"
          :value="String(chip.width)"
          class="d-press h-5.5 min-w-0 gap-1 rounded-full border border-(--d-border) px-2 text-11 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:border-(--d-border2) data-[state=on]:bg-(--d-hover) data-[state=on]:text-(--d-text) [&_svg]:size-3"
          data-testid="preview-journey-width"
          :data-width="chip.width"
          :data-passed="String(chip.passed)"
        >
          <Check
            v-if="chip.passed"
            class="text-(--d-success-text)"
            aria-hidden="true"
          />
          <X
            v-else
            class="text-(--d-danger-text)"
            aria-hidden="true"
          />
          <span class="font-mono tabular-nums">{{ chip.label }}</span>
          <span class="font-mono text-10.5 text-(--d-faint-text) tabular-nums">{{ chip.count }}/{{ steps.length }}</span>
          <span class="sr-only">{{ t(chip.passed ? 'design.journey.state.pass' : 'design.journey.state.fail') }}</span>
        </ToggleGroupItem>
      </ToggleGroup>
      <p
        v-else-if="awaiting"
        class="flex items-center gap-1.5 px-3 pt-2 text-(--d-muted)"
        data-testid="preview-journey-running"
      >
        {{ t('design.journey.running') }}
      </p>

      <ol
        class="flex flex-col gap-px px-1.5 pt-1.5"
        :aria-label="t('design.journey.stepsLabel')"
        data-testid="preview-journey-steps"
      >
        <li
          v-for="row in rows"
          :key="row.index"
          class="flex min-w-0 flex-col rounded-md px-1.5 py-1 transition-colors duration-200"
          :class="ROW_CLASS[row.state]"
          data-testid="preview-journey-step"
          :data-state="row.state"
          :data-action="row.step.action"
        >
          <span class="flex min-w-0 items-start gap-2">
            <span
              class="mt-px w-4 flex-none text-end font-mono text-10.5 text-(--d-faint-text) tabular-nums"
              aria-hidden="true"
            >{{ row.index + 1 }}</span>
            <span
              class="relative mt-px flex size-4 flex-none items-center justify-center rounded-full transition-colors duration-200"
              :class="ICON_CLASS[row.state]"
              aria-hidden="true"
            >
              <span
                v-if="row.state === 'active'"
                class="pointer-events-none absolute -inset-0.75 rounded-full shadow-[inset_0_0_0_2px_var(--d-design)] animate-[d-attention-ring_1.1s_var(--ease-out)_infinite]"
              />
              <Transition name="t-icon">
                <LoaderCircle
                  v-if="row.state === 'active'"
                  class="d-spinning size-2.75"
                />
                <Check
                  v-else-if="row.state === 'pass'"
                  class="size-2.75"
                  stroke-width="3"
                />
                <X
                  v-else-if="row.state === 'fail'"
                  class="size-2.75"
                  stroke-width="3"
                />
              </Transition>
            </span>
            <span
              class="min-w-0 flex-1 text-pretty"
              :class="row.step.action === 'assert' && row.state !== 'notRun' && 'text-(--d-muted)'"
            >
              <JourneyStepText
                :step="row.step"
                data-testid="preview-journey-step-text"
              />
              <span class="sr-only"> · {{ t(`design.journey.state.${row.state}`) }}</span>
            </span>
          </span>
          <span
            v-if="row.result"
            class="mt-0.5 flex min-w-0 flex-col gap-0.5 ps-12"
            data-testid="preview-journey-failure"
            :data-failure="row.result.failure"
          >
            <span class="font-medium text-(--d-danger-text)">{{ failureText(row.result) }}</span>
            <span
              v-if="row.result.message"
              class="text-pretty wrap-anywhere text-(--d-muted)"
              lang="en"
            >{{ row.result.message }}</span>
          </span>
        </li>
      </ol>

      <section
        v-if="untested.length > 0"
        class="px-3 pt-2"
        data-testid="preview-journey-untested"
      >
        <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint-text) uppercase">
          {{ t('design.journey.untested') }}
        </p>
        <ul class="flex flex-col gap-0.5">
          <li
            v-for="(item, index) in untested"
            :key="index"
            class="flex min-w-0 items-start gap-2 text-(--d-muted)"
          >
            <span
              class="mt-1.25 size-1.5 flex-none rotate-45 border border-(--d-design)"
              aria-hidden="true"
            />
            <span class="min-w-0 text-pretty wrap-anywhere">{{ item }}</span>
          </li>
        </ul>
      </section>

      <p
        v-if="details?.outline"
        class="flex items-start gap-2 px-3 pt-2 text-pretty text-(--d-muted)"
        data-testid="preview-journey-outline"
      >
        <FileText
          class="mt-px size-3.25 flex-none text-(--d-faint-text)"
          aria-hidden="true"
        />
        {{ t('design.journey.outline') }}
      </p>

      <div
        v-if="details"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pt-2 pb-2.5"
      >
        <Button
          v-if="canReplay"
          type="button"
          variant="ghost"
          class="d-press d-tone-design h-7 gap-1.5 rounded-7 bg-(--tone)/12 px-2.5 text-xs font-semibold hover:bg-(--tone)/20 hover:text-(--d-design-text) focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-0 [&_svg]:size-3"
          :disabled="replaying"
          :aria-busy="replaying || undefined"
          data-testid="preview-journey-replay"
          @click="startReplay"
        >
          <LoaderCircle
            v-if="replaying"
            class="d-spinning"
            aria-hidden="true"
          />
          <RotateCcw
            v-else
            aria-hidden="true"
          />{{ t(replaying ? 'design.journey.replaying' : 'design.journey.replay') }}
        </Button>
        <span
          class="flex min-w-0 flex-1 basis-56 flex-col gap-0.5 text-11 text-(--d-faint-text)"
          data-testid="preview-journey-files"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <FileCode
              class="size-3 flex-none"
              aria-hidden="true"
            />
            <span
              class="min-w-0 truncate font-mono"
              dir="ltr"
              :title="`${details.journeyFile} · ${details.specFile}`"
            >{{ details.specFile }}</span>
          </span>
          <span>{{ t('design.journey.footer', { steps: steps.length, max: MAX_JOURNEY_STEPS }) }}</span>
        </span>
      </div>
      <p
        v-if="refusal !== undefined"
        role="status"
        class="flex items-start gap-2 border-t border-[color-mix(in_srgb,var(--d-danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2 text-(--d-danger-text)"
        data-testid="preview-journey-replay-refusal"
      >
        <CircleAlert
          class="mt-px size-3.25 flex-none"
          aria-hidden="true"
        />
        <span class="text-pretty wrap-anywhere">{{ refusalText }}</span>
      </p>
      <div
        v-else-if="!details"
        class="pb-2"
      />
    </div>

    <ToolErrorStrip
      v-if="toolCall.status === 'failed' && toolCall.errorMessage"
      :message="toolCall.errorMessage"
      data-testid="preview-journey-error"
    />
    <ToolBlockedReason
      v-else-if="toolCall.status === 'blocked' && toolCall.feedback"
      :reason="toolCall.feedback"
    />
    <div
      v-if="awaiting"
      class="d-sweep-bar h-0.5 bg-(--d-hover) text-(--d-design)"
      aria-hidden="true"
    />
  </ToolCardFrame>
</template>
