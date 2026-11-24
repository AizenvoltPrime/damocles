<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, ImagePlus } from 'lucide-vue-next';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated } from '@shared/bidi-isolate';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useReducedMotion } from '@/utils/reducedMotion';
import { characterIndex, characterView, CHARACTER_STATES, frameAsset, frameFor, MAX_SPRITE_BYTES, MAX_SPRITE_FPS, MAX_SPRITE_SIDE, type CharacterState } from '@shared/themes/characters';
import { MAX_STRIP_FRAMES, MAX_THEME_NAME_CHARS } from '@shared/themes/limits';
import { CHARACTER_SELECTIONS, type CharacterSelection, type CharacterSet, type ThemeFile } from '@shared/themes/schema';
import { themeBlobUrl, type FlashRecord } from '@shared/themes/wallpapers';
import type { DamoclesOverlayApi, ThemeEditorSession } from '../../../preload/overlay-channels';
import CharacterImage from '../../components/CharacterImage.vue';
import { avatarHue } from '../../project-avatar';
import { withCharacterSet, withNewCharacter, withSelection, withStateImage } from './character-edits';
import CharacterSetPreview from './CharacterSetPreview.vue';
import type { EditorImports } from './editor-imports';
import { useEditorFormat } from './format';
import type { PinChoice } from './pins';

// The editor's Characters section (design S5): the theme's character set, taken from another theme or built from images, shown
// in each state; each image's flash check and the per-file allowance; and the pins of every project, saved with the theme.
// It unmounts when its tab hides, so what an import told and every call to main live in `imports`, which the editor owns.
const props = defineProps<{
  api: DamoclesOverlayApi;
  draft: ThemeFile;
  readOnly: boolean;
  session: ThemeEditorSession;
  // each project's pin, a character the set lacks already shown as automatic
  pins: Readonly<Record<string, PinChoice>>;
  imports: EditorImports;
  // what a pick of another set, or of none, replaced, while Undo can put it back
  replaced?: { readonly text: string; readonly undo: boolean } | undefined;
}>();
// replace: a pick that takes the place of the theme's own set, which the editor keeps for Undo
const emit = defineEmits<{ update: [theme: ThemeFile]; replace: [theme: ThemeFile]; undoReplace: []; pin: [projectKey: string, choice: PinChoice] }>();
const { t } = useI18n();
const format = useEditorFormat();

const newName = ref('');
const stripFrames = ref(1);
const stripFps = ref(4);
const still = useReducedMotion();
const busy = computed(() => props.imports.busy.sprite);
const failure = computed(() => props.imports.failure.characters);
const fail = (text: string): void => props.imports.fail('characters', text);

const set = computed<CharacterSet | undefined>(() => props.draft.characters);
const flashOf = (sha: string): FlashRecord | undefined => props.imports.allowed[sha] ?? props.imports.sprites[sha] ?? props.session.sprites?.[sha];
const sources = { url: themeBlobUrl, flash: flashOf };
const views = computed(() => (set.value?.characters ?? []).map((character) => ({ character, view: characterView(character, props.draft.assets ?? {}, sources) })));
const rows = computed(() => views.value.map(({ character, view }) => ({ name: character.name, states: Object.fromEntries(CHARACTER_STATES.flatMap((state) => (character.states[state] && view?.states[state] ? [[state, view.states[state]]] : []))) })));

// The set select: none, this theme's own set, or another theme's to take.
const choice = computed(() => (set.value ? 'own' : 'none'));
const setOptions = computed(() => [
  { value: 'none', label: t('themeEditor.characters.none') },
  ...(set.value ? [{ value: 'own', label: t('themeEditor.characters.own', { name: isolated(set.value.name), n: set.value.characters.length }, set.value.characters.length) }] : []),
  ...(props.session.characterSets ?? []).map((other) => ({ value: `from:${other.themeId}`, label: t('themeEditor.characters.from', { name: isolated(other.name) }) })),
]);

function pickSet(value: string): void {
  if (props.readOnly || value === choice.value) return;
  props.imports.clear('characters');
  const other = props.session.characterSets?.find((candidate) => `from:${candidate.themeId}` === value);
  if (value !== 'none' && !other) return;
  const next = withCharacterSet(props.draft, other?.characters, other?.assets);
  if (set.value) emit('replace', next);
  else emit('update', next);
}

// The cut of the image a character is added or changed with: one frame, or a strip of frames side by side.
function strip(): { readonly frames: number; readonly fps: number } | undefined {
  const frames = Math.min(MAX_STRIP_FRAMES, Math.max(1, Math.round(stripFrames.value)));
  return frames > 1 ? { frames, fps: Math.min(MAX_SPRITE_FPS, Math.max(1, stripFps.value)) } : undefined;
}

async function addCharacter(): Promise<void> {
  const name = newName.value.trim();
  if (props.readOnly || busy.value) return;
  if (name === '') {
    fail(t('themeEditor.characters.nameEmpty'));
    return;
  }
  const taken = t('themeEditor.characters.nameTaken', { name });
  if (set.value?.characters.some((character) => character.name === name)) {
    fail(taken);
    return;
  }
  // the set is read again when the image arrives: it may have changed while the file dialog was open
  if (await props.imports.importSprite(strip(), (draft, sprite) => withNewCharacter(draft, name, sprite) ?? taken)) newName.value = '';
}

function choose(index: number, state: CharacterState): void {
  const name = set.value?.characters[index]?.name;
  if (name === undefined || props.readOnly || busy.value) return;
  // by name, so the image goes to the character it was chosen for wherever it is by then, and nowhere if it is gone
  void props.imports.importSprite(strip(), (draft, sprite) => withStateImage(draft, name, state, sprite));
}

// How the selected project's character is marked, each choice drawn on the set's first character in the first project's hue.
const selection = computed<CharacterSelection>(() => set.value?.selection ?? 'outline');
const selectionSample = computed(() => views.value.find(({ view }) => view !== undefined)?.view?.states.idle);
const selectionHue = computed(() => ({ '--avatar-hue': String(avatarHue(props.session.projects?.[0]?.name ?? set.value?.name ?? '')) }));
function pickSelection(value: unknown): void {
  if (props.readOnly || value === selection.value || !CHARACTER_SELECTIONS.includes(value as CharacterSelection)) return;
  emit('update', withSelection(props.draft, value as CharacterSelection));
}

function remove(index: number): void {
  const current = set.value;
  if (!current || props.readOnly) return;
  emit('update', withCharacterSet(props.draft, { ...current, characters: current.characters.filter((_, at) => at !== index) }));
}

// A moving image whose flash check blocked it: it shows its still frame until the user allows the file here.
const blocked = computed(() => views.value.flatMap(({ character }) => CHARACTER_STATES.flatMap((state) => {
  const frame = character.states[state];
  if (!frame) return [];
  const sha = frameAsset(frame);
  const record = flashOf(sha);
  return record?.flagged === true && record.allowed !== true ? [{ sha, label: t('themeEditor.characters.cell', { character: character.name, state: t(`projects.characterState.${state}`) }), atMs: record.atMs }] : [];
})).filter((entry, i, all) => all.findIndex((other) => other.sha === entry.sha) === i));
function allowFlashing(sha: string): void {
  if (!props.readOnly) void props.imports.allowFlash('characters', sha);
}

// Pins: each project's character of this set, automatic by its key unless pinned, and whether it is kept in every theme.
const characterNames = computed(() => (set.value?.characters ?? []).map((character) => character.name));
const automatic = (key: string): string | undefined => characterNames.value[characterIndex(key, characterNames.value.length)];
const shownName = (key: string): string | undefined => props.pins[key]?.character ?? automatic(key);
const kept = (key: string): boolean => {
  const pin = props.pins[key];
  return pin?.every !== null && pin?.every !== undefined && pin.every === shownName(key);
};
// reka keeps '' for no selection, so the automatic option is a sentinel of its own
const AUTOMATIC = '\u0000auto';
const pinOptions = (key: string): Array<{ value: string; label: string }> => [
  { value: AUTOMATIC, label: t('themeEditor.characters.automatic', { character: isolated(automatic(key) ?? '') }) },
  ...characterNames.value.map((name) => ({ value: name, label: isolated(name) })),
];
const pinValue = (key: string): string => props.pins[key]?.character ?? AUTOMATIC;
function setPin(key: string, value: string): void {
  const character = value === AUTOMATIC ? null : value;
  const before = props.pins[key] ?? { character: null, every: null };
  const wasKept = kept(key);
  const name = character ?? automatic(key) ?? null;
  emit('pin', key, { character, every: wasKept ? name : before.every });
}
function setKept(key: string, on: boolean): void {
  const before = props.pins[key] ?? { character: null, every: null };
  emit('pin', key, { character: before.character, every: on ? shownName(key) ?? null : null });
}
const avatarOf = (key: string, state: CharacterState) => {
  const name = shownName(key);
  const view = views.value.find((entry) => entry.character.name === name)?.view;
  return view ? frameFor(view, state) : undefined;
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-1">
      <SettingSelect
        :model-value="choice"
        :options="setOptions"
        :label="t('themeEditor.characters.set')"
        :disabled="readOnly"
        data-testid="character-set-select"
        @update:model-value="pickSet"
      />
      <p class="text-11.5 text-(--d-muted)">
        {{ t('themeEditor.characters.setDescription') }}
      </p>
      <p
        role="status"
        :aria-label="t('themeEditor.characters.replacedStatus')"
        class="text-11.5 text-(--d-muted)"
        data-testid="character-set-replaced"
      >
        <template v-if="replaced">
          <IsolatedText :text="replaced.text" />{{ ' ' }}<button
            v-if="replaced.undo"
            type="button"
            class="ms-1 text-(--d-accent) underline underline-offset-2"
            @click="emit('undoReplace')"
          >
            {{ t('themeEditor.characters.undoReplace') }}
          </button>
        </template>
      </p>
    </div>

    <CharacterSetPreview
      v-if="set"
      :caption="t('themeEditor.characters.caption', { name: set.name })"
      :rows="rows"
      :read-only="readOnly"
      :busy="busy"
      :still="still"
      @choose="choose"
      @remove="remove"
    />
    <p
      v-else
      class="text-11.5 text-(--d-muted)"
    >
      {{ t('themeEditor.characters.noneText') }}
    </p>

    <div
      v-if="set"
      class="flex flex-col gap-1.5"
    >
      <span
        id="theme-character-selection"
        class="text-12 font-medium"
      >{{ t('themeEditor.characters.selection') }}</span>
      <RadioGroup
        :model-value="selection"
        :disabled="readOnly"
        orientation="horizontal"
        aria-labelledby="theme-character-selection"
        aria-describedby="theme-character-selection-note"
        class="grid grid-cols-2 gap-2"
        data-testid="character-selection"
        @update:model-value="pickSelection"
      >
        <label
          v-for="option in CHARACTER_SELECTIONS"
          :key="option"
          :for="`theme-character-selection-${option}`"
          class="flex items-center gap-2 rounded-8 border px-2.5 py-2 transition-colors duration-150 ease-out"
          :class="[readOnly ? '' : 'cursor-pointer', selection === option ? 'border-(--d-accent-fill) bg-(--d-accent-soft)' : readOnly ? 'border-(--d-border)' : 'border-(--d-border) hover:bg-(--d-hover)']"
        >
          <RadioGroupItem
            :id="`theme-character-selection-${option}`"
            :value="option"
          />
          <span
            v-if="selectionSample"
            aria-hidden="true"
            class="project-character flex size-6 shrink-0 items-center justify-center p-0.5"
            data-selected
            :data-selection="option"
            :style="selectionHue"
          >
            <CharacterImage
              :image="selectionSample"
              alt=""
              :moves="false"
            />
          </span>
          <span class="text-12">{{ t(`themeEditor.characters.selections.${option}`) }}</span>
        </label>
      </RadioGroup>
      <p
        id="theme-character-selection-note"
        class="text-11.5 text-(--d-muted)"
      >
        {{ t('themeEditor.characters.selectionNote') }}
      </p>
    </div>

    <div
      v-for="entry in blocked"
      :key="entry.sha"
      class="flex flex-col gap-2 rounded-8 bg-(--d-warning-fill)/10 px-2 py-1.5 text-11.5 text-(--d-warning-text)"
      role="group"
      :aria-label="t('themeEditor.wallpapers.flash.blocked')"
      data-testid="character-flash-blocked"
    >
      <span class="flex flex-wrap items-center gap-2">
        <AlertTriangle
          class="size-3.5 flex-none"
          aria-hidden="true"
        />
        <Badge
          variant="tone"
          class="d-tone-warning"
        >
          {{ t('themeEditor.wallpapers.flash.blocked') }}
        </Badge>
        <span class="font-medium">{{ entry.label }}</span>
      </span>
      <span>{{ entry.atMs !== undefined ? t('themeEditor.wallpapers.flash.at', { time: format.duration(entry.atMs) }) : t('themeEditor.wallpapers.flash.found') }}</span>
      <span>{{ t('themeEditor.wallpapers.flash.warning') }}</span>
      <button
        type="button"
        class="sm-button self-start"
        :disabled="readOnly || imports.busy.allowing"
        data-testid="character-allow-flashing"
        @click="allowFlashing(entry.sha)"
      >
        {{ t('themeEditor.wallpapers.flash.allow') }}
      </button>
    </div>

    <div
      v-if="!readOnly"
      class="flex flex-col gap-2 rounded-8 border border-(--d-border) p-2"
      role="group"
      :aria-label="t('themeEditor.characters.addGroup')"
    >
      <label
        class="text-12 font-medium"
        for="theme-character-name"
      >{{ t('themeEditor.characters.newName') }}</label>
      <Input
        id="theme-character-name"
        v-model="newName"
        dir="auto"
        class="h-7 text-12"
        :maxlength="MAX_THEME_NAME_CHARS"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="flex flex-wrap items-end gap-2">
        <span class="flex flex-col gap-1">
          <label
            class="text-11 text-(--d-muted)"
            for="theme-character-frames"
          >{{ t('themeEditor.characters.frames') }}</label>
          <Input
            id="theme-character-frames"
            v-model.number="stripFrames"
            type="number"
            min="1"
            :max="MAX_STRIP_FRAMES"
            class="h-7 w-16 text-12"
          />
        </span>
        <span class="flex flex-col gap-1">
          <label
            class="text-11 text-(--d-muted)"
            for="theme-character-fps"
          >{{ t('themeEditor.characters.fps') }}</label>
          <Input
            id="theme-character-fps"
            v-model.number="stripFps"
            type="number"
            min="1"
            :max="MAX_SPRITE_FPS"
            class="h-7 w-16 text-12"
            :disabled="stripFrames <= 1"
          />
        </span>
        <button
          type="button"
          class="sm-button"
          :disabled="busy"
          data-testid="character-add"
          @click="addCharacter"
        >
          <ImagePlus
            class="size-3"
            aria-hidden="true"
          />{{ busy ? t('themeEditor.characters.reading') : t('themeEditor.characters.add') }}
        </button>
      </div>
      <p class="text-11 text-(--d-muted)">
        {{ t('themeEditor.characters.stripNote', { size: format.number(MAX_SPRITE_BYTES / 1024), side: format.number(MAX_SPRITE_SIDE) }) }}
      </p>
    </div>
    <p
      v-if="failure"
      class="text-11 text-(--d-danger-text)"
      role="alert"
    >
      {{ failure }}
    </p>

    <p class="text-11.5 text-(--d-muted)">
      {{ t('themeEditor.characters.motionNote') }}
      <button
        type="button"
        class="text-(--d-accent) underline underline-offset-2"
        @click="api.themeEditor.openSettings()"
      >
        {{ t('themeEditor.characters.motionLink') }}
      </button>
      {{ t('themeEditor.characters.motionAfter') }}
    </p>

    <h2
      id="theme-character-pins"
      class="text-12 font-semibold"
    >
      {{ t('themeEditor.characters.pins') }}
    </h2>
    <p class="text-11.5 text-(--d-muted)">
      {{ t('themeEditor.characters.pinsNote') }}
    </p>
    <p
      v-if="!set || (session.projects ?? []).length === 0"
      class="text-11.5 text-(--d-faint-text)"
    >
      {{ set ? t('themeEditor.characters.noProjects') : t('themeEditor.characters.pinsNeedSet') }}
    </p>
    <ul
      v-else
      class="flex flex-col"
      aria-labelledby="theme-character-pins"
      data-testid="character-pins"
    >
      <li
        v-for="project in session.projects"
        :key="project.key"
        class="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 border-b border-(--d-border) py-2"
      >
        <span class="project-character flex size-6 items-center justify-center rounded-6 bg-(--d-card) p-0.5">
          <CharacterImage
            v-if="avatarOf(project.key, project.state)"
            :image="avatarOf(project.key, project.state)!"
            alt=""
            :moves="false"
          />
        </span>
        <span class="min-w-0 font-medium wrap-anywhere">{{ project.name }}</span>
        <SettingSelect
          :model-value="pinValue(project.key)"
          :options="pinOptions(project.key)"
          :label="t('themeEditor.characters.pinFor', { project: project.name })"
          :disabled="readOnly"
          @update:model-value="(value: string) => setPin(project.key, value)"
        />
        <label class="col-start-2 col-end-4 flex items-center gap-1.5 text-12 text-(--d-muted)">
          <Checkbox
            :checked="kept(project.key)"
            :disabled="readOnly"
            @update:checked="(on: boolean) => setKept(project.key, on)"
          />
          <span>{{ t('themeEditor.characters.every') }}</span>
          <span class="sr-only">{{ t('themeEditor.characters.everyFor', { project: project.name }) }}</span>
        </label>
      </li>
    </ul>
  </div>
</template>
