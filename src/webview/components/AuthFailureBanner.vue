<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { IconWarning, IconXMark } from '@/components/icons';

defineProps<{
  message: string;
}>();

defineEmits<{
  (e: 'sign-in'): void;
  (e: 'dismiss'): void;
}>();
</script>

<template>
  <Alert
    class="flex items-center gap-3 px-4 py-2 rounded-none border-x-0 border-t-0 bg-warning/30 border-warning/50"
  >
    <IconWarning :size="20" class="shrink-0" />

    <div class="flex-1 min-w-0">
      <AlertTitle class="font-medium text-warning mb-0">
        Claude authentication required
      </AlertTitle>
      <AlertDescription class="text-xs opacity-80 mt-0.5 truncate">
        {{ message }}
      </AlertDescription>
      <p class="text-xs opacity-70 mt-1">
        {{ $t('authBanner.independenceNote') }}
      </p>
    </div>

    <Button
      variant="default"
      size="sm"
      class="h-7 shrink-0"
      @click="$emit('sign-in')"
    >
      Sign In
    </Button>

    <Button
      variant="ghost"
      size="icon-sm"
      class="opacity-50 hover:opacity-100 h-6 w-6 shrink-0"
      title="Dismiss"
      @click="$emit('dismiss')"
    >
      <IconXMark :size="12" />
    </Button>
  </Alert>
</template>
