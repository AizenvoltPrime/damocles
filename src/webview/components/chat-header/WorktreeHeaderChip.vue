<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDown, ChevronDown, FolderTree, Plus, TriangleAlert } from 'lucide-vue-next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { remPx } from '@/composables/useRemPx';
import { branchLeaf } from '@/utils/branch-leaf';
import { visibleText } from '@shared/visible-text';
import { MENU_CONTENT, MENU_ITEM } from './menuStyles';

/**
 * The header's live worktree chip (D30): the branch's leaf, and a menu that starts another chat in the same worktree.
 * Narrow, the behind or rewritten note folds into the chip as an icon whose title carries the full text.
 */
const props = defineProps<{ branch: string; note?: { text: string; warning: boolean } | undefined; narrow: boolean }>();
const emit = defineEmits<{ newChatHere: [] }>();
const { t } = useI18n();

const shownBranch = computed(() => visibleText(props.branch));
const branchTitle = computed(() => t('worktree.branchTitle', { branch: shownBranch.value }));
// Narrow, the note's full text moves into the chip's title, beside its icon.
const title = computed(() => (props.narrow && props.note ? `${branchTitle.value}, ${props.note.text}` : branchTitle.value));
</script>

<template>
  <!-- One element root: the header swaps this chip inside an out-in Transition, which a fragment root would stall. -->
  <span class="flex min-w-0 shrink-0">
    <DropdownMenu>
      <DropdownMenuTrigger
        class="flex h-4.5 max-w-44 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-(--d-accent-soft) px-1.5 font-mono text-10.5 text-(--d-accent-text) transition-colors outline-none hover:bg-[color-mix(in_srgb,var(--d-accent)_22%,transparent)] focus-visible:ring-1 focus-visible:ring-(--d-accent) data-[state=open]:bg-[color-mix(in_srgb,var(--d-accent)_22%,transparent)]"
        dir="ltr"
        :title="title"
        data-testid="chat-header-worktree"
        data-place="live"
      >
        <FolderTree
          class="size-2.5 shrink-0"
          aria-hidden="true"
        />
        <!-- The leaf tells worktrees apart; the full branch is in the title and the accessible name. -->
        <span
          class="min-w-18 truncate text-start"
          aria-hidden="true"
          data-testid="chat-header-worktree-label"
        >{{ visibleText(branchLeaf(branch)) }}</span>
        <Transition name="t-icon">
          <component
            :is="note.warning ? TriangleAlert : ArrowDown"
            v-if="narrow && note"
            class="size-2.5 shrink-0"
            :class="note.warning ? 'text-(--d-warning-text)' : 'text-(--d-faint-text)'"
            aria-hidden="true"
            data-testid="chat-header-worktree-note-icon"
          />
        </Transition>
        <ChevronDown
          class="size-2.5 shrink-0 opacity-70"
          aria-hidden="true"
        />
        <span class="sr-only">{{ title }}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        :side-offset="remPx(0.375)"
        :class="['w-72', MENU_CONTENT]"
        data-testid="chat-header-worktree-menu"
      >
        <DropdownMenuLabel class="flex flex-col gap-0.5 px-2.25 pt-1.25 pb-1.5 font-normal">
          <span class="text-10.5 tracking-[.06em] text-(--d-faint-text) uppercase">{{ t('worktree.handOffHeading') }}</span>
          <span
            class="truncate font-mono text-11.5 text-(--d-text)"
            dir="ltr"
          >{{ shownBranch }}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem
          :class="[MENU_ITEM, 'cursor-pointer']"
          data-testid="hand-off-new-in-worktree"
          @select="emit('newChatHere')"
        >
          <Plus aria-hidden="true" />
          <span>{{ t('worktree.newChatHere') }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </span>
</template>
