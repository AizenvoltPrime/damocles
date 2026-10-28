<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleAlert, KeyRound, LoaderCircle, Power } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import HostBadge from '@/components/HostBadge.vue';
import { PROVIDER_NAMES } from '@shared/types/messages';
import type { CloseRemoteChoice, CloseRemoteRow, CloseRemoteStatus, DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { answerOf } from '../popup-answer';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';
import AllowBackgroundWork from './AllowBackgroundWork.vue';

// A close or quit while remote chats run: each chat with its live status, Keep running focused first.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'closeRemote' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const rows = shallowRef<readonly CloseRemoteRow[]>(props.request.rows);
const dontAskAgain = ref(false);
const checkboxId = useId();

let stop: (() => void) | undefined;
onMounted(() => {
  stop = props.api.onCloseRemoteRows((next) => {
    rows.value = next;
  });
});
onBeforeUnmount(() => stop?.());

const CHOICES: readonly CloseRemoteChoice[] = ['cancel', 'stop', 'keep'];
const KEEP = 2;
const buttons = computed((): DialogButton[] => [
  { label: t('closeRemote.cancel'), variant: 'plain', testId: 'close-remote-cancel' },
  { label: t('closeRemote.stop'), variant: 'plain', testId: 'close-remote-stop' },
  { label: t('closeRemote.keep'), variant: 'fill', testId: 'close-remote-keep' },
]);

function choose(index: number): void {
  const choice = CHOICES[index] ?? 'cancel';
  emit('answer', { kind: 'closeRemote', choice, dontAskAgain: choice !== 'cancel' && dontAskAgain.value });
}

// One Allow background work per host, under its chats.
const lingerHosts = computed(() => [...new Map(rows.value.filter((row) => row.lingerWarning).map((row) => [row.hostId, row.hostLabel])).entries()]);

const TONE: Readonly<Record<CloseRemoteStatus, string>> = { running: 'd-tone-accent', waiting: 'd-tone-warning', signIn: 'd-tone-warning', idle: 'd-tone-success' };
// own keys only: a provider id such as "constructor" would read Object.prototype
const providerName = (provider: string): string => (Object.hasOwn(PROVIDER_NAMES, provider) ? PROVIDER_NAMES[provider]! : provider);
</script>

<template>
  <OverlayDialog
    severity="accent"
    :icon="Power"
    :title="t('closeRemote.title')"
    :buttons="buttons"
    :initial-focus="KEEP"
    :cancel-index="0"
    wide
    test-id="close-remote"
    @choose="choose"
  >
    <p class="text-12.5/relaxed text-pretty text-(--d-muted)">
      {{ t('closeRemote.body', rows.length) }}
    </p>
    <ul
      class="flex max-h-60 flex-col gap-1.5 overflow-y-auto"
      :aria-label="t('closeRemote.listLabel')"
    >
      <li
        v-for="row in rows"
        :key="row.panelId"
        data-testid="close-remote-row"
        :data-panel-id="row.panelId"
        :data-status="row.status"
        class="flex flex-col gap-1 rounded-9 bg-(--d-hover) px-3 py-2"
      >
        <div class="flex min-w-0 items-center gap-2">
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-13 text-(--d-text)">{{ row.title || t('closeRemote.newChat') }}</span>
            <span class="truncate text-11 text-(--d-faint-text)">{{ row.projectLabel }}</span>
          </span>
          <Transition
            name="t-swap-box"
            mode="out-in"
          >
            <Badge
              :key="row.status"
              as="span"
              variant="tone"
              data-testid="close-remote-status"
              :class="['flex shrink-0 gap-1 border-0 bg-(--tone)/15 px-1.5 py-px text-10.5 font-medium', TONE[row.status]]"
            >
              <LoaderCircle
                v-if="row.status === 'running'"
                aria-hidden="true"
                class="d-spinning size-2.5"
              />
              <KeyRound
                v-else-if="row.status === 'signIn'"
                aria-hidden="true"
                class="size-2.5"
              />
              <CircleAlert
                v-else-if="row.status === 'waiting'"
                aria-hidden="true"
                class="size-2.5"
              />
              <Check
                v-else
                aria-hidden="true"
                class="size-2.5"
              />
              {{ t(`closeRemote.status.${row.status}`) }}
            </Badge>
          </Transition>
          <HostBadge
            :name="row.hostLabel"
            :tone="row.hostTone"
          />
        </div>
        <p
          v-if="row.tokenNote"
          data-testid="close-remote-token-note"
          class="text-11 text-(--d-warning-text)"
        >
          {{ t('closeRemote.tokenNote', row.tokenNote.minutesLeft, { named: { provider: providerName(row.tokenNote.provider), minutes: row.tokenNote.minutesLeft } }) }}
        </p>
      </li>
    </ul>
    <div
      v-for="[hostId, hostLabel] in lingerHosts"
      :key="hostId"
      data-testid="close-remote-linger"
      class="flex flex-col gap-1.5 rounded-9 bg-(--d-warning)/12 px-3 py-2 text-11.5 text-(--d-warning-text)"
    >
      <span>{{ t('closeRemote.linger', { name: hostLabel }) }}</span>
      <AllowBackgroundWork
        :host-name="hostLabel"
        :allow="() => answerOf(api.allowBackgroundWork(hostId))"
      />
    </div>
    <div class="flex items-center gap-2">
      <Checkbox
        :id="checkboxId"
        :checked="dontAskAgain"
        data-testid="close-remote-dont-ask"
        class="size-3.75 shrink-0 rounded-xs border-(--d-border2) data-[state=checked]:border-(--d-accent) data-[state=checked]:bg-(--d-accent) data-[state=checked]:text-(--d-on-accent) [&_svg]:size-2.75"
        @update:checked="dontAskAgain = $event"
      />
      <label
        :for="checkboxId"
        class="cursor-pointer text-12.5"
      >{{ t('closeRemote.dontAskAgain') }}</label>
    </div>
  </OverlayDialog>
</template>
