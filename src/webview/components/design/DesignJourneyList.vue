<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DesignJourneyRecord } from '@shared/types/design';

// The journeys a finished version carries (PD-21): each screen's untested remainder, or its waiver. The parent's result card
// and the design chat's FinishDesign card show the same list.
const props = defineProps<{ journeys: readonly DesignJourneyRecord[] }>();
const { t } = useI18n();

const rows = computed(() => props.journeys.map((journey) => ('waiver' in journey
  ? { screen: journey.screen, waiver: true as const, untested: [] as readonly string[] }
  : { screen: journey.screen, waiver: false as const, untested: journey.untested })));
</script>

<template>
  <section data-testid="design-result-journeys">
    <p class="mb-1 text-10.5 font-semibold tracking-[.06em] text-(--d-faint-text) uppercase">
      {{ t('design.result.journeysLabel') }}
    </p>
    <ul class="flex flex-col gap-1">
      <li
        v-for="journey in rows"
        :key="journey.screen"
        class="flex min-w-0 items-start gap-2"
        data-testid="design-result-journey"
        :data-screen="journey.screen"
        :data-waiver="journey.waiver || undefined"
      >
        <span
          class="mt-1.25 size-1.5 flex-none rotate-45"
          :class="journey.waiver ? 'border border-(--d-design)' : 'bg-(--d-design)'"
          aria-hidden="true"
        />
        <span class="min-w-0 text-pretty">
          <span class="font-mono text-11 font-semibold text-(--d-design-text)">{{ `${journey.screen} ` }}</span>
          <span
            v-if="journey.waiver"
            class="text-(--d-muted)"
          >{{ t('design.result.journeyWaiver') }}</span>
          <template v-else-if="journey.untested.length > 0">
            <span class="text-(--d-muted)">{{ t('design.result.journeyUntested') }}</span>
            <span class="text-(--d-text)">{{ ` ${journey.untested.join(' · ')}` }}</span>
          </template>
          <span
            v-else
            class="text-(--d-muted)"
          >{{ t('design.result.journeyComplete') }}</span>
        </span>
      </li>
    </ul>
  </section>
</template>
