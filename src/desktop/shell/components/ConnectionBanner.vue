<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { useHostConnection } from '@/composables/useHostConnection';
import { hostAttention, type ShellHost } from '../../preload/shell-channels';
import HostStatusDot from './HostStatusDot.vue';
import { hostStateLabel } from '../host-label';
import HostUpdateBanner from '@/components/HostUpdateBanner.vue';

// The attempt main started at launch never opens a dialog itself; Sign in opens it on the waiting prompt.
// edge: the strip alone, continuing a chat page's banner (webview ConnectionBanner.vue) across the gutter; keep the one-line min-h-8 and colors equal.
const props = defineProps<{ host: ShellHost | undefined; edge?: boolean }>();
const emit = defineEmits<{ reconnect: [hostId: string]; signIn: [hostId: string]; showLog: [hostId: string]; editHost: [hostId: string]; switchWhenIdle: [hostId: string]; switchNow: [hostId: string] }>();
const { t } = useI18n();

const view = useHostConnection(() => (props.host ? { hostId: props.host.hostId, connected: props.host.connection === 'connected', reconnect: props.host.reconnect, attention: hostAttention(props.host) } : undefined));
const kind = view.kind;
const TONE = {
  warning: 'border-(--d-warning)/25 bg-[color-mix(in_srgb,var(--d-warning)_11%,var(--d-bg))] text-(--d-warning-text)',
  danger: 'border-(--d-danger)/28 bg-[color-mix(in_srgb,var(--d-danger)_11%,var(--d-bg))] text-(--d-danger-text)',
  success: 'border-(--d-success)/28 bg-[color-mix(in_srgb,var(--d-success)_11%,var(--d-bg))] text-(--d-success-text)',
} as const;
const tone = computed(() => TONE[kind.value === 'failed' ? 'danger' : kind.value === 'reconnected' ? 'success' : 'warning']);
const STRIP = 'flex min-h-8 shrink-0 items-center gap-2 border-b transition-colors duration-200 ease-out';

// The live region says what changed and never counts down, so a screen reader hears each state once.
const announcement = computed(() => {
  const name = props.host?.name ?? '';
  if (props.host?.update) return '';
  switch (kind.value) {
    case 'reconnecting': return t('remote.banner.announce.reconnecting', { name });
    case 'failed': return t('remote.banner.announce.failed', { name });
    case 'reconnected': return t('remote.banner.reconnected', { name });
    case 'signIn': return t('remote.banner.signIn', { name });
    case 'offline': return t('remote.banner.offline', { name });
    default: return '';
  }
});
</script>

<template>
  <div class="contents">
    <!-- A host waiting on a version switch is not offline: its banner takes the connection banner's place, its edge in the same tone. -->
    <div
      v-if="host?.update && edge"
      aria-hidden="true"
      data-testid="connection-banner-edge"
      data-state="update"
      :class="[STRIP, 'border-(--d-info)/28 bg-[color-mix(in_srgb,var(--d-info)_11%,var(--d-bg))]']"
    />
    <HostUpdateBanner
      v-else-if="host?.update"
      :host-name="host.name"
      :update="host.update"
      @switch-when-idle="emit('switchWhenIdle', host.hostId)"
      @switch-now="emit('switchNow', host.hostId)"
    />
    <Transition
      v-else
      name="t-banner"
    >
      <div
        v-if="host && kind && edge"
        aria-hidden="true"
        data-testid="connection-banner-edge"
        :data-state="kind"
        :class="[STRIP, tone]"
      />
      <div
        v-else-if="host && kind"
        data-testid="connection-banner"
        :data-state="kind"
        :data-host-id="host.hostId"
        class="connection-banner @container/banner px-3.5 py-1 text-12"
        :class="[STRIP, tone]"
      >
        <HostStatusDot
          :connection="host.connection"
          :reconnect="host.reconnect"
          :slow="host.latency?.slow"
          :label="hostStateLabel(host, t)"
        />
        <!-- The actions wrap below the whole sentence before either is cut; under 24rem it always stacks, so a ticking countdown never flips the layout. -->
        <div
          class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5"
          data-testid="connection-banner-body"
        >
          <span
            class="min-w-0 grow @max-[24rem]/banner:basis-full"
            data-testid="connection-banner-text"
          >
            <i18n-t
              v-if="kind === 'reconnecting' && view.seconds.value !== undefined && view.seconds.value > 0"
              keypath="remote.banner.reconnectingIn"
              scope="global"
            >
              <template #name>{{ host.name }}</template>
              <template #seconds><span
                class="tabular-nums"
                data-testid="connection-banner-countdown"
              >{{ view.seconds.value }}</span></template>
            </i18n-t>
            <template v-else-if="kind === 'reconnecting'">{{ t('remote.banner.reconnecting', { name: host.name }) }}</template>
            <template v-else-if="kind === 'failed'">{{ t('remote.banner.failed', { name: host.name }) }}</template>
            <template v-else-if="kind === 'reconnected'">{{ t('remote.banner.reconnected', { name: host.name }) }}</template>
            <template v-else-if="kind === 'signIn'">{{ t('remote.banner.signIn', { name: host.name }) }}</template>
            <template v-else>{{ t('remote.banner.offline', { name: host.name }) }}</template>
          </span>
          <div
            v-if="kind !== 'reconnected'"
            class="flex flex-wrap items-center gap-x-2"
            data-testid="connection-banner-actions"
          >
            <template v-if="kind === 'failed'">
              <Button
                v-for="action in (['reconnect', 'showLog', 'editHost'] as const)"
                :key="action"
                type="button"
                variant="link"
                size="sm"
                class="h-auto shrink-0 px-0 text-12 font-semibold text-current"
                :data-testid="`connection-banner-${action}`"
                @click="action === 'reconnect' ? emit('reconnect', host.hostId) : action === 'showLog' ? emit('showLog', host.hostId) : emit('editHost', host.hostId)"
              >
                {{ t(`remote.banner.${action === 'reconnect' ? 'retry' : action}`) }}
              </Button>
            </template>
            <Button
              v-else
              type="button"
              variant="link"
              size="sm"
              class="h-auto shrink-0 px-0 text-12 font-semibold text-current"
              data-testid="connection-banner-action"
              @click="kind === 'signIn' ? emit('signIn', host.hostId) : emit('reconnect', host.hostId)"
            >
              {{ kind === 'signIn' ? t('remote.banner.signInAction', { name: host.name }) : kind === 'reconnecting' ? t('remote.banner.reconnectNow') : t('remote.banner.reconnect') }}
            </Button>
          </div>
        </div>
      </div>
    </Transition>
    <p
      v-if="!edge"
      class="sr-only"
      aria-live="polite"
      data-testid="connection-banner-announcement"
    >
      {{ announcement }}
    </p>
  </div>
</template>
