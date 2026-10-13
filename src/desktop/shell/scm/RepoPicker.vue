<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronsUpDown, FolderGit2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { ScmRepoSummary, ScmView } from '../../preload/scm-channels';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import { tidyMenu } from '../../preload/overlay-channels';
import { pickerMenu, toOverlayMenu, type ScmAction } from './scm-menus';
import { visibleText } from './scm-list';

const props = defineProps<{
  api: DamoclesShellApi;
  view: ScmView;
  // the selected repository's branch or detached commit, as the picker's description
  branchOf: (repoId: string) => string;
}>();
const emit = defineEmits<{ select: [repoId: string]; action: [action: ScmAction] }>();
const { t } = useI18n();

const button = ref<InstanceType<typeof Button> | null>(null);
const selectedIndex = computed(() => props.view.repos.findIndex((repo) => repo.repoId === props.view.selectedRepoId));
const selected = computed(() => props.view.repos[selectedIndex.value]);
// A repository's folder path adds nothing when it is just its name (a nested repository one level down).
const description = (repo: ScmRepoSummary): string =>
  [props.branchOf(repo.repoId), repo.displayPath === repo.label ? '' : visibleText(repo.displayPath)].filter((part) => part !== '').join(' · ');

// The picker's menu (plan A.5): the open repositories to choose from, then the repository commands.
async function open(): Promise<void> {
  const element = button.value?.$el as HTMLElement | undefined;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const repos: OverlayMenuItem[] = props.view.repos.map((repo) => ({
    kind: 'item',
    id: `repo:${repo.repoId}`,
    label: description(repo) === '' ? visibleText(repo.label) : `${visibleText(repo.label)} · ${description(repo)}`,
    checked: repo.repoId === props.view.selectedRepoId,
    radio: true,
  }));
  const commands = toOverlayMenu(pickerMenu({ openRepos: props.view.repos.length, closedCount: props.view.closedCount }), (key) => t(`scm.${key}`));
  const answer = await props.api.requestOverlay({
    kind: 'menu',
    label: t('scm.picker.menuLabel'),
    anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
    items: tidyMenu([...repos, { kind: 'separator' }, ...commands]),
  });
  if (answer.kind !== 'menu') return;
  if (answer.itemId.startsWith('repo:')) emit('select', answer.itemId.slice('repo:'.length));
  else emit('action', answer.itemId as ScmAction);
}
</script>

<template>
  <!-- The prototype's repository card: a button that opens the picker's overlay menu. -->
  <Button
    v-if="selected"
    ref="button"
    type="button"
    variant="outline"
    data-testid="scm-repo-picker"
    aria-haspopup="menu"
    :aria-label="t('scm.picker.label', { name: visibleText(selected.label), index: selectedIndex + 1, count: view.repos.length })"
    :title="t('scm.picker.title')"
    class="h-6.5 w-full justify-start gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-2 text-xs font-normal transition-colors hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.25"
    @click="open"
  >
    <FolderGit2
      aria-hidden="true"
      class="shrink-0 text-(--d-accent-text)"
    />
    <span class="relative flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      <Transition
        name="t-swap"
        mode="out-in"
      >
        <span
          :key="selected.repoId"
          class="flex min-w-0 flex-1 items-center gap-1.5"
        >
          <span
            data-testid="scm-repo-name"
            class="shrink-0 font-medium whitespace-nowrap"
          >{{ visibleText(selected.label) }}</span>
          <span class="min-w-0 flex-1 truncate text-left font-mono text-11 text-(--d-faint)">{{ branchOf(selected.repoId) }}</span>
        </span>
      </Transition>
    </span>
    <span class="shrink-0 text-10.5 whitespace-nowrap text-(--d-faint)">{{ t('scm.picker.count', { index: selectedIndex + 1, count: view.repos.length }) }}</span>
    <ChevronsUpDown
      aria-hidden="true"
      class="shrink-0 text-(--d-faint)"
    />
  </Button>
</template>
