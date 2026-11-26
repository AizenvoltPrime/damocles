<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDownToLine, ArrowLeft, Bot, Box, Check, CircleArrowUp, Clock, FileText, FolderPlus, Key, KeyRound, Laptop, LoaderCircle, Pencil, Plug, Server, ServerOff, Settings2, Shield, SquareTerminal, Timer, TriangleAlert, Users, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { hostUpdateState, hostUpdateTone, terminalsHold } from '@/components/banner-tone';
import CountdownClock from '@/components/CountdownClock.vue';
import { deadlineParts, useUpdateClock } from '@/components/host-update-clock';
import { hostColorLook } from '@shared/host-colors';
import { visibleText } from '@shared/visible-text';
import type { HostCardInfo, HostRun, HostUpdateAction, InstallFolderResult, LingerResult, NameCheck, RemoteBrowseResult } from '../../../preload/overlay-channels';
import HostStatusDot from '../../components/HostStatusDot.vue';
import { draining, hostStatus, removedText, updateLead } from '../../host-label';
import LatencySparkline from './LatencySparkline.vue';
import HostNameField from './HostNameField.vue';
import InstallFolderField from './InstallFolderField.vue';
import AllowBackgroundWork from './AllowBackgroundWork.vue';
import { devicesDiffer, distroDetail, failureText, hostNotices, needsInstallFolder, otherDeviceCount } from '../connect-text';

// One saved host: its state, the probe's notices, what runs on it, its safety settings, Rename in place and its install
// folder. Every action goes through the props, events and the wsl and actions slots, so any parent can show it.
const props = defineProps<{
  host: HostCardInfo;
  // undefined while loading; 'failed' when main could not list them
  runs: readonly HostRun[] | 'failed' | undefined;
  // End terminal host runs: main's question, then the hosts ending
  endingTerminalHost?: boolean;
  checkName: (name: string) => Promise<NameCheck | undefined>;
  rename: (name: string) => Promise<NameCheck | undefined>;
  setInstallFolder: (folder: string | null) => Promise<InstallFolderResult | undefined>;
  // the connected host's folders, for its install folder
  browse: (path?: string) => Promise<RemoteBrowseResult | undefined>;
  allowBackgroundWork: () => Promise<LingerResult | undefined>;
  // opens with the name field open (Rename from a project's menu)
  startRenaming?: boolean;
  // shown as a popover from a host chip, with no host list to go back to
  hideBack?: boolean;
}>();
const emit = defineEmits<{ back: []; close: []; connect: []; openFolder: []; showLog: []; openSettings: []; kill: [runId: string]; openRun: [runId: string]; endTerminalHost: []; updateAction: [action: HostUpdateAction] }>();
defineSlots<{ wsl?: () => unknown; container?: () => unknown; actions?: () => unknown }>();
const { t, locale } = useI18n();
const clock = useUpdateClock();

const headingId = useId();
const renaming = ref(false);
const draft = ref('');
const field = ref<InstanceType<typeof HostNameField> | null>(null);
const renameButton = ref<InstanceType<typeof Button> | null>(null);
const choosingFolder = ref(false);

const update = computed(() => props.host.update);
// this app is older than the host's server: the host is not usable from here, so the card lists nothing it runs
const outdated = computed(() => update.value?.phase === 'appOutdated');
// a daemon of another protocol serves this app no workspace, so nothing below the Update section applies to it
const unattached = computed(() => update.value?.source === 'otherProtocol');
// the heading names the host, so the row shows its state alone and the latency never truncates away
const statusText = computed(() => hostStatus(props.host, t));
const UPDATE_NOTE = {
  info: 'bg-(--d-info-fill)/12 text-(--d-info-text)',
  warning: 'bg-(--d-warning-fill)/12 text-(--d-warning-text)',
  danger: 'bg-(--d-danger-fill)/12 text-(--d-danger-text)',
} as const;
const UPDATE_PILL = {
  info: 'bg-(--d-info-fill)/16 text-(--d-info-text) hover:bg-(--d-info-fill)/16',
  warning: 'bg-(--d-warning-fill)/16 text-(--d-warning-text) hover:bg-(--d-warning-fill)/16',
  danger: 'bg-(--d-danger-fill)/16 text-(--d-danger-text) hover:bg-(--d-danger-fill)/16',
} as const;
const updateTone = computed(() => (update.value ? hostUpdateTone(update.value) : 'info'));
const updateState = computed(() => (update.value ? hostUpdateState(update.value) : undefined));
// the live lead says a required switch's deadline; its distance shows beside it, hidden, as it changes each minute
const deadline = computed(() => deadlineParts(update.value?.required?.deadline ?? 0, clock, t));
// a legacy daemon's terminals end with it; switching already ends them
const terminalsClose = computed(() => {
  const current = update.value;
  return current !== undefined && !current.terminalsSurvive && (current.phase === 'offer' || current.phase === 'waiting');
});
// a terminal host whose daemon cannot reach it holds one of the rows; End terminal host ends every such host
const notResponding = computed(() => props.runs !== undefined && props.runs !== 'failed' && props.runs.some((run) => run.notResponding === true));
// What a pending switch waits for, and what it stops.
const blockers = computed(() => {
  const current = update.value;
  if (!current || (current.phase !== 'offer' && current.phase !== 'waiting')) return [];
  const rows: Array<{ key: 'agents' | 'cliWaits' | 'devices' | 'closes' | 'survive'; text: string }> = [];
  if (current.runningAgents > 0) rows.push({ key: 'agents', text: t(`hostUpdate.card.${updateState.value === 'countdown' ? 'stopping' : 'agents'}`, current.runningAgents, { named: { count: current.runningAgents } }) });
  const waits = current.cliWaits ?? 0;
  if (waits > 0) rows.push({ key: 'cliWaits', text: t(`hostUpdate.card.${updateState.value === 'countdown' ? 'cliWaitsStopping' : 'cliWaits'}`, waits, { named: { count: waits } }) });
  const devices = current.otherDevices ?? 0;
  if (devices > 0) {
    // a legacy daemon is never drained, so its other computers only disconnect
    const text = !current.terminalsSurvive
      ? t('hostUpdate.card.devices', devices, { named: { count: devices } })
      : draining(current)
        ? t('hostUpdate.card.devicesAt', devices, { named: { count: devices, time: clock.time(current.drainEndsAt) } })
        : t('hostUpdate.card.devicesAfter', devices, { named: { count: devices } });
    rows.push({ key: 'devices', text });
  }
  if (current.runningTerminals > 0) {
    rows.push(terminalsClose.value
      ? { key: 'closes', text: t('hostUpdate.card.closes', current.runningTerminals, { named: { count: current.runningTerminals } }) }
      : { key: 'survive', text: t('hostUpdate.card.survive') });
  }
  return rows;
});

const heading = ref<HTMLElement | null>(null);
const updateSection = ref<HTMLElement | null>(null);
const switchNowButton = ref<InstanceType<typeof Button> | null>(null);
// An action that goes away under focus hands it on: to Switch now, else to the card's heading.
watch(updateState, async () => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !updateSection.value?.contains(active)) return;
  await nextTick();
  if (active.isConnected) return;
  ((switchNowButton.value?.$el as HTMLElement | undefined) ?? heading.value)?.focus();
});
const terminalHostNotice = ref<HTMLElement | null>(null);
// End terminal host's notice leaving under focus hands it to the card's heading.
watch(notResponding, (now) => {
  const active = document.activeElement;
  if (!now && active instanceof HTMLElement && terminalHostNotice.value?.contains(active)) heading.value?.focus();
});
const notices = computed(() => hostNotices(props.host, t, locale.value));
const failure = computed(() => (props.host.failure ? failureText(props.host.failure, props.host.name, t) : undefined));
const removed = computed(() => removedText(props.host, t));
const others = computed(() => otherDeviceCount(props.host.devices));
// A container's image, engine, where it runs and what it was made from, each only when known.
const containerFacts = computed(() => {
  const container = props.host.container;
  if (!container) return [];
  const facts: Array<{ key: string; value: string }> = [];
  if (container.image !== undefined) facts.push({ key: 'image', value: visibleText(container.image) });
  facts.push({ key: 'engine', value: container.engine });
  facts.push({ key: 'runsOn', value: container.via ? container.via.name : t('remote.container.thisComputer') });
  if (container.workspaceFolder !== undefined) facts.push({ key: 'folder', value: visibleText(container.workspaceFolder) });
  if (container.configPath !== undefined) facts.push({ key: 'config', value: visibleText(container.configPath) });
  if (container.containerName !== undefined) facts.push({ key: 'container', value: visibleText(container.containerName) });
  if (container.user !== undefined) facts.push({ key: 'user', value: t(`remote.container.user.${container.user}`) });
  return facts;
});
const safety = computed(() => [
  props.host.defaultPermissionMode ? t('remote.card.mode', { mode: t(`remoteHosts.mode.${props.host.defaultPermissionMode}`) }) : t('remote.card.hostMode'),
  props.host.allowBypass ? t('remote.card.yoloAllowed') : t('remote.card.yoloNotAllowed'),
].join(' · '));

async function startRename(): Promise<void> {
  draft.value = props.host.name;
  renaming.value = true;
  await nextTick();
  field.value?.focus();
  field.value?.select();
}

onMounted(() => {
  if (props.startRenaming) void startRename();
});

async function endRename(): Promise<void> {
  renaming.value = false;
  await nextTick();
  (renameButton.value?.$el as HTMLElement | undefined)?.focus();
}

async function save(name: string): Promise<void> {
  if (name === props.host.name) {
    await endRename();
    return;
  }
  let result: NameCheck | undefined;
  try {
    result = await props.rename(name);
  } catch {
    field.value?.saveFailed();
    return;
  }
  if (!result) return;
  if (result.ok) await endRename();
  else field.value?.refuse(result);
}
</script>

<template>
  <section
    class="flex min-h-0 flex-1 flex-col"
    data-testid="host-card"
    :aria-labelledby="headingId"
  >
    <div class="flex items-center gap-3 border-b border-(--d-border) px-4.5 pt-4 pb-3">
      <span
        aria-hidden="true"
        data-testid="host-card-icon"
        class="grid size-8.5 shrink-0 place-items-center rounded-10 bg-(--tone)/15"
        v-bind="hostColorLook(host.color)"
      >
        <SquareTerminal
          v-if="host.kind === 'wsl'"
          class="size-4.5"
        />
        <Box
          v-else-if="host.kind === 'container'"
          class="size-4.5"
        />
        <Server
          v-else
          class="size-4.5"
        />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <template v-if="renaming">
            <!-- the section's name while the field replaces its heading -->
            <span
              :id="headingId"
              class="sr-only"
            >{{ host.name }}</span>
            <HostNameField
              ref="field"
              v-model="draft"
              :label="t('remote.card.renameLabel')"
              :check="(name) => checkName(name)"
              class="w-56 max-w-full"
              @submit="save"
              @cancel="endRename"
            />
          </template>
          <template v-else>
            <h2
              :id="headingId"
              ref="heading"
              tabindex="-1"
              class="min-w-0 truncate text-15 font-semibold"
            >
              <Transition
                name="t-swap"
                mode="out-in"
              >
                <span
                  :key="host.name"
                  data-testid="host-card-name"
                >{{ host.name }}</span>
              </Transition>
            </h2>
            <Button
              ref="renameButton"
              type="button"
              variant="ghost"
              size="icon-sm"
              class="size-6 rounded-6 text-(--d-muted) hover:text-(--d-text)"
              :aria-label="t('remote.card.rename', { name: host.name })"
              :title="t('remote.card.rename', { name: host.name })"
              @click="startRename"
            >
              <Pencil
                aria-hidden="true"
                class="size-3"
              />
            </Button>
          </template>
        </div>
        <span
          dir="ltr"
          data-testid="host-card-destination"
          class="truncate font-mono text-11 text-(--d-faint-text)"
        >{{ host.wsl ? distroDetail(host.name, host.wsl) : host.destinationLabel }}</span>
      </div>
      <!-- in the header row, so a long name truncates before Close -->
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="host-card-close"
        :data-view-focus="(outdated && !host.canCheckForUpdates) || undefined"
        class="size-7 shrink-0 self-start rounded-7 text-(--d-muted)"
        :aria-label="t('remote.connect.close')"
        @click="emit('close')"
      >
        <X
          aria-hidden="true"
          class="size-3.5"
        />
      </Button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4.5 py-3.5">
      <div class="flex items-center gap-2.5 rounded-10 bg-(--d-panel) px-2.5 py-2">
        <HostStatusDot
          :connection="host.connection"
          :reconnect="host.reconnect"
          :slow="host.latency?.slow"
          :update="update"
        />
        <span
          class="min-w-0 flex-1 truncate text-13 font-semibold"
          data-testid="host-card-status"
        >{{ statusText }}</span>
        <LatencySparkline
          v-if="host.connection === 'connected' && !host.reconnect && host.latency"
          :history="host.latency.history"
          :slow="host.latency.slow"
          :measurements="host.latency.measurements"
        />
      </div>

      <p
        v-if="removed"
        role="status"
        data-testid="host-card-removed"
        class="flex gap-2 rounded-8 bg-(--d-warning-fill)/12 px-2.5 py-2 text-12 text-(--d-warning-text)"
      >
        <ServerOff
          aria-hidden="true"
          class="mt-0.5 size-3.5 shrink-0"
        />
        <span class="min-w-0">{{ removed }}</span>
      </p>

      <section
        v-if="update"
        ref="updateSection"
        class="flex flex-col gap-1.5"
        data-testid="host-update"
        :data-phase="update.phase"
        :data-state="updateState"
        :data-tone="updateTone"
      >
        <h3 class="text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
          {{ t('hostUpdate.card.heading') }}
        </h3>
        <div
          class="flex gap-2 rounded-8 px-2.5 py-2 text-12"
          :class="UPDATE_NOTE[updateTone]"
        >
          <LoaderCircle
            v-if="update.phase === 'switching'"
            aria-hidden="true"
            class="d-spinning mt-0.5 size-3.5 shrink-0"
          />
          <ArrowDownToLine
            v-else-if="outdated"
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <Clock
            v-else-if="updateState === 'required'"
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <Timer
            v-else-if="updateState === 'countdown'"
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <CircleArrowUp
            v-else
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <p
              class="font-semibold"
              role="status"
              data-testid="host-update-lead"
            >
              <i18n-t
                v-if="updateState === 'countdown' && update.required"
                keypath="hostUpdate.card.lead.countdown"
                scope="global"
              >
                <template #to>
                  {{ update.targetVersion }}
                </template>
                <template #clock>
                  <CountdownClock
                    :to="update.required.deadline"
                    live
                  />
                </template>
              </i18n-t>
              <i18n-t
                v-else-if="updateState === 'required' && update.required"
                keypath="hostUpdate.card.lead.required"
                scope="global"
              >
                <template #to>
                  {{ update.targetVersion }}
                </template>
                <template #by>
                  {{ deadline.by }}
                </template>
                <template #left>
                  <span aria-hidden="true">{{ deadline.left }}</span>
                </template>
              </i18n-t>
              <template v-else>
                {{ updateLead(update, t, clock) }}
              </template>
            </p>
            <ul
              v-if="blockers.length > 0"
              class="flex flex-col gap-1"
            >
              <li
                v-for="blocker in blockers"
                :key="blocker.key"
                class="flex items-center gap-2"
                :data-blocker="blocker.key"
                :class="blocker.key === 'closes' ? 'font-semibold text-(--d-warning-text)' : 'text-(--d-text)'"
              >
                <Bot
                  v-if="blocker.key === 'agents'"
                  aria-hidden="true"
                  class="size-3.5 shrink-0 text-(--d-muted)"
                />
                <FileText
                  v-else-if="blocker.key === 'cliWaits'"
                  aria-hidden="true"
                  class="size-3.5 shrink-0 text-(--d-muted)"
                />
                <Laptop
                  v-else-if="blocker.key === 'devices'"
                  aria-hidden="true"
                  class="size-3.5 shrink-0 text-(--d-muted)"
                />
                <Check
                  v-else-if="blocker.key === 'survive'"
                  aria-hidden="true"
                  class="size-3.5 shrink-0 text-(--d-success-text)"
                />
                <SquareTerminal
                  v-else
                  aria-hidden="true"
                  class="size-3.5 shrink-0"
                />
                <span class="min-w-0">{{ blocker.text }}</span>
              </li>
            </ul>
            <p
              v-if="outdated"
              class="text-(--d-text)"
              data-testid="host-update-sub"
            >
              {{ update.outdated === 'floor'
                ? t('hostUpdate.card.floorSub', { to: update.targetVersion, from: update.serverVersion, host: host.name })
                : t('hostUpdate.card.outdatedSub', { to: update.targetVersion }) }}
            </p>
            <div
              v-if="update.phase !== 'switching' && (!outdated || host.canCheckForUpdates)"
              class="flex flex-wrap gap-1.5"
            >
              <Button
                v-if="updateState === 'offer'"
                type="button"
                variant="outline"
                size="sm"
                data-view-focus
                data-testid="host-update-when-idle"
                class="d-press h-7 rounded-lg border-(--d-border2) bg-transparent px-2.75 text-12 font-normal text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)"
                @click="emit('updateAction', 'switchWhenIdle')"
              >
                {{ t(terminalsHold(update) ? 'hostUpdate.switchWhenClosed' : 'hostUpdate.switchWhenIdle') }}
              </Button>
              <Button
                v-if="!outdated"
                ref="switchNowButton"
                type="button"
                variant="ghost"
                size="sm"
                :data-view-focus="updateState !== 'offer' || undefined"
                data-testid="host-update-now"
                class="d-press h-7 rounded-lg px-2.75 text-12 font-semibold hover:brightness-115"
                :class="UPDATE_PILL[updateTone]"
                @click="emit('updateAction', 'switchNow')"
              >
                {{ t('hostUpdate.switchNow') }}
              </Button>
              <Button
                v-else
                type="button"
                variant="ghost"
                size="sm"
                data-view-focus
                data-testid="host-update-check"
                class="d-press h-7 rounded-lg px-2.75 text-12 font-semibold hover:brightness-115"
                :class="UPDATE_PILL[updateTone]"
                @click="emit('updateAction', 'checkForUpdates')"
              >
                {{ t('hostUpdate.checkUpdates') }}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <p
        v-if="failure"
        role="alert"
        data-testid="host-card-failure"
        class="rounded-8 bg-(--d-danger-fill)/12 px-2.5 py-2 font-mono text-11.5 text-(--d-danger-text)"
      >
        {{ failure }}
      </p>

      <slot name="wsl" />

      <dl
        v-if="host.container"
        data-testid="host-card-container"
        class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-10 bg-(--d-panel) px-3 py-2.5 text-12"
      >
        <template
          v-for="fact in containerFacts"
          :key="fact.key"
        >
          <dt class="text-(--d-muted)">
            {{ t(`remote.container.fact.${fact.key}`) }}
          </dt>
          <dd
            dir="ltr"
            :data-fact="fact.key"
            class="min-w-0 font-mono text-11.5 break-all text-(--d-text)"
          >
            {{ fact.value }}
          </dd>
        </template>
      </dl>

      <slot name="container" />

      <ul
        v-if="notices.length > 0"
        :aria-label="t('remote.card.notices')"
        class="flex flex-col gap-2"
      >
        <li
          v-for="notice in notices"
          :key="notice.key"
          data-testid="host-notice"
          :data-code="notice.key"
          class="flex gap-2 rounded-8 px-2.5 py-2 text-12"
          :class="notice.key === 'serverInUse' ? 'bg-(--d-info-fill)/12 text-(--d-info-text)' : 'bg-(--d-warning-fill)/12 text-(--d-warning-text)'"
        >
          <Users
            v-if="notice.key === 'sharedHome'"
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <Laptop
            v-else-if="notice.key === 'serverInUse'"
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <TriangleAlert
            v-else
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <span class="flex min-w-0 flex-col gap-1.5">
            <span>{{ notice.text }}</span>
            <code
              v-if="notice.command"
              dir="ltr"
              class="self-start rounded-6 border border-(--d-border) bg-(--d-code) px-2 py-1 font-mono text-11 text-(--d-text) select-all"
            >{{ notice.command }}</code>
            <AllowBackgroundWork
              v-if="notice.key === 'noLinger' && host.connection === 'connected'"
              :host-name="host.name"
              :allow="allowBackgroundWork"
            />
          </span>
        </li>
      </ul>

      <section
        v-if="host.devices && !unattached"
        class="flex flex-col gap-1.5"
        data-testid="host-devices"
      >
        <h3 class="text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
          {{ t('remote.card.devices', { count: host.devices.length }) }}
        </h3>
        <p
          v-if="others > 0"
          data-testid="host-other-devices"
          class="text-12"
        >
          {{ t('remote.card.otherDevices', others, { named: { count: others, name: host.name } }) }}
        </p>
        <ul class="flex flex-col">
          <li
            v-for="(device, index) in host.devices"
            :key="index"
            data-testid="host-device"
            class="flex h-7 items-center gap-2 text-12"
          >
            <Laptop
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-muted)"
            />
            <span class="min-w-0 truncate">{{ visibleText(device.deviceName) }}</span>
            <span
              v-if="device.self"
              class="text-11 text-(--d-faint-text)"
            >{{ t('remote.card.thisDevice') }}</span>
          </li>
        </ul>
        <p
          v-if="devicesDiffer(host.devices)"
          data-testid="host-account-advice"
          class="flex gap-2 rounded-8 bg-(--d-info-fill)/12 px-2.5 py-2 text-12 text-(--d-info-text)"
        >
          <Users
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <span>{{ t('remote.card.accountAdvice', { name: host.name }) }}</span>
        </p>
      </section>

      <section
        v-if="!unattached"
        class="flex flex-col gap-1.5"
      >
        <h3 class="text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
          {{ t('remote.card.running', { name: host.name }) }}
        </h3>
        <p
          v-if="runs === undefined"
          class="text-12 text-(--d-faint-text)"
        >
          {{ t('remote.card.runsLoading') }}
        </p>
        <p
          v-else-if="runs === 'failed'"
          role="alert"
          class="text-12 text-(--d-danger-text)"
        >
          {{ t('remote.card.runsFailed') }}
        </p>
        <p
          v-else-if="runs.length === 0"
          class="text-12 text-(--d-faint-text)"
        >
          {{ t('remote.card.nothingRunning') }}
        </p>
        <ul
          v-else
          class="flex flex-col"
        >
          <li
            v-for="run in runs"
            :key="run.id"
            data-testid="host-run"
            :data-state="run.notResponding ? 'notResponding' : run.state"
            class="flex min-h-8 items-center gap-2 text-12"
          >
            <SquareTerminal
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-muted)"
            />
            <span class="flex min-w-0 flex-1 flex-col py-1">
              <span class="truncate">{{ visibleText(run.title) }}</span>
              <span
                v-if="terminalsClose"
                data-testid="host-run-closes"
                class="text-11/tight font-semibold text-(--d-warning-text)"
              >{{ t('hostUpdate.card.closesTag') }}</span>
            </span>
            <Transition
              name="t-swap-box"
              mode="out-in"
            >
              <span
                v-if="run.notResponding"
                key="notResponding"
                data-testid="host-run-state"
                class="flex items-center gap-1.5 text-11 font-semibold text-(--d-warning-text)"
              >
                <span
                  aria-hidden="true"
                  class="size-1.5 shrink-0 rounded-full bg-(--d-warning-fill)"
                />{{ t('remote.card.notResponding') }}
              </span>
              <span
                v-else
                :key="run.state"
                data-testid="host-run-state"
                class="text-11 text-(--d-faint-text)"
              >{{ t(`remote.card.runState.${run.state}`) }}</span>
            </Transition>
            <Button
              v-if="run.canOpen"
              type="button"
              variant="ghost"
              size="sm"
              data-testid="host-run-open"
              class="h-6 rounded-7 px-2 text-11 text-(--d-muted) hover:text-(--d-text)"
              :aria-label="t('remote.card.open', { title: visibleText(run.title) })"
              @click="emit('openRun', run.id)"
            >
              {{ t('remote.card.openShort') }}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="host-run-kill"
              class="h-6 rounded-7 px-2 text-11 text-(--d-muted) hover:text-(--d-text)"
              :aria-label="t('remote.card.kill', { title: visibleText(run.title) })"
              @click="emit('kill', run.id)"
            >
              {{ t('remote.card.killShort') }}
            </Button>
          </li>
        </ul>
        <Transition name="t-banner">
          <div
            v-if="notResponding"
            ref="terminalHostNotice"
            role="status"
            data-testid="host-terminal-host-not-responding"
            class="flex items-start gap-2 rounded-8 bg-(--d-warning-fill)/12 px-2.5 py-2 text-12 text-(--d-warning-text)"
          >
            <TriangleAlert
              aria-hidden="true"
              class="mt-0.5 size-3.5 shrink-0"
            />
            <span class="min-w-0 flex-1">{{ t('remote.card.terminalHostNotResponding', { name: host.name }) }}</span>
            <!-- aria-disabled, not disabled, while main asks, since a disabled button drops the keyboard focus -->
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="host-end-terminal-host"
              class="d-press h-6 shrink-0 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-2 text-11 text-(--d-text) hover:border-(--d-danger-fill) hover:bg-(--d-card) aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:border-(--d-border2) [&_svg]:size-3"
              :aria-busy="endingTerminalHost || undefined"
              :aria-disabled="endingTerminalHost || undefined"
              @click="endingTerminalHost || emit('endTerminalHost')"
            >
              <LoaderCircle
                v-if="endingTerminalHost"
                aria-hidden="true"
                class="d-spinning"
              />{{ t('remote.card.endTerminalHost') }}
            </Button>
          </div>
        </Transition>
      </section>

      <section
        class="flex flex-col gap-1.5"
        data-testid="host-card-safety"
      >
        <h3 class="text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
          {{ t('remote.card.safety') }}
        </h3>
        <p class="flex h-7 items-center gap-2 text-12">
          <Shield
            aria-hidden="true"
            class="size-3.5 shrink-0 text-(--d-muted)"
          />
          <span class="min-w-0 truncate">{{ safety }}</span>
        </p>
        <p
          v-if="host.kind === 'ssh'"
          class="flex h-7 items-center gap-2 text-12"
          data-testid="host-card-sign-in"
        >
          <KeyRound
            aria-hidden="true"
            class="size-3.5 shrink-0 text-(--d-muted)"
          />
          <span class="min-w-0 truncate">{{ host.passwordless ? t('remote.card.signsInWithKey') : t('remote.card.signsInWithPassword') }}</span>
        </p>
        <p
          v-if="host.agentForwarding !== undefined"
          class="flex h-7 items-center gap-2 text-12"
          data-testid="host-card-agent"
        >
          <Key
            aria-hidden="true"
            class="size-3.5 shrink-0 text-(--d-muted)"
          />
          <span class="min-w-0 truncate">{{ host.agentForwarding ? t('remote.card.forwardsAgent') : t('remote.card.doesNotForwardAgent') }}</span>
        </p>
        <slot name="actions" />
      </section>

      <section class="flex flex-col gap-1.5">
        <h3 class="text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
          {{ t('remote.installFolder.heading') }}
        </h3>
        <span
          dir="ltr"
          class="font-mono text-12"
        >{{ host.installFolder ?? t('remote.installFolder.default') }}</span>
        <InstallFolderField
          v-if="choosingFolder || needsInstallFolder(host.failure)"
          :current="host.installFolder"
          :host-name="host.name"
          :browse="host.connection === 'connected' ? browse : undefined"
          :save="setInstallFolder"
          @saved="choosingFolder = false"
        />
        <Button
          v-else
          type="button"
          variant="outline"
          size="sm"
          class="h-7 self-start rounded-7 border-(--d-border2) bg-(--d-card) px-2.5 text-11"
          @click="choosingFolder = true"
        >
          {{ t('remote.installFolder.choose') }}
        </Button>
      </section>
    </div>

    <!-- the primary action keeps the trailing edge, wrapped or not -->
    <div class="flex flex-wrap items-center gap-2 border-t border-(--d-border) px-4.5 py-3">
      <Button
        v-if="!hideBack"
        type="button"
        variant="ghost"
        size="sm"
        class="h-7.5 rounded-8 px-2.5 text-12 text-(--d-muted)"
        @click="emit('back')"
      >
        <ArrowLeft aria-hidden="true" />
        {{ t('remote.connect.back') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="host-card-settings"
        class="h-7.5 rounded-8 border-(--d-border2) bg-(--d-card) px-3 text-12"
        @click="emit('openSettings')"
      >
        <Settings2 aria-hidden="true" />
        {{ t('remote.card.hostSettings') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7.5 rounded-8 border-(--d-border2) bg-(--d-card) px-3 text-12"
        @click="emit('showLog')"
      >
        <FileText aria-hidden="true" />
        {{ t('remote.card.showLog') }}
      </Button>
      <!-- Open folder or Connect would only meet the same server again -->
      <Button
        v-if="!unattached && host.connection === 'connected'"
        type="button"
        size="sm"
        data-view-focus
        data-testid="host-card-open-folder"
        class="ms-auto h-7.5 rounded-8 px-3 text-12 font-semibold"
        :aria-label="t('remote.card.openFolder', { name: host.name })"
        @click="emit('openFolder')"
      >
        <FolderPlus aria-hidden="true" />
        {{ t('remote.card.openFolderShort') }}
      </Button>
      <Button
        v-else-if="!unattached"
        type="button"
        size="sm"
        data-view-focus
        data-testid="host-card-connect"
        class="ms-auto h-7.5 rounded-8 px-3 text-12 font-semibold"
        @click="emit('connect')"
      >
        <Plug aria-hidden="true" />
        {{ host.connection === 'failed' ? t('remote.card.reconnect') : t('remote.card.connect') }}
      </Button>
    </div>
  </section>
</template>
