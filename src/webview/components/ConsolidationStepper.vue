<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Ban, Circle, CircleCheck, CircleX, LoaderCircle } from 'lucide-vue-next';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import type { ConsolidationPhaseId } from '@shared/types/consolidation';
import { consolidationReasonKey } from './consolidation-reasons';

const store = useConsolidationStore();
const { phaseStatus, phaseMeta, persistProgress } = storeToRefs(store);

const { t } = useI18n();

const PHASES: ConsolidationPhaseId[] = ['claim', 'extract', 'persist', 'maintain', 'profiles'];

function reasonText(reason: string): string {
  const key = consolidationReasonKey(reason);
  return key ? t(key) : reason;
}

/** Trailing text per phase: real counts on done rows, reason/summary on skipped/failed rows. */
function trailing(id: ConsolidationPhaseId): string {
  const status = phaseStatus.value[id];
  const meta = phaseMeta.value[id];
  if (id === 'claim' && status === 'done') return t('consolidation.stepper.turns', meta.count ?? 0);
  if (id === 'extract') {
    if (status === 'active') return meta.total && meta.done ? `${meta.done}/${meta.total}` : t('consolidation.stepper.readingTurns');
    if (status === 'done') return t('consolidation.stepper.found', { n: meta.count ?? 0 });
  }
  if (id === 'persist') {
    if (status === 'active') return `${persistProgress.value.done}/${persistProgress.value.total}`;
    if (status === 'done') return t('consolidation.stepper.items', meta.done ?? 0);
  }
  if (id === 'maintain' && status === 'done') return meta.summary ?? '';
  if (id === 'profiles' && status === 'done') return t('consolidation.stepper.profilesDone');
  if (status === 'skipped') return meta.reason ? t('consolidation.stepper.skippedBecause', { reason: reasonText(meta.reason) }) : t('consolidation.stepper.skipped');
  if (status === 'failed') return meta.reason ? reasonText(meta.reason) : t('consolidation.stepper.failed');
  if (status === 'active') return t('consolidation.stepper.working');
  return '—';
}

/** A running phase's measured progress as a fraction, or null when it reports none. */
function progress(id: ConsolidationPhaseId): number | null {
  if (id === 'persist' && persistProgress.value.total > 0) return persistProgress.value.done / persistProgress.value.total;
  const meta = phaseMeta.value[id];
  if (id === 'extract' && meta.total && meta.done) return meta.done / meta.total;
  return null;
}

/** How far the phase's bar is filled. */
function fill(id: ConsolidationPhaseId): number {
  const status = phaseStatus.value[id];
  if (status === 'done' || status === 'failed' || status === 'skipped') return 1;
  if (status !== 'active') return 0;
  return progress(id) ?? 0.5;
}

const rows = computed(() =>
  PHASES.map((id) => {
    const status = phaseStatus.value[id];
    return {
      id,
      status,
      label: t(`consolidation.phase.${id}`),
      trailing: trailing(id),
      fill: fill(id),
      // An active phase with no measurable progress sweeps instead of claiming a fraction.
      sweep: status === 'active' && progress(id) === null,
    };
  }),
);
</script>

<template>
  <ol
    class="grid grid-cols-5 gap-1.5"
    :aria-label="t('consolidation.stepper.label')"
  >
    <li
      v-for="row in rows"
      :key="row.id"
      class="flex min-w-0 flex-col gap-1.75"
      :aria-current="row.status === 'active' ? 'step' : undefined"
      :data-status="row.status"
      data-testid="consolidation-phase"
    >
      <div
        class="relative h-1 overflow-hidden rounded-full bg-(--d-hover)"
        :class="row.sweep && 'd-sweep-bar text-(--d-accent)'"
        aria-hidden="true"
      >
        <div
          v-if="!row.sweep"
          class="absolute inset-0 origin-left rounded-full transition-transform duration-500 ease-out rtl:origin-right"
          :class="{
            'bg-(--d-success)': row.status === 'done',
            'bg-(--d-accent)': row.status === 'active',
            'bg-(--d-danger)': row.status === 'failed',
            'bg-(--d-border2)': row.status === 'skipped' || row.status === 'pending',
          }"
          :style="{ transform: `scaleX(${row.fill})` }"
        />
      </div>
      <div
        class="flex min-w-0 items-center gap-1.25 text-xs font-semibold"
        :class="{
          'text-(--d-text)': row.status === 'done',
          'text-(--d-accent)': row.status === 'active',
          'text-(--d-danger)': row.status === 'failed',
          'text-(--d-faint)': row.status === 'pending' || row.status === 'skipped',
        }"
      >
        <LoaderCircle
          v-if="row.status === 'active'"
          class="size-3 d-spinning flex-none"
          aria-hidden="true"
        />
        <CircleCheck
          v-else-if="row.status === 'done'"
          class="size-3 flex-none text-(--d-success)"
          aria-hidden="true"
        />
        <CircleX
          v-else-if="row.status === 'failed'"
          class="size-3 flex-none"
          aria-hidden="true"
        />
        <Ban
          v-else-if="row.status === 'skipped'"
          class="size-3 flex-none"
          aria-hidden="true"
        />
        <Circle
          v-else
          class="size-3 flex-none"
          aria-hidden="true"
        />
        <span class="truncate">{{ row.label }}</span>
      </div>
      <div
        class="truncate text-11 text-(--d-faint) tabular-nums"
        :title="row.trailing"
      >
        {{ row.trailing }}
      </div>
    </li>
  </ol>
</template>
