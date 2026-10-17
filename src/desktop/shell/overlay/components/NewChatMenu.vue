<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, ChevronsUpDown, Cloud, CornerDownLeft, FolderTree, GitBranch, Info, MessageSquarePlus, Target } from 'lucide-vue-next';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { MAX_CONTINUE_WORKTREES, type ChatsContinueWorktree, type ChatsWorktreeBranch, type ChatsWorktreeOptions } from '../../../preload/shell-channels';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { remPx } from '@/composables/useRemPx';
import { branchLeaf } from '@/utils/branch-leaf';
import { visibleText } from '@shared/visible-text';
import { answerOf } from '../popup-answer';
import { placePopup } from '../placement';
import { pickerPlacement, typeAheadMatch, type PickerPlacement } from './new-chat-menu';

/**
 * The Chats section's New split button menu (D30, D63): New chat, the "Run in a new worktree" toggle, which starts off on
 * every open, and with it on the Start from picker, Bring my uncommitted changes and New chat in a worktree; under them the
 * project's live chat worktrees to continue in. The options come from main after the menu shows, so it opens at once.
 */
const props = defineProps<{ api: DamoclesOverlayApi; request: Extract<OverlayRequest, { kind: 'newChatMenu' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

// The prototype's menu: 340px wide, its left edge 250px left of the split button's right edge.
const WIDTH_REM = 21.25;
const RIGHT_OVERHANG_REM = 15.625;
const GAP_REM = 0.375;

type Loaded = Extract<ChatsWorktreeOptions, { available: true }>;
const options = ref<ChatsWorktreeOptions | 'loading' | 'failed'>('loading');
const loaded = computed((): Loaded | undefined => (typeof options.value === 'object' && options.value.available ? options.value : undefined));
const reason = computed((): string | undefined => {
  const value = options.value;
  if (value === 'loading' || value === 'failed' || value.available) return undefined;
  return t(`worktree.newMenu.${value.reason}`);
});
const toggleSub = computed(() => {
  if (options.value === 'loading') return t('worktree.newMenu.loading');
  if (options.value === 'failed') return t('worktree.newMenu.loadFailed');
  return reason.value ?? t('worktree.newMenu.toggleSub');
});
const canToggle = computed(() => loaded.value !== undefined);

const worktreeOn = ref(false);
const currentBranch = computed(() => loaded.value?.branches.find((branch) => branch.current && !branch.remote));
const startRef = ref<string | undefined>();
const start = computed((): ChatsWorktreeBranch | undefined => {
  const branches = loaded.value?.branches ?? [];
  return branches.find((branch) => branch.ref === startRef.value) ?? currentBranch.value ?? branches[0];
});
// The trigger cuts a long name, so its tooltip carries the whole name above what the trigger does.
const startTitle = computed(() => (start.value ? `${nameOf(start.value)}\n${t('worktree.newMenu.pickerTitle')}` : undefined));
const startsAtCurrent = computed(() => start.value !== undefined && start.value.ref === currentBranch.value?.ref);
const uncommitted = computed(() => loaded.value?.uncommittedCount ?? 0);
// D63: offered only from the current branch with changes to bring, and on by default.
const offersChanges = computed(() => startsAtCurrent.value && uncommitted.value > 0);
const bringChanges = ref(true);

const noteOf = (branch: ChatsWorktreeBranch): string => {
  if (branch.current && !branch.remote) return t('worktree.newMenu.current');
  return branch.newer ? t('worktree.newMenu.newer', { n: branch.newer }) : '';
};
const iconOf = (branch: ChatsWorktreeBranch) => (branch.remote ? Cloud : branch.current ? Target : GitBranch);
// The name as shown; the raw ref stays the value a choice answers with.
const nameOf = (branch: ChatsWorktreeBranch): string => visibleText(branch.name);

// The live chat worktrees, most recently used first as main orders them; past the cap, "All worktrees…" lists every one.
// They come on their own call, since their change counts take longer than the branches the toggle waits for.
const worktrees = ref<readonly ChatsContinueWorktree[]>([]);
const recentWorktrees = computed(() => worktrees.value.slice(0, MAX_CONTINUE_WORKTREES));
const hasMoreWorktrees = computed(() => worktrees.value.length > MAX_CONTINUE_WORKTREES);
const chatsText = (worktree: ChatsContinueWorktree): string => t('worktree.newMenu.chats', { n: worktree.chatCount }, worktree.chatCount);
const behindText = (worktree: ChatsContinueWorktree): string | undefined =>
  worktree.behind > 0 && worktree.baseBranch !== undefined ? t('worktree.newMenu.behind', { n: worktree.behind, branch: visibleText(worktree.baseBranch) }) : undefined;
// The full branch and every figure, since the row shows only the leaf and the figures as glyphs.
const worktreeLabel = (worktree: ChatsContinueWorktree): string => [
  visibleText(worktree.branch),
  chatsText(worktree),
  t('worktree.newMenu.changes', { added: worktree.added, removed: worktree.removed }),
  behindText(worktree),
].filter((part) => part !== undefined).join(', ');

const root = ref<HTMLElement | null>(null);
const position = ref({ left: props.request.anchor.x, top: props.request.anchor.y + props.request.anchor.height });
// Flipped above its button where it would not fit below, it grows from its bottom edge instead.
const above = ref(false);
const maxHeight = ref<number | undefined>();

onMounted(async () => {
  const element = root.value;
  if (element) {
    const anchor = props.request.anchor;
    const left = anchor.x + anchor.width - remPx(RIGHT_OVERHANG_REM);
    const placed = placePopup({ ...anchor, x: Math.max(0, left), height: anchor.height + remPx(GAP_REM) }, { width: remPx(WIDTH_REM), height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    position.value = placed;
    above.value = placed.top < anchor.y;
    maxHeight.value = window.innerHeight - placed.top - remPx(0.5);
  }
  void nextTick(() => focusRow(0));
  void loadContinueWorktrees();
  let value: ChatsWorktreeOptions | undefined;
  try {
    value = await answerOf(props.api.worktreeOptions());
  } catch (error) {
    console.error('[newChatMenu] worktree options failed', error);
    options.value = 'failed';
    return;
  }
  // undefined: main closed the menu while the options were read
  if (value) options.value = value;
});

async function loadContinueWorktrees(): Promise<void> {
  try {
    // undefined: main closed the menu while they were read
    const value = await answerOf(props.api.continueWorktrees());
    if (value) worktrees.value = value;
  } catch (error) {
    // the group is an offer, not the menu's purpose: without it the menu still starts any chat
    console.error('[newChatMenu] continue worktrees failed', error);
  }
}

function plain(): void {
  emit('answer', { kind: 'newChatMenu', choice: 'plain' });
}

function create(): void {
  const branch = start.value;
  if (!worktreeOn.value || !branch) return;
  emit('answer', { kind: 'newChatMenu', choice: 'worktree', startRef: branch.ref, bringChanges: offersChanges.value && bringChanges.value });
}

function continueIn(worktree: ChatsContinueWorktree): void {
  emit('answer', { kind: 'newChatMenu', choice: 'continueInWorktree', worktreeId: worktree.worktreeId });
}

function toggleWorktree(): void {
  if (!canToggle.value) return;
  worktreeOn.value = !worktreeOn.value;
  picker.value = null;
}

function toggleBring(): void {
  bringChanges.value = !bringChanges.value;
}

// Rows of the menu in order; the arrow keys and type-ahead move between them as in any menu.
const rowElements = (): HTMLElement[] => [...(root.value?.querySelectorAll<HTMLElement>('[data-nm-row]') ?? [])];
function focusRow(index: number): void {
  const rows = rowElements();
  if (rows.length > 0) rows[(index + rows.length) % rows.length]?.focus();
}

// Type-ahead keystrokes further apart than this start a new search.
const TYPE_AHEAD_RESET_MS = 500;
let typed = { text: '', at: Number.NEGATIVE_INFINITY };

/**
 * With the toggle on, Enter creates the worktree chat from any row that has no action of its own; the plain New chat row,
 * the Start from trigger and the worktree rows keep theirs. Space always activates the focused row.
 */
function onRowKeydown(event: KeyboardEvent, activate: () => void, enter: 'create' | 'own' = 'create'): void {
  const rows = rowElements();
  const index = rows.indexOf(event.currentTarget as HTMLElement);
  if (event.key === 'ArrowDown') focusRow(index + 1);
  else if (event.key === 'ArrowUp') focusRow(index - 1);
  else if (event.key === 'Home') focusRow(0);
  else if (event.key === 'End') focusRow(-1);
  else if (event.key === 'Enter') (worktreeOn.value && enter === 'create' ? create : activate)();
  else if (event.key === ' ') activate();
  else if (event.key === 'Tab') emit('answer', { kind: 'dismissed' });
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    typed = event.timeStamp - typed.at > TYPE_AHEAD_RESET_MS ? { text: event.key, at: event.timeStamp } : { text: typed.text + event.key, at: event.timeStamp };
    const match = typeAheadMatch(rows.map((row) => row.dataset['nmLabel'] ?? row.textContent ?? ''), index, typed.text);
    if (match >= 0) focusRow(match);
  } else return;
  event.preventDefault();
}

// The pickers: Start from's branches and All worktrees…, each a filter over a list, placed from its trigger's rect.
const picker = ref<{ readonly kind: 'branch' | 'worktree'; readonly placement: PickerPlacement } | null>(null);
const trigger = ref<HTMLElement | null>(null);
const allTrigger = ref<HTMLElement | null>(null);
const branches = computed(() => {
  const all = loaded.value?.branches ?? [];
  // the current local branch first, then the others in main's order
  const local = all.filter((branch) => !branch.remote);
  return { local: [...local.filter((branch) => branch.current), ...local.filter((branch) => !branch.current)], remote: all.filter((branch) => branch.remote) };
});

function openPicker(kind: 'branch' | 'worktree'): void {
  if (picker.value?.kind === kind) {
    closePicker();
    return;
  }
  const anchor = (kind === 'branch' ? trigger.value : allTrigger.value)?.getBoundingClientRect();
  const box = root.value?.getBoundingClientRect();
  if (!anchor || !box) return;
  picker.value = { kind, placement: pickerPlacement(anchor, box, window.innerHeight, remPx) };
}

function closePicker(): void {
  const kind = picker.value?.kind;
  picker.value = null;
  void nextTick(() => (kind === 'worktree' ? allTrigger.value : trigger.value)?.focus());
}

function pick(branch: ChatsWorktreeBranch): void {
  startRef.value = branch.ref;
  closePicker();
}

function onFilterKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closePicker();
  else if (event.key === 'Tab') emit('answer', { kind: 'dismissed' });
  else return;
  event.preventDefault();
  event.stopPropagation();
}

const rowClass = 'flex cursor-pointer items-center gap-2.25 rounded-7 px-2.25 outline-none hover:bg-(--d-hover) focus:bg-(--d-hover)';
const optionClass = 'h-7 cursor-pointer gap-2.25 rounded-7 px-2.25 font-mono text-11.5 text-(--d-text) data-highlighted:bg-(--d-hover) data-highlighted:text-(--d-text) data-[state=checked]:bg-(--d-accent-soft) [&_svg]:size-3.25';
// The group heading is ListboxGroupLabel, the group's first child.
const continueId = useId();
const noteId = useId();
const pickerListId = useId();
const pickerGroupClass = 'p-0 [&>:first-child]:px-2.25 [&>:first-child]:pt-1.25 [&>:first-child]:pb-0.75 [&>:first-child]:text-10.5 [&>:first-child]:font-normal [&>:first-child]:tracking-[.06em] [&>:first-child]:text-(--d-faint-text) [&>:first-child]:uppercase';
</script>

<template>
  <!-- Custom menu markup: main opens this popup in the overlay, and its toggle row and embedded pickers fit no menu part. -->
  <div
    ref="root"
    data-testid="new-chat-menu"
    :data-placement="above ? 'above' : 'below'"
    class="new-chat-menu fixed flex flex-col rounded-11 border border-(--d-border2) bg-(--d-card) text-12.5 text-(--d-text) shadow-(--d-shadow)"
    :style="{ left: `${position.left}px`, top: `${position.top}px`, width: `${WIDTH_REM}rem` }"
  >
    <!-- The list scrolls, not the menu, so a picker can open past the list's edge. -->
    <div
      role="menu"
      :aria-label="t('worktree.newMenu.label')"
      data-testid="new-chat-menu-list"
      class="flex min-h-0 flex-col overflow-y-auto p-1.5"
      :style="{ maxHeight: maxHeight === undefined ? undefined : `${maxHeight}px` }"
    >
      <div
        data-nm-row
        :data-nm-label="t('worktree.newMenu.newChat')"
        role="menuitem"
        tabindex="-1"
        data-testid="new-chat-menu-plain"
        :class="[rowClass, 'h-7 shrink-0']"
        @click="plain"
        @keydown="onRowKeydown($event, plain, 'own')"
      >
        <MessageSquarePlus
          aria-hidden="true"
          class="size-3.5 shrink-0"
        />
        <span class="flex-1">{{ t('worktree.newMenu.newChat') }}</span>
        <span class="font-mono text-10.5 text-(--d-faint)">{{ request.shortcut }}</span>
      </div>
      <div
        role="separator"
        class="mx-1.5 my-1 h-px shrink-0 bg-(--d-border)"
      />
      <div
        data-nm-row
        :data-nm-label="t('worktree.newMenu.toggle')"
        role="menuitemcheckbox"
        tabindex="-1"
        :aria-checked="worktreeOn"
        :aria-disabled="!canToggle || undefined"
        :aria-busy="options === 'loading' || undefined"
        :title="reason"
        data-testid="new-chat-menu-worktree"
        class="flex shrink-0 items-center gap-2.5 rounded-7 px-2.25 py-1.5 outline-none"
        :class="canToggle ? 'cursor-pointer hover:bg-(--d-hover) focus:bg-(--d-hover)' : 'cursor-default focus:bg-(--d-hover)'"
        @click="toggleWorktree"
        @keydown="onRowKeydown($event, toggleWorktree)"
      >
        <FolderTree
          aria-hidden="true"
          class="size-3.5 shrink-0 text-(--d-muted)"
          :class="canToggle ? '' : 'opacity-55'"
        />
        <span class="flex min-w-0 flex-1 flex-col">
          <span :class="canToggle ? '' : 'opacity-55'">{{ t('worktree.newMenu.toggle') }}</span>
          <Transition
            name="t-swap"
            mode="out-in"
          >
            <span
              :key="toggleSub"
              data-testid="new-chat-menu-worktree-sub"
              class="text-11"
              :class="options === 'failed' ? 'text-(--d-danger-text)' : 'text-(--d-faint-text)'"
            >{{ toggleSub }}</span>
          </Transition>
        </span>
        <!-- The row is the control; the switch only draws its state. -->
        <ToggleSwitch
          :checked="worktreeOn"
          :disabled="!canToggle"
          tabindex="-1"
          aria-hidden="true"
          class="pointer-events-none"
        />
      </div>
      <Transition name="t-tuck">
        <div
          v-if="worktreeOn && loaded && start"
          data-testid="new-chat-menu-options"
          role="group"
          :aria-label="t('worktree.newMenu.toggle')"
          class="mx-1.5 mt-0.5 mb-1 flex shrink-0 flex-col gap-2.5 rounded-9 bg-(--d-panel) p-2.5"
        >
          <!-- The options unfold one after another, the Create row last. -->
          <div
            class="d-row-reveal"
            style="--reveal-index: 0"
          >
            <div
              aria-hidden="true"
              class="mb-1 text-11 text-(--d-faint-text)"
            >
              {{ t('worktree.newMenu.startFrom') }}
            </div>
            <div
              ref="trigger"
              data-nm-row
              :data-nm-label="t('worktree.newMenu.startFrom')"
              role="menuitem"
              tabindex="-1"
              aria-haspopup="listbox"
              :aria-expanded="picker?.kind === 'branch'"
              :aria-controls="picker?.kind === 'branch' ? pickerListId : undefined"
              :title="startTitle"
              :aria-label="`${t('worktree.newMenu.startFrom')}: ${nameOf(start)}`"
              data-testid="new-chat-menu-start"
              class="flex h-7 cursor-pointer items-center gap-1.5 rounded-7 border border-(--d-border2) bg-(--d-card) px-2.25 font-mono text-11.5 outline-none transition-colors hover:border-(--d-accent) focus:border-(--d-accent)"
              @click="openPicker('branch')"
              @keydown="onRowKeydown($event, () => openPicker('branch'), 'own')"
            >
              <component
                :is="iconOf(start)"
                aria-hidden="true"
                class="size-3.25 shrink-0"
                :class="startsAtCurrent ? 'text-(--d-accent)' : 'text-(--d-muted)'"
              />
              <span
                class="min-w-0 flex-1 truncate"
                dir="ltr"
              >{{ nameOf(start) }}</span>
              <span class="font-sans text-10.5 text-(--d-faint-text)">{{ noteOf(start) }}</span>
              <ChevronsUpDown
                aria-hidden="true"
                class="size-3 shrink-0 text-(--d-faint)"
              />
            </div>
          </div>
          <Transition name="t-tuck">
            <div
              v-if="offersChanges"
              data-nm-row
              :data-nm-label="t('worktree.newMenu.bring')"
              role="menuitemcheckbox"
              tabindex="-1"
              :aria-checked="bringChanges"
              data-testid="new-chat-menu-bring"
              class="-mx-1 flex cursor-pointer rounded-7 px-1 py-0.5 outline-none focus:bg-(--d-hover)"
              @click="toggleBring"
              @keydown="onRowKeydown($event, toggleBring)"
            >
              <!-- The transition root takes t-tuck alone, so its exit plays; the stagger rides on its content. -->
              <span
                class="d-row-reveal flex min-w-0 items-start gap-2"
                style="--reveal-index: 1"
              >
                <Checkbox
                  :checked="bringChanges"
                  tabindex="-1"
                  aria-hidden="true"
                  class="pointer-events-none mt-0.5 size-3.75 rounded-xs border-(--d-border2) data-[state=checked]:border-(--d-accent) data-[state=checked]:bg-(--d-accent) data-[state=checked]:text-(--d-on-accent) [&_svg]:size-2.75"
                />
                <span class="flex min-w-0 flex-col">
                  <span>{{ t('worktree.newMenu.bring') }}</span>
                  <span class="text-11 text-pretty text-(--d-faint-text)">{{ t('worktree.newMenu.bringDetail', { n: uncommitted, project: loaded.projectName }, uncommitted) }}</span>
                </span>
              </span>
            </div>
          </Transition>
          <!-- Menu-mode screen readers skip text that is no menu item, so the Create row names this note as its description. -->
          <p
            :id="noteId"
            class="d-row-reveal flex gap-1.5 text-11 text-pretty text-(--d-faint-text)"
            style="--reveal-index: 2"
            data-testid="new-chat-menu-note"
          >
            <Info
              aria-hidden="true"
              class="mt-0.5 size-3 shrink-0"
            />
            <i18n-t
              keypath="worktree.newMenu.createsBranch"
              tag="span"
              scope="global"
            >
              <template #prefix>
                <span
                  class="font-mono"
                  dir="ltr"
                >{{ loaded.branchPrefix }}...</span>
              </template>
              <template #branch>
                <span
                  class="font-mono"
                  dir="ltr"
                >{{ nameOf(start) }}</span>
              </template>
              <template #file>
                <span
                  class="font-mono"
                  dir="ltr"
                >.damocles/worktree.json</span>
              </template>
            </i18n-t>
          </p>
        </div>
      </Transition>
      <Transition name="t-tuck">
        <div
          v-if="worktreeOn && loaded && start"
          data-nm-row
          :data-nm-label="t('worktree.newMenu.newInWorktree')"
          role="menuitem"
          tabindex="-1"
          :aria-describedby="noteId"
          data-testid="new-chat-menu-create"
          :class="[rowClass, 'h-7 shrink-0 font-medium text-(--d-accent-text)']"
          @click="create"
          @keydown="onRowKeydown($event, create)"
        >
          <span
            class="d-row-reveal flex flex-1 items-center gap-2.25"
            style="--reveal-index: 3"
          >
            <CornerDownLeft
              aria-hidden="true"
              class="size-3.5 shrink-0"
            />
            <span class="flex-1">{{ t('worktree.newMenu.newInWorktree') }}</span>
            <!-- The key's own name, as Ctrl+N beside New chat is, so no locale renames or decorates it. -->
            <kbd
              aria-hidden="true"
              class="font-mono text-10.5 font-normal text-(--d-faint)"
            >Enter</kbd>
          </span>
        </div>
      </Transition>
      <!-- The project's live chat worktrees; a row starts a chat in its worktree at once. -->
      <template v-if="recentWorktrees.length > 0">
        <div
          role="separator"
          class="mx-1.5 my-1 h-px shrink-0 bg-(--d-border)"
        />
        <div
          role="group"
          :aria-labelledby="continueId"
          data-testid="new-chat-menu-continue"
          class="flex shrink-0 flex-col"
        >
          <div
            :id="continueId"
            role="presentation"
            class="px-2.25 py-1 text-10.5 font-semibold tracking-[.07em] text-(--d-faint-text) uppercase"
          >
            {{ t('worktree.newMenu.continue') }}
          </div>
          <div
            v-for="(worktree, index) in recentWorktrees"
            :key="worktree.worktreeId"
            data-nm-row
            :data-nm-label="visibleText(branchLeaf(worktree.branch))"
            role="menuitem"
            tabindex="-1"
            :title="visibleText(worktree.branch)"
            :aria-label="worktreeLabel(worktree)"
            :data-worktree-id="worktree.worktreeId"
            :data-branch="worktree.branch"
            data-testid="new-chat-menu-continue-row"
            :class="[rowClass, 'group/wt d-row-reveal py-1.25']"
            :style="{ '--reveal-index': index }"
            @click="continueIn(worktree)"
            @keydown="onRowKeydown($event, () => continueIn(worktree), 'own')"
          >
            <FolderTree
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-accent-text)"
            />
            <span
              aria-hidden="true"
              class="flex min-w-0 flex-1 flex-col"
            >
              <span
                class="truncate font-mono text-12 text-(--d-accent-text)"
                dir="ltr"
              >{{ visibleText(branchLeaf(worktree.branch)) }}</span>
              <span class="flex min-w-0 items-center gap-1.5 text-11 whitespace-nowrap text-(--d-faint-text)">
                <span>{{ chatsText(worktree) }}</span>
                <span>·</span>
                <span
                  class="flex gap-1.5 font-mono text-10.5"
                  dir="ltr"
                >
                  <span class="text-(--d-success-text)">+{{ worktree.added }}</span>
                  <span class="text-(--d-danger-text)">−{{ worktree.removed }}</span>
                  <span
                    v-if="behindText(worktree)"
                    class="truncate text-(--d-warning-text)"
                  >{{ worktree.behind }}↓ {{ visibleText(worktree.baseBranch ?? '') }}</span>
                </span>
              </span>
            </span>
            <!-- The enter glyph slides in on hover and focus; it never takes or gives space. -->
            <CornerDownLeft
              aria-hidden="true"
              class="size-3.25 shrink-0 -translate-x-1 text-(--d-accent-text) opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover/wt:translate-x-0 group-hover/wt:opacity-100 group-focus/wt:translate-x-0 group-focus/wt:opacity-100"
            />
          </div>
          <div
            v-if="hasMoreWorktrees"
            ref="allTrigger"
            data-nm-row
            :data-nm-label="t('worktree.newMenu.allWorktrees')"
            role="menuitem"
            tabindex="-1"
            aria-haspopup="listbox"
            :aria-expanded="picker?.kind === 'worktree'"
            :aria-controls="picker?.kind === 'worktree' ? pickerListId : undefined"
            data-testid="new-chat-menu-all-worktrees"
            :class="[rowClass, 'd-row-reveal h-7 text-(--d-muted)']"
            :style="{ '--reveal-index': recentWorktrees.length }"
            @click="openPicker('worktree')"
            @keydown="onRowKeydown($event, () => openPicker('worktree'), 'own')"
          >
            <span class="w-3.5 shrink-0" />
            <span class="flex-1">{{ t('worktree.newMenu.allWorktrees') }}</span>
            <span class="font-mono text-10.5 text-(--d-faint)">{{ worktrees.length }}</span>
            <ChevronRight
              aria-hidden="true"
              class="size-3 shrink-0 text-(--d-faint)"
            />
          </div>
        </div>
      </template>
    </div>
    <!-- A searchable list placed from its trigger, flipped above it where it would not fit below. -->
    <Transition :name="picker?.placement.above ? 't-pop-top' : 't-pop'">
      <div
        v-if="picker && loaded"
        class="absolute inset-x-4 z-10 overflow-hidden rounded-11 border border-(--d-border2) bg-(--d-card) shadow-(--d-shadow)"
        :style="picker.placement.above ? { bottom: `${picker.placement.offset}px` } : { top: `${picker.placement.offset}px` }"
        :data-placement="picker.placement.above ? 'above' : 'below'"
        :data-testid="picker.kind === 'branch' ? 'new-chat-menu-picker' : 'new-chat-menu-worktree-picker'"
      >
        <Command
          v-if="picker.kind === 'branch'"
          :model-value="start?.ref ?? ''"
          highlight-on-hover
          class="rounded-none bg-transparent text-(--d-text)"
        >
          <CommandInput
            data-testid="new-chat-menu-picker-filter"
            spellcheck="false"
            :aria-label="t('worktree.newMenu.pickerPlaceholder')"
            :placeholder="t('worktree.newMenu.pickerPlaceholder')"
            class="h-8 text-xs text-(--d-text) placeholder:text-(--d-faint)"
            @keydown="onFilterKeydown"
          />
          <CommandList
            :id="pickerListId"
            :aria-label="t('worktree.newMenu.startFrom')"
            class="overflow-y-auto p-1.25"
            :style="{ maxHeight: `${picker.placement.listHeight}px` }"
          >
            <CommandEmpty class="px-2.25 py-2 text-left text-xs text-(--d-faint-text)">
              {{ t('worktree.newMenu.noMatch') }}
            </CommandEmpty>
            <CommandGroup
              v-if="branches.local.length > 0"
              :heading="t('worktree.newMenu.branches')"
              :class="pickerGroupClass"
            >
              <CommandItem
                v-for="branch in branches.local"
                :key="branch.ref"
                :value="branch.ref"
                :data-ref="branch.ref"
                data-testid="new-chat-menu-branch"
                :class="optionClass"
                @select="pick(branch)"
              >
                <component
                  :is="iconOf(branch)"
                  aria-hidden="true"
                  :class="branch.current ? 'text-(--d-accent)' : 'text-(--d-muted)'"
                />
                <span
                  class="min-w-0 flex-1 truncate"
                  dir="ltr"
                  :title="nameOf(branch)"
                >{{ nameOf(branch) }}</span>
                <span class="font-sans text-10.5 text-(--d-faint-text)">{{ noteOf(branch) }}</span>
              </CommandItem>
            </CommandGroup>
            <CommandGroup
              v-if="branches.remote.length > 0"
              :heading="t('worktree.newMenu.remoteBranches')"
              :class="pickerGroupClass"
            >
              <CommandItem
                v-for="branch in branches.remote"
                :key="branch.ref"
                :value="branch.ref"
                :data-ref="branch.ref"
                data-testid="new-chat-menu-branch"
                :class="optionClass"
                @select="pick(branch)"
              >
                <component
                  :is="iconOf(branch)"
                  aria-hidden="true"
                  class="text-(--d-muted)"
                />
                <span
                  class="min-w-0 flex-1 truncate"
                  dir="ltr"
                  :title="nameOf(branch)"
                >{{ nameOf(branch) }}</span>
                <span class="font-sans text-10.5 text-(--d-faint-text)">{{ noteOf(branch) }}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
        <Command
          v-else
          highlight-on-hover
          class="rounded-none bg-transparent text-(--d-text)"
        >
          <CommandInput
            data-testid="new-chat-menu-worktree-filter"
            spellcheck="false"
            :aria-label="t('worktree.newMenu.worktreePlaceholder')"
            :placeholder="t('worktree.newMenu.worktreePlaceholder')"
            class="h-8 text-xs text-(--d-text) placeholder:text-(--d-faint)"
            @keydown="onFilterKeydown"
          />
          <CommandList
            :id="pickerListId"
            :aria-label="t('worktree.newMenu.continue')"
            class="overflow-y-auto p-1.25"
            :style="{ maxHeight: `${picker.placement.listHeight}px` }"
          >
            <CommandEmpty class="px-2.25 py-2 text-left text-xs text-(--d-faint-text)">
              {{ t('worktree.newMenu.noWorktreeMatch') }}
            </CommandEmpty>
            <CommandGroup class="p-0">
              <CommandItem
                v-for="worktree in worktrees"
                :key="worktree.worktreeId"
                :value="worktree.worktreeId"
                :title="visibleText(worktree.branch)"
                :aria-label="worktreeLabel(worktree)"
                :data-worktree-id="worktree.worktreeId"
                data-testid="new-chat-menu-worktree-option"
                :class="[optionClass, 'h-auto py-1.25']"
                @select="continueIn(worktree)"
              >
                <FolderTree
                  aria-hidden="true"
                  class="text-(--d-accent-text)"
                />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span
                    class="truncate text-(--d-accent-text)"
                    dir="ltr"
                  >{{ visibleText(worktree.branch) }}</span>
                  <span class="flex gap-1.5 font-sans text-10.5 text-(--d-faint-text)">
                    <span>{{ chatsText(worktree) }}</span>
                    <span
                      class="font-mono text-(--d-success-text)"
                      dir="ltr"
                    >+{{ worktree.added }}</span>
                    <span
                      class="font-mono text-(--d-danger-text)"
                      dir="ltr"
                    >−{{ worktree.removed }}</span>
                    <span
                      v-if="behindText(worktree)"
                      class="truncate font-mono text-(--d-warning-text)"
                      dir="ltr"
                    >{{ worktree.behind }}↓ {{ visibleText(worktree.baseBranch ?? '') }}</span>
                  </span>
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </Transition>
  </div>
</template>
