<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import {
  IconDatabase,
  IconPlay,
  IconCheck,
  IconFileText,
  IconSparkles,
} from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import { useVSCode } from '@/composables/useVSCode';

const emit = defineEmits<{ (e: 'close'): void }>();

const store = useConsolidationStore();
const { pendingCandidates, isRunning, pendingCount, lastResult } = storeToRefs(store);
const { postMessage } = useVSCode();

function triggerNow(): void {
  postMessage({ type: 'triggerConsolidation' });
}

const statusBadge = computed(() => ({
  label: isRunning.value ? 'Running' : 'Idle',
  class: isRunning.value
    ? 'bg-primary/30 text-primary border-primary/30'
    : 'bg-muted text-muted-foreground border-border',
  showSpinner: isRunning.value,
}));

const subtitle = computed(() =>
  isRunning.value
    ? 'Consolidating…'
    : `${pendingCount.value} turn${pendingCount.value === 1 ? '' : 's'} queued`,
);

const PERSIST_TONE: Record<string, string> = {
  inserted: 'bg-success/20 text-success',
  merged: 'bg-blue-500/15 text-blue-400',
  superseded: 'bg-violet-500/15 text-violet-400',
  deduped: 'bg-muted text-muted-foreground',
  invalid: 'bg-error/20 text-error',
};
</script>

<template>
  <OverlayShell
    title="Memory Consolidation"
    :subtitle="subtitle"
    :icon="IconDatabase"
    icon-class="text-violet-400"
    :status-badge="statusBadge"
    @close="emit('close')"
  >
    <template #header-actions>
      <Button
        variant="secondary"
        size="sm"
        class="gap-1.5 shrink-0"
        :disabled="isRunning"
        title="Run a full consolidation pass now"
        @click="triggerNow"
      >
        <IconPlay :size="14" />
        <span>Run now</span>
      </Button>
    </template>

    <div class="p-4 space-y-5">
      <!-- Queued: turns considered for the next pass -->
      <section>
        <div class="flex items-center gap-2 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <IconFileText :size="13" />
          <span>Queued for consolidation ({{ pendingCandidates.length }})</span>
        </div>
        <div
          v-if="pendingCandidates.length === 0"
          class="text-sm text-muted-foreground pl-1 py-2"
        >
          No turns waiting — everything has been consolidated.
        </div>
        <div
          v-else
          class="space-y-1.5"
        >
          <div
            v-for="c in pendingCandidates"
            :key="c.id"
            class="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-xs space-y-1.5"
          >
            <div>
              <span class="text-[10px] uppercase tracking-wide text-muted-foreground">User</span>
              <MarkdownRenderer
                :content="c.userPreview"
                class="text-xs text-foreground/90"
              />
            </div>
            <div>
              <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Assistant</span>
              <MarkdownRenderer
                :content="c.assistantPreview"
                class="text-xs text-muted-foreground/80"
              />
            </div>
          </div>
        </div>
      </section>

      <!-- Last run: what was extracted -->
      <section v-if="lastResult">
        <div class="flex items-center gap-2 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <IconSparkles :size="13" />
          <span>Last run — extracted {{ lastResult.extracted.length }}</span>
        </div>
        <div
          v-if="lastResult.extracted.length === 0"
          class="text-sm text-muted-foreground pl-1 py-2"
        >
          No new memories were extracted.
        </div>
        <ul
          v-else
          class="space-y-1.5"
        >
          <li
            v-for="(m, i) in lastResult.extracted"
            :key="i"
            class="rounded-md border border-border/50 bg-card px-3 py-2"
          >
            <div class="flex items-center gap-2 mb-1">
              <span
                class="text-[10px] px-1.5 py-0.5 rounded"
                :class="PERSIST_TONE[m.outcome]"
              >{{ m.outcome }}</span>
              <span class="text-[10px] text-muted-foreground">{{ m.kind }} / {{ m.scope }}</span>
            </div>
            <MarkdownRenderer
              :content="m.content"
              class="text-xs text-foreground/90"
            />
          </li>
        </ul>
      </section>

      <div
        v-if="!lastResult && !isRunning"
        class="text-center text-muted-foreground text-sm py-6"
      >
        <IconCheck
          :size="20"
          class="mx-auto mb-2 opacity-60"
        />
        <p>No consolidation has run yet this session.</p>
        <p class="text-xs mt-1">
          Click <span class="text-foreground">Run now</span> to consolidate the queued turns.
        </p>
      </div>
    </div>
  </OverlayShell>
</template>
