<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleCheck, CloudOff, KeyRound, RefreshCw, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { chatHostAction, useChatHost } from '@/composables/useChatHost';
import { useHostConnection } from '@/composables/useHostConnection';
import { useConnectionStore } from '@/stores/useConnectionStore';
import HostUpdateBanner from './HostUpdateBanner.vue';

// The shell's ConnectionBanner edge continues this strip across the chat pane's gutter: keep the one-line min-h-8 height and colors equal.
const { t } = useI18n();
const host = useChatHost();
const connection = useConnectionStore();

const view = useHostConnection(() => {
  const current = host.value;
  if (!current) return undefined;
  const state = connection.state;
  return {
    connected: state.phase === 'connected' && current.attention === undefined,
    reconnect: state.phase === 'connected' || state.phase === 'offline' ? undefined : state,
    attention: current.attention,
  };
});
const kind = view.kind;
const TONE = {
  warning: 'border-(--d-warning)/25 bg-[color-mix(in_srgb,var(--d-warning)_11%,var(--d-bg))] text-(--d-warning-text)',
  danger: 'border-(--d-danger)/28 bg-[color-mix(in_srgb,var(--d-danger)_11%,var(--d-bg))] text-(--d-danger-text)',
  success: 'border-(--d-success)/28 bg-[color-mix(in_srgb,var(--d-success)_11%,var(--d-bg))] text-(--d-success-text)',
} as const;
const tone = computed(() => TONE[kind.value === 'failed' ? 'danger' : kind.value === 'reconnected' ? 'success' : 'warning']);

// The live region says what changed and never counts down, so a screen reader hears each state once.
const announcement = computed(() => {
  const name = host.value?.name ?? '';
  if (host.value?.update) return '';
  switch (kind.value) {
    case 'reconnecting': return t('remote.announce.reconnecting', { host: name });
    case 'failed': return t('remote.announce.failed', { host: name });
    case 'reconnected': return t('remote.reconnected', { host: name });
    case 'signIn': return t('remote.signIn', { host: name });
    case 'offline': return t('remote.offline', { host: name });
    default: return '';
  }
});
</script>

<template>
  <div class="contents">
    <!-- A host waiting on a version switch is not offline: its banner takes the connection banner's place. -->
    <HostUpdateBanner
      v-if="host?.update"
      :host-name="host.name"
      :update="host.update"
      @switch-when-idle="chatHostAction('switchWhenIdle')"
      @switch-now="chatHostAction('switchNow')"
    />
    <Transition
      v-else
      name="t-banner"
    >
      <div
        v-if="host && kind"
        data-testid="chat-connection-banner"
        :data-state="kind"
        class="@container/banner flex min-h-8 shrink-0 items-center gap-2 border-b py-1 ps-4 pe-2.5 text-12 transition-colors duration-200 ease-out"
        :class="tone"
      >
        <KeyRound
          v-if="kind === 'signIn'"
          aria-hidden="true"
          class="size-3.5 shrink-0"
        />
        <RefreshCw
          v-else-if="kind === 'reconnecting'"
          aria-hidden="true"
          class="d-pulsing size-3.5 shrink-0"
        />
        <TriangleAlert
          v-else-if="kind === 'failed'"
          aria-hidden="true"
          class="size-3.5 shrink-0"
        />
        <CircleCheck
          v-else-if="kind === 'reconnected'"
          aria-hidden="true"
          class="size-3.5 shrink-0"
        />
        <CloudOff
          v-else
          aria-hidden="true"
          class="size-3.5 shrink-0"
        />
        <!-- The actions wrap below the whole sentence before either is cut; under 24rem it always stacks, so a ticking countdown never flips the layout. -->
        <div
          class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5"
          data-testid="chat-connection-banner-body"
        >
          <span
            class="min-w-0 grow @max-[24rem]/banner:basis-full"
            data-testid="chat-connection-banner-text"
          >
            <i18n-t
              v-if="kind === 'reconnecting' && view.seconds.value !== undefined && view.seconds.value > 0"
              keypath="remote.reconnectingIn"
              scope="global"
            >
              <template #host>{{ host.name }}</template>
              <template #seconds><span
                class="tabular-nums"
                data-testid="chat-connection-banner-countdown"
              >{{ view.seconds.value }}</span></template>
            </i18n-t>
            <template v-else-if="kind === 'reconnecting'">{{ t('remote.reconnecting', { host: host.name }) }}</template>
            <template v-else-if="kind === 'failed'">{{ t('remote.failed', { host: host.name }) }}</template>
            <template v-else-if="kind === 'reconnected'">{{ t('remote.reconnected', { host: host.name }) }}</template>
            <template v-else-if="kind === 'signIn'">{{ t('remote.signIn', { host: host.name }) }}</template>
            <template v-else>{{ t('remote.offline', { host: host.name }) }}</template>
          </span>
          <div
            v-if="kind !== 'reconnected'"
            class="flex flex-wrap items-center gap-x-2"
            data-testid="chat-connection-banner-actions"
          >
            <template v-if="kind === 'failed'">
              <Button
                v-for="action in (['reconnect', 'showLog', 'editHost'] as const)"
                :key="action"
                type="button"
                variant="link"
                size="sm"
                class="h-auto shrink-0 px-0 text-12 font-semibold text-current"
                :data-testid="`chat-connection-banner-${action}`"
                @click="chatHostAction(action)"
              >
                {{ t(`remote.${action === 'reconnect' ? 'retry' : action}`) }}
              </Button>
            </template>
            <Button
              v-else
              type="button"
              variant="link"
              size="sm"
              class="h-auto shrink-0 px-0 text-12 font-semibold text-current"
              data-testid="chat-connection-banner-action"
              @click="chatHostAction(kind === 'signIn' ? 'signIn' : 'reconnect')"
            >
              {{ kind === 'signIn' ? t('remote.signInAction', { host: host.name }) : kind === 'reconnecting' ? t('remote.reconnectNow') : t('remote.reconnect') }}
            </Button>
          </div>
        </div>
      </div>
    </Transition>
    <p
      class="sr-only"
      aria-live="polite"
      data-testid="chat-connection-banner-announcement"
    >
      {{ announcement }}
    </p>
  </div>
</template>
