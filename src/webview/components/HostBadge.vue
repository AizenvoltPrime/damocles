<script setup lang="ts">
import { Badge } from '@/components/ui/badge';

// A remote host's name as this computer's host store names it. leading: a part before the name, such as the Projects list's
// status dot, which then names the host to assistive technology itself.
defineProps<{ name: string; title?: string | undefined }>();
defineSlots<{ leading?: () => unknown }>();
</script>

<template>
  <Badge
    as="span"
    variant="tone"
    data-testid="host-name-badge"
    class="d-tone-muted inline-flex h-4.5 max-w-27 shrink-0 border-0 bg-(--tone)/15 px-1.5 align-middle text-10 font-semibold transition-colors duration-200"
    :class="$slots.leading && 'gap-1.25 pl-1.25'"
    :title="title ?? name"
  >
    <slot name="leading" />
    <span
      class="truncate"
      :aria-hidden="$slots.leading ? 'true' : undefined"
    >{{ name }}</span>
  </Badge>
</template>
