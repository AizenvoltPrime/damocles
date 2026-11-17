<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleX, FolderSearch, LoaderCircle, RotateCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, ShellProject } from '../../preload/shell-channels';
import type { RelocationStepName } from '../../../core/project-relocation/types';
import { confirmStopMoving } from '../stop-moving';

// A missing or unavailable project's Locate… and its move's progress, pause or refusal under its row; main renders every reason.
// The Projects listbox may own only options, so the notice serves the pointer alone: its text describes the option, a refusal or
// pause is spoken from outside the list, and the keyboard reaches Locate…, Retry and Stop moving… in the project's menu.
const props = defineProps<{
  api: DamoclesShellApi;
  project: ShellProject;
  // the notice text's id, which the row's option names as its description
  textId?: string | undefined;
}>();
const { t } = useI18n();

const STEP_LABELS: Readonly<Record<RelocationStepName, string>> = {
  checkpoints: 'projects.locate.step.checkpoints',
  sessions: 'projects.locate.step.sessions',
  worktrees: 'projects.locate.step.worktrees',
  repair: 'projects.locate.step.repair',
  memory: 'projects.locate.step.memory',
  compass: 'projects.locate.step.compass',
  hostState: 'projects.locate.step.hostState',
};

const relocation = computed(() => props.project.relocation);
const state = computed(() => relocation.value?.state ?? 'absent');
const abandonable = computed(() => relocation.value?.state === 'paused' && relocation.value.abandonable === true);
const progressText = computed(() => {
  const value = relocation.value;
  if (value?.state !== 'running' && value?.state !== 'paused') return '';
  // a remote core newer than this app may name a step it does not know
  const step = t(Object.hasOwn(STEP_LABELS, value.step) ? STEP_LABELS[value.step] : 'projects.locate.step.other');
  return value.total > 0 ? t('projects.locate.progress', value.total, { named: { step, done: value.done, total: value.total } }) : step;
});
const spoken = computed(() => (relocation.value?.state === 'refused' || relocation.value?.state === 'paused' ? relocation.value.reason.text : ''));

const pending = ref(false);

async function run(action: () => Promise<void>, what: string): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  try {
    await action();
  } catch (error) {
    console.error(`[projects] ${what} failed`, error);
  } finally {
    pending.value = false;
  }
}

const locate = (): Promise<void> => run(() => props.api.locateProject(props.project.key), 'locating the project');
const retry = (): Promise<void> => run(() => props.api.retryRelocation(props.project.key), 'retrying the move');
const stopMoving = (): Promise<void> => run(() => confirmStopMoving(props.api, props.project, t), 'stopping the move');
</script>

<template>
  <div
    data-testid="project-locate"
    :data-project-key="project.key"
    :data-state="state"
    aria-hidden="true"
    class="ms-8 me-1 flex items-start gap-2 rounded-lg bg-(--d-warning)/12 px-2 py-1.5 text-11 text-(--d-warning-text)"
    @click.stop
    @contextmenu.stop
  >
    <LoaderCircle
      v-if="state === 'running'"
      aria-hidden="true"
      class="mt-0.5 size-3 shrink-0 d-spinning"
    />
    <FolderSearch
      v-else
      aria-hidden="true"
      class="mt-0.5 size-3 shrink-0"
    />
    <div class="flex min-w-0 flex-1 flex-col items-start gap-1">
      <div
        :id="textId"
        class="flex min-w-0 flex-col items-start gap-1"
      >
        <p
          v-if="state === 'running' || state === 'paused'"
          data-testid="project-locate-progress"
          :data-step="relocation && 'step' in relocation ? relocation.step : undefined"
          :data-done="relocation && 'done' in relocation ? relocation.done : undefined"
          :data-total="relocation && 'total' in relocation ? relocation.total : undefined"
          class="leading-snug"
        >
          {{ state === 'paused' ? t('projects.locate.paused', { progress: progressText }) : progressText }}
        </p>
        <p
          v-else-if="(state === 'absent' || state === 'refused') && project.locateUnsupported"
          data-testid="project-locate-unsupported"
          class="leading-snug"
        >
          {{ t('projects.locate.unsupported', { host: project.authority.name }) }}
        </p>
        <p
          v-else-if="state === 'absent'"
          class="leading-snug"
        >
          {{ t('projects.locate.hint') }}
        </p>
        <p
          v-if="relocation?.reason"
          data-testid="project-locate-reason"
          :data-code="relocation.reason.code"
          class="leading-snug"
          :class="state === 'running' ? '' : 'text-(--d-danger-text)'"
        >
          {{ relocation.reason.text }}
        </p>
      </div>
      <!-- The notice is hidden from assistive technology inside the listbox, so a refusal or pause, of any row, is spoken from a
           region outside both, mounted empty before a reason fills it. -->
      <Teleport to="body">
        <p
          role="alert"
          data-testid="project-locate-alert"
          :data-project-key="project.key"
          class="sr-only"
        >
          {{ spoken }}
        </p>
      </Teleport>
      <!-- Links in the narrow project row, as the WSL notice's Reopen; a paused move's two share a line. -->
      <div
        v-if="state === 'paused'"
        class="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <Button
          type="button"
          size="sm"
          variant="link"
          data-testid="project-locate-retry"
          class="h-auto gap-1.5 p-0 text-11 font-semibold text-(--d-warning-text) underline-offset-2 [&_svg]:size-3"
          tabindex="-1"
          :disabled="pending"
          @click="retry"
        >
          <RotateCw aria-hidden="true" />
          {{ t('projects.locate.retry') }}
        </Button>
        <Button
          v-if="abandonable"
          type="button"
          size="sm"
          variant="link"
          data-testid="project-locate-abandon"
          class="h-auto gap-1.5 p-0 text-11 font-semibold text-(--d-warning-text) underline-offset-2 [&_svg]:size-3"
          tabindex="-1"
          :disabled="pending"
          @click="stopMoving"
        >
          <CircleX aria-hidden="true" />
          {{ t('projects.locate.abandon') }}
        </Button>
      </div>
      <Button
        v-else-if="state !== 'running' && state !== 'notLocatable'"
        type="button"
        size="sm"
        variant="link"
        data-testid="project-locate-button"
        class="h-auto gap-1.5 p-0 text-11 font-semibold text-(--d-warning-text) underline-offset-2 [&_svg]:size-3"
        tabindex="-1"
        :aria-busy="pending || undefined"
        :disabled="pending || project.locateUnsupported"
        @click="locate"
      >
        <LoaderCircle
          v-if="pending"
          aria-hidden="true"
          class="d-spinning"
        />
        {{ t('projects.locate.action') }}
      </Button>
    </div>
  </div>
</template>
