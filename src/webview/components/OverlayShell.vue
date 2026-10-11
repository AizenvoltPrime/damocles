<script setup lang="ts">
import { computed, ref, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';
import LoadingSpinner from './LoadingSpinner.vue';
import JumpToLatestButton from './JumpToLatestButton.vue';
import { useOverlayDialog } from '@/composables/useOverlayDialog';
import { useStickToBottom } from '@/composables/useStickToBottom';

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string | undefined;
  icon: Component;
  /** Colours the icon tile; the tile's background is a tint of the same colour. */
  iconClass?: string | undefined;
  titleClass?: string | undefined;
  /** The reference's header chip. Below 560px of panel width it keeps only its dot or icon, with the label as its tooltip. */
  statusBadge?: {
    label: string;
    class: string;
    icon?: Component | undefined;
    showSpinner?: boolean | undefined;
    /** The dot breathes, for a live state such as Running. */
    pulse?: boolean | undefined;
  } | undefined;
  maxWidth?: string;
  /** Gives the panel the full height, for bodies that lay themselves out against it instead of their content. */
  fill?: boolean;
  /** Set for a body that streams output: it follows the output at the bottom, and a new key starts it there again. */
  followKey?: string | undefined;
  /** The overlay holds unsent text, so a click on the scrim leaves it open; X and Escape still close it. */
  hasDraft?: boolean;
}>(), { maxWidth: '51.25rem', fill: false, followKey: undefined, hasDraft: false });

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const { zIndex, root, titleId } = useOverlayDialog(() => emit('close'));

function onScrimClick(): void {
  if (!props.hasDraft) emit('close');
}

const body = ref<HTMLElement | null>(null);
const follow = useStickToBottom(
  computed(() => (props.followKey === undefined ? null : body.value)),
  { resetKey: () => props.followKey },
);
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    tabindex="-1"
    class="@container/overlay absolute inset-0 flex items-center justify-center p-2 outline-none @min-[45rem]/app:p-5.5"
    :style="{ zIndex }"
  >
    <div
      class="absolute inset-0 bg-(--d-scrim) backdrop-blur-xs"
      aria-hidden="true"
      data-testid="overlay-scrim"
      @click="onScrimClick"
    />
    <div
      class="o-panel relative flex max-h-full w-full min-w-0 min-h-0 flex-col overflow-hidden rounded-2xl border border-(--d-border2) bg-(--d-bg) text-(--d-text) shadow-(--d-shadow)"
      :class="fill && 'h-full'"
      :style="{ maxWidth }"
    >
      <header class="flex flex-none items-center gap-3 border-b border-(--d-border) pt-3.5 pr-3.5 pb-3 pl-4.5">
        <span
          class="flex size-8 flex-none items-center justify-center rounded-10 bg-[color-mix(in_srgb,currentColor_14%,transparent)]"
          :class="iconClass ?? 'text-(--d-accent)'"
          aria-hidden="true"
        >
          <component
            :is="icon"
            class="size-4"
          />
        </span>

        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
            <h2
              :id="titleId"
              class="min-w-0 truncate text-15 font-semibold tracking-[-.01em]"
              :class="titleClass"
            >
              {{ title }}
            </h2>
            <span
              v-if="statusBadge"
              class="flex flex-none items-center gap-1.25 rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_14%,transparent)] px-2 py-px text-11 font-medium @max-[34.9375rem]/overlay:p-1.25"
              :class="statusBadge.class"
              :title="statusBadge.label"
              data-testid="overlay-status"
            >
              <LoadingSpinner
                v-if="statusBadge.showSpinner"
                class="size-2.75"
              />
              <component
                :is="statusBadge.icon"
                v-else-if="statusBadge.icon"
                class="size-2.75"
              />
              <span
                v-else
                class="size-1.5 flex-none rounded-full bg-current"
                :class="statusBadge.pulse && 'd-pulsing'"
                aria-hidden="true"
              />
              <span class="@max-[34.9375rem]/overlay:sr-only">{{ statusBadge.label }}</span>
            </span>
          </div>
          <div
            v-if="$slots.subtitle || subtitle"
            class="truncate text-xs text-(--d-muted)"
          >
            <slot name="subtitle">
              {{ subtitle }}
            </slot>
          </div>
        </div>

        <slot name="header-actions" />

        <button
          type="button"
          class="flex size-7.5 flex-none items-center justify-center rounded-9 text-(--d-muted) transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
          :aria-label="t('overlay.close')"
          :title="t('overlays.closeHint')"
          data-overlay-fallback-focus
          data-testid="overlay-close"
          @click="emit('close')"
        >
          <X
            class="size-4"
            aria-hidden="true"
          />
        </button>
      </header>

      <div
        ref="body"
        :tabindex="followKey === undefined ? undefined : -1"
        class="relative min-h-0 overflow-x-hidden overflow-y-auto"
        :class="[fill ? 'flex-1' : 'flex-[0_1_auto]', followKey !== undefined && 'outline-none']"
        style="scrollbar-gutter: stable"
      >
        <slot />
        <!-- Last in the body, so sticking to its bottom holds the button at the body's bottom edge. -->
        <div
          v-if="followKey !== undefined"
          class="pointer-events-none sticky bottom-0 z-10 h-0"
        >
          <Transition name="t-pop">
            <JumpToLatestButton
              v-if="!follow.isFollowing.value"
              class="pointer-events-auto absolute bottom-3.5 inset-e-5"
              @click="follow.jumpToLatest"
            />
          </Transition>
        </div>
      </div>

      <slot name="footer" />
    </div>
  </div>
</template>
