<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import { MIN_SECTION_SIZE } from '../../preload/shell-channels';
import { SECTION_HEADER_REM } from '../layout';

const props = defineProps<{
  title: string;
  count?: number | undefined;
  collapsed: boolean;
  // CSS px of the body; absent, the section takes the sidebar's remaining height
  bodySize?: number | undefined;
}>();
const emit = defineEmits<{ toggle: [] }>();

const headingId = useId();
const bodyId = useId();
const body = ref<HTMLElement | null>(null);

const sectionStyle = computed(() => {
  if (props.collapsed) return { flex: `0 0 ${SECTION_HEADER_REM}rem` };
  // MIN_SECTION_SIZE is px at the default font.
  if (props.bodySize === undefined) return { flex: '1 1 0px', minHeight: `${MIN_SECTION_SIZE / 16 + SECTION_HEADER_REM}rem` };
  return { flex: `0 0 calc(${props.bodySize}px + ${SECTION_HEADER_REM}rem)` };
});

defineExpose({ bodyHeight: (): number => body.value?.getBoundingClientRect().height ?? 0 });
</script>

<template>
  <!-- overflow-clip, not hidden: a hidden overflow is still a scroll container, which a focused input or its caret
       scrolls when the section is shorter than its content, moving every control in it. -->
  <section
    :aria-labelledby="headingId"
    class="sidebar-section flex min-h-0 flex-col overflow-clip"
    :style="sectionStyle"
  >
    <div
      class="flex shrink-0 items-center gap-1.5 pr-1.5 pl-2 hover:bg-(--d-hover)"
      :style="{ height: `${SECTION_HEADER_REM}rem` }"
    >
      <h2
        :id="headingId"
        class="flex min-w-0 flex-1 self-stretch"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          :aria-expanded="!collapsed"
          :aria-controls="bodyId"
          @click="emit('toggle')"
        >
          <ChevronRight
            aria-hidden="true"
            class="size-3.25 shrink-0 text-(--d-faint) transition-transform duration-200"
            :class="collapsed ? '' : 'rotate-90'"
          />
          <span class="truncate text-11 font-semibold tracking-[.07em] text-(--d-muted) uppercase">{{ title }}</span>
          <span
            v-if="count !== undefined"
            class="font-mono text-10.5 text-(--d-faint)"
          >{{ count }}</span>
        </button>
      </h2>
      <slot name="actions" />
    </div>
    <!-- Not a Collapsible: the body stays mounted and clipped while collapsed, so the section height can animate; inert hides it from focus and AT. -->
    <div
      :id="bodyId"
      ref="body"
      :inert="collapsed"
      class="flex min-h-0 flex-1 flex-col"
    >
      <slot />
    </div>
  </section>
</template>
