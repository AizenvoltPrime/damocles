<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { terminalProfilesModel, terminalProjectsModel, type QuickPickModel } from '../quick-pick';
import QuickPick from './QuickPick.vue';

// The new-terminal quick pick: a shell profile, then the project whose folder it starts in. Shift+Enter or Shift+click on a
// profile starts it in the current project; one open project skips the second step, and so does none (the home folder).
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'newTerminal' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const profileId = ref<string | null>(null);
const current = computed(() => props.request.projects.find((project) => project.current));
const labels = computed(() => ({
  isDefault: t('terminal.pick.default'),
  current: t('terminal.pick.current'),
  ...(current.value && props.request.projects.length > 1 ? { shiftHint: t('terminal.pick.shiftHint', { project: current.value.name }) } : {}),
}));

const loadProfiles = (query: string): Promise<QuickPickModel> => Promise.resolve(terminalProfilesModel(props.request.profiles, query, labels.value));
const loadProjects = (query: string): Promise<QuickPickModel> => Promise.resolve(terminalProjectsModel(props.request.projects, query, labels.value));

function onAccept(id: string, shift: boolean): void {
  if (profileId.value !== null) {
    emit('answer', { kind: 'newTerminal', profileId: profileId.value, projectKey: id });
    return;
  }
  const { projects } = props.request;
  if (projects.length <= 1) emit('answer', { kind: 'newTerminal', profileId: id, projectKey: projects[0]?.key ?? null });
  else if (shift && current.value) emit('answer', { kind: 'newTerminal', profileId: id, projectKey: current.value.key });
  else profileId.value = id;
}
</script>

<template>
  <QuickPick
    data-pick="terminal"
    :data-step="profileId === null ? 'profile' : 'project'"
    :label="profileId === null ? t('terminal.pick.profileLabel') : t('terminal.pick.projectLabel')"
    :placeholder="profileId === null ? t('terminal.pick.profilePlaceholder') : t('terminal.pick.projectPlaceholder')"
    :load="profileId === null ? loadProfiles : loadProjects"
    @accept="onAccept"
    @cancel="emit('answer', { kind: 'dismissed' })"
  />
</template>
