<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, Eraser, LoaderCircle, MapPin, MoveUpRight, Pencil, SendHorizontal, Snowflake, Square, Undo2, X } from 'lucide-vue-next';
import type { AcceptableValue } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { MAX_MARKUP_MARKS } from '../../../shared/design-markup';
import { TOOLBAR_BUTTON } from './design-toolbar';
import { commitMarks, setMarkupTool, undoMarks, type MarkupSession, type MarkupTool } from './markup-session';

// Toolbar row 2 while markup is on (UI reference: Markup).
const props = defineProps<{ session: MarkupSession; sending: boolean; notice: 'sendFailed' | 'limit' | null; shake: number; mac: boolean }>();
const emit = defineEmits<{ exit: []; send: []; announce: [text: string] }>();
const { t } = useI18n();

const TOOLS: readonly { tool: MarkupTool; icon: typeof Pencil }[] = [
  { tool: 'pen', icon: Pencil },
  { tool: 'arrow', icon: MoveUpRight },
  { tool: 'box', icon: Square },
  { tool: 'pin', icon: MapPin },
];

const count = computed(() => props.session.marks.length);
// The count rolls the way it moved.
const countRose = ref(true);
watch(count, (next, previous) => {
  countRose.value = next >= previous;
});
const chip = computed(() => t('editor.designPreview.markup.frozen', { band: props.session.freeze.breakpoint, width: props.session.freeze.width, state: props.session.freeze.state }));
const undoKey = computed(() => (props.mac ? '⌘Z' : 'Ctrl+Z'));

function setTool(value: AcceptableValue | AcceptableValue[]): void {
  const next = TOOLS.find((candidate) => candidate.tool === value);
  if (next) setMarkupTool(props.session, next.tool);
}

function undo(): void {
  if (props.sending) return;
  if (undoMarks(props.session)) emit('announce', t('editor.designPreview.markup.undone'));
}

function clear(): void {
  const n = count.value;
  if (props.sending || n === 0) return;
  commitMarks(props.session, []);
  emit('announce', t('editor.designPreview.markup.cleared', { n }, n));
}

// The shake replays on every refusal: the class goes and comes back a frame later.
const shaking = ref(false);
watch(() => props.shake, async () => {
  shaking.value = false;
  await nextTick();
  requestAnimationFrame(() => {
    shaking.value = true;
  });
});

const tools = ref<HTMLElement | null>(null);
defineExpose({
  /** Focuses the selected tool; false while the tools are not rendered. */
  focusTool: (): boolean => {
    const root = (tools.value as { $el?: HTMLElement } | null)?.$el ?? tools.value;
    const tool = root?.querySelector<HTMLElement>('[data-state="on"]');
    tool?.focus();
    return tool !== null && tool !== undefined;
  },
});
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-2 gap-y-1.5"
    data-testid="design-markup-toolbar"
  >
    <ToggleGroup
      ref="tools"
      type="single"
      :model-value="session.tool"
      :disabled="sending"
      :aria-label="t('editor.designPreview.markup.tools')"
      data-testid="design-markup-tools"
      class="gap-0.5 rounded-7 border border-(--d-border) bg-(--d-bg) p-0.5"
      @update:model-value="setTool"
    >
      <ToggleGroupItem
        v-for="item in TOOLS"
        :key="item.tool"
        :value="item.tool"
        :title="t(`editor.designPreview.markup.${item.tool}Title`)"
        data-testid="design-markup-tool"
        :data-tool="item.tool"
        class="h-5.5 gap-1 rounded-5 px-2 text-11 font-medium text-(--d-muted) transition-[color,background-color] duration-150 hover:bg-transparent hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:bg-(--d-design) data-[state=on]:text-(--d-on-design) @max-[42rem]:px-1.5 [&_svg]:size-3"
      >
        <component
          :is="item.icon"
          aria-hidden="true"
        />
        <span class="@max-[42rem]:sr-only">{{ t(`editor.designPreview.markup.${item.tool}`) }}</span>
      </ToggleGroupItem>
    </ToggleGroup>
    <span
      aria-hidden="true"
      class="h-4 w-px bg-(--d-border)"
    />
    <!-- Undo, Clear and Send are aria-disabled, not disabled: each can empty what enables it while it holds focus. -->
    <Button
      variant="ghost"
      data-testid="design-markup-undo"
      :class="TOOLBAR_BUTTON"
      :title="t('editor.designPreview.markup.undoTitle', { key: undoKey })"
      :aria-keyshortcuts="mac ? 'Meta+Z' : 'Control+Z'"
      :aria-disabled="sending || session.undo.length === 0 || undefined"
      @click="undo"
    >
      <Undo2 aria-hidden="true" /><span class="@max-[42rem]:sr-only">{{ t('editor.designPreview.markup.undo') }}</span>
    </Button>
    <Button
      variant="ghost"
      data-testid="design-markup-clear"
      :class="TOOLBAR_BUTTON"
      :title="t('editor.designPreview.markup.clearTitle')"
      :aria-disabled="sending || count === 0 || undefined"
      @click="clear"
    >
      <Eraser aria-hidden="true" /><span class="@max-[42rem]:sr-only">{{ t('editor.designPreview.markup.clear') }}</span>
    </Button>
    <div class="ms-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
      <span
        data-testid="design-markup-chip"
        :title="t('editor.designPreview.markup.frozenTitle')"
        class="inline-flex h-5.5 items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--d-design)_40%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-design)_10%,transparent)] px-2 text-11 whitespace-nowrap text-(--d-design-text) tabular-nums"
      >
        <Snowflake
          aria-hidden="true"
          class="size-3"
        />{{ chip }}
      </span>
      <Button
        variant="ghost"
        data-testid="design-markup-exit"
        :class="TOOLBAR_BUTTON"
        :title="t('editor.designPreview.markup.exitTitle')"
        :disabled="sending"
        @click="emit('exit')"
      >
        <X aria-hidden="true" />{{ t('editor.designPreview.markup.exit') }}
      </Button>
      <Button
        data-testid="design-markup-send"
        :class="cn(
          'd-press h-6.5 gap-1.5 rounded-7 bg-(--d-design) px-2.5 text-12 font-medium text-(--d-on-design) hover:bg-[color-mix(in_srgb,var(--d-design)_88%,var(--d-text))] focus-visible:ring-2 focus-visible:ring-(--d-accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--d-panel) aria-disabled:cursor-default aria-disabled:opacity-(--d-opacity-disabled) aria-disabled:hover:bg-(--d-design) [&_svg]:size-3.5',
          shaking && 'd-shake',
        )"
        :aria-disabled="sending || count === 0 || undefined"
        :aria-busy="sending || undefined"
        @click="emit('send')"
        @animationend.self="shaking = false"
      >
        <LoaderCircle
          v-if="sending"
          aria-hidden="true"
          class="d-spinning"
        />
        <SendHorizontal
          v-else
          aria-hidden="true"
        />
        <template v-if="sending">
          {{ t('editor.designPreview.markup.sending') }}
        </template>
        <i18n-t
          v-else
          keypath="editor.designPreview.markup.send"
          scope="global"
          tag="span"
        >
          <template #n>
            <Transition
              :name="countRose ? 't-swap' : 't-swap-down'"
              mode="out-in"
            >
              <span
                :key="count"
                data-testid="design-markup-send-count"
                class="tabular-nums"
              >{{ count }}</span>
            </Transition>
          </template>
        </i18n-t>
      </Button>
    </div>
    <Transition name="t-tuck">
      <span
        v-if="notice"
        role="status"
        data-testid="design-markup-notice"
        :data-notice="notice"
        class="order-last flex basis-full items-center gap-1 text-11.5"
        :class="notice === 'limit' ? 'text-(--d-warning-text)' : 'text-(--d-danger-text)'"
      >
        <CircleAlert
          aria-hidden="true"
          class="size-3.25 flex-none"
        />
        {{ notice === 'limit' ? t('editor.designPreview.markup.limit', { max: MAX_MARKUP_MARKS }) : t('editor.designPreview.markup.sendFailed') }}
      </span>
    </Transition>
  </div>
</template>
