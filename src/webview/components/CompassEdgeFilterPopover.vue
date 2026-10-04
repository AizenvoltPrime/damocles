<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { SlidersHorizontal } from 'lucide-vue-next';
import { useCompassStore } from '@/stores/useCompassStore';
import { EDGE_STYLE } from '@/composables/compass/useGraphSymbols';
import type { CompassEdgeKind } from '@shared/types/compass';

const { t } = useI18n();
const store = useCompassStore();

const EDGE_KINDS: CompassEdgeKind[] = ['CALLS', 'IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'CONTAINS', 'TESTED_BY', 'DEPENDS_ON', 'REFERENCES'];
const edgeKinds = computed(() => EDGE_KINDS.map((kind) => ({ kind, label: t(`compass.edgeKind.${kind}`) })));

const totalCount = EDGE_KINDS.length;

const visibleCount = computed(() => store.visibleEdgeKinds.size);

function checkboxId(kind: CompassEdgeKind): string {
	return `compass-edge-filter-${kind.toLowerCase()}`;
}

function onToggle(kind: CompassEdgeKind, value: boolean): void {
	store.setEdgeKindVisible(kind, value);
}

function selectAll(): void {
	store.setAllEdgeKindsVisible(true);
}

function selectNone(): void {
	store.setAllEdgeKindsVisible(false);
}
</script>

<template>
  <Popover>
    <PopoverTrigger
      class="flex h-7.5 items-center gap-1.5 rounded-9 border border-(--d-border2) px-2.75 @max-[34.9375rem]/overlay:px-2 text-xs font-medium text-(--d-text) transition-colors hover:bg-(--d-hover) data-[state=open]:bg-(--d-hover)"
      data-testid="compass-edge-filter"
      :title="t('compass.edgeFilter.trigger', { visible: visibleCount, total: totalCount })"
    >
      <SlidersHorizontal
        class="size-3.25"
        aria-hidden="true"
      />
      <span class="@max-[34.9375rem]/overlay:sr-only">{{ t('compass.edgeFilter.trigger', { visible: visibleCount, total: totalCount }) }}</span>
    </PopoverTrigger>
    <PopoverContent class="w-72 rounded-xl border-(--d-border2) bg-(--d-card) p-3 text-(--d-text) shadow-(--d-shadow)">
      <div class="flex flex-col gap-2">
        <h3 class="text-10.5 font-normal tracking-[.06em] text-(--d-faint) uppercase">
          {{ t('compass.edgeFilter.title') }}
        </h3>
        <ul class="flex flex-col gap-2">
          <li
            v-for="e in edgeKinds"
            :key="e.kind"
            class="flex items-center gap-2"
          >
            <svg
              viewBox="0 0 32 8"
              class="h-2 w-8 shrink-0"
            >
              <line
                x1="0"
                y1="4"
                x2="32"
                y2="4"
                :stroke="EDGE_STYLE[e.kind].stroke"
                :stroke-dasharray="EDGE_STYLE[e.kind].dash ?? undefined"
                :stroke-opacity="EDGE_STYLE[e.kind].opacity"
                stroke-width="1.5"
              />
            </svg>
            <Checkbox
              :id="checkboxId(e.kind)"
              :checked="store.visibleEdgeKindsRecord[e.kind]"
              @update:checked="(v) => onToggle(e.kind, v)"
            />
            <label
              :for="checkboxId(e.kind)"
              class="flex-1 cursor-pointer text-12.5 text-(--d-text)"
            >
              {{ e.label }}
            </label>
          </li>
        </ul>
        <div class="flex items-center justify-end gap-1 pt-2 border-t border-(--d-border)">
          <button
            type="button"
            class="rounded-7 px-2 py-1 text-11.5 text-(--d-accent) transition-colors hover:bg-(--d-hover) hover:text-(--d-accent-text)"
            @click="selectAll"
          >
            {{ t('compass.edgeFilter.all') }}
          </button>
          <button
            type="button"
            class="rounded-7 px-2 py-1 text-11.5 text-(--d-accent) transition-colors hover:bg-(--d-hover) hover:text-(--d-accent-text)"
            @click="selectNone"
          >
            {{ t('compass.edgeFilter.none') }}
          </button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
