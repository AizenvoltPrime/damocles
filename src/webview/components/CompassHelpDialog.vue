<script setup lang="ts">
import { computed } from 'vue';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCompassStore } from '@/stores/useCompassStore';
import { EDGE_STYLE, nodePathGenerator } from '@/composables/compass/useGraphSymbols';
import type { CompassEdgeKind, CompassNodeKind } from '@shared/types/compass';

const store = useCompassStore();

const open = computed({
	get: () => store.helpOpen,
	set: (value: boolean) => {
		store.setHelpOpen(value);
	},
});

interface Shortcut {
	keys: string[];
	description: string;
}

const shortcuts: Shortcut[] = [
	{ keys: ['Tab'], description: 'Enter graph focus' },
	{ keys: ['Shift', 'Tab'], description: 'Exit graph focus' },
	{ keys: ['↑', '↓', '←', '→'], description: 'Move focus to nearest node' },
	{ keys: ['Enter'], description: 'Open file at line' },
	{ keys: ['Space'], description: 'Open file at line' },
	{ keys: ['Esc'], description: 'Clear selection / close dialog' },
	{ keys: ['?'], description: 'Open this dialog' },
	{ keys: ['F'], description: 'Fit graph to view' },
	{ keys: ['R'], description: 'Refresh graph' },
];

const nodeKinds: Array<{ kind: CompassNodeKind; label: string }> = [
	{ kind: 'File', label: 'File' },
	{ kind: 'Class', label: 'Class' },
	{ kind: 'Function', label: 'Function' },
	{ kind: 'Type', label: 'Type' },
	{ kind: 'Test', label: 'Test' },
];

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
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-xl max-h-[80vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Compass keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Keyboard shortcuts and graph legend reference.
        </DialogDescription>
      </DialogHeader>

      <section class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-foreground">
          Shortcuts
        </h3>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <template
            v-for="(s, idx) in shortcuts"
            :key="idx"
          >
            <dt class="flex items-center gap-1 flex-wrap">
              <template
                v-for="(k, i) in s.keys"
                :key="k"
              >
                <kbd class="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded border border-border bg-secondary text-secondary-foreground font-mono text-[10px]">{{ k }}</kbd>
                <span
                  v-if="i < s.keys.length - 1"
                  class="text-muted-foreground"
                >+</span>
              </template>
            </dt>
            <dd class="text-muted-foreground self-center">
              {{ s.description }}
            </dd>
          </template>
        </dl>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-foreground">
          Node legend
        </h3>
        <ul class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <li
            v-for="n in nodeKinds"
            :key="n.kind"
            class="flex items-center gap-2"
          >
            <svg
              width="16"
              height="16"
              viewBox="-10 -10 20 20"
              class="shrink-0"
            >
              <path
                :d="nodePathGenerator(n.kind)"
                fill="var(--foreground)"
                stroke="var(--background)"
                stroke-width="1"
              />
            </svg>
            <span class="text-muted-foreground">{{ n.label }}</span>
          </li>
        </ul>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-sm font-semibold text-foreground">
          Edge legend
        </h3>
        <ul class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
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
            <span class="text-muted-foreground">{{ e.label }}</span>
          </li>
        </ul>
      </section>
    </DialogContent>
  </Dialog>
</template>
