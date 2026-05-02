<script setup lang="ts">
import { computed } from "vue";
import { Badge } from "@/components/ui/badge";
import { getToolColorClass } from "./toolBadgeColors";

const props = defineProps<{
  name: string;
}>();

const colorClass = computed(() => getToolColorClass(props.name));
</script>

<template>
  <Badge variant="outline" :class="['border', 'text-[9px]', 'font-mono', 'px-1.5', 'py-0.5', 'leading-none', colorClass]">
    {{ props.name }}
  </Badge>
</template>
