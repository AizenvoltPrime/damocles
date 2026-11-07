<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { DesignCheckIssue } from '@shared/types/design';
import { useTKnown } from '@/composables/useTKnown';

// The DesignCheck warnings a version carries, each named by its rule in the view's language, never by the check's English message.
defineProps<{ warnings: readonly DesignCheckIssue[] }>();
const { t } = useI18n();
const tKnown = useTKnown();

const ruleLabel = (rule: string): string => tKnown('design.check.rule', rule, rule);
</script>

<template>
  <ul class="flex flex-col gap-1">
    <li
      v-for="(warning, index) in warnings"
      :key="`${warning.rule}:${warning.screen}:${index}`"
      data-testid="design-result-warning"
      :data-rule="warning.rule"
      class="flex min-w-0 items-start gap-2"
    >
      <span
        class="mt-1.25 size-1.5 flex-none rotate-45 bg-(--d-warning)"
        aria-hidden="true"
      />
      <span class="min-w-0 text-pretty">
        <span class="font-medium text-(--d-text)">{{ `${ruleLabel(warning.rule)} ` }}</span>
        <span class="font-mono text-11 text-(--d-faint-text)">{{ `${warning.screen} ` }}</span>
        <span
          v-if="warning.element"
          class="font-mono text-11 wrap-anywhere text-(--d-muted)"
          dir="ltr"
        >{{ warning.element }}</span>
        <span
          v-if="warning.more"
          class="block text-11 text-(--d-muted)"
          data-testid="design-result-warning-more"
        >{{ t('design.check.more', { n: warning.more }, warning.more) }}</span>
      </span>
    </li>
  </ul>
</template>
