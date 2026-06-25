<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import {
  IconDatabase,
  IconPlay,
  IconCheck,
  IconFileText,
  IconSparkles,
  IconWarning,
  IconRepeat,
  IconKey,
  IconRotateLeft,
  IconChevronDown,
  IconChevronRight,
} from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import ConsolidationStepper from './ConsolidationStepper.vue';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import { useRelativeTime } from '@/composables/useRelativeTime';
import { useVSCode } from '@/composables/useVSCode';
import type { ConsolidationPersistOutcome } from '@shared/types/consolidation';

const emit = defineEmits<{ (e: 'close'): void }>();

const store = useConsolidationStore();
const { pendingCandidates, isRunning, pendingCount, lastResult, phase, phaseMeta, persistProgress } =
  storeToRefs(store);
const { postMessage } = useVSCode();

function triggerNow(): void {
  // Doherty-threshold ack: flip the stepper to Claim-active immediately, before the round-trip.
  store.ackManualRun();
  postMessage({ type: 'triggerConsolidation' });
}

function retry(): void {
  triggerNow();
}

function signIn(): void {
  postMessage({ type: 'openSettingsPanel' });
}

// ── Phase-aware header badge ──────────────────────────────────────────────────────────────────
const PHASE_LABELS: Record<string, string> = {
  claim: 'Claim',
  extract: 'Extract',
  persist: 'Persist',
  maintain: 'Maintain',
  profiles: 'Profiles',
};

const statusBadge = computed(() => {
  if (!isRunning.value) {
    return {
      label: 'Idle',
      class: 'bg-muted text-muted-foreground border-border',
      showSpinner: false,
    };
  }
  const base = PHASE_LABELS[phase.value] ?? 'Running';
  const label =
    phase.value === 'persist' && persistProgress.value.total > 0
      ? `${base} ${persistProgress.value.done}/${persistProgress.value.total}`
      : base;
  return {
    label,
    class: 'bg-primary/30 text-primary border-primary/30',
    showSpinner: true,
  };
});

const subtitle = computed(() =>
  isRunning.value ? 'Consolidating…' : `${pendingCount.value} turn${pendingCount.value === 1 ? '' : 's'} queued`,
);

// ── Honest progress strip ─────────────────────────────────────────────────────────────────────
const claimCount = computed(() => phaseMeta.value.claim.count ?? 0);

const STILL_THINKING_MS = 8_000;
const extractElapsedMs = ref(0);
let extractInterval: ReturnType<typeof setInterval> | null = null;

watch(
  phase,
  (p) => {
    if (extractInterval) {
      clearInterval(extractInterval);
      extractInterval = null;
    }
    if (p === 'extract') {
      const start = Date.now();
      extractElapsedMs.value = 0;
      extractInterval = setInterval(() => {
        extractElapsedMs.value = Date.now() - start;
      }, 1000);
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  if (extractInterval) clearInterval(extractInterval);
});

/** Strip descriptor: determinate (Persist) or indeterminate (everything else with no real ETA). */
const strip = computed(() => {
  switch (phase.value) {
    case 'claim':
      return { mode: 'indeterminate' as const, label: 'Reviewing queued turns…' };
    case 'extract':
      return {
        mode: 'indeterminate' as const,
        label:
          extractElapsedMs.value >= STILL_THINKING_MS
            ? 'Still thinking — extraction can take up to 20s'
            : `Reading ${claimCount.value} turn${claimCount.value === 1 ? '' : 's'}…`,
      };
    case 'persist':
      // Until the total is known (the first persist event), show an indeterminate bar rather than a
      // meaningless "0/0".
      return persistProgress.value.total > 0
        ? {
            mode: 'determinate' as const,
            label: 'Persisting extracted memories',
            done: persistProgress.value.done,
            total: persistProgress.value.total,
          }
        : { mode: 'indeterminate' as const, label: 'Persisting extracted memories…' };
    case 'maintain':
      return { mode: 'indeterminate' as const, label: 'Running maintenance…' };
    case 'profiles':
      return { mode: 'indeterminate' as const, label: 'Updating user profiles…' };
    default:
      return null;
  }
});

const persistPct = computed(() => {
  const { done, total } = persistProgress.value;
  return total > 0 ? Math.round((done / total) * 100) : 0;
});

// ── Terminal result ───────────────────────────────────────────────────────────────────────────
const { relative: ranRelative, absolute: ranAbsolute } = useRelativeTime(
  () => lastResult.value?.ranAt ?? null,
);

const FAILURE_COPY: Record<string, string> = {
  'no-model': 'No model is signed in — queued turns are safe and will retry.',
  unavailable: 'Memory system is unavailable — try reloading the window.',
};

const failureMessage = computed(() => {
  const f = lastResult.value?.failure;
  if (!f) return '';
  return FAILURE_COPY[f.kind] ?? f.detail ?? 'Consolidation failed.';
});

const failureFooter = computed(() => {
  const f = lastResult.value?.failure;
  if (!f) return '';
  const when = ranRelative.value || 'just now';
  return f.phase ? `Failed at ${f.phase} · ${when}` : when;
});

// ── Last-run summary (extracted / empty) ──────────────────────────────────────────────────────
const triggerChip = computed(() => {
  const manual = lastResult.value?.trigger === 'manual';
  return {
    label: manual ? 'Manual' : 'Auto',
    icon: manual ? IconPlay : IconRepeat,
    class: manual
      ? 'bg-violet-500/15 text-violet-400 border-violet-500/30'
      : 'bg-muted text-muted-foreground border-border',
  };
});

const rollup = computed<string[]>(() => {
  const r = lastResult.value;
  if (!r) return [];
  const counts: Record<ConsolidationPersistOutcome, number> = {
    inserted: 0,
    merged: 0,
    superseded: 0,
    deduped: 0,
    invalid: 0,
  };
  for (const m of r.extracted) counts[m.outcome]++;
  const parts: string[] = [];
  if (counts.inserted) parts.push(`${counts.inserted} new`);
  if (counts.merged) parts.push(`${counts.merged} merged`);
  if (counts.superseded) parts.push(`${counts.superseded} superseded`);
  if (counts.deduped) parts.push(`${counts.deduped} deduped`);
  if (counts.invalid) parts.push(`${counts.invalid} invalid`);
  if (r.maintenance.promoted) parts.push(`${r.maintenance.promoted} promoted`);
  if (r.maintenance.decayed) parts.push(`${r.maintenance.decayed} decayed`);
  if (r.maintenance.pruned) parts.push(`${r.maintenance.pruned} pruned`);
  return parts;
});

// ── Outcome badges (1px same-hue border + uppercase tracking + leading dot) ─────────────────────
const PERSIST_TONE: Record<ConsolidationPersistOutcome, { wrap: string; dot: string }> = {
  inserted: { wrap: 'border-success/40 text-success', dot: 'bg-success' },
  merged: { wrap: 'border-blue-400/40 text-blue-400', dot: 'bg-blue-400' },
  superseded: { wrap: 'border-violet-400/40 text-violet-400', dot: 'bg-violet-400' },
  deduped: { wrap: 'border-border text-muted-foreground', dot: 'bg-muted-foreground' },
  invalid: { wrap: 'border-error/40 text-error', dot: 'bg-error' },
};

// ── Collapsible queue (collapsed by default once a run exists) ──────────────────────────────────
const queueOpen = ref(true);
let queueUserToggled = false;
watch(
  lastResult,
  (r) => {
    if (r && !queueUserToggled) queueOpen.value = false;
  },
  { immediate: true },
);
function toggleQueue(): void {
  queueUserToggled = true;
  queueOpen.value = !queueOpen.value;
}

const showNoRunPlaceholder = computed(() => !lastResult.value && !isRunning.value);
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

    <!-- Honest progress strip (sticky under header while running) -->
    <div
      v-if="isRunning && strip"
      class="sticky top-0 z-10 px-4 py-2 bg-background/95 backdrop-blur border-b border-border/40"
    >
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <span class="text-[11px] text-muted-foreground truncate">{{ strip.label }}</span>
        <span
          v-if="strip.mode === 'determinate'"
          class="text-[11px] tabular-nums text-muted-foreground shrink-0"
        >{{ strip.done }}/{{ strip.total }}</span>
      </div>
      <div class="h-1 rounded-full bg-muted overflow-hidden">
        <div
          v-if="strip.mode === 'determinate'"
          class="h-full bg-primary rounded-full transition-[width] duration-300"
          :style="{ width: `${persistPct}%` }"
        />
        <div
          v-else
          class="h-full w-1/3 bg-primary/70 rounded-full"
          style="animation: indeterminate 1.4s ease-in-out infinite"
        />
      </div>
    </div>

    <div class="p-4 space-y-5">
      <!-- Live stepper while a pass runs -->
      <section v-if="isRunning">
        <ConsolidationStepper />
      </section>

      <!-- FAILURE card -->
      <section
        v-if="!isRunning && lastResult && lastResult.status === 'failed'"
        class="rounded-lg border border-error/30 bg-error/5 p-4 space-y-3"
      >
        <div class="flex items-start gap-2.5">
          <IconWarning
            :size="18"
            class="text-error shrink-0 mt-0.5"
          />
          <div class="space-y-1 min-w-0">
            <p class="text-sm text-foreground/90">
              {{ failureMessage }}
            </p>
            <p
              class="text-[11px] text-muted-foreground"
              :title="ranAbsolute"
            >
              {{ failureFooter }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            class="gap-1.5"
            @click="retry"
          >
            <IconRotateLeft :size="13" />
            <span>Retry now</span>
          </Button>
          <Button
            v-if="lastResult.failure?.kind === 'no-model'"
            variant="outline"
            size="sm"
            class="gap-1.5"
            @click="signIn"
          >
            <IconKey :size="13" />
            <span>Sign in to a model</span>
          </Button>
        </div>
      </section>

      <!-- EMPTY-SUCCESS card (neutral, no error tone, no retry) -->
      <section
        v-else-if="!isRunning && lastResult && lastResult.status === 'empty'"
        class="rounded-lg border border-border/60 bg-muted/30 p-4"
      >
        <div class="flex items-start gap-2.5">
          <IconCheck
            :size="16"
            class="text-muted-foreground shrink-0 mt-0.5"
          />
          <div class="space-y-1 min-w-0">
            <p class="text-sm text-foreground/80">
              Nothing new to remember — reviewed {{ lastResult.candidatesReviewed }} turn{{ lastResult.candidatesReviewed === 1 ? '' : 's' }}.
            </p>
            <div class="flex items-center gap-2 flex-wrap">
              <span
                class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
                :class="triggerChip.class"
              >
                <component
                  :is="triggerChip.icon"
                  :size="9"
                />
                {{ triggerChip.label }}
              </span>
              <span
                v-if="rollup.length"
                class="text-[11px] text-muted-foreground tabular-nums"
              >{{ rollup.join(' · ') }}</span>
              <span
                class="text-[11px] text-muted-foreground"
                :title="ranAbsolute"
              >{{ ranRelative }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- EXTRACTED: last-run summary + items -->
      <section v-else-if="!isRunning && lastResult && lastResult.status === 'extracted'">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <IconSparkles
            :size="13"
            class="text-violet-400 shrink-0"
          />
          <span class="text-xs font-medium text-foreground/90">
            Extracted {{ lastResult.extracted.length }}
          </span>
          <span
            class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
            :class="triggerChip.class"
          >
            <component
              :is="triggerChip.icon"
              :size="9"
            />
            {{ triggerChip.label }}
          </span>
          <span
            v-if="rollup.length"
            class="text-[11px] text-muted-foreground tabular-nums"
          >{{ rollup.join(' · ') }}</span>
          <span
            class="text-[11px] text-muted-foreground ml-auto"
            :title="ranAbsolute"
          >{{ ranRelative }}</span>
        </div>
        <ul class="space-y-1.5">
          <!-- Extracted memories carry no id; compose a stable key from their natural identity
               (kind/scope/content) so rows keep identity across re-renders instead of by index. -->
          <li
            v-for="m in lastResult.extracted"
            :key="`${m.kind}:${m.scope}:${m.content}`"
            class="rounded-md border border-border/50 bg-card px-3 py-2"
          >
            <div class="flex items-center gap-2 mb-1">
              <span
                class="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-medium"
                :class="PERSIST_TONE[m.outcome].wrap"
              >
                <span
                  class="h-1 w-1 rounded-full"
                  :class="PERSIST_TONE[m.outcome].dot"
                />
                {{ m.outcome }}
              </span>
              <span class="text-[10px] text-muted-foreground">{{ m.kind }} / {{ m.scope }}</span>
            </div>
            <MarkdownRenderer
              :content="m.content"
              class="text-xs text-foreground/90"
            />
          </li>
        </ul>
      </section>

      <!-- Queued turns (collapsible; collapsed by default once a run exists) -->
      <section>
        <button
          type="button"
          class="flex items-center gap-2 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors w-full cursor-pointer"
          @click="toggleQueue"
        >
          <component
            :is="queueOpen ? IconChevronDown : IconChevronRight"
            :size="12"
          />
          <IconFileText :size="13" />
          <span>Queued for consolidation ({{ pendingCandidates.length }})</span>
        </button>
        <template v-if="queueOpen">
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
              class="rounded-md border border-border/50 bg-muted/40 px-3 py-2 text-xs space-y-1.5 cursor-pointer hover:bg-muted/60 transition-colors"
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
        </template>
      </section>

      <!-- First-run placeholder -->
      <div
        v-if="showNoRunPlaceholder"
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
