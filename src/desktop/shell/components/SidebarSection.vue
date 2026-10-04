<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import { MIN_SECTION_SIZE } from '../../preload/shell-channels';
import { SECTION_HEADER_HEIGHT } from '../layout';

const props = defineProps<{
  title: string;
  count?: number | undefined;
  collapsed: boolean;
  // CSS px of the body; absent, the section takes the sidebar's remaining height
  size?: number | undefined;
}>();
const emit = defineEmits<{ toggle: [] }>();

const headingId = useId();
const bodyId = useId();
const body = ref<HTMLElement | null>(null);

const sectionStyle = computed(() => {
  if (props.collapsed) return { flex: `0 0 ${SECTION_HEADER_HEIGHT}px` };
  if (props.size === undefined) return { flex: '1 1 0px', minHeight: `${MIN_SECTION_SIZE + SECTION_HEADER_HEIGHT}px` };
  return { flex: `0 0 ${props.size + SECTION_HEADER_HEIGHT}px` };
});

defineExpose({ bodyHeight: (): number => body.value?.getBoundingClientRect().height ?? 0 });
</script>

<template>
  <section
    :aria-labelledby="headingId"
    class="sidebar-section flex min-h-0 flex-col overflow-hidden"
    :style="sectionStyle"
  >
    <div
      class="flex shrink-0 items-center gap-1.5 pr-1.5 pl-2 hover:bg-(--d-hover)"
      :style="{ height: `${SECTION_HEADER_HEIGHT}px` }"
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
            class="size-[13px] shrink-0 text-(--d-faint) transition-transform duration-200"
            :class="collapsed ? '' : 'rotate-90'"
          />
          <span class="truncate text-[11px] font-semibold tracking-[.07em] text-(--d-muted) uppercase">{{ title }}</span>
          <span
            v-if="count !== undefined"
            class="font-mono text-[10.5px] text-(--d-faint)"
          >{{ count }}</span>
        </button>
      </h2>
      <slot name="actions" />
    </div>
    <!-- Clipped rather than removed while collapsed, so the section height can animate; inert hides it from focus and AT. -->
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
