<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { FolderPlus, ShieldAlert } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, ShellProject } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import SidebarSection from './SidebarSection.vue';
import ProjectAvatar from './ProjectAvatar.vue';

const props = defineProps<{
  api: DamoclesShellApi;
  projects: readonly ShellProject[];
  selectedKey: string | undefined;
  collapsed: boolean;
  // CSS px of the body; absent, the section takes the sidebar's remaining height
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();

const listId = useId();
const helpId = useId();
const optionId = (index: number): string => `${listId}-option-${index}`;
const listbox = ref<HTMLElement | null>(null);
const section = ref<InstanceType<typeof SidebarSection> | null>(null);

// Keyboard position; the selection itself is main's (selectedKey).
const activeKey = ref<string | undefined>();
const activeIndex = computed(() => {
  const index = props.projects.findIndex((project) => project.key === activeKey.value);
  return index >= 0 ? index : Math.max(0, props.projects.findIndex((project) => project.key === props.selectedKey));
});
const activeProject = computed(() => props.projects[activeIndex.value]);

// Only the latest refusal shows; any later action on the list clears it.
const refusal = ref<string | undefined>();
watch(() => props.projects, () => {
  if (activeKey.value !== undefined && !props.projects.some((project) => project.key === activeKey.value)) activeKey.value = undefined;
});

function select(project: ShellProject): void {
  refusal.value = undefined;
  activeKey.value = project.key;
  void props.api.selectProject(project.key);
}

function trust(project: ShellProject): void {
  refusal.value = undefined;
  void props.api.grantTrust(project.key);
}

async function remove(project: ShellProject): Promise<void> {
  refusal.value = undefined;
  const result = await props.api.removeProject(project.key);
  if (!result.ok) refusal.value = t('projects.removeRefused', { name: project.name, reason: result.reason });
}

async function openMenu(project: ShellProject, anchor: { x: number; y: number; width: number; height: number }): Promise<void> {
  activeKey.value = project.key;
  const items: OverlayMenuItem[] = [
    ...(project.trusted ? [] : [{ kind: 'item', id: 'trust', label: t('projects.trust'), icon: 'shield-check' } as const, { kind: 'separator' } as const]),
    { kind: 'item', id: 'remove', label: t('projects.remove'), icon: 'folder-minus', danger: true },
  ];
  const answer = await props.api.requestOverlay({ kind: 'menu', label: t('projects.menuLabel', { name: project.name }), anchor, items });
  if (answer.kind !== 'menu') return;
  if (answer.itemId === 'trust') trust(project);
  else if (answer.itemId === 'remove') await remove(project);
}

function onContextMenu(project: ShellProject, event: MouseEvent): void {
  event.preventDefault();
  void openMenu(project, { x: event.clientX, y: event.clientY, width: 0, height: 0 });
}

function rowRect(index: number): { x: number; y: number; width: number; height: number } {
  const rect = document.getElementById(optionId(index))?.getBoundingClientRect();
  return rect ? { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 };
}

function move(index: number): void {
  const project = props.projects[Math.min(Math.max(index, 0), props.projects.length - 1)];
  if (!project) return;
  activeKey.value = project.key;
  void nextTick(() => document.getElementById(optionId(activeIndex.value))?.scrollIntoView({ block: 'nearest' }));
}

function onKeydown(event: KeyboardEvent): void {
  const project = activeProject.value;
  if (!project) return;
  const index = activeIndex.value;
  if (event.key === 'ArrowDown') move(index + 1);
  else if (event.key === 'ArrowUp') move(index - 1);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(props.projects.length - 1);
  else if (event.key === 'Enter' || event.key === ' ') select(project);
  else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) void openMenu(project, rowRect(index));
  else return;
  event.preventDefault();
}

function badge(project: ShellProject): { text: string; title: string; waiting: boolean } | undefined {
  if (project.waiting > 0) return { text: t('projects.waiting', { count: project.waiting }), title: t('projects.waitingTitle'), waiting: true };
  if (project.running > 0) return { text: t('projects.running', { count: project.running }), title: t('projects.runningTitle'), waiting: false };
  return undefined;
}

defineExpose({
  focus: (): boolean => {
    if (!listbox.value || props.collapsed) return false;
    activeKey.value = props.selectedKey;
    listbox.value.focus();
    return true;
  },
  bodyHeight: (): number => section.value?.bodyHeight() ?? 0,
});
</script>

<template>
  <SidebarSection
    ref="section"
    data-testid="sidebar-projects"
    :title="t('projects.heading')"
    :count="projects.length"
    :collapsed="collapsed"
    :body-size="bodySize"
    @toggle="emit('toggle')"
  >
    <template #actions>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="add-project"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
        :aria-label="t('projects.add')"
        :title="t('projects.add')"
        @click="refusal = undefined; api.addProject()"
      >
        <FolderPlus
          aria-hidden="true"
          class="size-3.25"
        />
      </Button>
    </template>
    <p
      v-if="projects.length === 0"
      class="px-3 py-2 text-xs text-(--d-faint)"
    >
      {{ t('projects.empty') }}
    </p>
    <!-- A listbox with aria-activedescendant and type-ahead, which no shadcn part provides outside a popup. -->
    <div
      v-else
      :id="listId"
      ref="listbox"
      role="listbox"
      tabindex="0"
      :aria-label="t('projects.listLabel')"
      :aria-describedby="helpId"
      :aria-activedescendant="optionId(activeIndex)"
      class="group/list flex min-h-0 flex-1 flex-col gap-px overflow-x-hidden overflow-y-auto px-1.5 pt-0.5 pb-1.5 focus-visible:outline-none"
      @keydown="onKeydown"
    >
      <div
        v-for="(project, index) in projects"
        :id="optionId(index)"
        :key="project.key"
        role="option"
        :aria-selected="project.key === selectedKey"
        :data-project-key="project.key"
        :title="project.fsPath"
        class="group/row flex h-8.5 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-(--d-hover)"
        :class="[
          project.key === selectedKey ? 'bg-(--d-accent-soft) font-semibold' : '',
          index === activeIndex ? 'group-focus-visible/list:outline group-focus-visible/list:-outline-offset-1 group-focus-visible/list:outline-(--d-accent)' : '',
        ]"
        @click="select(project)"
        @contextmenu="onContextMenu(project, $event)"
      >
        <ProjectAvatar
          :name="project.name"
          class="size-5.5 rounded-md text-11"
          :class="project.key === selectedKey ? 'project-avatar-ring' : ''"
        />
        <span class="flex min-w-0 flex-1 flex-col leading-tight">
          <span class="truncate">{{ project.name }}</span>
          <span
            v-if="project.branch"
            data-testid="project-branch"
            dir="ltr"
            class="truncate font-mono text-10.5 font-normal"
            :class="project.key === selectedKey ? 'text-(--d-faint-text)' : 'text-(--d-faint) group-hover/row:text-(--d-faint-text)'"
          >{{ project.branch }}</span>
        </span>
        <Badge
          v-if="!project.trusted"
          variant="tone"
          data-testid="untrusted-badge"
          class="d-tone-warning flex shrink-0 rounded-5 border-0 bg-(--tone)/15 px-1.5 py-px text-10.5 font-normal"
          :title="t('projects.untrustedTitle')"
          @click.stop="trust(project)"
        >
          <ShieldAlert
            aria-hidden="true"
            class="size-2.75"
          />
          {{ t('projects.untrusted') }}
        </Badge>
        <Badge
          v-if="badge(project)"
          variant="tone"
          data-testid="activity-badge"
          :class="['flex shrink-0 border-0 bg-(--tone)/15 px-1.5 py-px font-mono text-10.5 font-normal', badge(project)?.waiting ? 'd-tone-warning' : 'd-tone-accent']"
          :title="badge(project)?.title"
        >
          <span
            aria-hidden="true"
            class="size-1.25 animate-[d-pulse_1.4s_infinite] rounded-full bg-current"
          />
          {{ badge(project)?.text }}
        </Badge>
      </div>
    </div>
    <p
      :id="helpId"
      class="sr-only"
    >
      {{ t('projects.keyboardHelp') }}
    </p>
    <p
      v-if="refusal"
      role="alert"
      class="px-3 pb-2 text-xs text-(--d-danger)"
    >
      {{ refusal }}
    </p>
  </SidebarSection>
</template>
