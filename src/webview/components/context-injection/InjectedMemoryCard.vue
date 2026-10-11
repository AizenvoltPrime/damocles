<script setup lang="ts">
import { computed } from 'vue';
import { I18nT, useI18n } from 'vue-i18n';
import { Pin } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconInfo } from '@/components/icons';
import HighlightedText from './HighlightedText.vue';
import InjectedMemoryActions from './InjectedMemoryActions.vue';
import { scopeBadgeClass, shortId, memoryLabel } from './memory-display';
import { SCORE_FORMULA_WEIGHTS, scoreFromBreakdown, scoreTerms } from './injection-score';
import type { InjectedMemory, InjectionReason } from '@shared/types/context-injection';

const props = defineProps<{
  memory: InjectedMemory;
  /** The memory's current pin, which can differ from the one recorded with the prompt. */
  pinned: boolean;
  forgotten: boolean;
}>();

const { t, locale } = useI18n();

const highlight = computed(() =>
  props.memory.reasons.flatMap((reason) => (reason.kind === 'matched' ? reason.terms : [])),
);

const label = computed(() => memoryLabel(props.memory.title, props.memory.content));

function quoteTerms(terms: readonly string[]): string {
  return terms.map((term) => t('contextInjection.reason.matchedTerm', { term })).join(', ');
}

function reasonText(reason: Exclude<InjectionReason, { kind: 'file' }>): string {
  switch (reason.kind) {
    case 'matched': return t('contextInjection.reason.matched', { terms: quoteTerms(reason.terms) });
    case 'replacement': return t('contextInjection.reason.replacement', { id: shortId(reason.replacesId) });
    default: return t(`contextInjection.reason.${reason.kind}`);
  }
}

const isObservation = computed(() => props.memory.kind === 'observation');

const number = computed(() => new Intl.NumberFormat(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt = (n: number): string => number.value.format(n);
const integerFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }));
const tokenCount = computed(() =>
  t('contextInjection.memoryTokenCount', { count: integerFormat.value.format(props.memory.tokens) }, props.memory.tokens),
);

const rerankTooltip = computed(() => {
  const { rerankRelevance, rerankClassifierScore, rerankReason } = props.memory;
  if (rerankRelevance === undefined || rerankClassifierScore === undefined) return rerankReason;
  return t('contextInjection.rerankClassifier', {
    verdict: t(`contextInjection.rerankVerdict.${rerankRelevance}`),
    score: fmt(rerankClassifierScore),
  });
});

const breakdown = computed(() => props.memory.scoreBreakdown);
const terms = computed(() => (breakdown.value ? scoreTerms(breakdown.value) : []));
const computedScore = computed(() => (breakdown.value ? scoreFromBreakdown(breakdown.value) : null));

const notRankedText = computed(() => {
  const onlyReplacement = props.memory.reasons.every((reason) => reason.kind === 'replacement');
  return t(onlyReplacement ? 'contextInjection.formula.notRankedReplacement' : 'contextInjection.formula.notRanked');
});
</script>

<template>
  <article
    class="space-y-2 rounded-lg border border-(--d-border) bg-[color-mix(in_srgb,var(--d-hover)_60%,transparent)] p-3"
    :class="forgotten && 'opacity-60'"
    :data-memory-id="memory.id"
    :data-forgotten="forgotten || undefined"
    :aria-label="label"
  >
    <div class="flex items-start gap-2">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <Badge
          variant="outline"
          class="px-1.5 py-0 text-10"
          :class="scopeBadgeClass(memory.scope)"
          data-badge="scope"
        >
          {{ t(`memory.scope.${memory.scope}`) }}
        </Badge>
        <Badge
          variant="outline"
          class="px-1.5 py-0 text-10 text-(--d-muted)"
          data-badge="kind"
        >
          {{ t(`memory.kind.${memory.kind}`) }}
        </Badge>
        <Badge
          :variant="memory.tier === 'full' ? 'secondary' : 'outline'"
          class="px-1.5 py-0 text-10"
          :class="memory.tier === 'compact' && 'border-dashed text-(--d-muted)'"
          data-badge="tier"
        >
          {{ t(`contextInjection.tier.${memory.tier}`) }}
        </Badge>
        <Badge
          v-if="pinned"
          variant="outline"
          class="border-[color-mix(in_srgb,var(--d-warning)_40%,transparent)] px-1.5 py-0 text-10 text-(--d-warning-text)"
          data-badge="pinned"
        >
          <Pin
            class="size-2.5"
            aria-hidden="true"
          />
          {{ t('contextInjection.badge.pinned') }}
        </Badge>
        <Badge
          v-if="memory.isStale"
          variant="outline"
          class="border-[color-mix(in_srgb,var(--d-warning)_40%,transparent)] px-1.5 py-0 text-10 text-(--d-warning-text)"
          data-badge="stale"
        >
          {{ t('contextInjection.badge.stale') }}
        </Badge>
        <Badge
          v-if="memory.upgradedFromCompact"
          variant="outline"
          class="border-[color-mix(in_srgb,var(--d-info)_40%,transparent)] px-1.5 py-0 text-10 text-(--d-info-text)"
          data-badge="upgraded"
        >
          {{ t('contextInjection.badge.upgraded') }}
        </Badge>
        <Badge
          v-if="memory.truncated"
          variant="outline"
          class="px-1.5 py-0 text-10 text-(--d-muted)"
          data-badge="truncated"
        >
          {{ t('contextInjection.badge.truncated') }}
        </Badge>
        <Badge
          v-if="memory.rerankRelevance"
          variant="outline"
          class="px-1.5 py-0 text-10 text-(--d-muted)"
          :title="rerankTooltip"
          data-badge="rerank"
        >
          {{ t(`contextInjection.badge.rerank.${memory.rerankRelevance}`) }}
        </Badge>
        <Badge
          v-if="forgotten"
          variant="outline"
          class="border-[color-mix(in_srgb,var(--d-danger)_40%,transparent)] px-1.5 py-0 text-10 text-(--d-danger-text)"
          data-badge="forgotten"
        >
          {{ t('contextInjection.badge.forgotten') }}
        </Badge>
      </div>
      <InjectedMemoryActions
        :id="memory.id"
        :kind="memory.kind"
        :label="label"
        :is-pinned="pinned"
        :forgotten="forgotten"
      />
    </div>

    <ul
      class="flex flex-wrap gap-x-3 gap-y-0.5 text-11 text-(--d-accent-text)"
      :aria-label="t('contextInjection.reason.label')"
    >
      <li
        v-for="(reason, i) in memory.reasons"
        :key="i"
        :data-reason="reason.kind"
        class="wrap-break-word"
      >
        <I18nT
          v-if="reason.kind === 'file'"
          :keypath="`contextInjection.reason.file.${reason.source}`"
          scope="global"
        >
          <template #path>
            <span class="break-all">{{ reason.path }}</span>
          </template>
        </I18nT>
        <template v-else>
          {{ reasonText(reason) }}
        </template>
      </li>
    </ul>

    <h4
      v-if="memory.title"
      class="text-xs font-medium text-(--d-text) wrap-break-word"
      data-memory-title
    >
      <HighlightedText
        :text="memory.title"
        :terms="highlight"
      />
    </h4>
    <p
      class="whitespace-pre-wrap wrap-break-word text-xs text-(--d-text)"
      data-memory-content
    >
      <HighlightedText
        :text="memory.content"
        :terms="highlight"
      />
    </p>

    <ul
      v-if="isObservation && memory.facts.length > 0"
      class="space-y-0.5"
      data-memory-facts
    >
      <li
        v-for="(fact, i) in memory.facts"
        :key="i"
        class="border-l border-(--d-border) pl-2 text-xs text-(--d-muted) wrap-break-word"
      >
        <HighlightedText
          :text="fact"
          :terms="highlight"
        />
      </li>
    </ul>
    <ul
      v-if="isObservation && memory.files.length > 0"
      class="flex flex-wrap gap-1"
      data-memory-files
    >
      <li
        v-for="file in memory.files"
        :key="file"
        class="rounded bg-[color-mix(in_srgb,var(--d-bg)_60%,transparent)] px-1 font-mono text-10 text-(--d-muted) break-all"
      >
        {{ file }}
      </li>
    </ul>

    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-10 text-(--d-muted) tabular-nums">
      <span data-memory-tokens>{{ tokenCount }}</span>
      <span v-if="memory.sourceCount > 1">{{ t('contextInjection.badge.sources', { count: memory.sourceCount }) }}</span>
      <span
        class="ml-auto flex items-center gap-1"
        data-memory-score
      >
        <span v-if="memory.score !== null">{{ t('contextInjection.score.value', { score: fmt(memory.score) }) }}</span>
        <span v-else>{{ t('contextInjection.score.notRanked') }}</span>
        <Popover>
          <PopoverTrigger as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-5 shrink-0 text-(--d-muted)"
              :aria-label="t('contextInjection.score.detailsFor', { label })"
              data-action="score-details"
            >
              <IconInfo class="size-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            class="w-80 space-y-2 p-3 text-xs/relaxed"
            align="end"
            data-score-popover
          >
            <template v-if="breakdown && computedScore !== null">
              <p
                class="font-mono text-11"
                data-score-formula
              >{{ t('contextInjection.formula.score', SCORE_FORMULA_WEIGHTS) }}</p>
              <p class="text-(--d-muted)">
                {{ t('contextInjection.formula.relevance', { matched: fmt(breakdown.matchedIdf), query: fmt(breakdown.queryIdf) }) }}
              </p>
              <table class="w-full tabular-nums">
                <tbody>
                  <tr
                    v-for="term in terms"
                    :key="term.id"
                    :data-score-term="term.id"
                  >
                    <th
                      scope="row"
                      class="py-0.5 pr-2 text-left font-normal text-(--d-muted)"
                    >{{ t(`contextInjection.score.term.${term.id}`) }}</th>
                    <td class="py-0.5 pr-2 text-right">{{ fmt(term.value) }}</td>
                    <td class="py-0.5 text-right text-(--d-muted)">
                      {{ term.weight === null ? fmt(term.contribution) : `${fmt(term.weight)} × ${fmt(term.value)} = ${fmt(term.contribution)}` }}
                    </td>
                  </tr>
                  <tr data-score-term="stalenessPenalty">
                    <th
                      scope="row"
                      class="py-0.5 pr-2 text-left font-normal text-(--d-muted)"
                    >{{ t('contextInjection.score.term.stalenessPenalty') }}</th>
                    <td class="py-0.5 pr-2 text-right">× {{ fmt(breakdown.stalenessPenalty) }}</td>
                    <td />
                  </tr>
                  <tr
                    class="border-t border-(--d-border) font-medium"
                    data-score-total
                  >
                    <th
                      scope="row"
                      class="pt-1 pr-2 text-left"
                    >{{ t('contextInjection.score.total') }}</th>
                    <td class="pt-1 pr-2 text-right">{{ fmt(memory.score ?? computedScore) }}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </template>
            <p
              v-else
              data-score-not-ranked
            >{{ notRankedText }}</p>
          </PopoverContent>
        </Popover>
      </span>
    </div>
  </article>
</template>
