<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, CircleCheck, CircleSlash, TriangleAlert } from 'lucide-vue-next';
import { issueCount, type DesignCheckIssue, type DesignCheckSummary } from '@shared/types/design';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { useTKnown } from '@/composables/useTKnown';

// A DesignCheck result (its tool card and FinishDesign's): errors before warnings, then what was checked. `warningsOnly` shows
// the warnings a finished version carries; `refused` leaves out the top line, which FinishDesign's refusal states above it.
const props = defineProps<{ summary: DesignCheckSummary; refused?: boolean; warningsOnly?: boolean }>();
const { t } = useI18n();
const { rt } = useLocalizedText();
const tKnown = useTKnown();

const widthCount = computed(() => props.summary.widths.length);
const widthsText = computed(() => t('design.check.widths', { n: widthCount.value }, widthCount.value));
const errorCount = computed(() => issueCount(props.summary.errors));
const warningCount = computed(() => issueCount(props.summary.warnings));
const skipped = computed(() => (props.summary.widthChecks ? rt(props.summary.widthChecks.skipped) : undefined));

const passLine = computed(() => (widthCount.value > 0 ? t('design.check.noErrors', { widths: widthsText.value }) : t('design.check.noErrorsStatic')));

const footer = computed(() => {
  const { attributesChecked, tokensChecked, skillHints } = props.summary;
  const parts = {
    attributes: t('design.check.attributes', { n: attributesChecked }, attributesChecked),
    tokens: t('design.check.tokens', { n: tokensChecked }, tokensChecked),
    hints: t('design.check.hints', { n: skillHints }, skillHints),
  };
  return widthCount.value > 0 ? t('design.check.footer', { ...parts, widths: widthsText.value }) : t('design.check.footerStatic', parts);
});

const groups = computed(() => [
  ...(props.warningsOnly ? [] : [{ key: 'errors', issues: props.summary.errors, count: errorCount.value, icon: CircleAlert, tone: 'text-(--d-danger-text)', label: t('design.check.errorsLabel') }]),
  { key: 'warnings', issues: props.summary.warnings, count: warningCount.value, icon: TriangleAlert, tone: 'text-(--d-warning-text)', label: t('design.check.warningsLabel') },
].filter((group) => group.issues.length > 0));

const ruleLabel = (rule: string): string => tKnown('design.check.rule', rule, rule);
const issueKey = (issue: DesignCheckIssue, index: number): string => `${issue.rule}:${issue.screen}:${issue.element}:${index}`;
</script>

<template>
  <div
    class="border-t border-(--d-border) text-xs"
    data-testid="design-check-report"
  >
    <template v-if="!refused && !warningsOnly">
      <p
        v-if="skipped !== undefined && errorCount === 0"
        class="flex items-start gap-2 px-3 pt-2 text-(--d-warning-text)"
        data-testid="design-check-skipped"
      >
        <CircleSlash
          class="mt-px size-3.25 flex-none"
          aria-hidden="true"
        />
        <span class="text-pretty">{{ skipped }}</span>
      </p>
      <p
        v-else-if="errorCount === 0"
        class="flex items-center gap-2 px-3 pt-2 text-(--d-success-text)"
        data-testid="design-check-pass"
      >
        <CircleCheck
          class="size-3.25 flex-none"
          aria-hidden="true"
        />
        <span class="font-medium">{{ passLine }}</span>
        <template v-if="warningCount > 0">
          <span
            aria-hidden="true"
            class="text-(--d-faint-text)"
          >·</span>
          <span class="text-(--d-warning-text)">{{ t('design.result.warnings', { n: warningCount }, warningCount) }}</span>
        </template>
      </p>
      <p
        v-else-if="skipped !== undefined"
        class="flex items-start gap-2 px-3 pt-2 text-(--d-warning-text)"
        data-testid="design-check-skipped"
      >
        <CircleSlash
          class="mt-px size-3.25 flex-none"
          aria-hidden="true"
        />
        <span class="text-pretty">{{ skipped }}</span>
      </p>
    </template>
    <section
      v-for="group in groups"
      :key="group.key"
      class="px-3 pt-2"
      :class="warningsOnly && 'pb-2.5'"
      :data-testid="`design-check-${group.key}`"
    >
      <p
        class="mb-1 flex items-center gap-1.5 text-10.5 font-semibold tracking-[.06em] uppercase"
        :class="group.tone"
      >
        {{ group.label }}
        <span
          class="font-mono font-normal tracking-normal"
          data-testid="design-check-count"
        >{{ group.count }}</span>
      </p>
      <ul class="flex flex-col gap-1.5">
        <li
          v-for="(issue, index) in group.issues"
          :key="issueKey(issue, index)"
          class="flex items-start gap-2"
          data-testid="design-check-issue"
          :data-severity="issue.severity"
          :data-rule="issue.rule"
        >
          <component
            :is="group.icon"
            class="mt-0.5 size-3.25 flex-none"
            :class="group.tone"
            aria-hidden="true"
          />
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span
                class="font-medium"
                :class="group.tone"
              >{{ ruleLabel(issue.rule) }}</span>
              <code
                class="font-mono text-10.5 text-(--d-faint-text)"
                dir="ltr"
              >{{ issue.rule }}</code>
              <span class="font-mono text-11 text-(--d-faint-text)">{{ issue.screen }}</span>
              <span
                v-if="issue.element"
                class="min-w-0 truncate font-mono text-11 text-(--d-muted)"
                :title="issue.element"
              >{{ issue.element }}</span>
              <span
                v-if="issue.width !== undefined"
                class="inline-flex flex-none items-center rounded-full border border-(--d-border) px-1.5 font-mono text-10.5 text-(--d-muted) tabular-nums"
                data-testid="design-check-issue-width"
              >{{ issue.breakpoint ? t('design.check.atBreakpoint', { breakpoint: issue.breakpoint, width: issue.width }) : t('design.check.atWidth', { width: issue.width }) }}</span>
            </span>
            <span
              class="text-pretty text-(--d-text)"
              lang="en"
            >{{ issue.message }}</span>
            <span
              v-if="issue.hint"
              class="flex min-w-0 flex-col gap-0.5 border-s-2 border-[color-mix(in_srgb,var(--d-design)_45%,var(--d-border2))] ps-2 text-(--d-muted)"
              data-testid="design-check-issue-hint"
            >
              <span class="text-10.5 text-(--d-faint-text)">{{ t('design.check.hint') }}<template v-if="issue.skill"> · <span
                class="font-mono text-(--d-design-text)"
                dir="ltr"
              >{{ issue.skill }}</span></template></span>
              <q class="text-pretty italic">{{ issue.hint }}</q>
            </span>
            <span
              v-if="issue.more"
              class="text-11 text-(--d-muted)"
              data-testid="design-check-issue-more"
            >{{ t('design.check.more', { n: issue.more }, issue.more) }}</span>
          </span>
        </li>
      </ul>
    </section>
    <p
      v-if="!warningsOnly"
      class="px-3 pt-2 pb-2.5 text-11 text-(--d-faint-text)"
    >
      {{ footer }}
    </p>
  </div>
</template>
