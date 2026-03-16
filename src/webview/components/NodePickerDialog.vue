<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import LoadingSpinner from './LoadingSpinner.vue';
import { IconLayers, IconPlus, IconCheck } from '@/components/icons';
import { useNodeStore } from '@/stores/useNodeStore';

const { t } = useI18n();
const store = useNodeStore();

const isCreatingNode = ref(false);

const isOpen = computed(() => store.isPickerOpen);
const selectedNodeId = computed({
  get: () => _selectedNodeId.value ?? store.pickerPreSelectedNodeId,
  set: (v) => { _selectedNodeId.value = v; },
});
const _selectedNodeId = ref<string | null>(null);

watch(isOpen, (open) => {
  if (open) {
    _selectedNodeId.value = null;
    isCreatingNode.value = false;
  }
});

const activeNodes = computed(() => store.pickerNodes);
const canCreateNew = computed(() => store.pickerCanCreateNew);
const createdPreview = computed(() => store.createdPreview);

function selectNode(nodeId: string): void {
  selectedNodeId.value = nodeId;
}

function confirmSelection(): void {
  if (!selectedNodeId.value) return;
  store.selectNode(selectedNodeId.value);
}

function requestNewNode(): void {
  if (isCreatingNode.value) return;
  _selectedNodeId.value = null;
  isCreatingNode.value = true;
  store.requestNewNode();
}

function confirmNewNode(): void {
  if (!createdPreview.value) return;
  store.selectNode(createdPreview.value.nodeId);
}

function cancel(): void {
  _selectedNodeId.value = null;
  isCreatingNode.value = false;
  store.cancelPicker();
}

function onOpenChange(open: boolean): void {
  if (!open) cancel();
}
</script>

<template>
  <Dialog :open="isOpen" @update:open="onOpenChange">
    <DialogContent class="max-w-[26.25rem] p-0 gap-0 overflow-hidden border-border/40 [&>button:last-child]:hidden">
      <div class="px-5 pt-5 pb-3">
        <div class="flex items-center gap-3">
          <div class="flex items-center justify-center size-9 rounded-lg bg-primary/10">
            <IconLayers :size="18" class="text-primary" />
          </div>
          <div>
            <h2 class="text-sm font-semibold text-foreground leading-tight">{{ t('nodePicker.title') }}</h2>
            <p class="text-xs text-muted-foreground mt-0.5">{{ t('nodePicker.subtitle') }}</p>
          </div>
        </div>
      </div>

      <div class="border-t border-border/40" />

      <ScrollArea v-if="!isCreatingNode && !createdPreview && activeNodes.length > 0" class="max-h-[17.5rem]">
        <div class="p-3 space-y-1.5">
          <button
            v-for="node in activeNodes"
            :key="node.nodeId"
            type="button"
            class="group w-full text-left rounded-lg p-3 transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-primary/40 select-none cursor-pointer"
            :class="selectedNodeId === node.nodeId
              ? 'bg-primary/8 ring-1 ring-primary/30'
              : 'hover:bg-muted/60'"
            @click="selectNode(node.nodeId)"
            @dblclick="() => { selectNode(node.nodeId); confirmSelection(); }"
          >
            <div class="flex items-start gap-3">
              <div
                class="mt-0.5 flex items-center justify-center size-5 rounded-full border-2 transition-colors duration-150 shrink-0"
                :class="selectedNodeId === node.nodeId
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground/30 group-hover:border-muted-foreground/50'"
              >
                <IconCheck
                  v-if="selectedNodeId === node.nodeId"
                  :size="10"
                  class="text-primary-foreground"
                />
              </div>

              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm font-medium text-foreground truncate">{{ node.title }}</span>
                  <div class="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground tabular-nums">
                    <span>{{ t('nodePicker.turnCount', { n: node.turnCount }) }}</span>
                    <span class="opacity-40">&middot;</span>
                    <span>{{ node.lastActivityAge }}</span>
                  </div>
                </div>

                <div v-if="node.entityTags.length > 0" class="flex flex-wrap gap-1 mt-1.5">
                  <Badge
                    v-for="tag in node.entityTags.slice(0, 5)"
                    :key="tag"
                    variant="secondary"
                    class="text-xs px-1.5 py-0 font-normal opacity-70"
                  >
                    {{ tag }}
                  </Badge>
                  <span
                    v-if="node.entityTags.length > 5"
                    class="text-xs text-muted-foreground/50 self-center"
                  >
                    +{{ node.entityTags.length - 5 }}
                  </span>
                </div>
              </div>
            </div>
          </button>
        </div>
      </ScrollArea>

      <div v-if="!isCreatingNode && !createdPreview && activeNodes.length > 0" class="border-t border-border/40" />

      <div class="p-3">
        <button
          v-if="!isCreatingNode && !createdPreview"
          type="button"
          class="w-full text-left rounded-lg border border-dashed p-3 transition-all duration-150 outline-none select-none"
          :class="canCreateNew
            ? 'border-primary/30 hover:border-primary/60 hover:bg-primary/5 cursor-pointer'
            : 'border-border/40 opacity-40 cursor-not-allowed'"
          :disabled="!canCreateNew"
          @click="canCreateNew && requestNewNode()"
        >
          <div class="flex items-center gap-2.5">
            <div class="flex items-center justify-center size-7 rounded-md bg-primary/10">
              <IconPlus :size="14" class="text-primary" />
            </div>
            <div>
              <span class="text-sm font-medium text-foreground">{{ t('nodePicker.newTask') }}</span>
              <p v-if="canCreateNew" class="text-xs text-muted-foreground mt-0.5">
                {{ t('nodePicker.newTaskHint') }}
              </p>
              <p v-else class="text-xs text-muted-foreground/60 mt-0.5">
                {{ t('nodePicker.maxNodesHint') }}
              </p>
            </div>
          </div>
        </button>

        <div
          v-else-if="isCreatingNode && !createdPreview"
          class="w-full rounded-lg border border-primary/20 bg-primary/5 p-3"
        >
          <div class="flex items-center gap-2.5">
            <LoadingSpinner :size="14" />
            <span class="text-xs text-muted-foreground">{{ t('nodePicker.generatingTitle') }}</span>
          </div>
        </div>

        <button
          v-else-if="createdPreview"
          type="button"
          class="w-full text-left rounded-lg p-3 transition-all duration-150 cursor-pointer outline-none select-none bg-primary/8 ring-1 ring-primary/30"
          @click="confirmNewNode"
        >
          <div class="flex items-start gap-3">
            <div class="mt-0.5 flex items-center justify-center size-5 rounded-full border-2 border-primary bg-primary shrink-0">
              <IconCheck :size="10" class="text-primary-foreground" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-medium text-foreground">{{ createdPreview.title }}</span>
                <Badge variant="outline" class="text-xs border-primary/40 text-primary font-normal shrink-0">
                  {{ t('nodePicker.newBadge') }}
                </Badge>
              </div>
              <div v-if="createdPreview.keyEntities.length > 0" class="flex flex-wrap gap-1 mt-1.5">
                <Badge
                  v-for="tag in createdPreview.keyEntities"
                  :key="tag"
                  variant="secondary"
                  class="text-xs px-1.5 py-0 font-normal opacity-70"
                >
                  {{ tag }}
                </Badge>
              </div>
              <p class="text-xs text-primary/70 mt-1.5">{{ t('nodePicker.confirmNewNode') }}</p>
            </div>
          </div>
        </button>
      </div>

      <div v-if="!(isCreatingNode && !createdPreview)" class="flex items-center justify-end gap-2 px-4 py-3 bg-muted/30 border-t border-border/40">
        <Button variant="ghost" size="sm" class="h-8 px-3 text-xs" @click="cancel">
          {{ t('common.cancel') }}
        </Button>
        <Button
          v-if="selectedNodeId && !createdPreview"
          size="sm"
          class="h-8 px-4 text-xs"
          @click="confirmSelection"
        >
          {{ t('nodePicker.continue') }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
