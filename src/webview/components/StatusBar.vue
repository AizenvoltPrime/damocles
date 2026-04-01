<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from "vue";
import { useI18n } from 'vue-i18n';
import { usePhraseCycler } from "../composables/usePhraseCycler";
import LottieSpinner from "./LottieSpinner.vue";

const { t } = useI18n();

const props = defineProps<{
  isProcessing: boolean;
  currentToolName?: string;
  statusOverride?: string;
  activeHooks?: Map<string, { hookName: string; hookEvent: string }>;
}>();

const startTime = ref<number | null>(null);
const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

const { currentPhrase } = usePhraseCycler(() => props.isProcessing);

const hookLabel = computed(() => {
  if (!props.activeHooks?.size) return null;
  if (props.activeHooks.size === 1) {
    const [hook] = props.activeHooks.values();
    return hook.hookEvent;
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

watch(
  () => props.isProcessing,
  (processing) => {
    if (processing) {
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
  <div v-if="isProcessing" class="flex items-center pl-2 pr-4 pt-1 border-t border-border/30 bg-card">
    <LottieSpinner :size="52" class="shrink-0" />
    <span class="flex-1 text-base text-muted-foreground italic truncate">
      {{ statusOverride ?? (currentToolName ? t('status.running', { tool: currentToolName }) : currentPhrase) }}
      <span v-if="hookLabel" class="text-xs opacity-40 not-italic"> · {{ t('status.hook', { event: hookLabel }) }}</span>
    </span>
    <span class="text-sm text-muted-foreground font-mono">
      {{ formattedTime }}
    </span>
  </div>
</template>
