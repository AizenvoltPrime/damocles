<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconChartBar, IconRotateLeft } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { useVSCode } from '@/composables/useVSCode';
import type { ProviderUsage, UsageSpend, UsageWindowBar } from '@shared/types/usage';

const { t, te, locale } = useI18n();
const store = useSubscriptionUsageStore();
const { postMessage } = useVSCode();

defineEmits<{
  (e: 'close'): void;
}>();

// Wall-clock tick drives countdown captions without any network per tick.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 30_000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (loadTimer) clearTimeout(loadTimer);
});

// Safety net: the handler always posts one reply, but if it never arrives (dropped/crashed host)
// the spinner would hang forever. Surface a terminal error instead. Re-armed on each fetch.
const LOAD_TIMEOUT_MS = 20_000;
const timedOut = ref(false);
let loadTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => store.isLoading,
  (loading) => {
    if (loadTimer) clearTimeout(loadTimer);
    if (loading) {
      timedOut.value = false;
      loadTimer = setTimeout(() => { timedOut.value = true; }, LOAD_TIMEOUT_MS);
    }
  },
  { immediate: true },
);

function fillColor(util: number): string {
  if (util >= 90) return 'bg-rose-500';
  if (util >= 70) return 'bg-amber-500';
  return 'bg-sky-500';
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function titleCase(id: string): string {
  return id.split('_').map(capitalize).join(' ');
}

function barLabel(id: string): string {
  const key = `usage.windows.${id}`;
  if (te(key)) return t(key);
  // Unknown model-scoped weekly (window ids churn: Sonnet→Fable→…): localize the "Weekly" prefix.
  if (id.startsWith('seven_day_')) return `${t('usage.windows.weekly')} ${capitalize(id.slice('seven_day_'.length))}`;
  return titleCase(id);
}

// Label Codex bars by window duration, not array position — a free plan reports a single
// monthly window while premium reports 5h + weekly, so the label follows the seconds, not the slot.
function windowLabel(bar: UsageWindowBar): string {
  const s = bar.windowSeconds;
  if (typeof s === 'number') {
    if (s <= 6 * 3600) return t('usage.windows.five_hour');
    if (s <= 8 * 86400) return t('usage.windows.weekly');
    return t('usage.windows.monthly');
  }
  return barLabel(bar.id);
}

function formatCountdown(msDiff: number): string {
  const totalMin = Math.floor(msDiff / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const min = totalMin % 60;
    return min > 0 ? `${totalHr}h ${min}m` : `${totalHr}h`;
  }
  const days = Math.floor(totalHr / 24);
  const hr = totalHr % 24;
  return hr > 0 ? `${days}d ${hr}h` : `${days}d`;
}

function resetsCaption(resetsAt: number | null): string | null {
  if (resetsAt === null || resetsAt <= now.value) return null;
  return t('usage.resetsIn', { time: formatCountdown(resetsAt - now.value) });
}

function formatCurrency(n: number, currency?: string): string {
  return new Intl.NumberFormat(locale.value, { style: 'currency', currency: currency ?? 'USD' }).format(n);
}

function spendText(spend: UsageSpend): string {
  if (spend.kind === 'balance') {
    return t('usage.credits', { amount: formatCurrency(spend.amount, spend.currency) });
  }
  const used = formatCurrency(spend.amount, spend.currency);
  const amount = spend.limit != null ? `${used} / ${formatCurrency(spend.limit, spend.currency)}` : used;
  return t('usage.extraUsage', { amount });
}

const claude = computed<ProviderUsage | undefined>(() => store.data?.claude);
const gpt = computed<ProviderUsage | undefined>(() => store.data?.gpt);

function refresh(): void {
  store.refresh();
  postMessage({ type: 'requestSubscriptionUsage' });
}
</script>

<template>
  <OverlayShell
    :title="t('usage.title')"
    :icon="IconChartBar"
    icon-class="text-sky-400"
    @close="$emit('close')"
  >
    <template #header-actions>
      <Button
        variant="ghost"
        size="icon-sm"
        :disabled="store.isLoading && !timedOut"
        :title="t('usage.refresh')"
        @click="refresh"
      >
        <IconRotateLeft :size="16" :class="{ 'animate-spin-reverse': store.isLoading && !timedOut }" />
      </Button>
    </template>

    <!-- Loading with no data yet -->
    <div v-if="store.isLoading && !store.data && !timedOut" class="flex-1 flex items-center justify-center py-16">
      <LoadingSpinner :size="32" />
    </div>

    <!-- Terminal state: reply never arrived (timed out) and nothing to show -->
    <div v-else-if="!store.data" class="flex-1 flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
      <IconChartBar :size="32" class="opacity-40" />
      <p class="text-sm font-medium">{{ t('usage.fetchError') }}</p>
    </div>

    <div v-else class="p-4 space-y-6">
      <!-- Claude -->
      <section class="space-y-3">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {{ t('usage.sectionClaude') }}
        </h3>
        <p v-if="claude!.status === 'not-connected'" class="text-xs text-muted-foreground">
          {{ t('usage.claudeNotConnected') }}
        </p>
        <p v-else-if="claude!.status === 'error'" class="text-xs text-rose-400">
          {{ t('usage.fetchError') }}<template v-if="claude!.error">: {{ claude!.error }}</template>
        </p>
        <template v-else>
          <div v-for="bar in claude!.bars" :key="bar.id" class="space-y-1">
            <div class="flex items-center gap-2 text-xs">
              <span class="text-foreground flex-1 truncate">{{ barLabel(bar.id) }}</span>
              <span class="tabular-nums text-muted-foreground">{{ Math.round(bar.utilization) }}%</span>
            </div>
            <div
              class="h-1.5 rounded-full bg-muted/30 overflow-hidden"
              role="progressbar"
              :aria-label="barLabel(bar.id)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="Math.round(bar.utilization)"
            >
              <div
                class="h-full rounded-full transition-all"
                :class="fillColor(bar.utilization)"
                :style="{ width: `${Math.min(bar.utilization, 100)}%` }"
              />
            </div>
            <p v-if="resetsCaption(bar.resetsAt)" class="text-xs text-muted-foreground">
              {{ resetsCaption(bar.resetsAt) }}
            </p>
          </div>
          <p v-if="claude!.spend" class="text-xs text-muted-foreground pt-1">
            {{ spendText(claude!.spend) }}
          </p>
        </template>
      </section>

      <!-- GPT -->
      <section class="space-y-3">
        <div class="flex items-center gap-2">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {{ t('usage.sectionGpt') }}
          </h3>
          <Badge v-if="gpt!.status === 'ok' && gpt!.planType" variant="secondary" class="text-xs">
            {{ gpt!.planType }}
          </Badge>
        </div>
        <p v-if="gpt!.status === 'not-connected'" class="text-xs text-muted-foreground">
          {{ t('usage.gptNotConnected') }}
        </p>
        <p v-else-if="gpt!.status === 'error'" class="text-xs text-rose-400">
          {{ t('usage.fetchError') }}<template v-if="gpt!.error">: {{ gpt!.error }}</template>
        </p>
        <template v-else>
          <div v-for="bar in gpt!.bars" :key="bar.id" class="space-y-1">
            <div class="flex items-center gap-2 text-xs">
              <span class="text-foreground flex-1 truncate">{{ windowLabel(bar) }}</span>
              <span class="tabular-nums text-muted-foreground">{{ Math.round(bar.utilization) }}%</span>
            </div>
            <div
              class="h-1.5 rounded-full bg-muted/30 overflow-hidden"
              role="progressbar"
              :aria-label="windowLabel(bar)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="Math.round(bar.utilization)"
            >
              <div
                class="h-full rounded-full transition-all"
                :class="fillColor(bar.utilization)"
                :style="{ width: `${Math.min(bar.utilization, 100)}%` }"
              />
            </div>
            <p v-if="resetsCaption(bar.resetsAt)" class="text-xs text-muted-foreground">
              {{ resetsCaption(bar.resetsAt) }}
            </p>
          </div>
          <p v-if="gpt!.spend" class="text-xs text-muted-foreground pt-1">
            {{ spendText(gpt!.spend) }}
          </p>
        </template>
      </section>
    </div>
  </OverlayShell>
</template>
