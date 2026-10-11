<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KpiCard from '../KpiCard.vue';
import { useStatsFormat } from '@/composables/useStatsFormat';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

const props = defineProps<{
  display: MemoryInjectionDisplay;
}>();

type KpiId = 'tokensAdded' | 'newMemories' | 'carried' | 'notices' | 'storeSize';

interface DetailRow {
  id: string;
  label: string;
  value: string;
}

interface Kpi {
  id: KpiId;
  label: string;
  value: string;
  note: string | undefined;
  details: DetailRow[];
}

const { t } = useI18n();
const format = useStatsFormat();

const kpis = computed<Kpi[]>(() => {
  const d = props.display;
  const row = (id: string, label: string, value: number): DetailRow => ({ id, label, value: format.integer(value) });
  const full = d.added.filter((m) => m.tier === 'full').length;
  return [
    {
      id: 'tokensAdded',
      label: t('contextInjection.kpi.tokensAdded'),
      value: format.integer(d.tokens.total),
      note: t('contextInjection.kpi.budgetNote', { budget: format.integer(d.tokens.budget) }),
      details: [
        row('memories', t('contextInjection.kpi.part.memories'), d.tokens.memories),
        row('notices', t('contextInjection.kpi.part.notices'), d.tokens.notices),
        row('profile', t('contextInjection.kpi.part.profile'), d.tokens.profile),
        row('compass', t('contextInjection.kpi.part.compass'), d.tokens.compass),
        row('budget', t('contextInjection.kpi.part.budget'), d.tokens.budget),
      ],
    },
    {
      id: 'newMemories',
      label: t('contextInjection.kpi.newMemories'),
      value: format.integer(d.added.length),
      note: d.added.length > 0 ? t('contextInjection.kpi.tierSplit', { full, compact: d.added.length - full }) : undefined,
      details: [
        row('considered', t('contextInjection.kpi.gate.considered'), d.gate.considered),
        row('passed', t('contextInjection.kpi.gate.passed'), d.gate.passed),
        row('unmatchedSkipped', t('contextInjection.kpi.gate.unmatchedSkipped'), d.gate.unmatchedSkipped),
        row('alreadyInContext', t('contextInjection.kpi.gate.alreadyInContext'), d.gate.alreadyInContext),
        row('overBudget', t('contextInjection.kpi.gate.overBudget'), d.gate.overBudget),
        row('preferencesDeferred', t('contextInjection.kpi.gate.preferencesDeferred'), d.gate.preferencesDeferred),
      ],
    },
    {
      id: 'carried',
      label: t('contextInjection.kpi.carried'),
      value: format.integer(d.carried.length),
      note: undefined,
      details: [],
    },
    {
      id: 'notices',
      label: t('contextInjection.kpi.notices'),
      value: format.integer(d.notices.length),
      note: d.notices.length > 0 ? t('contextInjection.memoryTokenCount', { count: format.integer(d.tokens.notices) }, d.tokens.notices) : undefined,
      details: [],
    },
    {
      id: 'storeSize',
      label: t('contextInjection.kpi.storeSize'),
      value: format.integer(d.storeCounts.total),
      note: undefined,
      details: [
        row('session', t('memory.scope.session'), d.storeCounts.session),
        row('project', t('memory.scope.project'), d.storeCounts.project),
        row('global', t('memory.scope.global'), d.storeCounts.global),
        row('observations', t('contextInjection.kpi.part.observations'), d.storeCounts.observations),
      ],
    },
  ];
});
</script>

<template>
  <div class="flex flex-wrap gap-px overflow-hidden rounded-lg border border-(--d-border) bg-(--d-border)">
    <KpiCard
      v-for="k in kpis"
      :id="k.id"
      :key="k.id"
      :label="k.label"
      :info-label="t('contextInjection.kpi.formulaFor', { label: k.label })"
      :value="k.value"
      :note="k.note"
    >
      <template #formula>
        <p data-kpi-formula>
          {{ t(`contextInjection.formula.${k.id}`) }}
        </p>
        <dl
          v-if="k.details.length > 0"
          class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums"
        >
          <template
            v-for="detail in k.details"
            :key="detail.id"
          >
            <dt class="text-(--d-muted)">
              {{ detail.label }}
            </dt>
            <dd
              class="text-right"
              :data-kpi-detail="detail.id"
            >
              {{ detail.value }}
            </dd>
          </template>
        </dl>
      </template>
    </KpiCard>
  </div>
</template>
