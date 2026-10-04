<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCompassStore } from '@/stores/useCompassStore';
import { EDGE_STYLE, nodePathGenerator } from '@/composables/compass/useGraphSymbols';
import type { CompassEdgeKind, CompassNodeKind } from '@shared/types/compass';

const { t } = useI18n();
const store = useCompassStore();

const open = computed({
	get: () => store.helpOpen,
	set: (value: boolean) => {
		store.setHelpOpen(value);
	},
});

interface Shortcut {
	keys: string[];
	descriptionKey: string;
}

const shortcuts: Shortcut[] = [
	{ keys: ['Tab'], descriptionKey: 'compass.help.enterFocus' },
	{ keys: ['Shift', 'Tab'], descriptionKey: 'compass.help.exitFocus' },
	{ keys: ['↑', '↓', '←', '→'], descriptionKey: 'compass.help.moveFocus' },
	{ keys: ['Enter'], descriptionKey: 'compass.help.openFile' },
	{ keys: ['Space'], descriptionKey: 'compass.help.openFile' },
	{ keys: ['Esc'], descriptionKey: 'compass.help.clearSelection' },
	{ keys: ['?'], descriptionKey: 'compass.help.openHelp' },
	{ keys: ['F'], descriptionKey: 'compass.help.fit' },
	{ keys: ['R'], descriptionKey: 'compass.help.refresh' },
];

const NODE_KINDS: CompassNodeKind[] = ['File', 'Class', 'Function', 'Type', 'Test'];
const nodeKinds = computed(() => NODE_KINDS.map((kind) => ({ kind, label: t(`compass.nodeKind.${kind}`) })));

const EDGE_KINDS: CompassEdgeKind[] = ['CALLS', 'IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'CONTAINS', 'TESTED_BY', 'DEPENDS_ON', 'REFERENCES'];
const edgeKinds = computed(() => EDGE_KINDS.map((kind) => ({ kind, label: t(`compass.edgeKind.${kind}`) })));
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-xl max-h-[80vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ t('compass.help.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('compass.help.description') }}
        </DialogDescription>
      </DialogHeader>

      <section class="flex flex-col gap-2">
        <h3 class="text-10.5 font-normal tracking-[.06em] text-(--d-faint) uppercase">
          {{ t('compass.help.shortcuts') }}
        </h3>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-12.5">
          <template
            v-for="(s, idx) in shortcuts"
            :key="idx"
          >
            <dt class="flex items-center gap-1 flex-wrap">
              <template
                v-for="(k, i) in s.keys"
                :key="k"
              >
                <kbd class="inline-flex min-w-6 items-center justify-center rounded-sm border border-(--d-border) bg-(--d-card) px-1.5 py-px font-mono text-10.5 text-(--d-muted)">{{ k }}</kbd>
                <span
                  v-if="i < s.keys.length - 1"
                  class="text-(--d-muted)"
                >+</span>
              </template>
            </dt>
            <dd class="text-(--d-muted) self-center">
              {{ t(s.descriptionKey) }}
            </dd>
          </template>
        </dl>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-10.5 font-normal tracking-[.06em] text-(--d-faint) uppercase">
          {{ t('compass.help.nodeLegend') }}
        </h3>
        <ul class="grid grid-cols-2 gap-x-4 gap-y-2 text-12.5">
          <li
            v-for="n in nodeKinds"
            :key="n.kind"
            class="flex items-center gap-2"
          >
            <svg
              viewBox="-10 -10 20 20"
              class="size-4 shrink-0"
            >
              <path
                :d="nodePathGenerator(n.kind)"
                fill="var(--d-text)"
                stroke="var(--d-bg)"
                stroke-width="1"
              />
            </svg>
            <span class="text-(--d-muted)">{{ n.label }}</span>
          </li>
        </ul>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-10.5 font-normal tracking-[.06em] text-(--d-faint) uppercase">
          {{ t('compass.help.edgeLegend') }}
        </h3>
        <ul class="grid grid-cols-2 gap-x-4 gap-y-2 text-12.5">
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
            <span class="text-(--d-muted)">{{ e.label }}</span>
          </li>
        </ul>
      </section>
    </DialogContent>
  </Dialog>
</template>
