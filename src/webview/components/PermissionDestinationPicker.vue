<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { User, FolderGit, Globe } from 'lucide-vue-next';
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
  <Dialog :open="open" @update:open="(v) => !v && emit('cancel')">
    <DialogContent class="max-w-md" @escape-key-down="emit('cancel')">
      <DialogHeader>
        <DialogTitle>{{ t(titleKey) }}</DialogTitle>
        <DialogDescription>
          {{ t(descriptionKey) }}
          <code class="bg-muted px-1 rounded text-xs">{{ pattern }}</code>
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-2 mt-4">
        <Button
          v-for="dest in destinations"
          :key="dest.value"
          variant="outline"
          class="h-auto py-3 justify-start text-left"
          @click="emit('select', dest.value)"
        >
          <component :is="dest.icon" class="w-4 h-4 mr-3 shrink-0" />
          <div class="flex flex-col">
            <span class="font-medium">{{ t(dest.labelKey) }}</span>
            <span class="text-xs text-muted-foreground">{{ t(dest.descriptionKey) }}</span>
          </div>
        </Button>
      </div>

      <div class="flex justify-end mt-4">
        <Button variant="ghost" @click="emit('cancel')">{{ t('permission.destination.cancel') }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
