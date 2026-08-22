<script setup lang="ts">
import { ref } from 'vue';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// A real SFC, not a render function: an event bound to a call expression compiles to
// `$event => (expr)`, which discards a returned handler. Only a compiled template shows that.
const picked = ref('a');
const seen = ref<string[]>([]);

function onPick(value: string): void {
  seen.value.push(value);
  picked.value = value;
}

defineExpose({ seen, picked });
</script>

<template>
  <Select :model-value="picked" @update:model-value="onPick">
    <SelectTrigger>
      <SelectValue placeholder="pick" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="a">Alpha</SelectItem>
      <SelectItem value="b">Beta</SelectItem>
    </SelectContent>
  </Select>
</template>
