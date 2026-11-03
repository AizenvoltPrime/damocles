<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import { computed } from 'vue';
import { hostColorDataTone, hostColorLook } from '@shared/host-colors';
import type { HostColor } from '@shared/host-colors';

// A remote host's name as this computer's host store names it, tinted with its safety color. leading: a part before the name,
// such as the Projects list's status dot, which then names the host to assistive technology itself.
const props = defineProps<{ name: string; title?: string | undefined; color?: HostColor | undefined }>();
defineSlots<{ leading?: () => unknown }>();
const look = computed(() => hostColorLook(props.color));
</script>

<template>
  <Badge
    as="span"
    variant="tone"
    data-testid="host-name-badge"
    class="inline-flex h-4.5 max-w-27 shrink-0 border-0 bg-(--tone)/15 px-1.5 align-middle text-10 font-semibold transition-colors duration-200"
    :class="[look.class, $slots.leading && 'gap-1.25 pl-1.25']"
    :style="look.style"
    :data-tone="color ? hostColorDataTone(color) : undefined"
    :title="title ?? name"
  >
    <slot name="leading" />
    <!-- A rename swaps the old name for the new one. -->
    <Transition
      name="t-swap"
      mode="out-in"
    >
      <span
        :key="name"
        class="truncate"
        :aria-hidden="$slots.leading ? 'true' : undefined"
      >{{ name }}</span>
    </Transition>
  </Badge>
</template>
