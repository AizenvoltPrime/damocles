<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowLeftRight, Check, ChevronDown, Folder, FolderTree } from 'lucide-vue-next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ChatPlace, WorktreeStateData } from '@shared/types/messages';
import { remPx } from '@/composables/useRemPx';
import { visibleText } from '@shared/visible-text';
import { MENU_CONTENT } from './menuStyles';

/**
 * D61's Hand off: the menu says where the chat works now and offers the move to the other place. The move is disabled, with
 * its reason, unless the chat is idle, and the trigger stays focusable so the reason is reachable; core checks again before
 * it moves anything.
 */
const props = defineProps<{ state: WorktreeStateData; projectBranch?: string | undefined; wide: boolean }>();
const emit = defineEmits<{ move: [to: ChatPlace] }>();
const { t } = useI18n();

const inWorktree = computed(() => props.state.place === 'worktree');
const title = computed(() => (props.state.canHandOff ? t('worktree.handOffTitle') : t('worktree.handOffDisabled')));
</script>

<template>
  <span
    class="flex"
    :title="title"
    data-testid="chat-header-hand-off-wrap"
  >
    <DropdownMenu>
      <DropdownMenuTrigger
        class="d-tool-btn gap-1.5 px-2 text-xs"
        :aria-label="state.canHandOff ? t('worktree.handOff') : `${t('worktree.handOff')}, ${t('worktree.handOffDisabled')}`"
        data-testid="chat-header-hand-off"
      >
        <ArrowLeftRight
          class="size-3.5"
          aria-hidden="true"
        />
        <span v-if="wide">{{ t('worktree.handOff') }}</span>
        <ChevronDown
          class="size-2.75"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        :side-offset="remPx(0.375)"
        :class="['w-82.5 whitespace-normal', MENU_CONTENT]"
        data-testid="hand-off-menu"
      >
        <!-- Where the chat works now is the label of the group holding the move, so the menu holds only menu roles. -->
        <DropdownMenuGroup>
          <DropdownMenuLabel class="p-0 text-13 font-normal">
            <div class="px-2.25 pt-1.25 pb-0.75 text-10.5 tracking-[.06em] text-(--d-faint-text) uppercase">
              {{ t('worktree.handOffHeading') }}
            </div>
            <div
              class="flex items-start gap-2.25 rounded-7 px-2.25 py-1.75"
              data-testid="hand-off-current"
              :data-place="state.place"
            >
              <component
                :is="inWorktree ? FolderTree : Folder"
                class="mt-0.5 size-3.5 shrink-0 text-(--d-faint)"
                aria-hidden="true"
              />
              <div class="flex min-w-0 flex-1 flex-col">
                <i18n-t
                  v-if="inWorktree"
                  keypath="worktree.worktreeBranch"
                  tag="span"
                  class="truncate"
                  scope="global"
                >
                  <template #branch>
                    <span
                      class="font-mono text-12"
                      dir="ltr"
                    >{{ visibleText(state.branch ?? '') }}</span>
                  </template>
                </i18n-t>
                <span v-else>{{ t('worktree.projectFolder') }}</span>
                <span class="text-11 text-(--d-faint-text)">{{ inWorktree ? t('worktree.worktreeSub') : projectBranch ? t('worktree.projectSub', { branch: visibleText(projectBranch) }) : '' }}</span>
              </div>
              <Check
                class="mt-0.5 size-3.25 shrink-0 text-(--d-accent)"
                aria-hidden="true"
              />
            </div>
          </DropdownMenuLabel>
          <!-- A disabled item takes no pointer events, so its reason is text in the item, as in the header's More menu. Only its
               label and icon dim, so the reason keeps its token's contrast (palette-contrast.test.ts). -->
          <DropdownMenuItem
            class="cursor-pointer items-start gap-2.25 rounded-7 px-2.25 py-1.75 text-13 text-(--d-text) focus:bg-(--d-hover) focus:text-(--d-text) data-disabled:opacity-100"
            :disabled="!state.canHandOff"
            data-testid="hand-off-move"
            @select="emit('move', inWorktree ? 'project' : 'worktree')"
          >
            <component
              :is="inWorktree ? Folder : FolderTree"
              class="mt-0.5 size-3.5 shrink-0 text-(--d-muted)"
              :class="!state.canHandOff && 'opacity-50'"
              aria-hidden="true"
            />
            <div class="flex min-w-0 flex-1 flex-col">
              <span :class="!state.canHandOff && 'opacity-50'">{{ inWorktree ? t('worktree.moveToProject') : t('worktree.moveToWorktree') }}</span>
              <span
                class="text-11 text-pretty text-(--d-faint-text)"
                :class="!state.canHandOff && 'opacity-50'"
              >{{ inWorktree ? t('worktree.moveToProjectSub') : t('worktree.moveToWorktreeSub') }}</span>
              <span
                v-if="!state.canHandOff"
                class="text-11 text-pretty text-(--d-muted)"
                data-testid="hand-off-disabled-reason"
              >{{ t('worktree.handOffDisabled') }}</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </span>
</template>
