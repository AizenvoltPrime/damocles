<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { User, FolderGit, Globe, ShieldCheck, ShieldX } from 'lucide-vue-next';
import { useOpenerFocus } from '@/composables/useOpenerFocus';
import ConfirmDialogLayout from './ConfirmDialogLayout.vue';
import type { PermissionUpdateDestination, PermissionBehavior } from '@shared/types/permissions';

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  pattern: string;
  behavior?: PermissionBehavior;
}>();

const titleKey = computed(() =>
  props.behavior === 'deny' ? 'permission.destination.titleDeny' : 'permission.destination.title'
);

const descriptionKey = computed(() =>
  props.behavior === 'deny' ? 'permission.destination.descriptionDeny' : 'permission.destination.description'
);

const emit = defineEmits<{
  (e: 'select', destination: PermissionUpdateDestination): void;
  (e: 'cancel'): void;
}>();

const returnFocus = useOpenerFocus(() => props.open);

const destinations = [
  {
    value: 'localSettings' as const,
    labelKey: 'permission.destination.local',
    descriptionKey: 'permission.destination.localDesc',
    icon: User,
  },
  {
    value: 'projectSettings' as const,
    labelKey: 'permission.destination.project',
    descriptionKey: 'permission.destination.projectDesc',
    icon: FolderGit,
  },
  {
    value: 'userSettings' as const,
    labelKey: 'permission.destination.global',
    descriptionKey: 'permission.destination.globalDesc',
    icon: Globe,
  },
];
</script>

<template>
  <AlertDialog
    :open="open"
    @update:open="(next: boolean) => !next && emit('cancel')"
  >
    <AlertDialogContent
      class="max-w-md gap-0 overflow-hidden p-0"
      data-testid="permission-destination-picker"
      @close-auto-focus="returnFocus"
    >
      <ConfirmDialogLayout
        :icon="behavior === 'deny' ? ShieldX : ShieldCheck"
        :tone="behavior === 'deny' ? 'danger' : 'accent'"
        :title="t(titleKey)"
      >
        <template #description>
          {{ t(descriptionKey) }}
          <span class="rounded-5 bg-(--d-hover) px-1.5 font-mono text-xs break-all text-(--d-accent-text)">{{ pattern }}</span>
        </template>

        <div class="flex flex-col gap-2">
          <button
            v-for="dest in destinations"
            :key="dest.value"
            type="button"
            class="d-press flex items-center gap-2.5 rounded-11 border border-(--d-border) bg-(--d-card) px-3 py-2.5 text-left transition-colors hover:border-(--d-accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
            :data-testid="`permission-destination-${dest.value}`"
            @click="emit('select', dest.value)"
          >
            <span
              class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)"
              aria-hidden="true"
            >
              <component
                :is="dest.icon"
                class="size-3.5"
              />
            </span>
            <span class="flex min-w-0 flex-col">
              <span class="text-13 font-medium">{{ t(dest.labelKey) }}</span>
              <span class="text-xs text-(--d-muted)">{{ t(dest.descriptionKey) }}</span>
            </span>
          </button>
        </div>

        <template #footer>
          <button
            type="button"
            class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
            data-testid="permission-destination-cancel"
            @click="emit('cancel')"
          >
            {{ t('permission.destination.cancel') }}
          </button>
        </template>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
</template>
