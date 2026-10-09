<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Tag, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { MAX_TAG_LENGTH } from '../../../preload/shell-channels';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import { placePopup } from '../placement';
import { trapTab } from '../focus-trap';

const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'tagPicker' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

// Suggestions narrow as the user types, so a short list is enough and stays unvirtualized.
const MAX_SUGGESTIONS = 50;

const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const listId = useId();
const optionId = (index: number): string => `${listId}-${index}`;
const value = ref(props.request.current ?? '');
const activeIndex = ref(-1);
const position = ref<{ left: number; top: number }>({ left: props.request.anchor.x, top: props.request.anchor.y + props.request.anchor.height });

const suggestions = computed(() => {
  const needle = value.value.trim().toLocaleLowerCase();
  const current = props.request.current;
  return props.request.tags
    .filter((tag) => tag !== current && (!needle || tag.toLocaleLowerCase().includes(needle)))
    .slice(0, MAX_SUGGESTIONS);
});

// An empty tag removes the tag, as the reference's tag editor does.
function save(tag: string): void {
  const trimmed = tag.trim().slice(0, MAX_TAG_LENGTH);
  emit('answer', { kind: 'tagPicker', tag: trimmed === '' ? null : trimmed });
}

function onInputKeydown(event: KeyboardEvent): void {
  const count = suggestions.value.length;
  if (event.key === 'ArrowDown' && count > 0) activeIndex.value = (activeIndex.value + 1) % count;
  else if (event.key === 'ArrowUp' && count > 0) activeIndex.value = activeIndex.value <= 0 ? count - 1 : activeIndex.value - 1;
  else if (event.key === 'Enter') save(suggestions.value[activeIndex.value] ?? value.value);
  else return;
  event.preventDefault();
}

function onKeydown(event: KeyboardEvent): void {
  if (root.value) trapTab(event, root.value);
}

onMounted(() => {
  const element = root.value;
  if (!element) return;
  // Layout size, not getBoundingClientRect: the entrance animation starts scaled down.
  position.value = placePopup(props.request.anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
  void nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
});
</script>

<!-- Popover and Command need their trigger in this document; its anchor is in the shell view, so this panel places itself at the rect it is sent. -->
<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    data-testid="overlay-tag-picker"
    :aria-label="t('overlay.tagPicker')"
    class="fixed flex w-65 animate-[d-pop_.14s_ease-out] flex-col gap-1.5 rounded-11 border border-(--d-border2) bg-(--d-card) p-1.5 text-(--d-text) shadow-(--d-shadow)"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    @keydown="onKeydown"
  >
    <div class="flex items-center gap-1.5">
      <Tag
        aria-hidden="true"
        class="ml-0.5 size-3 shrink-0 text-(--d-faint)"
      />
      <input
        ref="input"
        v-model="value"
        type="text"
        role="combobox"
        data-testid="overlay-tag-input"
        :maxlength="MAX_TAG_LENGTH"
        :aria-label="t('overlay.tagPicker')"
        :aria-expanded="suggestions.length > 0"
        :aria-controls="listId"
        aria-autocomplete="list"
        :aria-activedescendant="activeIndex >= 0 && activeIndex < suggestions.length ? optionId(activeIndex) : undefined"
        :placeholder="request.placeholder"
        class="h-6 min-w-0 flex-1 rounded-md border border-(--d-accent) bg-(--d-input) px-2 text-xs text-(--d-text) outline-none placeholder:text-(--d-faint)"
        @input="activeIndex = -1"
        @keydown="onInputKeydown"
      >
      <Button
        type="button"
        size="icon-sm"
        data-testid="overlay-tag-save"
        class="size-5.5 rounded-md hover:bg-primary [&_svg]:size-3"
        :aria-label="t('overlay.save')"
        :title="t('overlay.save')"
        @click="save(value)"
      >
        <Check
          aria-hidden="true"
          class="size-3"
        />
      </Button>
      <Button
        v-if="request.current"
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="overlay-tag-remove"
        class="size-5.5 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3"
        :aria-label="t('overlay.removeTag')"
        :title="t('overlay.removeTag')"
        @click="emit('answer', { kind: 'tagPicker', tag: null })"
      >
        <X
          aria-hidden="true"
          class="size-3"
        />
      </Button>
    </div>
    <div
      v-show="suggestions.length > 0"
      :id="listId"
      role="listbox"
      :aria-label="t('overlay.existingTags')"
      class="max-h-48 overflow-y-auto"
    >
      <div
        v-for="(tag, index) in suggestions"
        :id="optionId(index)"
        :key="tag"
        role="option"
        :aria-selected="index === activeIndex"
        class="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs hover:bg-(--d-hover)"
        :class="index === activeIndex ? 'bg-(--d-hover)' : ''"
        @click="save(tag)"
      >
        <Tag
          aria-hidden="true"
          class="size-2.75 shrink-0 text-(--d-faint)"
        />
        <span class="min-w-0 truncate">{{ tag }}</span>
      </div>
    </div>
  </div>
</template>
