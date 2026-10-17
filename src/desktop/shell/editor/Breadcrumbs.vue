<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, Folder, FolderTree, Lock } from 'lucide-vue-next';
import { visibleText } from '@shared/visible-text';
import type { TabPlace } from './editor-place';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { isBlankPage, pageHost } from './browser-page';

defineOptions({ name: 'EditorBreadcrumbs' });

// place: the first crumb, so a worktree's copy of a file and the project folder's never read alike
const props = defineProps<{ tab: ShellEditorTab; projectName?: string | undefined; place?: TabPlace }>();
const { t } = useI18n();

// The project, then each folder and the file; a file outside every project, each folder of its path and the file, as VS
// Code's breadcrumbs show it; a page, Browser and its host.
const crumbs = computed(() => {
  const url = props.tab.browser?.url;
  if (url !== undefined) return [t('editor.browser.label'), isBlankPage(url) ? t('editor.browser.newPage') : pageHost(url)];
  const { relativePath } = props.tab;
  const { projectName } = props;
  // Escaped after the split, since an escape holds a backslash.
  if (relativePath === undefined || projectName === undefined) return props.tab.displayPath.split(/[\\/]+/).filter((segment) => segment !== '').map(visibleText);
  return [projectName, ...relativePath.split('/')].map(visibleText);
});

// The worktree crumb shows what its tab's chip shows, and names the whole branch, or the bare place while main cannot name it.
const worktreeName = computed(() => {
  const place = props.place;
  if (place?.kind !== 'worktree') return undefined;
  return place.branch === undefined ? t('worktree.chip.worktree') : t('worktree.chip.tab', { branch: visibleText(place.branch) });
});
const placeLabel = computed(() => {
  const place = props.place;
  if (place?.kind !== 'worktree') return t('worktree.chip.projectFolder');
  return place.label === undefined ? t('worktree.chip.worktree') : visibleText(place.label);
});
</script>

<template>
  <div
    data-testid="editor-breadcrumbs"
    class="flex h-6.5 shrink-0 items-center gap-2 border-b border-(--d-border) bg-(--d-bg) px-3.5 text-11.5 text-(--d-faint-text)"
  >
    <nav
      :aria-label="t('editor.breadcrumbs')"
      class="flex min-w-0 flex-1 items-center gap-1"
    >
      <span
        v-if="place"
        data-testid="editor-breadcrumb-place"
        :data-place="place.kind"
        class="flex max-w-36 min-w-2.75 shrink-1000000 items-center gap-1"
        :class="[place.kind === 'worktree' ? 'text-(--d-accent-text)' : '', place.kind === 'worktree' && place.label !== undefined ? 'font-mono' : '']"
        :dir="place.kind === 'worktree' && place.label !== undefined ? 'ltr' : undefined"
        :title="worktreeName"
      >
        <component
          :is="place.kind === 'worktree' ? FolderTree : Folder"
          aria-hidden="true"
          class="size-2.75 shrink-0"
        />
        <span
          class="truncate"
          :aria-hidden="place.kind === 'worktree' || undefined"
        >{{ placeLabel }}</span>
        <span
          v-if="worktreeName"
          class="sr-only"
        >{{ worktreeName }}</span>
      </span>
      <ChevronRight
        v-if="place && crumbs.length > 0"
        aria-hidden="true"
        class="size-2.75 shrink-0"
      />
      <!-- Flex shrinks by weight times width, so these weights keep the file's share under a layout unit while others can shrink:
           the folders give way first, then the place down to its icon (its name stays in the title), then the file. -->
      <span
        v-if="crumbs.length > 1"
        class="flex min-w-0 shrink-100000000 items-center gap-1 overflow-hidden"
      >
        <template
          v-for="(crumb, index) in crumbs.slice(0, -1)"
          :key="index"
        >
          <span
            data-crumb
            class="min-w-0 truncate"
          >{{ crumb }}</span>
          <ChevronRight
            aria-hidden="true"
            class="size-2.75 shrink-0"
          />
        </template>
      </span>
      <span
        v-if="crumbs.length > 0"
        data-crumb
        class="min-w-0 truncate text-(--d-text)"
        aria-current="location"
      >{{ crumbs.at(-1) }}</span>
    </nav>
    <span
      v-if="tab.readOnly"
      data-testid="editor-read-only"
      class="flex shrink-0 items-center gap-1 text-10.5"
      :title="t(`editor.readOnly.${tab.readOnlyReason ?? 'log'}`)"
    >
      <Lock
        aria-hidden="true"
        class="size-2.75"
      />{{ t('editor.tab.readOnly') }}
    </span>
    <!-- A side that is not text has no lines to count. -->
    <span
      v-if="tab.diff && !tab.diff.sides"
      data-testid="editor-diff-stats"
      class="flex shrink-0 gap-2.5 font-mono"
      :aria-label="t('editor.diffStats', { added: tab.diff.added, removed: tab.diff.removed })"
    >
      <span class="text-(--d-success-text)">+{{ tab.diff.added }}</span>
      <span class="text-(--d-danger-text)">−{{ tab.diff.removed }}</span>
    </span>
    <!-- The pane's status for the tab, such as Formatting…, right of the path where it never covers the text. -->
    <slot />
  </div>
</template>
