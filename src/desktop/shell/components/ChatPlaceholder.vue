<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleX, FolderMinus, FolderSearch, FolderX, LoaderCircle, MessageSquarePlus, RotateCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { providePageHeading } from '@/composables/usePageHeading';
import { visibleText } from '@shared/visible-text';
import type { DamoclesShellApi, ShellHost, ShellProject } from '../../preload/shell-channels';
import ConnectionBanner from './ConnectionBanner.vue';
import { confirmStopMoving } from '../stop-moving';

// The chat slot while no chat view covers it: a chat page's header row (the gutter's grip cell continues it), then the host's banner.
// A project whose folder is not there says so in place of the empty state, with Locate… (Retry and Stop moving… while its move is
// paused) and Remove project; its Projects row shows the move's progress and speaks its refusals and pauses.
const props = defineProps<{ api: DamoclesShellApi; project: ShellProject | undefined; host: ShellHost | undefined }>();
// removed: Remove project answered, taking its focused button with the project if main removed it
const emit = defineEmits<{ removed: [key: string] }>();
const { t } = useI18n();
const title = ref<HTMLElement | null>(null);
providePageHeading(() => title.value);

const hostName = computed(() => (props.project && props.project.authority.kind !== 'local' ? props.project.authority.name : undefined));

function checkForUpdates(): void {
  props.api.runUpdateAction('check').catch((error: unknown) => console.error('[update] checking for updates failed', error));
}

const removeRefusal = ref<string>();
watch(() => props.project?.key, () => { removeRefusal.value = undefined; });

const pending = ref(false);
const relocation = computed(() => props.project?.relocation);
const running = computed(() => relocation.value?.state === 'running');
const paused = computed(() => relocation.value?.state === 'paused');
const abandonable = computed(() => relocation.value?.state === 'paused' && relocation.value.abandonable === true);
const busy = computed(() => pending.value || running.value);
const reasonIsError = computed(() => relocation.value?.state === 'refused' || relocation.value?.state === 'paused');

async function run(action: () => Promise<void>, what: string): Promise<void> {
  if (pending.value) return;
  removeRefusal.value = undefined;
  pending.value = true;
  try {
    await action();
  } catch (error) {
    console.error(`[projects] ${what} failed`, error);
  } finally {
    pending.value = false;
  }
}

function locateOrRetry(project: ShellProject): Promise<void> | undefined {
  if (paused.value) return run(() => props.api.retryRelocation(project.key), 'retrying the move');
  if (running.value || project.locateUnsupported) return undefined;
  return run(() => props.api.locateProject(project.key), 'locating the project');
}

const stopMoving = (project: ShellProject): Promise<void> => run(() => confirmStopMoving(props.api, project, t), 'stopping the move');

async function remove(project: ShellProject): Promise<void> {
  removeRefusal.value = undefined;
  const result = await props.api.removeProject(project.key);
  if (!result.ok) removeRefusal.value = t('projects.removeRefused', { name: project.name, reason: result.reason });
  else if (result.removed) emit('removed', project.key);
}
</script>

<template>
  <div
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    data-testid="chat-placeholder"
  >
    <header
      v-if="project"
      class="flex h-11.5 shrink-0 items-center border-b border-(--d-border) bg-(--d-panel) ps-4 pe-2.5 text-(--d-text)"
      data-testid="chat-placeholder-header"
    >
      <div class="flex min-w-0 items-baseline gap-1.5">
        <h1
          ref="title"
          tabindex="-1"
          class="truncate text-13.5/5 font-semibold tracking-[-.005em]"
          data-testid="chat-placeholder-title"
        >
          {{ project.name }}
        </h1>
        <span
          v-if="hostName !== undefined"
          class="shrink-0 text-12 text-(--d-faint)"
        >{{ t('content.onHost', { host: hostName }) }}</span>
      </div>
    </header>
    <ConnectionBanner
      :key="host?.hostId ?? 'none'"
      :host="host"
      @reconnect="api.reconnectHost($event)"
      @sign-in="api.signInHost($event)"
      @show-log="api.showHostLog($event)"
      @edit-host="api.renameHostOnCard($event)"
      @switch-when-idle="api.switchHostWhenIdle($event)"
      @switch-now="api.switchHostNow($event)"
      @check-for-updates="checkForUpdates"
    />
    <div
      v-if="project?.presence"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="absent-project"
    >
      <FolderX
        aria-hidden="true"
        class="size-8 text-(--d-faint)"
      />
      <p class="text-sm font-medium">
        {{ t('content.absent.title', { name: project.name }) }}
      </p>
      <p class="max-w-md text-xs text-(--d-muted)">
        {{ t(`content.absent.${project.presence}`) }}
      </p>
      <p
        dir="ltr"
        data-testid="absent-project-path"
        class="max-w-full truncate font-mono text-xs text-(--d-faint-text)"
        :title="project.fsPath"
      >
        {{ visibleText(project.fsPath) }}
      </p>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <!-- One button locates, or retries a paused move, so focus stays on it as the move pauses and runs on; aria-disabled, not
             disabled, while busy, since a disabled button drops the keyboard focus. -->
        <Button
          v-if="relocation?.state !== 'notLocatable'"
          type="button"
          :data-testid="paused ? 'absent-project-retry' : 'absent-project-locate'"
          class="h-auto gap-1.5 rounded-lg px-3 py-1.5 text-xs aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-primary [&_svg]:size-3.5"
          :aria-busy="busy || undefined"
          :aria-disabled="busy || undefined"
          :disabled="!paused && project.locateUnsupported"
          @click="locateOrRetry(project)"
        >
          <LoaderCircle
            v-if="busy"
            aria-hidden="true"
            class="size-3.5 d-spinning"
          />
          <RotateCw
            v-else-if="paused"
            aria-hidden="true"
            class="size-3.5"
          />
          <FolderSearch
            v-else
            aria-hidden="true"
            class="size-3.5"
          />
          {{ paused ? t('projects.locate.retry') : t('projects.locate.action') }}
        </Button>
        <Button
          v-if="abandonable"
          type="button"
          variant="outline"
          data-testid="absent-project-abandon"
          class="h-auto gap-1.5 rounded-lg px-3 py-1.5 text-xs aria-disabled:cursor-default aria-disabled:opacity-50 [&_svg]:size-3.5"
          :aria-disabled="pending || undefined"
          @click="stopMoving(project)"
        >
          <CircleX
            aria-hidden="true"
            class="size-3.5"
          />
          {{ t('projects.locate.abandon') }}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="absent-project-remove"
          class="h-auto gap-1.5 rounded-lg px-3 py-1.5 text-xs [&_svg]:size-3.5"
          @click="remove(project)"
        >
          <FolderMinus
            aria-hidden="true"
            class="size-3.5"
          />
          {{ t('projects.remove') }}
        </Button>
      </div>
      <p
        v-if="project.locateUnsupported"
        data-testid="absent-project-locate-unsupported"
        class="max-w-md text-xs text-(--d-muted)"
      >
        {{ t('projects.locate.unsupported', { host: project.authority.name }) }}
      </p>
      <!-- The project's row speaks a refusal or pause, so this one is not announced again. -->
      <p
        v-if="relocation?.reason"
        data-testid="absent-project-locate-reason"
        :data-code="relocation.reason.code"
        class="max-w-md text-xs"
        :class="reasonIsError ? 'text-(--d-danger-text)' : 'text-(--d-muted)'"
      >
        {{ relocation.reason.text }}
      </p>
      <p
        v-if="removeRefusal"
        role="alert"
        class="text-xs text-(--d-danger-text)"
      >
        {{ removeRefusal }}
      </p>
    </div>
    <div
      v-else
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p class="text-sm font-medium">
        {{ t('content.empty') }}
      </p>
      <Button
        type="button"
        class="h-auto gap-1.5 rounded-lg px-3 py-1.5 text-xs hover:bg-primary [&_svg]:size-3.5"
        @click="api.newChat()"
      >
        <MessageSquarePlus
          aria-hidden="true"
          class="size-3.5"
        />
        {{ t('content.newChat') }}
      </Button>
    </div>
  </div>
</template>
