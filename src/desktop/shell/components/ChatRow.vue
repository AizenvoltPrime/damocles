<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleAlert, LoaderCircle, MessageSquare, Pencil, Tag, Trash2, X } from 'lucide-vue-next';
import { providerLogoSvg } from '@/components/icons/provider-logos';
import { formatClock } from '@/utils/clock';
import { MAX_CHAT_NAME_LENGTH, type ShellChat } from '../../preload/shell-channels';
import { chatGroupOf, hasSavedConversation, modelLabel } from '../chat-list';

const props = defineProps<{
  chat: ShellChat;
  optionId: string;
  selected: boolean;
  // the listbox's keyboard position
  active: boolean;
  renaming: boolean;
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
}>();
const { t, locale } = useI18n();

const title = computed(() => props.chat.title || t('chats.newChat'));
const saved = computed(() => hasSavedConversation(props.chat));
const logo = computed(() => (props.chat.model ? providerLogoSvg(props.chat.model.provider) : undefined));
const model = computed(() => (props.chat.model ? modelLabel(props.chat.model) : undefined));
const when = computed(() => {
  const date = new Date(props.chat.timestamp);
  const recent = chatGroupOf(props.chat.timestamp, new Date()) !== 'earlier';
  return recent ? formatClock(date, locale.value) : new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric' }).format(date);
});

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
    <button
      type="button"
      class="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-(--d-accent) text-(--d-on-accent)"
      :aria-label="t('chats.save')"
      :title="t('chats.save')"
      @click="emit('commitRename', draft)"
    >
      <Check
        aria-hidden="true"
        class="size-3"
      />
    </button>
    <button
      type="button"
      class="flex size-[22px] shrink-0 items-center justify-center rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text)"
      :aria-label="t('chats.cancel')"
      :title="t('chats.cancel')"
      @click="emit('cancelRename')"
    >
      <X
        aria-hidden="true"
        class="size-3"
      />
    </button>
  </div>
  <div
    v-else
    :id="optionId"
    role="option"
    :aria-selected="selected"
    :data-chat-id="chat.id"
    :data-status="chat.status"
    :data-loaded="chat.loaded"
    class="group/row flex h-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-1.5 pl-2 transition-colors hover:bg-(--d-hover)"
    :class="[selected ? 'bg-(--d-accent-soft) font-semibold' : '', active ? 'group-focus-visible/list:outline group-focus-visible/list:-outline-offset-1 group-focus-visible/list:outline-(--d-accent)' : '']"
    @click="emit('select')"
    @contextmenu.prevent="emit('menu', $event)"
  >
    <span
      class="flex w-4 shrink-0 justify-center"
      :title="chat.status === 'running' ? t('chats.running') : chat.status === 'waiting' ? t('chats.needsYou') : undefined"
    >
      <LoaderCircle
        v-if="chat.status === 'running'"
        aria-hidden="true"
        class="size-[13px] d-spinning text-(--d-accent)"
      />
      <CircleAlert
        v-else-if="chat.status === 'waiting'"
        aria-hidden="true"
        class="size-[13px] animate-[d-pulse_1.4s_infinite] text-(--d-warning)"
      />
      <MessageSquare
        v-else
        aria-hidden="true"
        class="size-[13px]"
        :class="selected ? 'text-(--d-accent)' : 'text-(--d-faint)'"
      />
      <span
        v-if="chat.status !== 'idle'"
        class="sr-only"
      >{{ chat.status === 'running' ? t('chats.running') : t('chats.needsYou') }},</span>
    </span>
    <span class="flex min-w-0 flex-1 flex-col leading-[1.3]">
      <span
        class="truncate"
        data-testid="chat-title"
      >{{ title }}</span>
      <span
        class="flex min-w-0 items-center gap-[5px] overflow-hidden text-[11px] font-normal whitespace-nowrap"
        :class="selected ? 'text-(--d-faint-text)' : 'text-(--d-faint) group-hover/row:text-(--d-faint-text)'"
      >
        <span class="shrink-0">{{ when }}</span>
        <template v-if="model">
          <span
            aria-hidden="true"
            class="shrink-0"
          >·</span>
          <!-- eslint-disable vue/no-v-html -- a static vendored SVG chosen by provider id, never session text -->
          <span
            v-if="logo"
            aria-hidden="true"
            class="provider-logo size-[11px] shrink-0"
            v-html="logo"
          />
          <!-- eslint-enable vue/no-v-html -->
          <span class="min-w-6 shrink truncate">{{ model }}</span>
        </template>
        <span
          v-if="chat.tag"
          data-testid="chat-tag"
          class="ml-0.5 flex max-w-[110px] min-w-11 shrink items-center gap-[3px] overflow-hidden rounded-full border border-(--d-border2) px-1.5 text-[10px] leading-[15px] text-(--d-muted) hover:border-(--d-accent) hover:text-(--d-accent-text)"
          :title="t('chats.showTagged', { tag: chat.tag })"
          @click.stop="emit('filterTag', chat.tag ?? '')"
        >
          <Tag
            aria-hidden="true"
            class="size-[9px] shrink-0"
          />
          <span class="min-w-0 truncate">{{ chat.tag }}</span>
        </span>
      </span>
    </span>
    <!-- Mouse shortcuts; keyboard users reach the same actions through the context menu, F2 and Delete. -->
    <span
      aria-hidden="true"
      class="hidden shrink-0 animate-[d-fade_.12s] items-center gap-px group-hover/row:flex"
    >
      <button
        v-if="saved"
        type="button"
        tabindex="-1"
        data-testid="chat-action-rename"
        class="flex size-[22px] items-center justify-center rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-accent)"
        :title="t('chats.rename')"
        @click.stop="emit('rename')"
      >
        <Pencil class="size-3" />
      </button>
      <button
        v-if="saved"
        type="button"
        tabindex="-1"
        data-testid="chat-action-tag"
        class="flex size-[22px] items-center justify-center rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-accent)"
        :title="chat.tag ? t('chats.changeTag') : t('chats.tag')"
        @click.stop="emit('tag')"
      >
        <Tag class="size-3" />
      </button>
      <button
        type="button"
        tabindex="-1"
        data-testid="chat-action-delete"
        class="flex size-[22px] items-center justify-center rounded-md text-(--d-danger) opacity-80 hover:bg-(--d-danger)/15 hover:opacity-100"
        :title="t('chats.delete')"
        @click.stop="emit('delete')"
      >
        <Trash2 class="size-3" />
      </button>
    </span>
  </div>
</template>
