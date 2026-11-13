<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { CONNECT_STEPS, type ConnectStep, type ConnectStepEvent, type InstallFolderResult } from '../../../preload/overlay-channels';
import InstallFolderField from './InstallFolderField.vue';
import SecretPrompt from './SecretPrompt.vue';
import TimelineStepRow from './TimelineStepRow.vue';
import BuildLogTail from './BuildLogTail.vue';
import { failureText, needsInstallFolder } from '../connect-text';

type RowState = 'pending' | 'active' | 'done' | 'failed';

// An attempt's steps as main reports them, with the secret ssh asks for in its row and the failure under the step it hit.
const props = defineProps<{
  event: ConnectStepEvent;
  hostName: string;
  // the devices attached to the host besides this one, once connected
  otherDevices: number;
  setInstallFolder: (folder: string | null) => Promise<InstallFolderResult | undefined>;
}>();
// remember: the user asked to keep the answer on this computer, offered only when main allows it
const emit = defineEmits<{ answer: [promptId: string, answer: string | null, remember: boolean]; retry: []; showLog: []; editHost: [] }>();
const { t } = useI18n();

const current = computed<ConnectStep | undefined>(() => {
  const step = props.event.step;
  return step === 'connected' || step === 'failed' ? props.event.visited.at(-1) : step;
});

// wsl.exe and docker exec need no sign-in, so only ssh authenticates; only a container builds.
const steps = computed((): readonly ConnectStep[] => CONNECT_STEPS.filter((name) => (name !== 'authenticating' || props.event.transport === 'ssh') && (name !== 'building' || props.event.transport === 'container')));
// A WSL attempt starts its distro and a container attempt attaches where an ssh one connects.
const stepLabel = (step: ConnectStep): string => {
  if (step !== 'connecting' || props.event.transport === 'ssh') return t(`remote.step.${step}`);
  return props.event.transport === 'wsl' ? t('remote.step.wslConnecting', { name: props.hostName }) : t('remote.step.attaching');
};

// Every visited step, then the steps still to come; installing is gone once the attempt went past it without installing.
const rows = computed(() => {
  const { visited, step } = props.event;
  const at = current.value === undefined ? -1 : steps.value.indexOf(current.value);
  return steps.value.flatMap((name, index): Array<{ name: ConnectStep; state: RowState }> => {
    if (visited.includes(name)) {
      const last = name === current.value;
      const state: RowState = !last || step === 'connected' ? 'done' : step === 'failed' ? 'failed' : 'active';
      return [{ name, state }];
    }
    if (index < at || step === 'connected' || step === 'failed') return [];
    return [{ name, state: 'pending' }];
  });
});

const progress = computed(() => props.event.progress);
const percent = computed(() => (progress.value === undefined ? undefined : Math.round(progress.value * 100)));
const doneCount = computed(() => rows.value.filter((row) => row.state === 'done').length);
const valueText = computed(() => {
  if (props.event.step === 'connected') return t('remote.timeline.connected');
  const step = current.value;
  const label = stepLabel(step ?? 'connecting');
  if (step === undefined) return label;
  if (props.event.step === 'failed') return t('remote.timeline.failedAt', { step: label });
  return step === 'installing' && percent.value !== undefined ? t('remote.timeline.progress', { step: label, percent: percent.value }) : label;
});

// A failed step's failure, or a connected dev container whose folder main could not open, shown under the last step.
const shownFailure = computed(() => (props.event.step === 'failed' ? props.event.failure : props.event.step === 'connected' ? props.event.folderFailure : undefined));
const failureRow = computed(() => (props.event.step === 'failed' ? current.value : rows.value.at(-1)?.name));
const failure = computed(() => (shownFailure.value ? failureText(shownFailure.value, props.hostName, t) : undefined));
const canRetry = computed(() => shownFailure.value?.code !== 'hostKeyChanged');
const choosingFolder = ref(false);

const prompt = computed(() => (props.event.prompt?.kind === 'secret' ? props.event.prompt : undefined));
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- A drawn bar: the steps carry the value through the progressbar role, which allows no interactive children. -->
    <div
      role="progressbar"
      data-testid="connect-progress"
      :aria-label="t('remote.timeline.label', { name: hostName })"
      aria-valuemin="0"
      :aria-valuemax="rows.length"
      :aria-valuenow="event.step === 'connected' ? rows.length : doneCount"
      :aria-valuetext="valueText"
      class="h-1 overflow-hidden rounded-full bg-(--d-border)"
    >
      <span
        class="timeline-bar block h-full rounded-full"
        :class="event.step === 'failed' ? 'bg-(--d-danger)' : 'bg-(--d-accent)'"
        :style="{ transform: `scaleX(${rows.length === 0 ? 0 : (event.step === 'connected' ? rows.length : doneCount) / rows.length})` }"
      />
    </div>
    <ol
      :aria-label="t('remote.timeline.steps')"
      class="flex flex-col"
    >
      <TimelineStepRow
        v-for="(row, index) in rows"
        :key="row.name"
        :step="row.name"
        :state="row.state"
        :index="index"
        :last="index === rows.length - 1"
      >
        <template #label>
          {{ stepLabel(row.name) }}
        </template>
        <template v-if="row.state === 'active' && row.name === 'installing' && percent !== undefined">
          <span class="text-11.5 text-(--d-muted) tabular-nums">{{ t('remote.timeline.percent', { percent }) }}</span>
          <!-- Drawn, not a second progressbar: the timeline's progressbar carries this value in its text. -->
          <span
            aria-hidden="true"
            class="mt-1.5 h-1 max-w-80 overflow-hidden rounded-full bg-(--d-border)"
          >
            <span
              data-testid="install-progress"
              class="timeline-bar block h-full rounded-full bg-(--d-accent)"
              :style="{ transform: `scaleX(${progress})` }"
            />
          </span>
        </template>
        <!-- The build's output while it runs, and under its failure; a finished build leaves only its check mark. -->
        <BuildLogTail
          v-if="row.name === 'building' && row.state !== 'done' && event.buildLog"
          class="timeline-grow"
          :lines="event.buildLog.lines"
          :total="event.buildLog.total"
          :host-name="hostName"
        />
        <SecretPrompt
          v-if="row.state === 'active' && prompt"
          :key="prompt.promptId"
          class="timeline-grow mt-2"
          :prompt="prompt"
          @answer="(answer, remember) => emit('answer', prompt!.promptId, answer, remember)"
        />
        <template v-if="row.name === failureRow && failure">
          <p
            role="alert"
            data-testid="connect-failure"
            :data-code="shownFailure?.code"
            class="timeline-grow mt-1.5 rounded-8 bg-(--d-danger)/12 px-2.5 py-2 font-mono text-11.5 text-(--d-danger-text)"
          >
            {{ failure }}
          </p>
          <InstallFolderField
            v-if="choosingFolder"
            class="mt-2"
            :save="setInstallFolder"
            @saved="choosingFolder = false; emit('retry')"
          />
          <span
            data-failure-actions
            class="mt-2.5 flex flex-wrap items-center gap-1.5"
          >
            <Button
              v-if="needsInstallFolder(shownFailure) && !choosingFolder"
              type="button"
              size="sm"
              class="h-6 rounded-7 px-2 text-11 font-semibold"
              @click="choosingFolder = true"
            >
              {{ t('remote.installFolder.choose') }}
            </Button>
            <Button
              v-if="canRetry"
              type="button"
              :variant="needsInstallFolder(shownFailure) ? 'outline' : 'default'"
              size="sm"
              class="h-6 rounded-7 px-2 text-11 font-semibold"
              @click="emit('retry')"
            >
              {{ t('remote.timeline.retry') }}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="h-6 rounded-7 border-(--d-border2) bg-(--d-card) px-2 text-11"
              @click="emit('showLog')"
            >
              {{ t('remote.card.showLog') }}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-6 rounded-7 px-2 text-11 text-(--d-muted)"
              @click="emit('editHost')"
            >
              {{ t('remote.timeline.editHost') }}
            </Button>
          </span>
        </template>
      </TimelineStepRow>
    </ol>
    <p
      v-if="event.step === 'connected' && otherDevices > 0"
      data-testid="timeline-other-devices"
      class="text-12 text-(--d-muted)"
    >
      {{ t('remote.card.otherDevices', otherDevices, { named: { count: otherDevices, name: hostName } }) }}
    </p>
  </div>
</template>
