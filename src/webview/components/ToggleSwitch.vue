<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui';

/**
 * The reference's on/off switch (Chat Panel.dc.html MCP and Tools rows, the Desktop settings rows at `md`): accent track,
 * a knob that springs across. The knob is `on-accent` on a `faint` (off) or `accent` (on) track: text-on-background pairs that
 * reach 3:1 against the knob where the reference's `border2` off track and white knob do not.
 */
withDefaults(defineProps<{
  checked: boolean;
  size?: 'sm' | 'md';
  disabled?: boolean;
}>(), { size: 'sm', disabled: false });

const emit = defineEmits<{
  (e: 'update:checked', value: boolean): void;
}>();
</script>

<template>
  <SwitchRoot
    :model-value="checked"
    :disabled="disabled === true"
    class="relative flex flex-none items-center rounded-full bg-(--d-faint) p-0.75 before:absolute before:inset-0 before:rounded-full before:bg-(--d-accent) before:opacity-0 before:transition-opacity before:duration-200 data-[state=checked]:before:opacity-100 disabled:opacity-45"
    :class="size === 'md' ? 'h-5.5 w-9.5' : 'h-5 w-8.5'"
    @update:model-value="(value: boolean) => emit('update:checked', value)"
  >
    <SwitchThumb
      class="relative block rounded-full bg-(--d-on-accent) shadow-sm transition-transform duration-200 ease-(--ease-spring) data-[state=unchecked]:translate-x-0"
      :class="size === 'md' ? 'size-4 data-[state=checked]:translate-x-4' : 'size-3.5 data-[state=checked]:translate-x-3.5'"
    />
  </SwitchRoot>
</template>
