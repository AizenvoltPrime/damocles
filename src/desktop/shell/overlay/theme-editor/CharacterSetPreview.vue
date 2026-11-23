<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ImagePlus, Trash2 } from 'lucide-vue-next';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CHARACTER_STATES, type CharacterFrameView, type CharacterState } from '@shared/themes/characters';
import CharacterImage from '../../components/CharacterImage.vue';

// A character set in each state (design S5): one row a character, its idle, running and waiting images as they move, each named
// "<character>, <state>". A state a character lacks shows its idle image in the window.
defineProps<{
  caption: string;
  rows: ReadonlyArray<{ readonly name: string; readonly states: Partial<Record<CharacterState, CharacterFrameView>> }>;
  readOnly: boolean;
  busy: boolean;
  // reduce motion: every image holds its first frame
  still: boolean;
}>();
const emit = defineEmits<{ choose: [index: number, state: CharacterState]; remove: [index: number] }>();
const { t } = useI18n();
const stateWord = (state: CharacterState): string => t(`projects.characterState.${state}`);
</script>

<template>
  <Table
    class="text-12"
    data-testid="character-set-preview"
  >
    <TableCaption class="sr-only">
      {{ caption }}
    </TableCaption>
    <TableHeader>
      <TableRow class="border-(--d-border)">
        <TableHead class="h-7 px-1 text-11 font-semibold text-(--d-faint-text)">
          {{ t('themeEditor.characters.character') }}
        </TableHead>
        <TableHead
          v-for="state in CHARACTER_STATES"
          :key="state"
          class="h-7 px-1 text-center text-11 font-semibold text-(--d-faint-text)"
        >
          {{ t(`themeEditor.characters.states.${state}`) }}
        </TableHead>
        <TableHead
          v-if="!readOnly"
          class="h-7 px-1"
        >
          <span class="sr-only">{{ t('themeEditor.characters.actions') }}</span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow
        v-for="(row, index) in rows"
        :key="row.name"
        class="border-(--d-border)"
      >
        <TableHead
          scope="row"
          class="h-auto p-1 font-medium text-(--d-text)"
        >
          <bdi>{{ row.name }}</bdi>
        </TableHead>
        <TableCell
          v-for="state in CHARACTER_STATES"
          :key="state"
          class="p-1 text-center"
        >
          <span class="inline-flex flex-col items-center gap-1">
            <span
              v-if="row.states[state]"
              class="project-character inline-flex size-10 items-center justify-center rounded-7 bg-(--d-card) p-1"
              :data-testid="`character-cell-${state}`"
            >
              <CharacterImage
                :frame="row.states[state]!"
                :alt="t('themeEditor.characters.cell', { character: row.name, state: stateWord(state) })"
                :moves="!still && row.states[state]!.moves && row.states[state]!.playable"
              />
            </span>
            <span
              v-else
              class="inline-flex size-10 items-center justify-center rounded-7 border border-dashed border-(--d-border2) text-10.5 text-(--d-faint-text)"
            >{{ t('themeEditor.characters.asIdle') }}</span>
            <button
              v-if="!readOnly"
              type="button"
              class="sm-button"
              :disabled="busy"
              :aria-label="t('themeEditor.characters.choose', { character: row.name, state: stateWord(state) })"
              @click="emit('choose', index, state)"
            >
              <ImagePlus
                class="size-3"
                aria-hidden="true"
              />
            </button>
          </span>
        </TableCell>
        <TableCell
          v-if="!readOnly"
          class="p-1 text-end"
        >
          <button
            type="button"
            class="sm-button"
            :disabled="busy"
            :aria-label="t('themeEditor.characters.remove', { character: row.name })"
            @click="emit('remove', index)"
          >
            <Trash2
              class="size-3"
              aria-hidden="true"
            />
          </button>
        </TableCell>
      </TableRow>
    </TableBody>
  </Table>
</template>
