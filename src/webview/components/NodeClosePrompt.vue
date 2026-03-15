<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import LoadingSpinner from './LoadingSpinner.vue';
import { useNodeStore } from '@/stores/useNodeStore';

const { t } = useI18n();
const store = useNodeStore();
</script>

<template>
  <div
    v-if="store.showClosePrompt"
    class="flex items-center justify-between gap-3 px-4 py-2 bg-muted/60 border-t border-border text-sm"
  >
    <span class="text-muted-foreground truncate">
      "<span class="font-medium text-foreground">{{ store.closePromptTitle }}</span>" — {{ t('nodePicker.closeTask') }}
    </span>
    <div class="flex items-center gap-2 shrink-0">
      <template v-if="store.isClosingNode">
        <LoadingSpinner :size="14" />
        <span class="text-xs text-muted-foreground">{{ t('nodePicker.closingTask') }}</span>
      </template>
      <template v-else>
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="store.dismissClosePrompt()">
          {{ t('common.dismiss') }}
        </Button>
        <Button size="sm" class="h-7 px-3 text-xs" @click="store.confirmCloseNode()">
          {{ t('common.yes') }}
        </Button>
      </template>
    </div>
  </div>
</template>
