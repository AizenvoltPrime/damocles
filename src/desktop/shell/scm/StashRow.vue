<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Archive, ArchiveRestore } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { fromNow, type ScmRow } from './scm-list';
import { visibleText } from '@shared/visible-text';

// A row of the Stashes group (prototype): the stash's message, then its branch and age; Apply Stash inline, View Stash on click.
const props = defineProps<{
  row: Extract<ScmRow, { kind: 'stash' }>;
  id: string;
  // the roving tabindex position
  current: boolean;
  // CSS px, fixed so the virtual list can place the row
  height: number;
  // ms since epoch the ages are measured from
  now: number;
  // the entrance class of a stash that arrived live, never one mounted by scroll
  arrival?: string | undefined;
  busy: boolean;
}>();
const emit = defineEmits<{ activate: []; apply: []; menu: [event: MouseEvent]; focus: [] }>();
const { t, locale } = useI18n();

const description = computed(() => visibleText(props.row.stash.description));
const age = computed(() => fromNow(props.row.stash.date, props.now, locale.value));
const detail = computed(() => (props.row.stash.branch === null ? age.value : `${visibleText(props.row.stash.branch)} · ${age.value}`));
const name = computed(() => `stash@{${props.row.stash.index}}`);
</script>

<template>
  <div
    :id="id"
    role="treeitem"
    :data-row-key="row.key"
    data-testid="scm-stash"
    :data-index="row.stash.index"
    :aria-level="row.level"
    :aria-posinset="row.position"
    :aria-setsize="row.setSize"
    :aria-label="t('scm.stashAria', { name, description, detail })"
    :tabindex="current ? 0 : -1"
    :title="`${name}: ${description}`"
    class="scm-row group/row flex cursor-pointer items-center gap-1.75 rounded-6 pr-1 pl-1.5 outline-none select-none hover:bg-(--d-hover) focus-visible:shadow-[inset_0_0_0_1px_var(--d-accent)]"
    :class="arrival ?? ''"
    :style="{ height: `${height}px` }"
    @click="emit('activate')"
    @focus="emit('focus')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <Archive
      aria-hidden="true"
      class="size-3.25 shrink-0 text-(--d-info)"
    />
    <span
      data-testid="scm-stash-description"
      class="min-w-0 shrink truncate text-12.5"
    >{{ description }}</span>
    <span
      data-testid="scm-stash-detail"
      class="min-w-0 flex-1 truncate text-11 text-(--d-faint) group-hover/row:text-(--d-faint-text)"
    >{{ detail }}</span>
    <!-- Takes no space until the row is hovered or focused, as in VS Code; the menu reaches it by keyboard. -->
    <span class="d-actions-in hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        data-testid="scm-stash-apply"
        class="size-5 rounded-5 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3"
        :disabled="busy"
        :aria-label="t('scm.action.applyStash')"
        :title="t('scm.action.applyStash')"
        @click.stop="emit('apply')"
      >
        <ArchiveRestore aria-hidden="true" />
      </Button>
    </span>
  </div>
</template>
