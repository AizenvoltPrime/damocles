<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, Laptop, Server } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import type { NameCheck } from '../../preload/overlay-channels';
import type { ProjectConnection, ShellHost } from '../../preload/shell-channels';
import { hostStateLabel } from '../host-label';
import HostNameField from '../overlay/components/HostNameField.vue';
import HostStatusDot from './HostStatusDot.vue';

// One authority's projects in the grouped Projects view: a role="group" of the one listbox, labelled by its name. Its header
// is an option row the listbox moves through, never focusable itself, whose disclosure and menu the listbox drives.
const props = defineProps<{
  groupKey: string;
  name: string;
  // absent for this computer, which is always connected
  connection?: ProjectConnection | undefined;
  // the saved host of a remote group, whose reconnect phase and latency its dot shows
  host?: ShellHost | undefined;
  collapsed: boolean;
  headerId: string;
  // the listbox's active descendant
  active: boolean;
  // chats running or waiting in the group's projects; waiting when any of them waits
  busy: { readonly count: number; readonly waiting: boolean };
  renaming: boolean;
}>();
const emit = defineEmits<{ toggle: []; renameSubmit: [name: string]; renameBlur: [name: string]; renameCancel: [] }>();
const { t } = useI18n();

const nameId = useId();
const draft = ref('');
const field = ref<InstanceType<typeof HostNameField> | null>(null);

const stateText = computed(() => (props.connection ? t(`projects.connection.${props.connection}`) : undefined));
const dotLabel = computed(() => (props.connection ? hostStateLabel({ name: props.name, connection: props.connection, reconnect: props.host?.reconnect, latency: props.host?.latency }, t) : ''));
// The header is an option, whose children are presentational, so its name carries the host's state and the disclosure.
const headerLabel = computed(() => [
  props.name,
  stateText.value,
  props.collapsed ? t('projects.group.collapsed') : t('projects.group.expanded'),
  props.collapsed && props.busy.count > 0 ? t('projects.group.busy', props.busy.count) : undefined,
].filter((part) => part !== undefined).join(', '));

watch(() => props.renaming, async (renaming) => {
  if (!renaming) return;
  draft.value = props.name;
  await nextTick();
  field.value?.focus();
  field.value?.select();
}, { immediate: true });

defineExpose({
  refuse: (check: Extract<NameCheck, { ok: false }>): Promise<void> | undefined => field.value?.refuse(check),
  saveFailed: (): void => field.value?.saveFailed(),
});
</script>

<template>
  <div
    role="group"
    :aria-labelledby="nameId"
    data-testid="project-group"
    :data-group="groupKey"
    :data-collapsed="collapsed || undefined"
    class="flex shrink-0 flex-col gap-px rounded-lg transition-[background-color,box-shadow] duration-150 data-dragging:relative data-dragging:z-5 data-dragging:bg-(--d-card) data-dragging:shadow-(--d-shadow) data-dragging:ring-1 data-dragging:ring-(--d-accent) data-refuse:bg-(--d-danger)/7 data-refuse:ring-1 data-refuse:ring-(--d-danger) data-refuse:ring-inset"
  >
    <div
      :id="headerId"
      :role="renaming ? undefined : 'option'"
      :aria-label="renaming ? undefined : headerLabel"
      data-testid="project-group-header"
      :data-group="groupKey"
      :data-flip="`g:${groupKey}`"
      class="mt-1 flex min-h-7 animate-[d-fade_.2s_var(--ease-out)] cursor-pointer items-center gap-1.5 rounded-7 pr-1 pl-1.5 text-11 font-semibold text-(--d-muted) select-none hover:bg-(--d-hover) hover:text-(--d-text)"
      :class="active ? 'group-focus-visible/list:outline group-focus-visible/list:-outline-offset-1 group-focus-visible/list:outline-(--d-accent)' : ''"
      @click="renaming || emit('toggle')"
    >
      <ChevronDown
        aria-hidden="true"
        data-testid="project-group-chevron"
        class="size-3 shrink-0 text-(--d-faint) transition-transform duration-200 ease-out"
        :class="collapsed ? '-rotate-90' : ''"
      />
      <component
        :is="connection ? Server : Laptop"
        aria-hidden="true"
        data-testid="project-group-icon"
        class="size-3 shrink-0"
        :class="host?.color ? `d-tone-${host.color}` : ''"
      />
      <template v-if="renaming">
        <span
          :id="nameId"
          class="sr-only"
        >{{ name }}</span>
        <span
          class="min-w-0 flex-1 py-0.5"
          @focusout="emit('renameBlur', draft)"
        >
          <HostNameField
            ref="field"
            v-model="draft"
            :label="t('remote.card.renameLabel')"
            class="h-6 rounded-md px-1.5 text-11"
            @submit="emit('renameSubmit', $event)"
            @cancel="emit('renameCancel')"
          />
        </span>
      </template>
      <span
        v-else
        :id="nameId"
        data-testid="project-group-name"
        class="min-w-0 truncate"
      >
        <!-- A rename swaps the old name for the new one. -->
        <Transition
          name="t-swap"
          mode="out-in"
        >
          <span :key="name">{{ name }}</span>
        </Transition>
      </span>
      <HostStatusDot
        v-if="connection && !renaming"
        :connection="connection"
        :reconnect="host?.reconnect"
        :slow="host?.latency?.slow"
        :label="dotLabel"
      />
      <Transition name="t-badge">
        <Badge
          v-if="collapsed && busy.count > 0 && !renaming"
          variant="tone"
          data-testid="group-activity-badge"
          :class="['flex shrink-0 border-0 bg-(--tone)/15 px-1.5 py-px font-mono text-10.5 font-normal', busy.waiting ? 'd-tone-warning' : 'd-tone-accent']"
          :title="t('projects.group.busy', busy.count)"
        >
          <span
            aria-hidden="true"
            class="size-1.25 animate-[d-pulse_1.4s_infinite] rounded-full bg-current"
          />
          {{ busy.count }}
        </Badge>
      </Transition>
    </div>
    <div class="flex flex-col gap-px pl-2">
      <slot />
    </div>
  </div>
</template>
