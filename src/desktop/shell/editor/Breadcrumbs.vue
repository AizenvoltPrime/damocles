<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, Lock } from 'lucide-vue-next';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { isBlankPage, pageHost } from './browser-page';

defineOptions({ name: 'EditorBreadcrumbs' });

const props = defineProps<{ tab: ShellEditorTab; projectName?: string | undefined }>();
const { t } = useI18n();

// The project, then each folder and the file; a file outside every project, each folder of its path and the file, as VS
// Code's breadcrumbs show it; a page, Browser and its host.
const crumbs = computed(() => {
  const url = props.tab.browser?.url;
  if (url !== undefined) return [t('editor.browser.label'), isBlankPage(url) ? t('editor.browser.newPage') : pageHost(url)];
  const { relativePath } = props.tab;
  const { projectName } = props;
  if (relativePath === undefined || projectName === undefined) return props.tab.displayPath.split(/[\\/]+/).filter((segment) => segment !== '');
  return [projectName, ...relativePath.split('/')];
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
      <!-- The folders alone give way; the file's own crumb keeps its width unless it is wider than the whole bar. -->
      <span
        v-if="crumbs.length > 1"
        class="flex min-w-0 items-center gap-1 overflow-hidden"
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
        class="max-w-full shrink-0 truncate text-(--d-text)"
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
