<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ChevronRight, GitCompare, Minus, Plus, Undo2 } from 'lucide-vue-next';
import type { Component } from 'vue';
import { Button } from '@/components/ui/button';
import type { GroupInlineAction } from './scm-menus';
import type { ScmRow } from './scm-list';

defineProps<{
  row: Extract<ScmRow, { kind: 'group' }>;
  id: string;
  current: boolean;
  height: number;
  actions: readonly GroupInlineAction[];
  busy: boolean;
}>();
const emit = defineEmits<{ toggle: []; action: [action: GroupInlineAction['action']]; menu: [event: MouseEvent]; focus: [] }>();
const { t } = useI18n();

const ACTION_ICONS: Readonly<Record<GroupInlineAction['icon'], Component>> = { 'git-compare': GitCompare, plus: Plus, minus: Minus, 'undo-2': Undo2 };
</script>

<template>
  <div
    :id="id"
    role="treeitem"
    :data-row-key="row.key"
    data-testid="scm-group"
    :data-group="row.group"
    aria-level="1"
    :aria-posinset="row.position"
    :aria-setsize="row.setSize"
    :aria-expanded="row.expanded"
    :aria-label="t('scm.groupAria', { name: t(`scm.group.${row.group}`), count: row.count })"
    :tabindex="current ? 0 : -1"
    class="flex cursor-pointer items-center gap-1.5 rounded-6 pr-1 pl-0.5 outline-none select-none focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
    :style="{ height: `${height}px` }"
    @click="emit('toggle')"
    @focus="emit('focus')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <ChevronRight
      aria-hidden="true"
      class="size-3 shrink-0 text-(--d-muted) transition-transform duration-200"
      :class="row.expanded ? 'rotate-90' : ''"
    />
    <span
      class="truncate text-11.5 font-semibold"
      :class="row.group === 'merge' ? 'text-(--d-danger-text)' : 'text-(--d-muted)'"
    >{{ t(`scm.group.${row.group}`) }}</span>
    <span class="relative inline-flex font-mono text-11.5 text-(--d-faint) tabular-nums">
      <Transition
        name="t-swap"
        mode="out-in"
      >
        <span
          :key="row.count"
          data-testid="scm-group-count"
        >{{ row.count }}</span>
      </Transition>
    </span>
    <span class="flex-1" />
    <Button
      v-for="action in actions"
      :key="action.label"
      type="button"
      variant="ghost"
      size="icon-sm"
      tabindex="-1"
      :data-testid="`scm-group-${action.label}`"
      class="size-5.5 rounded-5 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.25"
      :disabled="busy && action.action !== 'openGroupChanges'"
      :aria-label="t(`scm.action.${action.label}`)"
      :title="t(`scm.action.${action.label}`)"
      @click.stop="emit('action', action.action)"
    >
      <component
        :is="ACTION_ICONS[action.icon]"
        aria-hidden="true"
      />
    </Button>
  </div>
</template>
