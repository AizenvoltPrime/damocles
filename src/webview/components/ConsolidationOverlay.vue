<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { ChevronRight, CircleCheck, CircleDashed, CircleX, KeyRound, LoaderCircle, Play, Repeat, RotateCcw, Sparkles } from 'lucide-vue-next';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ConsolidationStepper from './ConsolidationStepper.vue';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import { useRelativeTime } from '@/composables/useRelativeTime';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useOpenSettings } from '@/composables/useOpenSettings';
import { folderName } from '@/lib/folder-name';
import type { ConsolidationPersistOutcome } from '@shared/types/consolidation';

const emit = defineEmits<{ (e: 'close'): void }>();
const { t, te } = useI18n();

const store = useConsolidationStore();
const { pendingCandidates, isRunning, lastResult, phase, phaseMeta, persistProgress } =
  storeToRefs(store);
const { postMessage } = usePlatformBridge();
const openSettings = useOpenSettings();

function triggerNow(): void {
  // Doherty-threshold ack: flip the stepper to Claim-active immediately, before the round-trip.
  store.ackManualRun();
  postMessage({ type: 'triggerConsolidation' });
}

function signIn(): void {
  openSettings('accounts');
}

const statusBadge = computed(() =>
  isRunning.value
    ? { label: t('consolidation.running'), class: 'd-tone-accent', pulse: true }
    : { label: t('consolidation.idle'), class: 'd-tone-muted' },
);

const STILL_THINKING_MS = 8_000;
const extractElapsedMs = ref(0);
let extractInterval: ReturnType<typeof setInterval> | null = null;

watch(
  phase,
  (p) => {
    if (extractInterval) {
      clearInterval(extractInterval);
      extractInterval = null;
    }
    if (p === 'extract') {
      const start = Date.now();
      extractElapsedMs.value = 0;
      extractInterval = setInterval(() => {
        extractElapsedMs.value = Date.now() - start;
      }, 1000);
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  if (extractInterval) clearInterval(extractInterval);
});

/** What the pass is doing now, in words; the stepper above shows where it is. */
const runningText = computed(() => {
  switch (phase.value) {
    case 'claim':
      return t('consolidation.strip.reviewing');
    case 'extract':
      return extractElapsedMs.value >= STILL_THINKING_MS
        ? t('consolidation.strip.stillThinking')
        : t('consolidation.strip.reading', phaseMeta.value.claim.count ?? 0);
    case 'persist':
      return persistProgress.value.total > 0
        ? `${t('consolidation.strip.persisting')} ${persistProgress.value.done}/${persistProgress.value.total}`
        : t('consolidation.strip.persistingPending');
    case 'maintain':
      return t('consolidation.strip.maintenance');
    case 'profiles':
      return t('consolidation.strip.profiles');
    default:
      return t('consolidation.consolidating');
  }
});

const { relative: ranRelative, absolute: ranAbsolute } = useRelativeTime(
  () => lastResult.value?.ranAt ?? null,
);

const FAILURE_COPY_KEYS: Record<string, string> = {
  'no-model': 'consolidation.failure.noModel',
  unavailable: 'consolidation.failure.unavailable',
};

const failureMessage = computed(() => {
  const f = lastResult.value?.failure;
  if (!f) return '';
  const key = FAILURE_COPY_KEYS[f.kind];
  return key ? t(key) : f.detail ?? t('consolidation.failure.generic');
});

const failureFooter = computed(() => {
  const f = lastResult.value?.failure;
  if (!f) return '';
  const when = ranRelative.value || t('consolidation.justNow');
  return f.phase ? t('consolidation.failedAt', { phase: t(`consolidation.phase.${f.phase}`), when }) : when;
});

const triggerChip = computed(() => {
  const manual = lastResult.value?.trigger === 'manual';
  return {
    label: manual ? t('consolidation.trigger.manual') : t('consolidation.trigger.auto'),
    icon: manual ? Play : Repeat,
  };
});

const isFailed = computed(() => !isRunning.value && lastResult.value?.status === 'failed');

const stripText = computed(() => {
  if (isRunning.value) return runningText.value;
  const r = lastResult.value;
  if (!r) return `${t('consolidation.noRunYet')} ${t('consolidation.noRunHintBefore')} ${t('consolidation.runNow')} ${t('consolidation.noRunHintAfter')}`;
  if (r.status === 'failed') return failureMessage.value;
  if (r.status === 'empty') return t('consolidation.nothingNew', r.candidatesReviewed);
  return [t('consolidation.extracted', { n: r.extracted.length }), ...rollup.value].join(' · ');
});

const stripIcon = computed(() => {
  if (isRunning.value) return { icon: LoaderCircle, class: 'd-spinning text-(--d-accent)' };
  const status = lastResult.value?.status;
  if (status === 'failed') return { icon: CircleX, class: 'text-(--d-danger)' };
  if (status) return { icon: CircleCheck, class: 'text-(--d-success)' };
  return { icon: CircleDashed, class: 'text-(--d-faint)' };
});

const rollup = computed<string[]>(() => {
  const r = lastResult.value;
  if (!r) return [];
  const counts: Record<ConsolidationPersistOutcome, number> = {
    inserted: 0,
    merged: 0,
    superseded: 0,
    deduped: 0,
    invalid: 0,
  };
  for (const m of r.extracted) counts[m.outcome]++;
  const parts: string[] = [];
  if (counts.inserted) parts.push(t('consolidation.rollup.inserted', { n: counts.inserted }));
  if (counts.merged) parts.push(t('consolidation.rollup.merged', { n: counts.merged }));
  if (counts.superseded) parts.push(t('consolidation.rollup.superseded', { n: counts.superseded }));
  if (counts.deduped) parts.push(t('consolidation.rollup.deduped', { n: counts.deduped }));
  if (counts.invalid) parts.push(t('consolidation.rollup.invalid', { n: counts.invalid }));
  if (r.maintenance.promoted) parts.push(t('consolidation.rollup.promoted', { n: r.maintenance.promoted }));
  if (r.maintenance.decayed) parts.push(t('consolidation.rollup.decayed', { n: r.maintenance.decayed }));
  if (r.maintenance.pruned) parts.push(t('consolidation.rollup.pruned', { n: r.maintenance.pruned }));
  return parts;
});

const OUTCOME_TONE: Record<ConsolidationPersistOutcome, string> = {
  inserted: 'bg-[color-mix(in_srgb,var(--d-success)_14%,transparent)] text-(--d-success-text)',
  merged: 'bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] text-(--d-info-text)',
  superseded: 'bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] text-(--d-info-text)',
  deduped: 'bg-(--d-hover) text-(--d-muted)',
  invalid: 'bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)] text-(--d-danger-text)',
};

// The queue starts collapsed once a run exists, unless the user has toggled it.
const queueOpen = ref(true);
let queueUserToggled = false;
watch(
  lastResult,
  (r) => {
    if (r && !queueUserToggled) queueOpen.value = false;
  },
  { immediate: true },
);
function toggleQueue(): void {
  queueUserToggled = true;
  queueOpen.value = !queueOpen.value;
}
</script>

<template>
  <OverlayShell
    max-width="62.5rem"
    :title="t('consolidation.title')"
    :subtitle="t('overlays.consolidation.subtitle')"
    :icon="Sparkles"
    :status-badge="statusBadge"
    data-testid="consolidation-overlay"
    @close="emit('close')"
  >
    <template #header-actions>
      <OverlayHeaderAction
        :label="isRunning ? t('consolidation.consolidating') : t('consolidation.runNow')"
        :title="t('consolidation.runNowTitle')"
        :icon="Play"
        primary
        :busy="isRunning"
        :disabled="isRunning"
        data-testid="consolidation-run"
        @click="triggerNow"
      />
    </template>

    <div class="flex flex-col gap-4 px-4.5 pt-4 pb-5">
      <ConsolidationStepper />

      <div
        class="flex flex-wrap items-center gap-2 rounded-10 border px-3 py-2.25 text-xs"
        :class="isFailed ? 'border-[color-mix(in_srgb,var(--d-danger)_35%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-danger)_6%,var(--d-card))] text-(--d-text)' : 'border-(--d-border) bg-(--d-card) text-(--d-muted)'"
        role="status"
        data-testid="consolidation-strip"
      >
        <component
          :is="stripIcon.icon"
          class="size-3.25 flex-none"
          :class="stripIcon.class"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 text-pretty">{{ stripText }}</span>
        <template v-if="lastResult && !isRunning">
          <span class="flex items-center gap-1 rounded-full bg-(--d-hover) px-1.75 text-10.5/4.5">
            <component
              :is="triggerChip.icon"
              class="size-2.5"
              aria-hidden="true"
            />{{ triggerChip.label }}
          </span>
          <span
            class="text-11 text-(--d-faint)"
            :title="ranAbsolute"
          >{{ isFailed ? failureFooter : ranRelative }}</span>
        </template>
        <div
          v-if="isFailed"
          class="flex w-full justify-end gap-2 pt-1"
        >
          <button
            v-if="lastResult?.failure?.kind === 'no-model'"
            type="button"
            class="d-press flex h-7 items-center gap-1.5 rounded-lg border border-(--d-border2) px-2.5 transition-colors hover:bg-(--d-hover)"
            @click="signIn"
          >
            <KeyRound
              class="size-3.25"
              aria-hidden="true"
            />{{ t('consolidation.signIn') }}
          </button>
          <button
            type="button"
            class="d-press flex h-7 items-center gap-1.5 rounded-lg bg-(--d-accent) px-2.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
            data-testid="consolidation-retry"
            @click="triggerNow"
          >
            <RotateCcw
              class="size-3.25"
              aria-hidden="true"
            />{{ t('consolidation.retryNow') }}
          </button>
        </div>
      </div>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(16.25rem,1fr))] gap-3.5">
        <section class="flex min-w-0 flex-col gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1.5 self-start text-11 font-semibold tracking-[.07em] text-(--d-faint) uppercase transition-colors hover:text-(--d-text)"
            :aria-expanded="queueOpen"
            data-testid="consolidation-queue-toggle"
            @click="toggleQueue"
          >
            <ChevronRight
              class="size-3 transition-transform duration-200 ease-out"
              :class="queueOpen && 'rotate-90'"
              aria-hidden="true"
            />
            {{ t('consolidation.queued', { n: pendingCandidates.length }) }}
          </button>
          <template v-if="queueOpen">
            <p
              v-if="pendingCandidates.length === 0"
              class="rounded-10 border border-dashed border-(--d-border2) p-3 text-xs text-(--d-faint)"
            >
              {{ t('consolidation.queueEmpty') }}
            </p>
            <div
              v-for="(c, index) in pendingCandidates"
              :key="c.id"
              class="d-arrive flex flex-col gap-1 rounded-10 border border-(--d-border) bg-(--d-card) px-2.5 py-2"
              :style="{ animationDelay: `${Math.min(index, 8) * 30}ms` }"
            >
              <div class="flex gap-2.25">
                <span class="w-15.5 flex-none text-10.5 font-semibold text-(--d-accent)">{{ t('consolidation.user') }}</span>
                <MarkdownRenderer
                  :content="c.userPreview"
                  :allow-remote-images="false"
                  class="line-clamp-2 min-w-0 flex-1 text-xs text-(--d-muted)"
                />
              </div>
              <div class="flex gap-2.25">
                <span class="w-15.5 flex-none text-10.5 font-semibold text-(--d-success)">{{ t('consolidation.assistant') }}</span>
                <MarkdownRenderer
                  :content="c.assistantPreview"
                  :allow-remote-images="false"
                  class="line-clamp-2 min-w-0 flex-1 text-xs text-(--d-muted)"
                />
              </div>
            </div>
          </template>
        </section>

        <section class="flex min-w-0 flex-col gap-1.5">
          <h3 class="text-11 font-semibold tracking-[.07em] text-(--d-faint) uppercase">
            {{ lastResult ? t('overlays.consolidation.lastPass', { n: lastResult.extracted.length }) : t('overlays.consolidation.noPass') }}
          </h3>
          <p
            v-if="!lastResult || lastResult.extracted.length === 0"
            class="rounded-10 border border-dashed border-(--d-border2) p-3 text-xs text-(--d-faint)"
          >
            {{ lastResult ? t('overlays.consolidation.nothingExtracted') : t('consolidation.noRunYet') }}
          </p>
          <!-- Extracted memories carry no id; their kind, scope and content are their identity. -->
          <div
            v-for="(m, index) in lastResult?.extracted ?? []"
            :key="`${m.kind}:${m.scope}:${m.content}`"
            class="d-arrive flex flex-col gap-1.25 rounded-10 border border-(--d-border) bg-(--d-card) px-2.75 py-2.25"
            :style="{ animationDelay: `${Math.min(index, 8) * 30}ms` }"
          >
            <div class="flex min-w-0 items-center gap-1.5 text-10.5">
              <span class="rounded-5 bg-(--d-accent-soft) px-1.5 leading-4.25 font-semibold text-(--d-accent-text)">{{ te(`memory.kind.${m.kind}`) ? t(`memory.kind.${m.kind}`) : m.kind }}</span>
              <span class="rounded-5 bg-(--d-hover) px-1.5 leading-4.25 text-(--d-muted)">{{ te(`memory.scope.${m.scope}`) ? t(`memory.scope.${m.scope}`) : m.scope }}</span>
              <span
                v-if="m.workspace"
                class="min-w-0 truncate text-(--d-faint)"
                :title="m.workspace"
                data-extracted-workspace
              ><span aria-hidden="true">→ </span>{{ folderName(m.workspace) }}</span>
              <span class="flex-1" />
              <span
                class="flex-none rounded-full px-1.5 leading-4.25 font-medium"
                :class="OUTCOME_TONE[m.outcome]"
              >{{ t(`consolidation.outcome.${m.outcome}`) }}</span>
            </div>
            <MarkdownRenderer
              :content="m.content"
              :allow-remote-images="false"
              class="text-12.5"
            />
          </div>
          <div
            v-if="rollup.length"
            class="flex flex-wrap gap-1.5 font-mono text-11 text-(--d-faint)"
          >
            <span
              v-for="part in rollup"
              :key="part"
            >{{ part }}</span>
          </div>
        </section>
      </div>
    </div>
  </OverlayShell>
</template>
