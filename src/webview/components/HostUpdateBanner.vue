<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDownToLine, CircleArrowUp, Clock, LoaderCircle, Timer } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { HostUpdate } from '@shared/host-update';
import { injectPageHeading } from '@/composables/usePageHeading';
import { BANNER_TONE, hostUpdateState, hostUpdateTone, terminalsHold } from './banner-tone';
import CountdownClock from './CountdownClock.vue';
import { deadlineParts, useUpdateClock } from './host-update-clock';

// A pending server switch on the host, or this app being too old for it. The shell and the chat page show the same strip, so
// both bundles carry its hostUpdate keys and the one-line min-h-8 matches ConnectionBanner's.
const props = defineProps<{
  hostName: string;
  update: HostUpdate;
  // the app's updater runs; absent in the unpackaged app
  canCheckForUpdates?: boolean | undefined;
}>();
const emit = defineEmits<{ switchWhenIdle: []; switchNow: []; checkForUpdates: [] }>();
const { t } = useI18n();
const clock = useUpdateClock();

const tone = computed(() => hostUpdateTone(props.update));
const state = computed(() => hostUpdateState(props.update));
const counted = (key: string, count: number, named: Record<string, unknown> = {}): string => t(key, count, { named: { ...named, count } });

// Every state's sentence but the required one's and the countdown's, whose time left stays out of the live text.
const sentence = computed((): string => {
  const update = props.update;
  const named = { host: props.hostName, from: update.serverVersion, to: update.targetVersion };
  switch (state.value) {
    case 'offer': return terminalsHold(update) ? counted('hostUpdate.runningTerminals', update.runningTerminals, named) : counted('hostUpdate.running', update.runningAgents, named);
    case 'switching': return t('hostUpdate.switching', named);
    case 'appOutdated': return t(update.outdated === 'floor' ? 'hostUpdate.appOutdatedFloor' : 'hostUpdate.appOutdated', named);
    case 'required':
    case 'countdown': return '';
    case 'waiting': break;
  }
  if (update.runningAgents > 0) return counted('hostUpdate.waiting', update.runningAgents, named);
  if (update.cliWaits) return counted('hostUpdate.waitingCliWaits', update.cliWaits, named);
  const devices = update.otherDevices ?? 0;
  if (update.drainEndsAt !== undefined) return counted('hostUpdate.waitingDrain', devices, { ...named, time: clock.time(update.drainEndsAt) });
  if (terminalsHold(update)) return counted('hostUpdate.waitingTerminals', update.runningTerminals, named);
  // a legacy daemon is never drained, so other devices hold it until they disconnect
  if (!update.terminalsSurvive && devices > 0) return counted('hostUpdate.waitingDevices', devices, named);
  return t('hostUpdate.waitingFree', named);
});

const deadline = computed(() => deadlineParts(props.update.required?.deadline ?? 0, clock, t));

// What the sentence leaves out: a required one's agents, the pending damocles --wait requests, then the terminals a legacy
// daemon closes, unless they alone hold it and the sentence named them.
const tail = computed((): string => {
  const update = props.update;
  const parts: string[] = [];
  if (update.runningAgents > 0 && state.value === 'required') parts.push(counted('hostUpdate.requiredAgents', update.runningAgents));
  if (update.runningAgents > 0 && state.value === 'countdown') parts.push(counted('hostUpdate.countdownAgents', update.runningAgents));
  const waits = update.cliWaits ?? 0;
  if (waits > 0 && state.value === 'countdown') parts.push(counted('hostUpdate.countdownCliWaits', waits));
  else if (waits > 0 && state.value !== 'switching' && state.value !== 'appOutdated' && !(state.value === 'waiting' && update.runningAgents === 0)) parts.push(counted('hostUpdate.cliWaits', waits));
  const pending = update.phase === 'offer' || update.phase === 'waiting';
  const named = (state.value === 'offer' || state.value === 'waiting') && terminalsHold(update);
  if (pending && !named && !update.terminalsSurvive && update.runningTerminals > 0) parts.push(counted('hostUpdate.terminalsClose', update.runningTerminals));
  return parts.map((part) => ` ${part}`).join('');
});

const strip = ref<HTMLElement | null>(null);
const switchNowButton = ref<InstanceType<typeof Button> | null>(null);
const pageHeading = injectPageHeading();
// An action that goes away under focus hands it on: to Switch now, else to the page's heading.
watch(state, async () => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !strip.value?.contains(active)) return;
  await nextTick();
  if (active.isConnected) return;
  ((switchNowButton.value?.$el as HTMLElement | undefined) ?? pageHeading?.())?.focus();
});

const ACTION = 'h-auto shrink-0 px-0 text-12 font-semibold text-current';
</script>

<template>
  <div
    ref="strip"
    data-testid="host-update-banner"
    :data-phase="update.phase"
    :data-state="state"
    :data-tone="tone"
    class="@container/banner flex min-h-8 shrink-0 items-center gap-2 border-b py-1 ps-4 pe-2.5 text-12 transition-colors duration-200 ease-out"
    :class="BANNER_TONE[tone]"
  >
    <!-- the spin sits on the wrapper so t-icon's entrance never fights it -->
    <span
      aria-hidden="true"
      data-testid="host-update-icon"
      class="inline-flex size-3.5 shrink-0 [&_svg]:size-3.5"
      :class="{ 'd-spinning': state === 'switching' }"
    >
      <Transition name="t-icon">
        <LoaderCircle v-if="state === 'switching'" />
        <ArrowDownToLine v-else-if="state === 'appOutdated'" />
        <Clock v-else-if="state === 'required'" />
        <Timer v-else-if="state === 'countdown'" />
        <CircleArrowUp v-else />
      </Transition>
    </span>
    <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span
        class="min-w-0 grow @max-[24rem]/banner:basis-full"
        role="status"
        data-testid="host-update-banner-text"
      >
        <i18n-t
          v-if="state === 'countdown' && update.required"
          keypath="hostUpdate.countdown"
          scope="global"
        >
          <template #host>{{ hostName }}</template>
          <template #to>{{ update.targetVersion }}</template>
          <template #clock><CountdownClock
            :to="update.required.deadline"
            live
          /></template>
        </i18n-t>
        <i18n-t
          v-else-if="state === 'required'"
          keypath="hostUpdate.required"
          scope="global"
        >
          <template #host>{{ hostName }}</template>
          <template #to>{{ update.targetVersion }}</template>
          <template #by>{{ deadline.by }}</template>
          <template #left><span aria-hidden="true">{{ deadline.left }}</span></template>
        </i18n-t>
        <template v-else>{{ sentence }}</template>{{ tail }}
      </span>
      <div class="flex flex-wrap items-center gap-x-2">
        <Button
          v-if="state === 'offer'"
          type="button"
          variant="link"
          size="sm"
          :class="ACTION"
          data-testid="host-update-when-idle"
          @click="emit('switchWhenIdle')"
        >
          {{ t(terminalsHold(update) ? 'hostUpdate.switchWhenClosed' : 'hostUpdate.switchWhenIdle') }}
        </Button>
        <Button
          v-if="update.phase === 'offer' || update.phase === 'waiting'"
          ref="switchNowButton"
          type="button"
          variant="link"
          size="sm"
          :class="ACTION"
          data-testid="host-update-now"
          @click="emit('switchNow')"
        >
          {{ t('hostUpdate.switchNow') }}
        </Button>
        <Button
          v-if="update.phase === 'appOutdated' && canCheckForUpdates"
          type="button"
          variant="link"
          size="sm"
          :class="ACTION"
          data-testid="host-update-check"
          @click="emit('checkForUpdates')"
        >
          {{ t('hostUpdate.checkUpdates') }}
        </Button>
      </div>
    </div>
  </div>
</template>
