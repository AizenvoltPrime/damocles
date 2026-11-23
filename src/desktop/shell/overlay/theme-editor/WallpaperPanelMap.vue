<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Panel } from '@shared/themes/schema';
import { thumbUrl } from '@shared/themes/wallpapers';

// The window's five panels drawn as a small map: one image per panel picks the panel to edit, one image across
// panels picks the panels it spans. Each cell shows the thumbnail of the image it has.
const props = defineProps<{
  // the pressed panels: the one being edited, or every spanned one
  pressed: readonly Panel[];
  // the image each panel shows, by sha256
  images: Partial<Record<Panel, string>>;
  disabled: boolean;
  describedBy: string;
}>();
const emit = defineEmits<{ toggle: [panel: Panel] }>();
const { t } = useI18n();

// Grid placement of each cell: the title bar across the top, then sidebar, chat, and editor over terminal.
const CELLS: ReadonlyArray<{ readonly panel: Panel; readonly area: string }> = [
  { panel: 'titlebar', area: 'col-span-3 row-start-1' },
  { panel: 'sidebar', area: 'col-start-1 row-span-2 row-start-2' },
  { panel: 'chat', area: 'col-start-2 row-span-2 row-start-2' },
  { panel: 'editor', area: 'col-start-3 row-start-2' },
  { panel: 'terminal', area: 'col-start-3 row-start-3' },
];

const name = (panel: Panel): string => {
  const sha = props.images[panel];
  return t('themeEditor.wallpapers.panelState', { panel: t(`themeEditor.wallpapers.panels.${panel}`), state: sha ? t('themeEditor.wallpapers.hasImage') : t('themeEditor.wallpapers.noImage') });
};
</script>

<template>
  <!-- a picture of the window's panels, which no shadcn part draws -->
  <div
    role="group"
    :aria-label="t('themeEditor.wallpapers.panel')"
    :aria-describedby="describedBy"
    class="grid max-w-68 grid-cols-[1fr_2fr_1.4fr] grid-rows-[1.25rem_3.25rem_2.25rem] gap-0.5 rounded-8 border border-(--d-border2) bg-(--d-border) p-0.5"
    data-testid="wallpaper-panel-map"
  >
    <button
      v-for="cell in CELLS"
      :key="cell.panel"
      type="button"
      class="relative flex min-w-0 items-center justify-center overflow-hidden rounded-5 border border-transparent bg-(--d-panel) bg-cover bg-center text-10 text-(--d-muted) focus-visible:outline-2 focus-visible:outline-(--d-accent-fill) disabled:opacity-(--d-opacity-disabled) aria-pressed:font-semibold aria-pressed:text-(--d-text) aria-pressed:outline-2 aria-pressed:-outline-offset-2 aria-pressed:outline-(--d-accent-fill)"
      :class="cell.area"
      :style="images[cell.panel] ? { backgroundImage: `url(${thumbUrl(images[cell.panel]!)})` } : undefined"
      :aria-pressed="pressed.includes(cell.panel)"
      :aria-label="name(cell.panel)"
      :disabled="disabled"
      :data-panel="cell.panel"
      @click="emit('toggle', cell.panel)"
    >
      <span class="relative rounded-5 bg-(--d-panel)/80 px-1 whitespace-nowrap">{{ t(`themeEditor.wallpapers.panels.${cell.panel}`) }}</span>
    </button>
  </div>
</template>
