<script lang="ts" setup>
import type { ToasterProps } from "vue-sonner"
import { reactiveOmit } from "@vueuse/core"
import { CheckIcon, InfoIcon, Loader2Icon, XCircleIcon, AlertTriangleIcon, XIcon } from "lucide-vue-next"
import { Toaster as Sonner } from "vue-sonner"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<ToasterProps>()
const delegatedProps = reactiveOmit(props, "toastOptions")

const toastClasses = {
  toast: 'group toast flex items-center gap-3 backdrop-blur-xl border border-border rounded-xl py-3 px-4 min-w-72 max-w-md shadow-2xl toast-base',
  title: 'font-medium text-sm leading-snug text-foreground tracking-tight',
  description: 'text-xs text-muted-foreground mt-1 leading-snug',
  actionButton: 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium transition-all hover:brightness-110',
  cancelButton: 'bg-muted text-muted-foreground rounded-md px-3 py-1.5 text-xs font-medium transition-all hover:bg-accent hover:text-accent-foreground',
  success: 'toast-success',
  error: 'toast-error',
  warning: 'toast-warning',
  info: 'toast-info',
}
</script>

<template>
  <Sonner
    class="toaster group"
    :toast-options="{ classes: toastClasses }"
    v-bind="definedProps(delegatedProps)"
  >
    <template #success-icon>
      <div class="toast-icon toast-icon-success">
        <CheckIcon class="size-3.5 stroke-[2.5]" />
      </div>
    </template>
    <template #info-icon>
      <div class="toast-icon toast-icon-info">
        <InfoIcon class="size-3.5" />
      </div>
    </template>
    <template #warning-icon>
      <div class="toast-icon toast-icon-warning">
        <AlertTriangleIcon class="size-3.5" />
      </div>
    </template>
    <template #error-icon>
      <div class="toast-icon toast-icon-error">
        <XCircleIcon class="size-3.5" />
      </div>
    </template>
    <template #loading-icon>
      <div class="toast-icon toast-icon-loading">
        <Loader2Icon class="size-3.5 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-3.5" />
    </template>
  </Sonner>
</template>
