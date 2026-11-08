<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import type { TerminalProfileOption, TerminalProjectOption } from '../../../preload/terminal-channels';
import { TERMINAL_HOME_ROW, terminalProfilesModel, terminalProjectsModel, type QuickPickModel } from '../quick-pick';
import { answerOf } from '../popup-answer';
import QuickPick from './QuickPick.vue';

// The new-terminal pick: the project whose folder it starts in, then a shell of that project's host. One reachable project
// skips the first step, and so does none (the home folder). Shift+Enter or Shift+click on a project starts its host's default
// shell there.
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'newTerminal' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const projects = computed(() => props.request.projects);
const [only] = props.request.projects;
const skipsProjects = props.request.projects.length === 0 || (props.request.projects.length === 1 && only?.reachable === true);
// undefined until a project is chosen; null: the home folder
const chosen = ref<string | null | undefined>(skipsProjects ? (only?.key ?? null) : undefined);
const chosenProject = computed<TerminalProjectOption | undefined>(() => projects.value.find((project) => project.key === chosen.value));
const local = computed(() => chosenProject.value === undefined || chosenProject.value.authority.kind === 'local');
const hostName = computed(() => chosenProject.value?.authority.name ?? t('projects.group.local'));

// The shells main serves for the chosen target once its host's detection settled; undefined while they load.
type Shells = { readonly listed: readonly TerminalProfileOption[] } | { readonly failed: 'none' | 'notConnected' | 'unloaded' };
const profiles = shallowRef<Shells | undefined>();
let loading: Promise<void> | undefined;

function fetchProfiles(projectKey: string | null): Promise<void> {
  loading ??= answerOf(props.api.terminalPickProfiles({ projectKey })).then(
    (answer) => {
      // undefined: main closed the pick meanwhile
      if (answer === undefined) return;
      if (answer.kind === 'notConnected') profiles.value = { failed: 'notConnected' };
      else profiles.value = answer.profiles.length > 0 ? { listed: answer.profiles } : { failed: 'none' };
    },
    (error: unknown) => {
      console.error('[terminalPick] the shells did not load', error);
      profiles.value = { failed: 'unloaded' };
    },
  );
  return loading;
}

function failureText(failed: 'none' | 'notConnected' | 'unloaded'): string {
  if (failed === 'notConnected') return t('terminal.pick.hostNotConnected', { host: hostName.value });
  if (failed === 'unloaded') return local.value ? t('terminal.pick.loadFailedLocal') : t('terminal.pick.loadFailed', { host: hostName.value });
  return local.value ? t('terminal.pick.noShellsLocal') : t('terminal.pick.noShells', { host: hostName.value });
}

const projectsModel = (query: string): Promise<QuickPickModel> => Promise.resolve(terminalProjectsModel(projects.value, query, {
  current: t('terminal.pick.current'),
  local: t('projects.group.local'),
  notConnected: t('terminal.pick.notConnected'),
  home: t('terminal.pick.home'),
  shiftHint: t('terminal.pick.shiftHint'),
}));

function shellsModel(query: string): QuickPickModel {
  const shown = profiles.value;
  if (shown === undefined) return { rows: [], empty: t('terminal.detecting') };
  if ('failed' in shown) return { rows: [], failure: failureText(shown.failed) };
  return terminalProfilesModel(shown.listed, query, { isDefault: t('terminal.pick.default') });
}

// While the shells load the step says so, and shows them as they arrive unless the query changed meanwhile.
function profilesModel(query: string): Promise<QuickPickModel> {
  const model = shellsModel(query);
  if (profiles.value !== undefined || chosen.value === undefined) return Promise.resolve(model);
  return Promise.resolve({ ...model, update: fetchProfiles(chosen.value).then(() => shellsModel(query)) });
}

function onAccept(id: string, shift: boolean): void {
  if (chosen.value !== undefined) {
    emit('answer', { kind: 'newTerminal', projectKey: chosen.value, profileId: id });
    return;
  }
  const projectKey = id === TERMINAL_HOME_ROW ? null : id;
  if (shift) emit('answer', { kind: 'newTerminal', projectKey, profileId: null });
  else chosen.value = projectKey;
}

const step = computed(() => (chosen.value === undefined ? 'project' : 'profile'));
const placeholder = computed(() => {
  if (step.value === 'project') return t('terminal.pick.projectPlaceholder');
  return local.value ? t('terminal.pick.profilePlaceholderLocal') : t('terminal.pick.profilePlaceholder', { host: hostName.value });
});
const spansHosts = new Set(props.request.projects.map((project) => project.authority.name ?? '')).size > 1;
// the shell step names the chosen project, and its host when the projects span several
const scope = computed(() => {
  if (skipsProjects || chosen.value === undefined) return undefined;
  const name = chosenProject.value?.name ?? t('terminal.pick.home');
  return { project: name, label: spansHosts ? `${name} · ${hostName.value}` : name };
});
</script>

<template>
  <QuickPick
    data-pick="terminal"
    :data-step="step"
    :label="step === 'project' ? t('terminal.pick.projectLabel') : t('terminal.pick.profileLabel')"
    :placeholder="placeholder"
    :scope="scope"
    :load="step === 'project' ? projectsModel : profilesModel"
    @accept="onAccept"
    @cancel="emit('answer', { kind: 'dismissed' })"
  />
</template>
