<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { IconCheckCircle, IconWarning, IconXCircle } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useNodeStore } from '@/stores/useNodeStore';
import { useNodeFormatting } from '@/composables/useNodeFormatting';
import type { TaskNodeDisplay } from '@shared/types/recall';

const props = defineProps<{
  node: TaskNodeDisplay;
  isClosing: boolean;
  isDefault?: boolean;
}>();
const { t } = useI18n();
const store = useNodeStore();
const { formatAge, outcomeBadgeClass } = useNodeFormatting();

const closePopoverOpen = ref(false);

const isActive = computed(() => props.node.status === 'ACTIVE');

const stripeClass = computed(() => {
  if (isActive.value) return 'bg-emerald-500';
  switch (props.node.summary?.outcome) {
    case 'resolved': return 'bg-emerald-500';
    case 'partial': return 'bg-amber-500';
    case 'abandoned': return 'bg-red-500';
    default: return 'bg-muted-foreground/30';
  }
});

function handleClose(outcome: 'resolved' | 'partial' | 'abandoned') {
  closePopoverOpen.value = false;
  store.closeNodeFromDashboard(props.node.nodeId, outcome);
}
</script>

<template>
  <div
    :data-node-id="node.nodeId"
    class="w-[16.25rem] overflow-hidden rounded-lg border border-border shadow-sm transition-shadow hover:shadow-md bg-card text-card-foreground cursor-pointer"
    @click="store.viewNodeDetail(node.nodeId)"
  >
    <div class="h-[3px] rounded-t-lg" :class="stripeClass" />

    <div class="flex flex-col gap-1.5 p-2.5">
      <div class="flex items-center gap-2">
        <div class="shrink-0">
          <div v-if="isActive" class="w-2.5 h-2.5 rounded-full bg-emerald-500" />
          <IconCheckCircle v-else-if="node.summary?.outcome === 'resolved'" :size="12" class="text-emerald-400" />
          <IconWarning v-else-if="node.summary?.outcome === 'partial'" :size="12" class="text-amber-400" />
          <IconXCircle v-else-if="node.summary?.outcome === 'abandoned'" :size="12" class="text-red-400" />
          <div v-else class="w-2.5 h-2.5 rounded-full bg-muted-foreground/30" />
        </div>
        <span class="text-xs font-medium text-foreground truncate flex-1">{{ node.title }}</span>
        <Badge
          v-if="isDefault && isActive"
          variant="outline"
          class="text-xs leading-none px-1.5 py-0.5 shrink-0 rounded-full border-primary/50 text-primary"
        >
          {{ t('nodeOverlay.default') }}
        </Badge>
        <Badge
          v-if="!isActive && node.summary?.outcome"
          variant="outline"
          class="text-xs leading-none px-1.5 py-0.5 shrink-0 rounded-full"
          :class="outcomeBadgeClass(node.summary.outcome)"
        >
          {{ t(`nodeOverlay.${node.summary.outcome}`) }}
        </Badge>
      </div>

      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        <span class="tabular-nums">{{ t('nodeOverlay.turnsBadge', { count: node.turnCount }) }}</span>
        <span>{{ formatAge(node.lastActivity ?? node.createdAt) }}</span>
      </div>

      <div v-if="node.keyEntities.length > 0" class="flex flex-wrap gap-0.5 min-w-0">
        <Badge
          v-for="tag in node.keyEntities.slice(0, 5)"
          :key="tag"
          variant="secondary"
          class="text-xs leading-none px-1.5 py-0.5 max-w-full truncate"
        >
          {{ tag }}
        </Badge>
      </div>

      <div class="flex justify-end mt-0.5 gap-1" @click.stop>
        <template v-if="isClosing">
          <LoadingSpinner :size="14" />
        </template>
        <template v-else-if="isActive">
          <Button
            v-if="!isDefault"
            variant="ghost"
            size="sm"
            class="h-6 px-2 text-xs text-muted-foreground hover:text-primary"
            @click="store.setActiveNode(node.nodeId)"
          >
            {{ t('nodeOverlay.setDefault') }}
          </Button>
          <Popover v-model:open="closePopoverOpen">
            <PopoverTrigger as-child>
              <Button variant="ghost" size="sm" class="h-6 px-2 text-xs text-muted-foreground hover:text-foreground">
                {{ t('nodeOverlay.closeAction') }}
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-auto p-1.5" side="bottom" :side-offset="4">
              <div class="flex flex-col gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs gap-1.5 justify-start text-emerald-400 hover:text-emerald-300"
                  @click="handleClose('resolved')"
                >
                  <IconCheckCircle :size="12" />
                  {{ t('nodeOverlay.resolved') }}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs gap-1.5 justify-start text-amber-400 hover:text-amber-300"
                  @click="handleClose('partial')"
                >
                  <IconWarning :size="12" />
                  {{ t('nodeOverlay.partial') }}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs gap-1.5 justify-start text-red-400 hover:text-red-300"
                  @click="handleClose('abandoned')"
                >
                  <IconXCircle :size="12" />
                  {{ t('nodeOverlay.abandoned') }}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </template>
        <template v-else>
          <Button
            variant="ghost"
            size="sm"
            class="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            @click="store.reopenNode(node.nodeId)"
          >
            {{ t('nodeOverlay.reopen') }}
          </Button>
        </template>
      </div>
    </div>
  </div>
</template>
