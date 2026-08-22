<script setup lang="ts">
import { ref, nextTick, type HTMLAttributes } from 'vue'
import { useVModel } from '@vueuse/core'
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
  defaultValue?: string | number
  modelValue?: string | number
}>()

const emits = defineEmits<{
  (e: 'update:modelValue', payload: string | number): void
}>()

const modelValue = useVModel(props, 'modelValue', emits, {
  passive: true,
  ...(props.defaultValue !== undefined && { defaultValue: props.defaultValue }),
})

const textareaRef = ref<HTMLTextAreaElement | null>(null)

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault()
    event.stopPropagation()
    const textarea = textareaRef.value
    if (textarea && typeof modelValue.value === 'string') {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      modelValue.value = modelValue.value.substring(0, start) + '\n' + modelValue.value.substring(end)
      nextTick(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1
        textarea.scrollTop = textarea.scrollHeight
      })
    }
  }
}
</script>

<template>
  <textarea
    ref="textareaRef"
    v-model="modelValue"
    :class="cn('flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 overflow-y-auto', props.class)"
    @keydown="handleKeydown"
  />
</template>
