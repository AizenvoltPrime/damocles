<script lang="ts">
import { MAX_AUTHOR_KEYS } from '@shared/forge/history';

// keys whose picture this page already showed: a row a scroll mounts again shows it without the fade, as no entrance replays;
// at most MAX_AUTHOR_KEYS (core's author key bound), the oldest going first
const SHOWN = new Set<string>();

function markShown(key: string): void {
  SHOWN.delete(key);
  SHOWN.add(key);
  if (SHOWN.size > MAX_AUTHOR_KEYS) SHOWN.delete(SHOWN.values().next().value!);
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  /** A login, or a commit author's name; its first grapheme is the initial. */
  login: string;
  /** Opaque key core issued; absent, or showAvatars off: only the initial shows. */
  avatarKey?: string | undefined;
  /** row: 1.75rem in settings lines; item: 1.25rem in menus and lists; chip: 0.875rem in a header chip and history lines. */
  size?: 'row' | 'item' | 'chip';
}>();
// the picture of avatarKey did not load, so the initial shows; a history view asks for the author's key again
const emit = defineEmits<{ failed: [] }>();

const SIZES = { row: 'size-7 text-xs', item: 'size-5 text-10', chip: 'size-3.5 text-[0.5rem]' } as const;

// Three tints tell two accounts on one server apart beside their logins, never alone.
const TINTS = [
  'bg-(--d-accent-soft) text-(--d-accent-text)',
  'bg-[color-mix(in_srgb,var(--d-design)_18%,transparent)] text-(--d-design-text)',
  'bg-[color-mix(in_srgb,var(--d-success)_16%,transparent)] text-(--d-success-text)',
] as const;

const tint = computed(() => TINTS[[...props.login].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TINTS.length]);
// the first grapheme, so a combining mark or a surrogate pair stays whole
const initial = computed(() => (new Intl.Segmenter().segment(props.login.trim())[Symbol.iterator]().next().value?.segment ?? '?').toUpperCase());
const src = computed(() => (props.avatarKey === undefined ? undefined : `app://damocles/forge/avatar/${encodeURIComponent(props.avatarKey)}`));

const loaded = ref(false);
const failed = ref(false);
const shownBefore = ref(props.avatarKey !== undefined && SHOWN.has(props.avatarKey));
watch(src, () => {
  loaded.value = false;
  failed.value = false;
  shownBefore.value = props.avatarKey !== undefined && SHOWN.has(props.avatarKey);
});

function onLoad(): void {
  loaded.value = true;
  if (props.avatarKey !== undefined) markShown(props.avatarKey);
}

function onError(): void {
  failed.value = true;
  emit('failed');
}
</script>

<template>
  <!-- the image sits over the initial in the same fixed box, so its arrival shifts nothing -->
  <span
    class="relative inline-flex flex-none items-center justify-center overflow-hidden rounded-full font-semibold"
    :class="[tint, SIZES[size ?? 'row']]"
    aria-hidden="true"
    data-testid="forge-avatar"
  >
    {{ initial }}
    <img
      v-if="src !== undefined && !failed"
      :src="src"
      alt=""
      class="absolute inset-0 size-full object-cover"
      :class="shownBefore ? '' : loaded ? 'd-fade-in' : 'opacity-0'"
      data-testid="forge-avatar-image"
      @load="onLoad"
      @error="onError"
    >
  </span>
</template>
