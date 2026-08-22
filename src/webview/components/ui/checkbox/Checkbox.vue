<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui'
import { Check } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { definedProps } from '@/lib/definedProps'

const props = defineProps<{
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  required?: boolean
  name?: string
  value?: string
  id?: string
  class?: HTMLAttributes['class']
}>()

const emits = defineEmits<{
  'update:checked': [value: boolean]
}>()

const rootProps = computed(() => definedProps({
  id: props.id,
  modelValue: props.checked,
  defaultValue: props.defaultChecked,
  disabled: props.disabled,
  required: props.required,
  name: props.name,
  value: props.value,
}))
</script>

<template>
  <CheckboxRoot
    v-bind="rootProps"
    :class="cn(
      'peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground cursor-pointer',
      props.class,
    )"
    @update:model-value="(val: boolean | 'indeterminate') => emits('update:checked', val === true)"
  >
    <CheckboxIndicator class="flex h-full w-full items-center justify-center text-current">
      <Check class="h-3.5 w-3.5" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
