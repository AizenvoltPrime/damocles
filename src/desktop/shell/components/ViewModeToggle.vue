<script setup lang="ts">
import { List, ListTree } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { TOOLBAR_BUTTON } from './sidebar-section';

defineProps<{
  // the view a click switches to, which the icon shows
  target: 'tree' | 'list';
  // names the action, never the current state, so it carries no aria-pressed
  label: string;
}>();
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    :class="TOOLBAR_BUTTON"
    :aria-label="label"
    :title="label"
  >
    <Transition name="t-letter">
      <ListTree
        v-if="target === 'tree'"
        key="tree"
        aria-hidden="true"
      />
      <List
        v-else
        key="list"
        aria-hidden="true"
      />
    </Transition>
  </Button>
</template>
