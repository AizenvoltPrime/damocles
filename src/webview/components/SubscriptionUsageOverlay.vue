<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Eye, Gauge, LoaderCircle, RotateCcw } from 'lucide-vue-next';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import { providerLogoSvg } from '@/components/icons/provider-logos';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import type { ProviderUsage, UsageSpend, UsageWindowBar } from '@shared/types/usage';

const { t, te, locale } = useI18n();
const store = useSubscriptionUsageStore();
const { postMessage } = usePlatformBridge();

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

const loading = computed(() => store.isLoading && !timedOut.value);

function fillColor(util: number): string {
  if (util >= 90) return 'bg-(--d-danger)';
  if (util >= 70) return 'bg-(--d-warning)';
  return 'bg-(--d-accent)';
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

const providers = computed(() => {
  const data = store.data;
  if (!data) return [];
  return [
    { id: 'claude' as const, name: t('usage.sectionClaude'), logo: providerLogoSvg('anthropic'), plan: null, usage: data.claude, notConnected: t('usage.claudeNotConnected'), label: (bar: UsageWindowBar) => barLabel(bar.id) },
    { id: 'gpt' as const, name: t('usage.sectionGpt'), logo: providerLogoSvg('openai'), plan: data.gpt.status === 'ok' ? data.gpt.planType ?? null : null, usage: data.gpt, notConnected: t('usage.gptNotConnected'), label: windowLabel },
  ];
});

// Raw profile values look like `default_claude_max_20x`; the vendor prefixes tell the user nothing.
function readableProfileValue(raw: string): string {
  const words = raw.replace(/^default_/, '').replace(/^claude_/, '').split('_').filter(Boolean);
  return words.map((w) => (/^\d+x$/.test(w) ? w : capitalize(w))).join(' ');
}

interface ProfileRow {
  key: string;
  label: string;
  value: string;
}

const profileRows = computed<ProfileRow[]>(() => {
  const p = claude.value?.profile;
  if (!p) return [];
  const rows: ProfileRow[] = [];
  const add = (key: string, raw: string | null): void => {
    if (raw) rows.push({ key, label: t(`usage.account.${key}`), value: readableProfileValue(raw) });
  };
  add('plan', p.organizationType);
  add('seatTier', p.seatTier);
  add('rateLimitTier', p.rateLimitTier);
  add('subscriptionStatus', p.subscriptionStatus);
  if (p.hasExtraUsageEnabled !== null) {
    rows.push({
      key: 'extraUsage',
      label: t('usage.account.extraUsage'),
      value: t(p.hasExtraUsageEnabled ? 'usage.account.on' : 'usage.account.off'),
    });
  }
  return rows;
});

type IdentityKey = 'email' | 'organizationName';

const identityRows = computed<(ProfileRow & { key: IdentityKey })[]>(() => {
  const p = claude.value?.profile;
  if (!p) return [];
  return (['email', 'organizationName'] as const).flatMap((key) => {
    const value = p[key];
    return value ? [{ key, label: t(`usage.account.${key}`), value }] : [];
  });
});

// Never persisted: the overlay unmounts on close, so identifying fields are masked again on reopen.
const revealed = ref<Record<IdentityKey, boolean>>({ email: false, organizationName: false });

function openUsageUrl(url: string): void {
  postMessage({ type: 'openExternalUrl', url });
}

function refresh(): void {
  store.refresh();
  postMessage({ type: 'requestSubscriptionUsage' });
}
</script>

<template>
  <OverlayShell
    :title="t('usage.title')"
    :subtitle="t('overlays.usage.subtitle')"
    :icon="Gauge"
    max-width="47.5rem"
    data-testid="subscription-usage-overlay"
    @close="$emit('close')"
  >
    <template #header-actions>
      <OverlayHeaderAction
        :label="t('usage.refresh')"
        :icon="RotateCcw"
        icon-only
        :busy="loading"
        :disabled="loading"
        data-testid="usage-refresh"
        @click="refresh"
      />
    </template>

    <div
      v-if="loading && !store.data"
      class="flex items-center justify-center gap-2 py-16 text-(--d-faint)"
      role="status"
    >
      <LoaderCircle
        class="size-4 d-spinning"
        aria-hidden="true"
      />{{ t('common.loading') }}
    </div>

    <div
      v-else-if="!store.data"
      class="flex flex-col items-center justify-center gap-2 py-16 text-(--d-faint)"
    >
      <Gauge
        class="size-7"
        aria-hidden="true"
      />
      <p class="text-13 font-medium text-(--d-muted)">
        {{ t('usage.fetchError') }}
      </p>
    </div>

    <div
      v-else
      class="flex flex-col gap-5.5 px-4.5 pt-4 pb-5 transition-opacity duration-200"
      :class="loading && 'opacity-55'"
    >
      <section
        v-for="provider in providers"
        :key="provider.id"
        class="flex flex-col gap-3"
        :data-testid="`usage-${provider.id}`"
      >
        <div class="flex items-center gap-2">
          <!-- eslint-disable vue/no-v-html -- a vendored static logo constant (provider-logos.ts) -->
          <span
            v-if="provider.logo"
            class="flex size-3.25 flex-none [&>svg]:size-full"
            aria-hidden="true"
            v-html="provider.logo"
          />
          <!-- eslint-enable vue/no-v-html -->
          <h3 class="text-11 font-semibold tracking-[.06em] text-(--d-muted) uppercase">
            {{ provider.name }}
          </h3>
          <span
            v-if="provider.plan"
            class="rounded-full bg-(--d-hover) px-1.75 text-10.5/4.5 font-medium text-(--d-text)"
          >{{ provider.plan }}</span>
        </div>

        <p
          v-if="provider.usage.status === 'not-connected'"
          class="text-xs text-(--d-muted)"
        >
          {{ provider.notConnected }}
        </p>
        <p
          v-else-if="provider.usage.status === 'error'"
          class="text-xs text-(--d-danger)"
        >
          {{ t('usage.fetchError') }}<template v-if="provider.usage.error">: {{ provider.usage.error }}</template>
        </p>
        <div
          v-else-if="provider.id === 'gpt' && provider.usage.usageUrl && provider.usage.bars.length === 0"
          class="flex flex-col gap-1"
          data-testid="gpt-usage-link"
        >
          <p class="text-xs text-(--d-muted)">
            {{ t('usage.gptUsageElsewhere') }}
          </p>
          <button
            type="button"
            class="self-start text-xs text-(--d-accent) hover:underline"
            :title="t('usage.openChatGPTUsage')"
            @click="openUsageUrl(provider.usage.usageUrl)"
          >
            {{ t('usage.gptUsageLink') }}
          </button>
        </div>
        <template v-else>
          <div
            v-for="bar in provider.usage.bars"
            :key="bar.id"
            class="flex flex-col gap-1.25"
          >
            <div class="flex items-center gap-2 text-12.5">
              <span class="min-w-0 flex-1 truncate">{{ provider.label(bar) }}</span>
              <span class="font-mono text-xs text-(--d-muted) tabular-nums">{{ Math.round(bar.utilization) }}%</span>
            </div>
            <div
              class="h-1.5 overflow-hidden rounded-full bg-(--d-hover)"
              role="progressbar"
              :aria-label="provider.label(bar)"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="Math.round(bar.utilization)"
            >
              <div
                class="d-bar h-full rounded-full"
                :class="fillColor(bar.utilization)"
                :style="{ width: `${Math.min(bar.utilization, 100)}%` }"
              />
            </div>
            <p
              v-if="resetsCaption(bar.resetsAt)"
              class="text-11 text-(--d-faint)"
            >
              {{ resetsCaption(bar.resetsAt) }}
            </p>
          </div>
          <p
            v-if="provider.usage.spend"
            class="text-xs text-(--d-muted)"
          >
            {{ spendText(provider.usage.spend) }}
          </p>
        </template>

        <div
          v-if="provider.id === 'claude' && claude?.profile"
          class="flex flex-col gap-2 rounded-10 border border-(--d-border) bg-(--d-card) p-3"
          data-testid="claude-account"
        >
          <h4 class="text-xs font-semibold">
            {{ t('usage.account.title') }}
          </h4>
          <dl class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs">
            <template
              v-for="row in profileRows"
              :key="row.key"
            >
              <dt class="text-(--d-faint)">
                {{ row.label }}
              </dt>
              <dd
                class="truncate"
                :class="row.key === 'subscriptionStatus' && row.value === 'Active' ? 'text-(--d-success)' : 'text-(--d-text)'"
              >
                {{ row.value }}
              </dd>
            </template>
            <template
              v-for="row in identityRows"
              :key="row.key"
            >
              <dt class="text-(--d-faint)">
                {{ row.label }}
              </dt>
              <dd class="flex min-w-0">
                <span
                  v-if="revealed[row.key]"
                  class="min-w-0 truncate text-(--d-text) select-text"
                >{{ row.value }}</span>
                <button
                  v-else
                  type="button"
                  class="-ml-1.5 flex h-5.5 items-center gap-1.5 rounded-md px-1.5 tracking-widest text-(--d-faint) transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
                  :aria-label="t('usage.account.reveal', { field: row.label })"
                  :title="t('usage.account.reveal', { field: row.label })"
                  @click="revealed[row.key] = true"
                >
                  ••••••••<Eye
                    class="size-2.75"
                    aria-hidden="true"
                  />
                </button>
              </dd>
            </template>
          </dl>
        </div>
        <p
          v-else-if="provider.id === 'claude' && claude?.profileError && claude.status === 'ok'"
          class="text-xs text-(--d-muted)"
        >
          {{ t('usage.account.unavailable') }}
        </p>
      </section>
    </div>
  </OverlayShell>
</template>
