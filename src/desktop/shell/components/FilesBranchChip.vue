<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, Folder, FolderTree } from 'lucide-vue-next';
import { visibleText } from '@shared/visible-text';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, ShownFolder } from '../../preload/shell-channels';
import type { OverlayRect } from '../../preload/overlay-channels';
import { finishActionOf, finishMenuItems } from '../worktree-menu';
import { branchLeaf } from '@/utils/branch-leaf';

/**
 * The Files header's branch chip (D31): the worktree's branch in accent while the views show the selected chat's worktree,
 * "Project folder" in muted text after Show project folder. Its menu switches between the two and holds the finish actions
 * (D33). In the project folder a click shows the worktree again; the chevron, a right-click and Shift+F10 open the menu.
 */
const props = defineProps<{ api: DamoclesShellApi; shown: ShownFolder; newChatShortcut?: string | undefined }>();
const { t } = useI18n();

const worktree = computed(() => props.shown.worktree);
const worktreeShown = computed(() => props.shown.root.worktreeId !== undefined);
const branch = computed(() => (worktree.value ? visibleText(worktree.value.branch) : ''));
const stateText = computed(() => {
  const wt = worktree.value;
  if (!wt || !worktreeShown.value || wt.baseBranch === undefined) return undefined;
  const base = visibleText(wt.baseBranch);
  if (wt.targetRewritten) return { text: t('worktree.chip.rewritten', { branch: base }), tone: 'warning' as const };
  if (wt.behind > 0) return { text: t('worktree.chip.behind', { n: wt.behind, branch: base }), tone: 'muted' as const };
  return undefined;
});
const title = computed(() => {
  if (!worktreeShown.value || !worktree.value) return t('worktree.chip.projectTitle');
  const place = t('worktree.chip.worktreeTitle', { branch: branch.value });
  return stateText.value ? `${place} (${stateText.value.text})` : place;
});
// The chip shows the branch's slug, which tells worktrees apart; its accessible name carries the full branch and its state.
const label = computed(() => (worktreeShown.value && worktree.value ? visibleText(branchLeaf(worktree.value.branch)) : t('worktree.chip.projectFolder')));
// In the project folder the chip's own action is to show the worktree, so its name says that after its visible label.
const ariaLabel = computed(() => {
  if (!worktree.value) return t('worktree.chip.projectFolder');
  if (!worktreeShown.value) return t('worktree.chip.projectAria', { branch: branch.value });
  const place = t('worktree.chip.tab', { branch: branch.value });
  return stateText.value ? `${place}, ${stateText.value.text}` : place;
});

const menuOpen = ref(false);
const root = ref<HTMLElement | null>(null);

function rectOf(element: Element | null): OverlayRect {
  const rect = element?.getBoundingClientRect();
  return rect ? { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height } : { x: 0, y: 0, width: 0, height: 0 };
}

async function openMenu(): Promise<void> {
  const wt = worktree.value;
  if (!wt || menuOpen.value) return;
  const { projectKey } = props.shown;
  menuOpen.value = true;
  let answer;
  try {
    answer = await props.api.requestOverlay({
      kind: 'menu',
      label: t('worktree.chip.menuLabel', { branch: visibleText(wt.branch) }),
      // the full branch heads the menu, since the chip shows only its slug
      caption: visibleText(wt.branch),
      anchor: rectOf(root.value),
      items: [
        {
          kind: 'item',
          id: 'newChatInWorktree',
          label: t('worktree.newChatHere'),
          icon: 'plus',
          ...(props.newChatShortcut ? { shortcut: props.newChatShortcut } : {}),
          ...(wt.newChatIn ? {} : { disabled: true, disabledReason: t('worktree.newChatFinishing') }),
        },
        { kind: 'separator' },
        { kind: 'item', id: 'showProject', label: t('worktree.chip.showProject'), icon: 'folder', checked: !worktreeShown.value, radio: true },
        { kind: 'item', id: 'showWorktree', label: t('worktree.chip.showWorktree'), icon: 'folder-tree', checked: worktreeShown.value, radio: true },
        { kind: 'separator' },
        ...finishMenuItems(t, wt.finish, wt.baseBranch),
      ],
    });
  } finally {
    menuOpen.value = false;
  }
  if (answer.kind !== 'menu') return;
  if (answer.itemId === 'newChatInWorktree') {
    // a fresh object: the shown folder can be a reactive proxy, which the context bridge cannot clone
    if (wt.newChatIn) await props.api.newChatInWorktree({ projectKey: wt.newChatIn.projectKey, worktreeId: wt.newChatIn.worktreeId });
    return;
  }
  if (answer.itemId === 'showProject' || answer.itemId === 'showWorktree') {
    const show = answer.itemId === 'showProject' ? 'project' : 'worktree';
    if ((show === 'worktree') !== worktreeShown.value) await props.api.showFolder({ projectKey, show });
    return;
  }
  const action = finishActionOf(answer.itemId);
  if (action) await props.api.worktreeFinish({ projectKey, worktreeId: wt.worktreeId, action });
}

// D31: clicking the chip again returns to the worktree; while the worktree shows, a click opens the menu.
function onClick(): void {
  if (worktreeShown.value) void openMenu();
  else void props.api.showFolder({ projectKey: props.shown.projectKey, show: 'worktree' });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
  event.preventDefault();
  void openMenu();
}

// Each part rounds its own outer end and insets its focus ring, so the ring follows the pill and the header's title actions
// beside the chip never cover it. Button's base sizes icons at size-4; the chip's are smaller.
const PART = 'h-full text-10.5 font-normal transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-2.5';
const TONE = computed(() => (worktreeShown.value
  ? 'bg-(--d-accent-soft) text-(--d-accent-text) hover:bg-[color-mix(in_srgb,var(--d-accent)_22%,transparent)] hover:text-(--d-accent-text)'
  : 'bg-(--d-hover) text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text)'));
</script>

<template>
  <span
    ref="root"
    data-testid="files-branch-chip"
    :data-shown="worktreeShown ? 'worktree' : 'project'"
    class="ms-1 flex h-4.5 max-w-full min-w-0 items-stretch rounded-full whitespace-nowrap"
    @contextmenu.prevent.stop="openMenu"
  >
    <Button
      type="button"
      variant="ghost"
      data-testid="files-branch-chip-main"
      :aria-haspopup="worktreeShown ? 'menu' : undefined"
      :aria-expanded="worktreeShown ? menuOpen : undefined"
      :aria-label="ariaLabel"
      :title="title"
      class="d-press min-w-0 flex-1 justify-start gap-1 overflow-hidden rounded-s-full rounded-e-none ps-1.5 pe-0.5"
      :class="[PART, TONE, worktreeShown ? 'font-mono' : '']"
      @click.stop="onClick"
      @keydown="onKeydown"
    >
      <Transition
        name="t-icon"
        mode="out-in"
      >
        <FolderTree
          v-if="worktreeShown"
          aria-hidden="true"
          class="size-2.5 shrink-0"
        />
        <Folder
          v-else
          aria-hidden="true"
          class="size-2.5 shrink-0"
        />
      </Transition>
      <Transition
        name="t-swap"
        mode="out-in"
      >
        <span
          :key="worktreeShown ? `w:${worktree?.branch}` : 'p'"
          class="min-w-0 truncate"
          :dir="worktreeShown ? 'ltr' : undefined"
          aria-hidden="true"
          data-testid="files-branch-chip-label"
        >{{ label }}</span>
      </Transition>
      <Transition name="t-fade">
        <span
          v-if="stateText"
          data-testid="files-branch-chip-state"
          aria-hidden="true"
          class="min-w-0 shrink-4 truncate font-sans"
          :class="stateText.tone === 'warning' ? 'text-(--d-warning-text)' : 'text-(--d-faint-text)'"
        >· {{ stateText.text }}</span>
      </Transition>
    </Button>
    <!-- While the worktree shows, the main part opens this same menu, so the chevron is a mouse target only. -->
    <Button
      type="button"
      variant="ghost"
      data-testid="files-branch-chip-menu"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :aria-hidden="worktreeShown || undefined"
      :tabindex="worktreeShown ? -1 : undefined"
      :aria-label="t('worktree.chip.menuButton')"
      :title="t('worktree.chip.menuButton')"
      class="w-4.5 shrink-0 rounded-s-none rounded-e-full px-0"
      :class="[PART, TONE]"
      @click.stop="openMenu"
    >
      <ChevronDown
        aria-hidden="true"
        class="transition-transform duration-200"
        :class="menuOpen ? 'rotate-180' : ''"
      />
    </Button>
  </span>
</template>
