<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { FileImage, FileJson, MoveUpRight, Pencil, PencilLine, Square } from 'lucide-vue-next';
import type { ImageBlock } from '@shared/types/content';
import type { DesignMarkupNote, MarkupStrokeType } from '@shared/design-markup';
import { Button } from '@/components/ui/button';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDesignStore } from '@/stores/useDesignStore';
import { imageBlockToDataUrl } from '@/utils/imageUtils';

// A markup the user sent from the preview (PD-12): the flattened capture, where it was drawn, one row per mark, and its
// feedback files. The marks come from the message's markup note; a message an earlier build sent has none and shows its text.
const props = defineProps<{ note: DesignMarkupNote; content: string; image: ImageBlock | undefined }>();
const emit = defineEmits<{ openLightbox: [block: ImageBlock] }>();
const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const designStore = useDesignStore();

const feedbackId = computed(() => props.note.feedbackId);
const markup = computed(() => props.note.markup);
const marks = computed(() => markup.value?.marks ?? []);
// The text after core's header line, for a note without marks.
const fallbackText = computed(() => (markup.value ? '' : props.content.split('\n').slice(1).join('\n').trim()));

const where = computed(() => {
  const value = markup.value;
  if (!value) return '';
  return [
    t('design.check.atBreakpoint', { breakpoint: value.breakpoint, width: value.width }),
    ...(value.state !== 'default' ? [t('design.markup.state', { state: value.state })] : []),
  ].join(' · ');
});
const meta = computed(() => {
  const pins = marks.value.filter((mark) => mark.type === 'pin').length;
  const strokes = marks.value.length - pins;
  return [
    ...(pins > 0 ? [t('design.markup.pins', { n: pins }, pins)] : []),
    ...(strokes > 0 ? [t('design.markup.strokes', { n: strokes }, strokes)] : []),
  ].join(' · ');
});
const imageUrl = computed(() => (props.image ? imageBlockToDataUrl(props.image) : undefined));
const designId = computed(() => designStore.design?.designId);
const files = computed(() => [
  { file: `feedback/${feedbackId.value}.png`, label: `${feedbackId.value}.png`, icon: FileImage },
  { file: `feedback/${feedbackId.value}.json`, label: `${feedbackId.value}.json`, icon: FileJson },
]);
const STROKES: Record<MarkupStrokeType, { icon: typeof Pencil; key: string }> = {
  arrow: { icon: MoveUpRight, key: 'design.markup.strokeArrow' },
  box: { icon: Square, key: 'design.markup.strokeBox' },
  pen: { icon: Pencil, key: 'design.markup.strokePen' },
};
// A stroke type a newer core sends draws as a pen stroke.
const strokeOf = (type: MarkupStrokeType): (typeof STROKES)[MarkupStrokeType] => STROKES[type] ?? STROKES.pen;

function open(file: string): void {
  if (designId.value) postMessage({ type: 'openDesignFile', designId: designId.value, file });
}
</script>

<template>
  <div
    role="group"
    :aria-label="t('design.markup.card', { id: feedbackId })"
    data-testid="markup-message"
    :data-feedback-id="feedbackId"
    class="@container w-lg max-w-full overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--d-design)_35%,var(--d-border))] bg-(--d-card)"
  >
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
      <span
        aria-hidden="true"
        class="flex size-5 flex-none items-center justify-center rounded-5 bg-[color-mix(in_srgb,var(--d-design)_15%,transparent)] text-(--d-design-text)"
      >
        <PencilLine class="size-3" />
      </span>
      <span class="text-12.5 font-medium text-(--d-text)">{{ t('design.markup.cardTitle', { id: feedbackId }) }}</span>
      <span
        v-if="meta"
        class="text-11 text-(--d-muted)"
      >{{ meta }}</span>
      <span class="ms-auto flex items-center gap-1 @max-[22rem]:ms-0 @max-[22rem]:basis-full">
        <Button
          v-for="entry in files"
          :key="entry.file"
          variant="ghost"
          :title="t('design.markup.cardOpen', { file: entry.file })"
          :disabled="!designId"
          data-testid="markup-message-file"
          :data-file="entry.file"
          class="h-6 gap-1 rounded-6 px-1.5 font-mono text-11 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3"
          @click="open(entry.file)"
        >
          <component
            :is="entry.icon"
            aria-hidden="true"
          />{{ entry.label }}
        </Button>
      </span>
    </div>
    <p
      v-if="markup"
      class="flex min-w-0 flex-wrap items-baseline gap-x-2 border-t border-(--d-border) px-3 py-1.5 text-11 text-(--d-muted)"
      data-testid="markup-message-where"
    >
      <span
        class="min-w-0 truncate font-mono text-(--d-text)"
        dir="ltr"
        :title="markup.file"
      >{{ markup.file }}</span>
      <span class="font-mono tabular-nums">{{ where }}</span>
    </p>
    <Button
      v-if="image && imageUrl"
      type="button"
      variant="ghost"
      data-testid="markup-message-image"
      class="block h-auto w-full cursor-zoom-in rounded-none border-y border-(--d-border) bg-(--d-bg) p-0 hover:bg-(--d-bg) focus-visible:ring-2 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0"
      :title="t('imageThumbnail.clickToPreview')"
      @click="emit('openLightbox', image)"
    >
      <img
        :src="imageUrl"
        :alt="t('design.markup.cardImage', { id: feedbackId })"
        class="block max-h-80 w-full object-contain"
      >
    </Button>
    <!-- Scrolls when long; focusable so a keyboard user can scroll it too. -->
    <ol
      v-if="marks.length > 0"
      tabindex="0"
      :aria-label="t('design.markup.marks', { id: feedbackId })"
      data-testid="markup-message-marks"
      class="flex max-h-48 flex-col gap-1.5 overflow-y-auto px-3 py-2 text-12 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--d-accent)"
    >
      <li
        v-for="(mark, index) in marks"
        :key="index"
        data-testid="markup-message-mark"
        :data-kind="mark.type === 'pin' ? mark.kind : mark.type"
        class="flex items-start gap-2"
      >
        <template v-if="mark.type === 'pin'">
          <span
            class="flex size-4.5 flex-none items-center justify-center rounded-full text-10 font-semibold tabular-nums"
            :class="mark.kind === 'change' ? 'bg-(--d-design) text-(--d-on-design)' : 'bg-(--d-bg) text-(--d-design-text) shadow-[inset_0_0_0_1.5px_var(--d-design)]'"
          ><span aria-hidden="true">{{ mark.n }}</span><span class="sr-only">{{ t(mark.kind === 'change' ? 'design.markup.pinChange' : 'design.markup.pinNote', { n: mark.n }) }}</span></span>
          <span class="min-w-0 wrap-break-word text-(--d-text)">
            <span
              v-if="mark.element !== null"
              dir="ltr"
              class="font-mono text-11 text-(--d-muted)"
            >{{ mark.element }}</span>
            <span
              v-else
              class="text-11 text-(--d-muted) italic"
            >{{ t('design.markup.noElement') }}</span><span
              v-if="mark.text.trim()"
              class="ms-1.5 whitespace-pre-line"
            >{{ mark.text.trim() }}</span>
          </span>
        </template>
        <template v-else>
          <span class="flex size-4.5 flex-none items-center justify-center rounded-5 bg-(--d-hover)">
            <component
              :is="strokeOf(mark.type).icon"
              aria-hidden="true"
              class="size-3 text-(--d-muted)"
            />
            <span class="sr-only">{{ t(strokeOf(mark.type).key) }}</span>
          </span>
          <span
            v-if="mark.elements.length > 0"
            dir="ltr"
            class="min-w-0 font-mono text-11 wrap-break-word text-(--d-muted)"
          >{{ mark.elements.join(', ') }}</span>
          <span
            v-else
            class="min-w-0 text-11 text-(--d-muted) italic"
          >{{ t('design.markup.noElement') }}</span>
        </template>
      </li>
    </ol>
    <p
      v-else-if="fallbackText"
      class="px-3 py-2 text-12 whitespace-pre-line wrap-break-word text-(--d-text)"
      data-testid="markup-message-text"
    >
      {{ fallbackText }}
    </p>
  </div>
</template>
