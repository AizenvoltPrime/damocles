<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, Info, X, XCircle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DamoclesShellApi, ShellToast } from '../../preload/shell-channels';

const props = defineProps<{ api: DamoclesShellApi }>();
const { t } = useI18n();

const toasts = ref<ShellToast[]>([]);
// Each list is its own live region, so a toast is announced once: errors interrupt, everything else waits its turn.
const groups = computed(() => [
  { live: 'assertive', toasts: toasts.value.filter((toast) => toast.severity === 'error') },
  { live: 'polite', toasts: toasts.value.filter((toast) => toast.severity !== 'error') },
] as const);

function drop(id: string): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

// Main owns the timeout; the shell only reports the user's answer, undefined meaning dismissed.
function resolve(id: string, action?: string): void {
  drop(id);
  props.api.resolveToast(id, action);
}

const stops: Array<() => void> = [];
onMounted(() => {
  stops.push(props.api.onToast((toast) => {
    if (!toasts.value.some((existing) => existing.id === toast.id)) toasts.value = [...toasts.value, toast];
  }));
  stops.push(props.api.onToastDismiss(drop));
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
});

const ICONS = { info: Info, warning: AlertTriangle, error: XCircle } as const;
const ICON_CLASS = { info: 'text-info', warning: 'text-warning', error: 'text-error' } as const;
</script>

<template>
  <!-- Outside the content rectangle: a native tab view paints over anything the shell draws inside it. -->
  <section
    :aria-label="t('toasts.region')"
    class="flex shrink-0 flex-col"
  >
    <div
      v-for="group in groups"
      :key="group.live"
      :aria-live="group.live"
      class="flex flex-col"
    >
      <div
        v-for="toast in group.toasts"
        :key="toast.id"
        class="flex items-start gap-2 border-b border-border bg-card px-3 py-2 text-sm"
      >
        <component
          :is="ICONS[toast.severity]"
          :class="cn('mt-0.5 size-4 shrink-0', ICON_CLASS[toast.severity])"
          aria-hidden="true"
        />
        <span class="sr-only">{{ t(`toasts.${toast.severity}`) }}:</span>
        <p class="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {{ toast.message }}
        </p>
        <div class="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            v-for="(action, index) in toast.actions"
            :key="index"
            size="sm"
            variant="secondary"
            class="h-7 px-2.5 text-xs"
            @click="resolve(toast.id, action)"
          >
            {{ action }}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-7"
            :aria-label="t('toasts.dismiss')"
            :title="t('toasts.dismiss')"
            @click="resolve(toast.id)"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  </section>
</template>
