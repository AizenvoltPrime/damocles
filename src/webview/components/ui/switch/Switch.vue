<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue"
import { SwitchRoot, SwitchThumb } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"

// Reka UI v2 uses modelValue for v-model, not checked
// Our wrapper accepts 'checked' for backwards compatibility with v-model:checked
const props = defineProps<{
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  required?: boolean
  name?: string
  value?: string
  class?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{
  'update:checked': [value: boolean]
}>()

const rootProps = computed(() => definedProps({
  modelValue: props.checked,
  defaultValue: props.defaultChecked,
  disabled: props.disabled,
  required: props.required,
  name: props.name,
  value: props.value,
}))
</script>

<template>
  <SwitchRoot
    v-bind="rootProps"
    :class="cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-switch-track',
      props.class,
    )"
    @update:model-value="(val: boolean) => emits('update:checked', val)"
  >
    <SwitchThumb
      :class="cn('pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-5')"
    >
      <slot name="thumb" />
    </SwitchThumb>
  </SwitchRoot>
</template>
