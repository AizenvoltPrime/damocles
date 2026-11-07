<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleAlert, LoaderCircle, Lock, MessageSquare, MessageSquareCode, Palette, Pencil, Plus, Tag, Trash2, X } from 'lucide-vue-next';
import ProviderLogo from '@/components/icons/ProviderLogo.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatClock } from '@/utils/clock';
import { MAX_CHAT_NAME_LENGTH, type ShellChat } from '../../preload/shell-channels';
import { chatGroupOf, chatOffers, modelLabel, type ChatNesting } from '../chat-list';
import { branchLeaf } from '@/utils/branch-leaf';
import { visibleText } from '@shared/visible-text';
import { DESIGN_TILE } from '@/components/design/design-tone';

const props = defineProps<{
  chat: ShellChat;
  optionId: string;
  selected: boolean;
  // the listbox's keyboard position
  active: boolean;
  renaming: boolean;
  // a live worktree chat: the row offers New chat in this worktree
  opensHere?: boolean;
  // a design chat listed under its parent's row: one line, joined to the parent by a tree line
  nested?: ChatNesting | undefined;
}>();
const emit = defineEmits<{
  select: [];
  menu: [event: MouseEvent];
  rename: [];
  tag: [];
  delete: [];
  filterTag: [tag: string];
  commitRename: [name: string];
  cancelRename: [];
  newHere: [];
}>();
const { t, locale } = useI18n();

const ROW_ACTION = 'size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-accent) [&_svg]:size-3';

const title = computed(() => props.chat.title || t('chats.newChat'));
// The hover actions take the status dot's place, so the dot hides only when there are actions to show.
const offersActions = computed(() => (['rename', 'tag', 'delete'] as const).some((action) => chatOffers(props.chat, action)));
const model = computed(() => (props.chat.model ? modelLabel(props.chat.model) : undefined));
const DESIGN_DOT = { running: 'd-pulsing bg-(--d-design)', waiting: 'bg-(--d-warning)', finished: 'bg-(--d-success)' } as const;
// A superseded design chat is read-only, so it has no state to show: its lock says so instead.
const superseded = computed(() => props.chat.design?.superseded === true);
const designDot = computed((): keyof typeof DESIGN_DOT | undefined => {
  const design = props.chat.design;
  if (!design || superseded.value) return undefined;
  if (props.chat.status !== 'idle') return props.chat.status;
  return design.finishedVersion !== undefined ? 'finished' : undefined;
});
const when = computed(() => {
  const date = new Date(props.chat.timestamp);
  const recent = chatGroupOf(props.chat.timestamp, new Date()) !== 'earlier';
  return recent ? formatClock(date, locale.value) : new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric' }).format(date);
});

// A worktree chat (D30, AD12 Listing) names its branch where other rows show the time and model; the title is the whole line.
const worktreeLine = computed(() => {
  const worktree = props.chat.worktree;
  if (!worktree) return undefined;
  const branch = visibleText(worktree.branch);
  const leaf = visibleText(branchLeaf(worktree.branch));
  switch (worktree.status) {
    case 'pending': {
      const text = t('worktree.row.newFrom', { branch });
      return { text, mono: false, title: text };
    }
    case 'live': return { text: leaf, mono: true, title: branch };
    case 'inProjectFolder': return { text: t('worktree.row.inProjectFolder', { branch: leaf }), mono: false, title: t('worktree.row.inProjectFolder', { branch }) };
    case 'deleted': {
      const text = worktree.fromProject ? t('worktree.row.deletedFrom', { project: worktree.fromProject }) : t('worktree.row.deleted');
      return { text, mono: false, title: text };
    }
  }
  return undefined;
});
const worktreeGone = computed(() => props.chat.worktree?.status === 'deleted' || props.chat.readOnly);

const draft = ref(props.chat.title);
const input = ref<HTMLInputElement | null>(null);
watch(() => props.renaming, (renaming) => {
  if (!renaming) return;
  draft.value = props.chat.title;
  void nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
}, { immediate: true });

function onRenameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    emit('commitRename', draft.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('cancelRename');
  }
}
</script>

<template>
  <div
    v-if="renaming"
    role="none"
    class="flex h-full animate-[d-fade_.15s] items-center gap-1.5 rounded-lg bg-(--d-hover) px-1.5"
    data-testid="chat-rename"
    @keydown.stop
  >
    <Pencil
      aria-hidden="true"
      class="ml-0.5 size-3 shrink-0 text-(--d-faint)"
    />
    <input
      ref="input"
      v-model="draft"
      type="text"
      :maxlength="MAX_CHAT_NAME_LENGTH"
      :aria-label="t('chats.rename')"
      :placeholder="t('chats.renamePlaceholder')"
      class="h-6 min-w-0 flex-1 rounded-md border border-(--d-accent) bg-(--d-input) px-2 text-xs text-(--d-text) outline-none"
      @keydown="onRenameKeydown"
    >
    <Button
      type="button"
      size="icon-sm"
      class="size-5.5 rounded-md hover:bg-primary [&_svg]:size-3"
      :aria-label="t('chats.save')"
      :title="t('chats.save')"
      @click="emit('commitRename', draft)"
    >
      <Check
        aria-hidden="true"
        class="size-3"
      />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3"
      :aria-label="t('chats.cancel')"
      :title="t('chats.cancel')"
      @click="emit('cancelRename')"
    >
      <X
        aria-hidden="true"
        class="size-3"
      />
    </Button>
  </div>
  <div
    v-else
    :id="optionId"
    role="option"
    :aria-selected="selected"
    :data-chat-id="chat.id"
    :data-status="chat.status"
    :data-loaded="chat.loaded"
    :data-worktree="chat.worktree?.status"
    :data-read-only="chat.readOnly || undefined"
    :data-design-of="chat.design?.parentId"
    :data-superseded="superseded || undefined"
    :data-nested="nested ? 'true' : undefined"
    class="group/row relative flex h-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-1.5 transition-colors hover:bg-(--d-hover)"
    :class="[nested ? 'pl-6.5' : 'pl-2', selected ? 'bg-(--d-accent-soft) font-semibold' : '', active ? 'group-focus-visible/list:outline group-focus-visible/list:-outline-offset-1 group-focus-visible/list:outline-(--d-accent)' : '']"
    @click="emit('select')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <!-- The tree line drops from under the parent's icon (its row's pl-2 plus half its w-4) into this row's badge, and runs on to
         the next child when one follows. -->
    <template v-if="nested">
      <span
        v-if="nested === 'continues'"
        aria-hidden="true"
        data-testid="chat-tree-line"
        class="pointer-events-none absolute -top-1 bottom-0 left-4 border-l border-(--d-border2)"
      />
      <span
        aria-hidden="true"
        data-testid="chat-tree-elbow"
        class="pointer-events-none absolute left-4 w-1.5 border-b border-(--d-border2)"
        :class="nested === 'continues' ? 'top-0 h-1/2' : '-top-1 h-[calc(50%+0.25rem)] rounded-bl-5 border-l'"
      />
    </template>
    <span
      class="flex shrink-0 justify-center"
      :class="nested ? '' : 'w-4'"
      :title="chat.status === 'running' ? t('chats.running') : chat.status === 'waiting' ? t('chats.needsYou') : undefined"
    >
      <!-- A design chat keeps its badge whatever its state, so the role stays readable; the dot at the row's end shows the state. -->
      <span
        v-if="chat.design !== undefined"
        class="grid shrink-0 place-items-center rounded-5"
        :class="[DESIGN_TILE, nested ? 'size-4.5' : 'size-4', superseded ? 'opacity-60' : '']"
        data-testid="chat-design-icon"
        :data-running="chat.status === 'running' || undefined"
      >
        <Palette
          aria-hidden="true"
          class="size-3"
        />
      </span>
      <CircleAlert
        v-else-if="chat.status === 'waiting'"
        aria-hidden="true"
        class="size-3.25 animate-[d-pulse_1.4s_infinite] text-(--d-warning)"
      />
      <!-- A running worktree chat keeps its worktree icon and pulses it, so the place stays readable. -->
      <MessageSquareCode
        v-else-if="chat.worktree"
        aria-hidden="true"
        data-testid="chat-worktree-icon"
        :data-running="chat.status === 'running' || undefined"
        class="size-3.25"
        :class="chat.status === 'running' ? 'd-pulsing text-(--d-accent)' : worktreeGone ? 'text-(--d-faint)' : 'text-(--d-accent)'"
      />
      <LoaderCircle
        v-else-if="chat.status === 'running'"
        aria-hidden="true"
        class="size-3.25 d-spinning text-(--d-accent)"
      />
      <MessageSquare
        v-else
        aria-hidden="true"
        class="size-3.25"
        :class="selected ? 'text-(--d-accent)' : 'text-(--d-faint)'"
      />
      <span
        v-if="chat.status !== 'idle'"
        class="sr-only"
      >{{ chat.status === 'running' ? t('chats.running') : t('chats.needsYou') }},</span>
      <span
        v-if="chat.design !== undefined"
        class="sr-only"
      >{{ t('chats.designChat') }},</span>
      <span
        v-if="superseded"
        class="sr-only"
      >{{ t('chats.designReadOnly') }},</span>
      <span
        v-if="designDot === 'finished'"
        class="sr-only"
      >{{ t('chats.designFinished', { version: chat.design?.finishedVersion }) }},</span>
      <span
        v-if="chat.worktree"
        class="sr-only"
      >{{ t('worktree.row.worktreeChat') }},</span>
      <span
        v-if="chat.readOnly"
        class="sr-only"
      >{{ t('worktree.row.readOnly') }},</span>
    </span>
    <!-- A nested row is one line: its title, then its tag; the time and model line is left out. -->
    <span
      class="flex min-w-0 flex-1"
      :class="nested ? 'items-center gap-1.5' : 'flex-col leading-[1.3]'"
    >
      <span
        v-if="superseded"
        class="flex min-w-0 items-center gap-1"
        :class="nested ? 'flex-1' : ''"
      >
        <span
          class="truncate text-(--d-muted)"
          data-testid="chat-title"
        >{{ title }}</span>
        <!-- The accessible name says Read-only in the badge column; the lock is its mark for the eye, with the reason on hover. -->
        <span
          aria-hidden="true"
          data-testid="chat-design-read-only"
          class="flex shrink-0 text-(--d-faint-text)"
          :title="t('chats.designReadOnlyHint')"
        >
          <Lock class="size-3" />
        </span>
      </span>
      <span
        v-else
        class="truncate"
        :class="nested ? 'min-w-0 flex-1' : ''"
        data-testid="chat-title"
      >{{ title }}</span>
      <span
        v-if="!nested || chat.tag"
        class="flex min-w-0 items-center gap-1.25 overflow-hidden text-11 font-normal whitespace-nowrap"
        :class="selected ? 'text-(--d-faint-text)' : 'text-(--d-faint) group-hover/row:text-(--d-faint-text)'"
      >
        <!-- No appear: a virtual row scrolled back into view stays still; a row that gains its branch or loses its worktree swaps. -->
        <Transition
          v-if="!nested"
          name="t-swap-box"
          mode="out-in"
        >
          <span
            v-if="worktreeLine"
            :key="worktreeLine.text"
            data-testid="chat-worktree-line"
            class="min-w-0 truncate"
            :class="worktreeLine.mono ? 'font-mono text-10.5' : ''"
            :dir="worktreeLine.mono ? 'ltr' : undefined"
            :title="worktreeLine.title"
          >{{ worktreeLine.text }}</span>
          <span
            v-else
            class="flex min-w-0 items-center gap-1.25 overflow-hidden"
          >
            <span class="shrink-0">{{ when }}</span>
            <template v-if="model">
              <span
                aria-hidden="true"
                class="shrink-0"
              >·</span>
              <ProviderLogo
                v-if="chat.model"
                :provider="chat.model.provider"
                class="size-2.75"
              />
              <span class="min-w-6 shrink truncate">{{ model }}</span>
            </template>
          </span>
        </Transition>
        <Badge
          v-if="chat.tag"
          as="span"
          variant="tone"
          data-testid="chat-tag"
          class="flex min-w-11 shrink gap-0.75 overflow-hidden border-(--d-border2) px-1.5 py-0 text-10/3.75 font-normal text-(--d-muted) transition-none hover:border-(--d-accent) hover:text-(--d-accent-text)"
          :class="nested ? 'max-w-20' : 'ml-0.5 max-w-27.5'"
          :title="t('chats.showTagged', { tag: chat.tag })"
          @click.stop="emit('filterTag', chat.tag ?? '')"
        >
          <Tag
            aria-hidden="true"
            class="size-2.25 shrink-0"
          />
          <span class="min-w-0 truncate">{{ chat.tag }}</span>
        </Badge>
      </span>
    </span>
    <span
      v-if="designDot"
      aria-hidden="true"
      data-testid="chat-design-dot"
      :data-state="designDot"
      class="me-1 size-1.5 shrink-0 rounded-full transition-colors duration-300 ease-out"
      :class="[DESIGN_DOT[designDot], offersActions ? 'group-hover/row:hidden' : '']"
    />
    <!-- Mouse shortcuts; keyboard users reach the same actions through the context menu, F2 and Delete. -->
    <span
      aria-hidden="true"
      class="hidden shrink-0 animate-[d-fade_.12s] items-center gap-px group-hover/row:flex"
    >
      <Button
        v-if="chatOffers(chat, 'rename')"
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        data-testid="chat-action-rename"
        :class="ROW_ACTION"
        :title="t('chats.rename')"
        @click.stop="emit('rename')"
      >
        <Pencil class="size-3" />
      </Button>
      <Button
        v-if="chatOffers(chat, 'tag')"
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        data-testid="chat-action-tag"
        :class="ROW_ACTION"
        :title="chat.tag ? t('chats.changeTag') : t('chats.tag')"
        @click.stop="emit('tag')"
      >
        <Tag class="size-3" />
      </Button>
      <Button
        v-if="chatOffers(chat, 'delete')"
        type="button"
        variant="ghost"
        size="icon-sm"
        tabindex="-1"
        data-testid="chat-action-delete"
        class="size-5.5 rounded-md text-(--d-danger) opacity-80 hover:bg-(--d-danger)/15 hover:text-(--d-danger) hover:opacity-100 [&_svg]:size-3"
        :title="t('chats.delete')"
        @click.stop="emit('delete')"
      >
        <Trash2 class="size-3" />
      </Button>
    </span>
    <!-- In its own slot past the hover actions, so it never moves; it reveals by opacity and scale only. A mouse shortcut like
         those: keyboard users have the row menu's Worktree submenu. -->
    <Button
      v-if="opensHere"
      type="button"
      variant="ghost"
      size="icon-sm"
      tabindex="-1"
      aria-hidden="true"
      data-testid="chat-action-new-in-worktree"
      class="size-5.5 shrink-0 scale-90 rounded-md text-(--d-muted) opacity-0 transition-[opacity,transform,background-color,color] duration-150 ease-out group-hover/row:scale-100 group-hover/row:opacity-100 hover:bg-(--d-accent-soft) hover:text-(--d-accent-text) [&_svg]:size-3"
      :class="active ? 'group-focus-visible/list:scale-100 group-focus-visible/list:opacity-100' : ''"
      :title="t('worktree.newChatHere')"
      @click.stop="emit('newHere')"
    >
      <Plus
        aria-hidden="true"
        class="size-3"
      />
    </Button>
  </div>
</template>
