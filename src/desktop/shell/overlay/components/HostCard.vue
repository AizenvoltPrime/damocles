<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowLeft, FileText, FolderPlus, KeyRound, Laptop, Pencil, Plug, Server, Settings2, Shield, SquareTerminal, TriangleAlert, Users } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { visibleText } from '@shared/visible-text';
import type { HostCardInfo, HostRun, InstallFolderResult, LingerResult, NameCheck, RemoteBrowseResult } from '../../../preload/overlay-channels';
import HostStatusDot from '../../components/HostStatusDot.vue';
import { hostStateLabel } from '../../host-label';
import LatencySparkline from './LatencySparkline.vue';
import HostNameField from './HostNameField.vue';
import InstallFolderField from './InstallFolderField.vue';
import AllowBackgroundWork from './AllowBackgroundWork.vue';
import { devicesDiffer, failureText, hostNotices, needsInstallFolder, otherDeviceCount } from '../connect-text';

// One saved host: its state, the probe's notices, what runs on it, its safety settings, Rename in place and its install
// folder. Every action goes through the props, events and the actions slot, so any parent can show it.
const props = defineProps<{
  host: HostCardInfo;
  // undefined while loading; 'failed' when main could not list them
  runs: readonly HostRun[] | 'failed' | undefined;
  checkName: (name: string) => Promise<NameCheck | undefined>;
  rename: (name: string) => Promise<NameCheck | undefined>;
  setInstallFolder: (folder: string | null) => Promise<InstallFolderResult | undefined>;
  // the connected host's folders, for its install folder
  browse: (path?: string) => Promise<RemoteBrowseResult | undefined>;
  allowBackgroundWork: () => Promise<LingerResult | undefined>;
  // opens with the name field open (Rename from a project's menu)
  startRenaming?: boolean;
}>();
const emit = defineEmits<{ back: []; connect: []; openFolder: []; showLog: []; openSettings: []; kill: [runId: string]; openRun: [runId: string] }>();
defineSlots<{ actions?: () => unknown }>();
const { t, locale } = useI18n();

const headingId = useId();
const renaming = ref(false);
const draft = ref('');
const field = ref<InstanceType<typeof HostNameField> | null>(null);
const renameButton = ref<InstanceType<typeof Button> | null>(null);
const choosingFolder = ref(false);

// "prod-1 · 38 ms", "Slow connection to prod-1 (620 ms)", else the host's state
const statusText = computed(() => (props.host.reconnect || (props.host.connection === 'connected' && props.host.latency) ? hostStateLabel(props.host, t) : t(`projects.connection.${props.host.connection}`)));
const notices = computed(() => hostNotices(props.host, t, locale.value));
const failure = computed(() => (props.host.failure ? failureText(props.host.failure, props.host.name, t) : undefined));
const others = computed(() => otherDeviceCount(props.host.devices));
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
        :class="`d-tone-${host.color ?? 'muted'}`"
      >
        <Server class="size-4.5" />
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
          class="truncate font-mono text-11 text-(--d-faint-text)"
        >{{ host.destinationLabel }}</span>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4.5 py-3.5">
      <div class="flex items-center gap-2.5 rounded-10 bg-(--d-panel) px-2.5 py-2">
        <HostStatusDot
          :connection="host.connection"
          :reconnect="host.reconnect"
          :slow="host.latency?.slow"
          :label="statusText"
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
        v-if="failure"
        role="alert"
        class="rounded-8 bg-(--d-danger)/12 px-2.5 py-2 font-mono text-11.5 text-(--d-danger-text)"
      >
        {{ failure }}
      </p>

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
          class="flex gap-2 rounded-8 bg-(--d-warning)/12 px-2.5 py-2 text-12 text-(--d-warning-text)"
        >
          <Users
            v-if="notice.key === 'sharedHome'"
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
        v-if="host.devices"
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
          class="flex gap-2 rounded-8 bg-(--d-info)/12 px-2.5 py-2 text-12 text-(--d-info-text)"
        >
          <Users
            aria-hidden="true"
            class="mt-0.5 size-3.5 shrink-0"
          />
          <span>{{ t('remote.card.accountAdvice', { name: host.name }) }}</span>
        </p>
      </section>

      <section class="flex flex-col gap-1.5">
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
            class="flex h-8 items-center gap-2 text-12"
          >
            <SquareTerminal
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-muted)"
            />
            <span class="min-w-0 flex-1 truncate">{{ visibleText(run.title) }}</span>
            <span class="text-11 text-(--d-faint-text)">{{ t(`remote.card.runState.${run.state}`) }}</span>
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
              class="h-6 rounded-7 px-2 text-11 text-(--d-muted) hover:text-(--d-text)"
              :aria-label="t('remote.card.kill', { title: visibleText(run.title) })"
              @click="emit('kill', run.id)"
            >
              {{ t('remote.card.killShort') }}
            </Button>
          </li>
        </ul>
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
          class="flex h-7 items-center gap-2 text-12"
          data-testid="host-card-sign-in"
        >
          <KeyRound
            aria-hidden="true"
            class="size-3.5 shrink-0 text-(--d-muted)"
          />
          <span class="min-w-0 truncate">{{ host.passwordless ? t('remote.card.signsInWithKey') : t('remote.card.signsInWithPassword') }}</span>
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

    <div class="flex flex-wrap items-center gap-2 border-t border-(--d-border) px-4.5 py-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-7.5 rounded-8 px-2.5 text-12 text-(--d-muted)"
        @click="emit('back')"
      >
        <ArrowLeft aria-hidden="true" />
        {{ t('remote.connect.back') }}
      </Button>
      <span class="flex-1" />
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
      <Button
        v-if="host.connection === 'connected'"
        type="button"
        size="sm"
        data-view-focus
        data-testid="host-card-open-folder"
        class="h-7.5 rounded-8 px-3 text-12 font-semibold"
        @click="emit('openFolder')"
      >
        <FolderPlus aria-hidden="true" />
        {{ t('remote.card.openFolder', { name: host.name }) }}
      </Button>
      <Button
        v-else
        type="button"
        size="sm"
        data-view-focus
        class="h-7.5 rounded-8 px-3 text-12 font-semibold"
        @click="emit('connect')"
      >
        <Plug aria-hidden="true" />
        {{ host.connection === 'failed' ? t('remote.card.reconnect') : t('remote.card.connect') }}
      </Button>
    </div>
  </section>
</template>
