<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { unrefElement, useResizeObserver } from '@vueuse/core';
import { Ellipsis, Folder, FolderTree, Lock } from 'lucide-vue-next';
import { visibleText } from '@shared/visible-text';
import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { remPx } from '@/composables/useRemPx';
import type { TabPlace } from './editor-place';
import type { DiffStats } from './editor-store';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { isBlankPage, pageHost } from './browser-page';
import { readOnlyMessageKey } from './read-only-message';
import { foldCrumbs } from './crumb-fold';

defineOptions({ name: 'EditorBreadcrumbs' });

// place: the first crumb, so a worktree's copy of a file and the project folder's never read alike
// diffStats: a diff tab's line counts once its editor computed the diff; a side that is not text has none
// hostName: the host of a file outside every project, its first crumb
const props = defineProps<{ tab: ShellEditorTab; projectName?: string | undefined; hostName?: string | undefined; place?: TabPlace; diffStats?: DiffStats | undefined }>();
const { t } = useI18n();

// The project, then each folder and the file; a file outside every project, its host's name if not this computer's, then
// each folder of its path and the file, as VS Code's breadcrumbs show it; a page, Browser and its host.
const crumbs = computed(() => {
  const url = props.tab.browser?.url;
  if (url !== undefined) return [t('editor.browser.label'), isBlankPage(url) ? t('editor.browser.newPage') : pageHost(url)];
  const { relativePath } = props.tab;
  const { projectName } = props;
  // Escaped after the split, since an escape holds a backslash.
  if (relativePath === undefined || projectName === undefined) {
    const segments = props.tab.displayPath.split(/[\\/]+/).filter((segment) => segment !== '');
    return [...(props.hostName === undefined ? [] : [props.hostName]), ...segments].map(visibleText);
  }
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

// Overflow, as Explorer's address bar: the leading folders fold into one ellipsis crumb after the first crumb. Past that,
// flex weights give way in order: the place down to its icon, the first crumb down to FIRST_CRUMB_MIN_REM, then the file.
const FIRST_CRUMB_MIN_REM = 2;
const list = useTemplateRef('list');
const measuring = ref(false);
const hidden = ref(0);
const firstWidth = ref(0);
const hiddenCrumbs = computed(() => crumbs.value.slice(1, 1 + hidden.value));
const shown = computed(() => {
  const all = crumbs.value.map((text, index) => ({ text, index }));
  if (all.length < 3 || (!measuring.value && hidden.value === 0)) return all;
  return [all[0]!, 'ellipsis' as const, ...all.slice(measuring.value ? 1 : 1 + hidden.value)];
});
const firstMinWidth = computed(() => `${Math.min(FIRST_CRUMB_MIN_REM, firstWidth.value / remPx(1))}rem`);

// Needs every crumb laid out whole and unshrunk, with the ellipsis after the first, as `measuring` renders them.
function measureFold(): number {
  const row = unrefElement(list);
  const crumbRects = [...row?.querySelectorAll('[data-crumb]') ?? []].map((crumb) => crumb.getBoundingClientRect());
  const ellipsis = row?.querySelector('[data-crumb-ellipsis]');
  const [first, second, third] = crumbRects;
  firstWidth.value = first?.width ?? 0;
  if (!row || !first || !second || !third || !ellipsis) return 0;
  return foldCrumbs(crumbRects.map((rect) => rect.width), row.getBoundingClientRect().right - first.left, third.left - second.right, ellipsis.getBoundingClientRect().width);
}

// Each re-measure shows every crumb whole for one render and folds before the next paint, as EditorTabs' place chips do.
const rowResizes = ref(0);
let rowSize = '';
useResizeObserver(list, (entries) => {
  const box = entries[0]?.contentRect;
  const size = box ? `${box.width}x${box.height}` : '';
  if (size === rowSize) return;
  rowSize = size;
  rowResizes.value++;
});
watch([() => crumbs.value.join('\n'), placeLabel, () => props.place?.kind, rowResizes], async () => {
  measuring.value = true;
  await nextTick();
  hidden.value = measureFold();
  measuring.value = false;
}, { flush: 'post' });
</script>

<template>
  <div
    data-testid="editor-breadcrumbs"
    class="flex h-6.5 shrink-0 items-center gap-2 border-b border-(--d-border) bg-(--d-bg) px-3.5 text-11.5 text-(--d-faint-text)"
  >
    <Breadcrumb
      :aria-label="t('editor.breadcrumbs')"
      class="flex min-w-0 flex-1"
    >
      <BreadcrumbList
        ref="list"
        class="min-w-0 flex-1 flex-nowrap gap-1 overflow-hidden text-11.5"
      >
        <BreadcrumbItem
          v-if="place"
          data-testid="editor-breadcrumb-place"
          :data-place="place.kind"
          class="flex max-w-36 min-w-2.75 gap-1"
          :class="[measuring ? 'shrink-0' : 'shrink-1000000', place.kind === 'worktree' ? 'text-(--d-accent-text)' : '', place.kind === 'worktree' && place.label !== undefined ? 'font-mono' : '']"
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
        </BreadcrumbItem>
        <BreadcrumbSeparator
          v-if="place && crumbs.length > 0"
          class="flex shrink-0 [&>svg]:size-2.75"
        />
        <template
          v-for="(crumb, position) in shown"
          :key="crumb === 'ellipsis' ? 'ellipsis' : crumb.index"
        >
          <BreadcrumbItem
            v-if="crumb === 'ellipsis'"
            data-crumb-ellipsis
            class="shrink-0"
          >
            <Tooltip disable-closing-trigger>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  :aria-label="t('editor.breadcrumbsHidden')"
                  class="flex h-4 items-center rounded-5 px-0.5 transition-colors duration-150 ease-out hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:outline-1 focus-visible:outline-(--d-accent) data-[state=delayed-open]:text-(--d-text) data-[state=instant-open]:text-(--d-text)"
                >
                  <BreadcrumbEllipsis class="size-auto">
                    <Ellipsis class="size-3" />
                  </BreadcrumbEllipsis>
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="start"
              >
                <ol class="flex flex-col gap-0.5">
                  <li
                    v-for="(folder, index) in hiddenCrumbs"
                    :key="index"
                    class="flex items-start gap-1.5 break-all"
                  >
                    <Folder
                      aria-hidden="true"
                      class="mt-0.5 size-3 shrink-0 text-(--d-faint-text)"
                    />{{ folder }}
                  </li>
                </ol>
              </TooltipContent>
            </Tooltip>
          </BreadcrumbItem>
          <BreadcrumbItem
            v-else-if="crumb.index < crumbs.length - 1"
            class="min-w-0"
            :class="measuring ? 'shrink-0' : crumb.index === 0 ? 'shrink-10000' : 'shrink-100000000'"
            :style="crumb.index === 0 && !measuring ? { minWidth: firstMinWidth } : undefined"
          >
            <span
              data-crumb
              class="min-w-0 truncate"
            >{{ crumb.text }}</span>
          </BreadcrumbItem>
          <BreadcrumbItem
            v-else
            class="min-w-0"
            :class="measuring ? 'shrink-0' : ''"
          >
            <BreadcrumbPage
              data-crumb
              class="min-w-0 truncate"
              aria-current="location"
            >
              {{ crumb.text }}
            </BreadcrumbPage>
          </BreadcrumbItem>
          <BreadcrumbSeparator
            v-if="position < shown.length - 1"
            class="flex shrink-0 [&>svg]:size-2.75"
          />
        </template>
      </BreadcrumbList>
    </Breadcrumb>
    <span
      v-if="tab.readOnly"
      data-testid="editor-read-only"
      class="flex shrink-0 items-center gap-1 text-10.5"
      :title="t(readOnlyMessageKey[tab.readOnlyReason ?? 'log'])"
    >
      <Lock
        aria-hidden="true"
        class="size-2.75"
      />{{ t('editor.tab.readOnly') }}
    </span>
    <span
      v-if="diffStats"
      data-testid="editor-diff-stats"
      class="flex shrink-0 gap-2.5 font-mono"
      :aria-label="t('editor.diffStats', { added: diffStats.added, removed: diffStats.removed })"
    >
      <span class="text-(--d-success-text)">+{{ diffStats.added }}</span>
      <span class="text-(--d-danger-text)">−{{ diffStats.removed }}</span>
    </span>
    <!-- The pane's status for the tab, such as Formatting…, right of the path where it never covers the text. -->
    <slot />
  </div>
</template>
