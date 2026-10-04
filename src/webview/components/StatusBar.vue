<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from "vue";
import { useI18n } from 'vue-i18n';
import { LoaderCircle } from 'lucide-vue-next';
import { usePhraseCycler } from "../composables/usePhraseCycler";
import { sessionStateTreatment } from "@/lib/session-state-indicator";

const { t } = useI18n();

const props = defineProps<{
  isProcessing: boolean;
  // The store getter owns the comparison against the published session state, so the bar never repeats it.
  awaitingUserAction: boolean;
  currentToolName?: string | undefined;
  statusOverride?: string | undefined;
  activeHooks?: Map<string, { hookName: string; hookEvent: string }> | undefined;
}>();

// A pending prompt outranks the turn lifecycle, so the bar stays up even once processing has stopped.
const isVisible = computed(() => props.isProcessing || props.awaitingUserAction);

// The bar can be up before the first sessionStateChanged lands, so anything not parked draws as working.
const treatment = computed(() => sessionStateTreatment(props.awaitingUserAction ? 'requires_action' : 'running'));

const startTime = ref<number | null>(null);
const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

const { currentPhrase } = usePhraseCycler(() => props.isProcessing);

const label = computed(() => props.statusOverride ?? (props.currentToolName ? t('status.running', { tool: props.currentToolName }) : currentPhrase.value));

const hookLabel = computed(() => {
  if (!props.activeHooks?.size) return null;
  if (props.activeHooks.size === 1) {
    const [hook] = props.activeHooks.values();
    return hook?.hookEvent ?? null;
  }
  return t('status.hooksCount', { count: props.activeHooks.size });
});

const formattedTime = computed(() => {
  const s = elapsedSeconds.value;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
});

// Tracks the bar, not the turn, so the clock keeps counting while a prompt holds the run past the turn.
watch(
  isVisible,
  (visible) => {
    if (visible) {
      startTime.value = Date.now();
      elapsedSeconds.value = 0;
      timerInterval = setInterval(() => {
        if (startTime.value) {
          elapsedSeconds.value = Math.floor((Date.now() - startTime.value) / 1000);
        }
      }, 1000);
    } else {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      startTime.value = null;
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval);
});
</script>

<template>
  <!-- Always mounted so a text change is announced, and only the parked label goes in it because the phrases would talk over everything. -->
  <span
    class="sr-only"
    role="status"
    aria-live="polite"
  >
    {{ awaitingUserAction ? t('status.requiresAction') : '' }}
  </span>

  <Transition name="t-up">
    <div
      v-if="isVisible"
      class="flex items-center gap-2.5 px-1"
      data-testid="status-row"
    >
      <template v-if="awaitingUserAction">
        <span
          class="size-2 flex-none rounded-full"
          :class="treatment.iconClass"
          aria-hidden="true"
        />
        <!-- Hidden from a reader because the live region above already carries this exact string. -->
        <span
          class="min-w-0 flex-1 truncate"
          :class="treatment.labelClass"
          aria-hidden="true"
          data-testid="status-label"
        >{{ t('status.requiresAction') }}</span>
      </template>
      <template v-else>
        <LoaderCircle
          class="size-3.75 flex-none"
          :class="treatment.iconClass"
          aria-hidden="true"
        />
        <span class="flex min-w-0 flex-1 items-baseline gap-1">
          <span
            class="d-glint min-w-0 truncate"
            :class="treatment.labelClass"
            data-testid="status-label"
          >{{ label }}<span
            class="d-glint-window text-(--d-text)"
            aria-hidden="true"
          ><span>{{ label }}</span></span></span>
          <span
            v-if="hookLabel"
            class="flex-none text-11 text-(--d-faint)"
          >· {{ t('status.hook', { event: hookLabel }) }}</span>
        </span>
        <span class="flex-none text-11 text-(--d-faint)">{{ t('status.escToInterrupt') }}</span>
      </template>
      <span
        class="flex-none font-mono text-11.5 text-(--d-faint) tabular-nums"
        data-testid="status-elapsed"
      >{{ formattedTime }}</span>
    </div>
  </Transition>
</template>
