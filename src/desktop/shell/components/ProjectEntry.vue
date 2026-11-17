<script setup lang="ts">
import { computed, ref, useAttrs, useId, watch } from 'vue';
import type { DamoclesShellApi, ShellHost, ShellProject } from '../../preload/shell-channels';
import ProjectRow from './ProjectRow.vue';
import WslNotice from './WslNotice.vue';
import LocateNotice from './LocateNotice.vue';

defineOptions({ inheritAttrs: false });

// A project's place in the Projects listbox: its option row, with its WSL or Locate notice as one unit that drags, reorders and
// enters together. The notices hold buttons, which an option's presentational children may not, so they sit beside the option in
// a role="none" wrapper.
const props = defineProps<{
  api: DamoclesShellApi;
  project: ShellProject;
  selected: boolean;
  active: boolean;
  grouped: boolean;
  host?: ShellHost | undefined;
  // the project may show a notice
  wrapped: boolean;
  // the notice's distro while it shows
  noticeDistro?: string | undefined;
}>();
const emit = defineEmits<{ trust: []; hostDetails: [badge: HTMLElement] }>();
const attrs = useAttrs();

// The option keeps its id, the listbox's active descendant, and the drag mark its cursor keys on; the rest moves and lifts the unit.
// The notice's text describes the option, since the listbox cannot own the notice's buttons.
const noticeTextId = useId();
const locateTextId = useId();
const locating = computed(() => props.project.presence !== undefined || props.project.relocation !== undefined);
// the wrapper stays while the Locate notice plays its exit
const locateLeaving = ref(false);
watch(locating, (now, before) => {
  if (before && !now) locateLeaving.value = true;
});
const unit = computed(() => props.wrapped || locateLeaving.value);
const describedBy = computed(() => [...(props.noticeDistro === undefined ? [] : [noticeTextId]), ...(locating.value ? [locateTextId] : [])].join(' ') || undefined);
const optionAttrs = computed(() => ({ id: attrs.id, 'data-dragging': attrs['data-dragging'], 'aria-describedby': describedBy.value }));
const unitAttrs = computed(() => Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== 'id')));
</script>

<template>
  <ProjectRow
    v-if="!unit"
    v-bind="attrs"
    :project="project"
    :selected="selected"
    :active="active"
    :grouped="grouped"
    :host="host"
    @trust="emit('trust')"
    @host-details="emit('hostDetails', $event)"
  />
  <div
    v-else
    v-bind="unitAttrs"
    role="none"
    :data-flip="`p:${project.key}`"
    class="flex shrink-0 flex-col gap-1 rounded-lg data-dragging:relative data-dragging:z-5 data-dragging:cursor-grabbing data-dragging:bg-(--d-card) data-dragging:shadow-(--d-shadow) data-dragging:ring-1 data-dragging:ring-(--d-accent)"
  >
    <ProjectRow
      v-bind="optionAttrs"
      :project="project"
      :selected="selected"
      :active="active"
      :grouped="grouped"
      :host="host"
      :flip="false"
      @trust="emit('trust')"
      @host-details="emit('hostDetails', $event)"
    />
    <Transition
      name="t-banner"
      appear
    >
      <WslNotice
        v-if="noticeDistro !== undefined"
        :api="api"
        :project-key="project.key"
        :project-name="project.name"
        :distro="noticeDistro"
        place="row"
        :text-id="noticeTextId"
        class="mb-1"
      />
    </Transition>
    <Transition
      name="t-banner"
      appear
      @after-leave="locateLeaving = false"
    >
      <LocateNotice
        v-if="locating"
        :api="api"
        :project="project"
        :text-id="locateTextId"
        class="mb-1"
      />
    </Transition>
  </div>
</template>
