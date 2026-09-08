<script setup lang="ts">
import { ref, watch, onUnmounted, computed, type Component } from "vue";
import { useI18n } from 'vue-i18n';
import { usePhraseCycler } from "../composables/usePhraseCycler";
import { sessionStateTreatment, type SessionStateIcon } from "@/lib/session-state-indicator";
import LottieSpinner from "@/components/LottieSpinner.vue";
import { IconExclamation } from "@/components/icons";

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

const ICON_COMPONENTS: Record<Exclude<SessionStateIcon, null>, Component> = {
  spinner: LottieSpinner,
  exclamation: IconExclamation,
};

const iconComponent = computed<Component | null>(() => {
  const icon = treatment.value.icon;
  return icon === null ? null : ICON_COMPONENTS[icon];
});

const startTime = ref<number | null>(null);
const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

const { currentPhrase } = usePhraseCycler(() => props.isProcessing);

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
  <span class="sr-only" role="status" aria-live="polite">
    {{ awaitingUserAction ? t('status.requiresAction') : '' }}
  </span>

  <div
    v-if="isVisible"
    class="flex items-center pl-1 pr-4 border-t"
    :class="treatment.barClass"
  >
    <!-- Fixed box so the bar keeps its height when the spinner is swapped for the smaller parked icon. -->
    <div
      class="flex h-[52px] w-[52px] shrink-0 items-center justify-center"
      :class="treatment.iconClass"
      aria-hidden="true"
    >
      <component
        :is="iconComponent"
        v-if="iconComponent"
        :size="treatment.iconSize"
      />
    </div>
    <!-- Hidden from a reader because the live region above already carries this exact string. -->
    <span
      v-if="awaitingUserAction"
      class="flex-1 text-base truncate"
      :class="treatment.labelClass"
      aria-hidden="true"
    >{{ t('status.requiresAction') }}</span>
    <span v-else class="flex-1 text-base truncate" :class="treatment.labelClass">
      {{ statusOverride ?? (currentToolName ? t('status.running', { tool: currentToolName }) : currentPhrase) }}
      <span v-if="hookLabel" class="text-xs opacity-40 not-italic"> · {{ t('status.hook', { event: hookLabel }) }}</span>
    </span>
    <span class="text-sm text-muted-foreground font-mono">
      {{ formattedTime }}
    </span>
  </div>
</template>
