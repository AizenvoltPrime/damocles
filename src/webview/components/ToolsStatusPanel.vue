<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolsSnapshot, ToolGroup, ToolStatusInfo, ToolGroupStatus } from '@shared/types/tools';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { IconChevronDown, IconChevronRight } from '@/components/icons';

const { t } = useI18n();

const props = defineProps<{
  snapshot: ToolsSnapshot;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggle', toolName: string, enabled: boolean): void;
  (e: 'toggleGroup', group: ToolGroup, enabled: boolean): void;
}>();

const GROUP_ORDER: ToolGroup[] = ['memory', 'compass', 'browser', 'web', 'core'];

const collapsed = ref<Partial<Record<ToolGroup, boolean>>>({ browser: true });

function toggleCollapsed(group: ToolGroup): void {
  collapsed.value = { ...collapsed.value, [group]: !collapsed.value[group] };
}

interface GroupView {
  group: ToolGroup;
  status: ToolGroupStatus | undefined;
  tools: ToolStatusInfo[];
}

const groups = computed<GroupView[]>(() =>
  GROUP_ORDER.map((group) => ({
    group,
    status: props.snapshot.groups.find((g) => g.group === group),
    tools: props.snapshot.tools.filter((tool) => tool.group === group),
  })).filter((view) => view.tools.length > 0),
);

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.visible) {
    e.stopPropagation();
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <Dialog
    :open="visible"
    @update:open="(open: boolean) => !open && emit('close')"
  >
    <DialogContent class="bg-card border-border max-w-md max-h-[32rem] overflow-hidden flex flex-col">
      <DialogHeader class="shrink-0 pr-8">
        <DialogTitle>{{ t('tools.title') }}</DialogTitle>
        <DialogDescription>{{ t('tools.description') }}</DialogDescription>
      </DialogHeader>

      <div class="flex-1 overflow-y-auto py-2 space-y-3">
        <div
          v-for="view in groups"
          :key="view.group"
          class="rounded-md border border-border bg-background"
        >
          <div class="flex items-center justify-between gap-2 px-3 py-2">
            <button
              type="button"
              class="flex items-center gap-1.5 min-w-0 flex-1 text-left"
              @click="toggleCollapsed(view.group)"
            >
              <component
                :is="collapsed[view.group] ? IconChevronRight : IconChevronDown"
                :size="14"
                class="shrink-0 text-muted-foreground"
              />
              <span class="font-medium truncate">{{ t(`tools.group.${view.group}`) }}</span>
              <span class="text-xs text-muted-foreground">{{ view.tools.length }}</span>
            </button>
            <Switch
              v-if="view.group !== 'core' && view.status"
              :checked="view.status.enabled"
              :disabled="!view.status.available"
              @update:checked="(checked: boolean) => emit('toggleGroup', view.group, checked)"
            />
          </div>

          <div
            v-show="!collapsed[view.group]"
            class="border-t border-border divide-y divide-border"
          >
            <div
              v-for="tool in view.tools"
              :key="tool.name"
              class="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div class="min-w-0 flex-1">
                <div
                  class="text-sm truncate"
                  :class="{ 'opacity-50': !tool.enabled }"
                >
                  {{ tool.label }}
                </div>
                <div
                  v-if="tool.description"
                  class="text-xs text-muted-foreground truncate"
                >
                  {{ tool.description }}
                </div>
              </div>
              <Switch
                :checked="tool.enabled"
                :disabled="!tool.toggleable || (view.status ? !view.status.enabled : false)"
                @update:checked="(checked: boolean) => emit('toggle', tool.name, checked)"
              />
            </div>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
