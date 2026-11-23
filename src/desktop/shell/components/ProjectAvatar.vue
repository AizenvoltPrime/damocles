<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { characterFor, frameFor, type CharacterState } from '@shared/themes/characters';
import { pageCharacters } from '../characters';
import { avatarHue, avatarInitial } from '../project-avatar';
import CharacterImage from './CharacterImage.vue';

// A project's character from the shown theme, or its initial on its colour when it has none or its image does not load
// (docs/themes.md "Characters"). `state` and `active` default to what main sent the page for `projectKey`.
// active defaults to undefined, not to the false Vue gives an absent boolean prop
const props = withDefaults(defineProps<{
  name: string;
  projectKey?: string | undefined;
  state?: CharacterState | undefined;
  active?: boolean | undefined;
  // the project's name and state are in text beside the avatar, so the character says nothing more
  decorative?: boolean;
}>(), { projectKey: undefined, state: undefined, active: undefined });
const { t } = useI18n();

const style = computed(() => ({ '--avatar-hue': String(avatarHue(props.name)) }));
const page = computed(() => pageCharacters());
const character = computed(() => characterFor(page.value.shown, props.projectKey));
const state = computed<CharacterState>(() => props.state ?? (props.projectKey !== undefined ? page.value.states[props.projectKey] : undefined) ?? 'idle');
const active = computed(() => props.active ?? (props.projectKey !== undefined && page.value.selected === props.projectKey));
const frame = computed(() => (character.value ? frameFor(character.value, state.value) : undefined));
const motion = computed(() => page.value.shown?.motion ?? 'still');
// hover: motion.css starts it under the pointer; active: only the selected project's moves
const moves = computed(() => frame.value?.moves === true && frame.value.playable && motion.value !== 'still' && (motion.value !== 'active' || active.value));
const label = computed(() => t('projects.character', { project: props.name, state: t(`projects.characterState.${state.value}`) }));
// an image that did not load, until the frame names other files
const failed = ref(false);
watch(() => `${frame.value?.url ?? ''} ${frame.value?.still ?? ''}`, () => (failed.value = false));
</script>

<template>
  <span
    v-if="!frame || failed"
    aria-hidden="true"
    class="project-avatar flex shrink-0 items-center justify-center font-bold"
    :style="style"
  >{{ avatarInitial(name) }}</span>
  <!-- the name sits on the wrapper: the image under it changes with the pointer, and its own text would come and go -->
  <span
    v-else
    class="project-character flex shrink-0 items-center justify-center"
    data-testid="project-character"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : label"
    :aria-hidden="decorative ? 'true' : undefined"
    :data-character-state="state"
    :data-character-moving="moves ? 'true' : 'false'"
    :style="style"
  >
    <CharacterImage
      :frame="frame"
      alt=""
      :moves="moves"
      :hover="motion === 'hover'"
      @failed="failed = true"
    />
  </span>
</template>
