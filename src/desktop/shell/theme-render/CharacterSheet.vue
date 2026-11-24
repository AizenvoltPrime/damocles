<script setup lang="ts">
import { computed, provide } from 'vue';
import type { RenderAppearance, SheetCharacterView } from '@shared/themes/agent';
import type { CharacterSheetPage, SheetLine, SheetRect } from '@shared/themes/character-sheet';
import type { ShownCharacters } from '@shared/themes/characters';
import { createPageCharacters, PAGE_CHARACTERS } from '../characters';
import ProjectAvatar from '../components/ProjectAvatar.vue';
import CharacterImage from '../components/CharacterImage.vue';
import { SAMPLE_SELECTED_NAME } from './sample-window';
import { wallpaperCrop } from './sheet-wallpaper';

// One page of a character sheet: each row a character of the set, each line one of its states, on the sidebar pane color, over
// the sidebar wallpaper, as the selected project and at the sidebar's size (ProjectAvatar, as the sidebar draws it), then frame
// by frame over a checkerboard (CharacterImage held on each frame). Every box is the layout's, in CSS px at the render page's
// device scale of 1, so a sprite enlarged by a whole number lands on whole pixels; text and gaps are rem at drawSheet's pinned
// root, which the layout's label and legend sizes assume. Labels name characters by index only: a name from outside this
// computer never reaches the image.
// English only: the image is for the model, as the sample window's content is (sample-window.ts).
const props = defineProps<{
  appearance: RenderAppearance;
  sheet: CharacterSheetPage;
  characters: readonly SheetCharacterView[];
}>();

const keyOf = (index: number): string => `sheet:${index}`;
const shown: ShownCharacters = {
  characters: props.characters.map((character) => character.view),
  pins: Object.fromEntries(props.characters.map((character, at) => [keyOf(character.index), at])),
  motion: 'still',
  selection: props.appearance.characters?.selection ?? 'outline',
};
const pageCharacters = createPageCharacters({ shown });
provide(PAGE_CHARACTERS, pageCharacters.characters);

const viewOf = (index: number) => props.characters.find((character) => character.index === index)?.view;
const sidebarWallpaper = computed(() => props.appearance.wallpapers?.find((wallpaper) => wallpaper.panel === 'sidebar'));

const box = (rect: SheetRect): Record<string, string> => ({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
const spriteBox = (line: SheetLine): Record<string, string> => ({ width: `${line.sprite.width}px`, height: `${line.sprite.height}px` });
// one checker square per sprite pixel once a pixel is 4 px or more, so the squares line up with the sprite's grid
const checker = (scale: number): Record<string, string> => {
  const side = scale * Math.max(1, Math.ceil(4 / scale));
  return { backgroundSize: `${side * 2}px ${side * 2}px` };
};
const crops = computed(() => new Map(props.sheet.rows.flatMap((row) => row.lines.flatMap((line) =>
  (sidebarWallpaper.value && line.wallpaper ? [[line, wallpaperCrop(sidebarWallpaper.value, props.appearance.arrangement, line.wallpaper, props.sheet.sidebarAvatar)] as const] : [])))));
const sidebarAvatar = computed(() => ({ width: `${props.sheet.sidebarAvatar}px`, height: `${props.sheet.sidebarAvatar}px` }));
const crop = (line: SheetLine) => crops.value.get(line);
const dim = computed(() => ({ backgroundColor: `rgb(from var(--d-pane-sidebar) r g b / ${sidebarWallpaper.value?.dim ?? 0})` }));
const frameWord = (count: number): string => `${count} frame${count === 1 ? '' : 's'}`;
</script>

<template>
  <div
    class="character-sheet relative overflow-hidden bg-(--d-bg) text-(--d-text)"
    data-testid="character-sheet"
    :style="{ width: `${sheet.width}px`, height: `${sheet.height}px` }"
  >
    <p
      class="absolute flex items-center gap-[0.375rem] truncate text-xs text-(--d-muted)"
      :style="box(sheet.legend)"
    >
      <span class="font-semibold text-(--d-text)">Character sheet</span>
      <span aria-hidden="true">·</span>
      <span>each line: sidebar pane · {{ sidebarWallpaper ? 'sidebar wallpaper · ' : '' }}selected · sidebar 1x · frames over a checkerboard</span>
    </p>
    <template
      v-for="row in sheet.rows"
      :key="`${row.character}-${row.lines[0]?.state}`"
    >
      <span
        v-if="row.rule"
        class="absolute bg-(--d-border)"
        :style="box(row.rule)"
      />
      <template
        v-for="line in row.lines"
        :key="line.state"
      >
        <div
          class="absolute flex flex-col justify-center"
          :data-sheet-label="`${row.character} ${line.state}`"
          :style="box(line.label)"
        >
          <!-- line heights: the layout's MIN_LINE is their sum -->
          <span class="truncate text-sm/[1rem] font-semibold tabular-nums">#{{ row.character }}<span
            v-if="row.continued"
            class="font-normal text-(--d-muted)"
          > cont.</span></span>
          <span class="truncate text-xs/[0.875rem] text-(--d-muted)">{{ line.state }}</span>
          <span class="truncate text-11/[0.875rem] text-(--d-faint-text) tabular-nums">×{{ row.scale }} · {{ frameWord(line.frameCount) }}</span>
        </div>
        <div
          class="sheet-cell absolute flex items-center justify-center overflow-hidden rounded-md ring-1 ring-(--d-border) ring-inset"
          data-sheet-cell="pane"
          :style="box(line.pane)"
        >
          <ProjectAvatar
            :name="SAMPLE_SELECTED_NAME"
            :project-key="keyOf(row.character)"
            :state="line.state"
            decorative
            :style="spriteBox(line)"
          />
        </div>
        <div
          v-if="line.wallpaper"
          class="sheet-cell absolute flex items-center justify-center overflow-hidden rounded-md ring-1 ring-(--d-border) ring-inset"
          data-sheet-cell="wallpaper"
          :style="box(line.wallpaper)"
        >
          <div
            v-if="crop(line)"
            class="pointer-events-none absolute"
            :style="crop(line)!.window"
          >
            <div
              class="sheet-cell absolute overflow-hidden"
              :style="crop(line)!.region"
            >
              <img
                v-if="crop(line)!.image"
                :src="sidebarWallpaper!.url"
                alt=""
                class="absolute max-w-none"
                :style="crop(line)!.image"
              >
              <template v-else>
                <div
                  class="absolute"
                  data-sheet-tile
                  :style="crop(line)!.tile"
                />
                <!-- the tile is a background: this image is what the job waits on and fails with -->
                <img
                  :src="sidebarWallpaper!.url"
                  alt=""
                  hidden
                >
              </template>
            </div>
          </div>
          <span
            class="absolute inset-0"
            :style="dim"
          />
          <ProjectAvatar
            class="relative"
            :name="SAMPLE_SELECTED_NAME"
            :project-key="keyOf(row.character)"
            :state="line.state"
            decorative
            :style="spriteBox(line)"
          />
        </div>
        <div
          class="sheet-cell absolute flex items-center justify-center overflow-hidden rounded-md ring-1 ring-(--d-border) ring-inset"
          data-sheet-cell="selected"
          :style="box(line.selected)"
        >
          <span class="absolute inset-0 bg-(--d-accent-soft)" />
          <ProjectAvatar
            class="relative"
            :name="SAMPLE_SELECTED_NAME"
            :project-key="keyOf(row.character)"
            :state="line.state"
            selected
            decorative
            :style="spriteBox(line)"
          />
        </div>
        <div
          class="sheet-cell absolute flex items-center justify-center overflow-hidden rounded-md ring-1 ring-(--d-border) ring-inset"
          data-sheet-cell="sidebar"
          :style="box(line.sidebar)"
        >
          <!-- ProjectRow's avatar, as the sidebar draws it at the default text size -->
          <ProjectAvatar
            :name="SAMPLE_SELECTED_NAME"
            :project-key="keyOf(row.character)"
            :state="line.state"
            decorative
            class="rounded-md text-11"
            :style="sidebarAvatar"
          />
        </div>
        <div
          class="absolute rounded-md bg-(--d-panel) ring-1 ring-(--d-border) ring-inset"
          data-sheet-cell="frames"
          :style="box(line.frames)"
        >
          <span
            v-for="(cell, at) in line.frameCells"
            :key="at"
            class="sheet-checker absolute flex"
            :data-sheet-frame="at"
            :style="{ ...box({ ...cell, x: cell.x - line.frames.x, y: cell.y - line.frames.y }), ...checker(row.scale) }"
          >
            <CharacterImage
              v-if="viewOf(row.character)?.states[line.state]"
              :image="viewOf(row.character)!.states[line.state]!"
              alt=""
              :moves="false"
              :frame="at"
            />
          </span>
        </div>
      </template>
    </template>
  </div>
</template>
