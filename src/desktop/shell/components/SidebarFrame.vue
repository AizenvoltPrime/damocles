<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

// The sidebar's column: its width, its slide out of view, and the pane ground under the sections the slot holds.
const props = defineProps<{
  // CSS px
  width: number;
  visible: boolean;
  // the user drags its edge, so the width follows the pointer with no transition
  resizing: boolean;
  // the sections' heights glide; off while a row sash drags
  sectionsAnimated: boolean;
}>();
// The panes beside the sidebar take every width in between while it slides; a transition its sections run bubbles here too.
const emit = defineEmits<{ slide: [running: boolean] }>();
const { t } = useI18n();

const root = ref<HTMLElement | null>(null);
// Reference motion: the sidebar slides out by its own width.
const slideStyle = computed(() => ({
  width: `${props.width}px`,
  marginLeft: props.visible ? '0px' : `-${props.width}px`,
  transition: props.resizing ? 'none' : 'margin-left .28s var(--ease-out)',
}));

function onSlide(event: TransitionEvent, running: boolean): void {
  if (event.target === root.value && event.propertyName === 'margin-left') emit('slide', running);
}

defineExpose({ root });
</script>

<template>
  <nav
    ref="root"
    data-wallpaper-panel="sidebar"
    :aria-label="t('sidebar.label')"
    :inert="!visible"
    class="relative flex shrink-0 flex-col overflow-hidden border-r border-(--d-border) bg-(--d-pane-sidebar) [reading-flow:flex-visual]"
    :class="sectionsAnimated ? 'sidebar-sections-animated' : ''"
    :style="slideStyle"
    @transitionrun="onSlide($event, true)"
    @transitionend="onSlide($event, false)"
    @transitioncancel="onSlide($event, false)"
  >
    <slot />
  </nav>
</template>
