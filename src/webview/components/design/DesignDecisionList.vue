<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DesignDecisionView, DesignResultDecision } from '@shared/types/design';
import { decisionReplacements } from './decision-replacements';

// A design's decisions; each title and chosen value is the designer's own words. One the list replaces is dimmed and names its
// replacement, and a stored conflict flag shows with its reason.
const props = defineProps<{ decisions: readonly (DesignResultDecision & Partial<Pick<DesignDecisionView, 'conflicts'>>)[] }>();
const { t } = useI18n();

const replacedBy = computed(() => decisionReplacements(props.decisions));
</script>

<template>
  <ul class="flex flex-col gap-1">
    <li
      v-for="decision in decisions"
      :key="decision.id"
      class="flex min-w-0 items-start gap-2"
      :class="replacedBy.has(decision.id) ? 'opacity-60' : ''"
      data-testid="design-decision"
      :data-replaced-by="replacedBy.get(decision.id)"
    >
      <span
        class="mt-1.25 size-1.5 flex-none rotate-45 bg-(--d-design)"
        aria-hidden="true"
      />
      <span class="min-w-0 text-pretty">
        <span class="font-mono text-11 font-semibold text-(--d-design-text)">{{ `${decision.id} ` }}</span>
        <span class="font-medium text-(--d-text)">{{ decision.title }}</span>
        <span
          aria-hidden="true"
          class="text-(--d-faint)"
        > · </span>
        <span class="text-(--d-muted)">{{ decision.chosen }}</span>
        <span
          v-if="decision.replaces?.length"
          class="text-(--d-faint-text)"
        >{{ ` · ${t('design.decision.replaces', { ids: decision.replaces.join(', ') })}` }}</span>
        <span
          v-if="replacedBy.has(decision.id)"
          class="text-(--d-faint-text)"
        >{{ ` · ${t('design.decision.replacedBy', { id: replacedBy.get(decision.id) })}` }}</span>
        <span
          v-for="flag in decision.conflicts ?? []"
          :key="flag.id"
          class="block text-(--d-warning-text)"
          data-testid="design-decision-conflict"
        >{{ t(`design.decision.conflict.${flag.kind}`, { id: flag.id, reason: flag.reason }) }}</span>
      </span>
    </li>
  </ul>
</template>
