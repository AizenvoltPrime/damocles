<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { JourneyStep } from '@shared/types/design';

// One journey step as a sentence in the view's language. The shell's replay strip mounts it too, so its keys live in both catalogs.
const props = defineProps<{ step: JourneyStep }>();
const { t } = useI18n();

const keypath = computed(() => {
  const { action, value, expect } = props.step;
  if (action === 'fill') return value === '' ? 'design.journey.step.clear' : 'design.journey.step.fill';
  if (action !== 'assert') return `design.journey.step.${action}`;
  if (expect && 'visible' in expect) return expect.visible ? 'design.journey.step.visible' : 'design.journey.step.hidden';
  if (expect && 'textContains' in expect) return 'design.journey.step.textContains';
  return 'design.journey.step.valueEquals';
});

const value = computed(() => {
  const { value: stepValue, expect } = props.step;
  if (expect && 'textContains' in expect) return expect.textContains;
  if (expect && 'valueEquals' in expect) return expect.valueEquals;
  return stepValue ?? '';
});

const target = computed(() => {
  const { target: stepTarget } = props.step;
  if ('role' in stepTarget) return { key: 'design.journey.target.role', role: stepTarget.role, name: stepTarget.name };
  if ('label' in stepTarget) return { key: 'design.journey.target.label', name: stepTarget.label };
  if ('placeholder' in stepTarget) return { key: 'design.journey.target.placeholder', name: stepTarget.placeholder };
  return { key: 'design.journey.target.text', name: stepTarget.text };
});
</script>

<template>
  <i18n-t
    :keypath="keypath"
    tag="span"
    scope="global"
    class="wrap-anywhere"
  >
    <template #target>
      <i18n-t
        :keypath="target.key"
        tag="span"
        scope="global"
      >
        <template #role>
          <span
            class="font-mono text-[0.92em] text-(--d-muted)"
            dir="ltr"
          >{{ target.role }}</span>
        </template>
        <template #name>
          <span class="font-medium text-(--d-text)">{{ t('design.journey.quoted', { text: target.name }) }}</span>
        </template>
      </i18n-t>
    </template>
    <template #value>
      <span
        v-if="value === ''"
        class="text-(--d-faint-text) italic"
      >{{ t('design.journey.empty') }}</span>
      <span
        v-else
        class="font-medium text-(--d-text)"
      >{{ t('design.journey.quoted', { text: value }) }}</span>
    </template>
    <template #key>
      <kbd
        class="rounded-sm border border-(--d-border2) bg-(--d-hover) px-1 font-mono text-[0.88em] text-(--d-text)"
        dir="ltr"
      >{{ step.key }}</kbd>
    </template>
  </i18n-t>
</template>
