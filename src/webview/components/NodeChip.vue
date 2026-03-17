<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { IconChevronDown, IconCheck, IconPlus } from '@/components/icons';
import { useNodeFormatting } from '@/composables/useNodeFormatting';
import type { TaskNodeDisplay } from '@shared/types/recall';

const props = defineProps<{
  activeNode: TaskNodeDisplay | null;
  activeNodes: TaskNodeDisplay[];
  canCreateNew: boolean;
  pendingNewNode: boolean;
  disabled: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', nodeId: string): void;
  (e: 'create-new'): void;
}>();

const { t } = useI18n();
const { formatAge } = useNodeFormatting();

function handleSelect(nodeId: string): void {
  emit('select', nodeId);
}

function handleCreateNew(): void {
  emit('create-new');
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <button
        class="flex items-center gap-1.5 text-xs leading-none px-2 py-1 rounded border transition-colors cursor-pointer"
        :class="[pendingNewNode
          ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/15'
          : activeNode
            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/15'
            : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/15 animate-pulse',
          { 'opacity-50 pointer-events-none': disabled }]"
        :disabled="disabled"
        :aria-disabled="disabled"
      >
        <span
          class="w-1.5 h-1.5 rounded-full shrink-0"
          :class="pendingNewNode ? 'bg-indigo-500' : activeNode ? 'bg-emerald-500' : 'bg-amber-500'"
        />
        <span class="max-w-[10rem] truncate">
          {{ pendingNewNode ? t('nodeChip.newTask') : activeNode ? activeNode.title : t('nodeChip.selectTask') }}
        </span>
        <IconChevronDown :size="10" class="shrink-0 opacity-60" />
      </button>
    </PopoverTrigger>
    <PopoverContent class="w-[16.25rem] p-0" side="top" :side-offset="6">
      <div v-if="activeNodes.length > 0" class="max-h-[14rem] overflow-y-auto p-1.5">
        <button
          v-for="node in activeNodes"
          :key="node.nodeId"
          type="button"
          class="w-full text-left rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/60 cursor-pointer flex items-center gap-2"
          @click="handleSelect(node.nodeId)"
        >
          <IconCheck
            v-if="activeNode?.nodeId === node.nodeId"
            :size="12"
            class="shrink-0 text-emerald-400"
          />
          <span v-else class="w-3 shrink-0" />
          <div class="flex-1 min-w-0">
            <span class="text-foreground truncate block">{{ node.title }}</span>
            <span class="text-muted-foreground/60">
              {{ t('nodeOverlay.turnsBadge', { count: node.turnCount }) }} · {{ formatAge(node.lastActivity ?? node.createdAt) }}
            </span>
          </div>
        </button>
      </div>

      <div :class="activeNodes.length > 0 ? 'border-t border-border/40 p-1.5' : 'p-1.5'">
        <Button
          variant="ghost"
          size="sm"
          class="w-full h-7 px-2.5 text-xs gap-1.5 justify-start"
          :class="canCreateNew
            ? 'text-primary hover:text-primary'
            : 'text-muted-foreground/40 cursor-not-allowed'"
          :disabled="!canCreateNew"
          @click="handleCreateNew"
        >
          <IconPlus :size="12" />
          {{ canCreateNew ? t('nodeChip.createNew') : t('nodeChip.maxNodes') }}
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
