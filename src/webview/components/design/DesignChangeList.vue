<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DesignChange } from '@shared/types/design';

// What changed from one version to the next, in the view's language; a decision's title and chosen value are the designer's.
const props = defineProps<{ changes: readonly DesignChange[] }>();
const { te } = useI18n();

// A kind from a newer core that this build cannot word is left out rather than shown as a keypath.
const shown = computed(() => props.changes.filter((change) => te(`design.change.${change.kind}`)));
</script>

<template>
  <ul class="flex flex-col gap-1">
    <li
      v-for="(change, index) in shown"
      :key="index"
      class="flex min-w-0 items-start gap-2"
      data-testid="design-change"
      :data-kind="change.kind"
    >
      <span
        class="mt-1.25 size-1.5 flex-none rotate-45"
        :class="change.kind === 'decisionAdded' ? 'bg-(--d-design)' : 'border border-(--d-design)'"
        aria-hidden="true"
      />
      <i18n-t
        v-if="change.kind === 'decisionAdded'"
        keypath="design.change.decisionAdded"
        tag="span"
        scope="global"
        class="min-w-0 text-pretty text-(--d-text)"
      >
        <template #id>
          <span class="font-mono text-11 font-semibold text-(--d-design-text)">{{ change.id }}</span>
        </template>
        <template #title>
          <span class="font-medium">{{ change.title }}</span>
        </template>
        <template #chosen>
          <span class="text-(--d-muted)">{{ change.chosen }}</span>
        </template>
      </i18n-t>
      <i18n-t
        v-else
        :keypath="`design.change.${change.kind}`"
        tag="span"
        scope="global"
        class="min-w-0 text-pretty text-(--d-text)"
      >
        <template #screen>
          <span class="font-mono text-11 font-semibold text-(--d-design-text)">{{ change.screen }}</span>
        </template>
      </i18n-t>
    </li>
  </ul>
</template>
