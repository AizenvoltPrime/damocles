<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FlowStepState } from '../../../../shared/forge/publish';
import TimelineStepRow from './TimelineStepRow.vue';

export interface FlowRow {
  readonly id: string;
  readonly state: FlowStepState;
  readonly label: string;
  // shown under the label while the step runs
  readonly sub?: string;
  // the failure box under a failed step
  readonly failure?: string;
}

// Publish and Fork and Push in the StepTimeline look: a drawn bar carrying the count, then one row per step.
const props = defineProps<{ rows: readonly FlowRow[]; failed: boolean }>();
const { t } = useI18n();

const doneCount = computed(() => props.rows.filter((row) => row.state === 'done').length);
const failedRow = computed(() => props.rows.find((row) => row.state === 'failed'));
const valueText = computed(() => (failedRow.value
  ? t('forgeFlow.failedAt', { step: failedRow.value.label })
  : t('forgeFlow.progress', { done: doneCount.value, total: props.rows.length })));
// the step under way, read out as it starts; a failure speaks through its own alert and the end through the dialog's status.
// The region is empty as it mounts, since a live region announces changes, not the text it was inserted with.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
const announcement = computed(() => {
  if (!mounted.value) return '';
  const index = props.rows.findIndex((row) => row.state === 'active');
  return index < 0 ? '' : t('forgeFlow.activeStep', { index: index + 1, total: props.rows.length, step: props.rows[index]!.label });
});
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- A drawn bar: the steps carry the value through the progressbar role, which allows no interactive children. -->
    <div
      role="progressbar"
      data-testid="flow-progress"
      :aria-label="t('forgeFlow.label')"
      aria-valuemin="0"
      :aria-valuemax="rows.length"
      :aria-valuenow="doneCount"
      :aria-valuetext="valueText"
      class="h-1 overflow-hidden rounded-full bg-(--d-border)"
    >
      <span
        class="timeline-bar block h-full rounded-full"
        :class="failed ? 'bg-(--d-danger)' : 'bg-(--d-accent)'"
        :style="{ transform: `scaleX(${rows.length === 0 ? 0 : doneCount / rows.length})` }"
      />
    </div>
    <p
      aria-live="polite"
      aria-atomic="true"
      data-testid="flow-announcement"
      class="sr-only"
    >
      {{ announcement }}
    </p>
    <ol
      :aria-label="t('forgeFlow.steps')"
      class="flex flex-col"
    >
      <TimelineStepRow
        v-for="(row, index) in rows"
        :key="row.id"
        :step="row.id"
        :state="row.state"
        :index="index"
        :last="index === rows.length - 1"
        data-testid="flow-step"
      >
        <template #label>
          {{ row.label }}<span class="sr-only">{{ t('forgeFlow.withState', { state: t(`forgeFlow.state.${row.state}`) }) }}</span>
        </template>
        <span
          v-if="row.state === 'active' && row.sub"
          data-testid="flow-step-sub"
          class="text-11.5 text-(--d-muted)"
        >{{ row.sub }}</span>
        <p
          v-if="row.state === 'failed' && row.failure"
          role="alert"
          data-testid="flow-failure"
          class="timeline-grow mt-1.5 rounded-8 bg-(--d-danger)/12 px-2.5 py-2 font-mono text-11.5 wrap-break-word text-(--d-danger-text)"
        >
          {{ row.failure }}
        </p>
      </TimelineStepRow>
    </ol>
  </div>
</template>
