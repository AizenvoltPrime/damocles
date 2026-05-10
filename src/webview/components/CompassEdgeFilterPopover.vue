<script setup lang="ts">
import { computed } from 'vue';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { useCompassStore } from '@/stores/useCompassStore';
import { EDGE_STYLE } from '@/composables/compass/useGraphSymbols';
import type { CompassEdgeKind } from '@shared/types/compass';

const store = useCompassStore();

const edgeKinds: Array<{ kind: CompassEdgeKind; label: string }> = [
	{ kind: 'CALLS', label: 'Calls' },
	{ kind: 'IMPORTS_FROM', label: 'Imports from' },
	{ kind: 'INHERITS', label: 'Inherits' },
	{ kind: 'IMPLEMENTS', label: 'Implements' },
	{ kind: 'CONTAINS', label: 'Contains' },
	{ kind: 'TESTED_BY', label: 'Tested by' },
	{ kind: 'DEPENDS_ON', label: 'Depends on' },
	{ kind: 'REFERENCES', label: 'References' },
];

const totalCount = edgeKinds.length;

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
      class="px-1.5 py-0.5 rounded text-[10px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
    >
      Filter edges ({{ visibleCount }}/{{ totalCount }})
    </PopoverTrigger>
    <PopoverContent class="w-72">
      <div class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold text-foreground">
          Edge filters
        </h3>
        <ul class="flex flex-col gap-2">
          <li
            v-for="e in edgeKinds"
            :key="e.kind"
            class="flex items-center gap-2"
          >
            <svg
              width="32"
              height="8"
              viewBox="0 0 32 8"
              class="shrink-0"
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
              class="flex-1 text-xs text-foreground cursor-pointer"
            >
              {{ e.label }}
            </label>
          </li>
        </ul>
        <div class="flex items-center justify-end gap-1 pt-2 border-t border-border">
          <button
            type="button"
            class="px-2 py-1 rounded text-[10px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
            @click="selectAll"
          >
            All
          </button>
          <button
            type="button"
            class="px-2 py-1 rounded text-[10px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
            @click="selectNone"
          >
            None
          </button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
