<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderTree, ShieldAlert } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import HostBadge from '@/components/HostBadge.vue';
import { visibleText } from '@shared/visible-text';
import type { ShellHost, ShellProject } from '../../preload/shell-channels';
import { hostStateLabel } from '../host-label';
import ProjectAvatar from './ProjectAvatar.vue';
import HostStatusDot from './HostStatusDot.vue';

// One project option of the Projects listbox. In the grouped view its group header names the host, so a remote row shows its
// folder in place of the branch and no host badge.
const props = defineProps<{
  project: ShellProject;
  selected: boolean;
  // the listbox's active descendant
  active: boolean;
  grouped: boolean;
  // the saved host of a remote project, whose reconnect phase and latency its dot shows
  host?: ShellHost | undefined;
}>();
const emit = defineEmits<{ trust: [] }>();
const { t } = useI18n();

const remote = computed(() => props.project.authority.kind !== 'local');
const detail = computed(() => (props.grouped && remote.value ? props.project.fsPath : props.project.branch));

const badge = computed(() => {
  if (props.project.waiting > 0) return { text: t('projects.waiting', { count: props.project.waiting }), title: t('projects.waitingTitle'), waiting: true };
  if (props.project.running > 0) return { text: t('projects.running', { count: props.project.running }), title: t('projects.runningTitle'), waiting: false };
  return undefined;
});

// The host and its state as one phrase ("Local daemon, Connecting", "prod-1 · 38 ms"), for the dot's name and the badge's tooltip.
const hostState = computed(() => hostStateLabel({ name: props.project.authority.name, connection: props.project.connection, reconnect: props.host?.reconnect, latency: props.host?.latency }, t));
</script>

<template>
  <div
    role="option"
    :aria-selected="selected"
    :data-project-key="project.key"
    :data-flip="`p:${project.key}`"
    :title="remote ? t('projects.remoteTitle', { host: project.authority.name, path: project.fsPath }) : project.fsPath"
    class="group/row @container/row flex h-8.5 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 transition-colors select-none hover:bg-(--d-hover) data-dragging:relative data-dragging:z-5 data-dragging:cursor-grabbing data-dragging:bg-(--d-card) data-dragging:shadow-(--d-shadow) data-dragging:ring-1 data-dragging:ring-(--d-accent)"
    :class="[
      selected ? 'bg-(--d-accent-soft) font-semibold' : '',
      active ? 'group-focus-visible/list:outline group-focus-visible/list:-outline-offset-1 group-focus-visible/list:outline-(--d-accent)' : '',
    ]"
  >
    <ProjectAvatar
      :name="project.name"
      class="size-5.5 rounded-md text-11"
      :class="selected ? 'project-avatar-ring' : ''"
    />
    <span class="flex min-w-0 flex-1 flex-col leading-tight">
      <span class="flex min-w-0 items-center gap-1.25">
        <span class="truncate">{{ project.name }}</span>
        <!-- An adopted worktree opened as its own project (AD12) reads apart from its main project. -->
        <FolderTree
          v-if="project.worktreeOf"
          role="img"
          data-testid="project-worktree"
          class="size-2.75 shrink-0 text-(--d-accent-text)"
          :aria-label="t('projects.worktreeOf', { project: project.worktreeOf })"
          :title="t('projects.worktreeOf', { project: project.worktreeOf })"
        />
      </span>
      <span
        v-if="detail"
        :data-testid="grouped && remote ? 'project-path' : 'project-branch'"
        dir="ltr"
        class="truncate font-mono text-10.5 font-normal"
        :class="selected ? 'text-(--d-faint-text)' : 'text-(--d-faint) group-hover/row:text-(--d-faint-text)'"
      >{{ visibleText(detail) }}</span>
    </span>
    <Badge
      v-if="!project.trusted"
      variant="tone"
      data-testid="untrusted-badge"
      class="d-tone-warning flex shrink-0 rounded-5 border-0 bg-(--tone)/15 px-1.5 py-px text-10.5 font-normal"
      :title="t('projects.untrustedTitle')"
      @click.stop="emit('trust')"
    >
      <ShieldAlert
        aria-hidden="true"
        class="size-2.75"
      />
      <!-- Beside a host badge in a narrow row the badge keeps only its shield, so the project's name keeps room. -->
      <span :class="remote && !grouped ? '@max-[14.5rem]/row:sr-only' : ''">{{ t('projects.untrusted') }}</span>
    </Badge>
    <Badge
      v-if="badge"
      variant="tone"
      data-testid="activity-badge"
      :class="['flex shrink-0 border-0 bg-(--tone)/15 px-1.5 py-px font-mono text-10.5 font-normal', badge.waiting ? 'd-tone-warning' : 'd-tone-accent']"
      :title="badge.title"
    >
      <span
        aria-hidden="true"
        class="size-1.25 animate-[d-pulse_1.4s_infinite] rounded-full bg-current"
      />
      {{ badge.text }}
    </Badge>
    <HostBadge
      v-if="remote && !grouped"
      data-testid="host-badge"
      :name="project.authority.name"
      :tone="project.authority.color"
      :title="hostState"
    >
      <template #leading>
        <HostStatusDot
          :connection="project.connection"
          :reconnect="host?.reconnect"
          :slow="host?.latency?.slow"
          :label="hostState"
        />
      </template>
    </HostBadge>
  </div>
</template>
