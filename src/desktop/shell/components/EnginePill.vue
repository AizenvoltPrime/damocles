<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { RotateCw } from 'lucide-vue-next';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import { Button } from '@/components/ui/button';

defineProps<{ api: DamoclesShellApi; halted: boolean }>();
const { t } = useI18n();
</script>

<template>
  <Transition name="engine-pill">
    <Button
      v-if="halted"
      type="button"
      variant="outline"
      size="sm"
      data-testid="engine-pill"
      class="title-bar-control d-press mr-1.5 flex h-6 shrink-0 gap-1.5 rounded-full border-(--d-danger)/45 bg-transparent px-2.5 text-11.5 font-medium text-(--d-danger-text) hover:border-(--d-danger) hover:bg-transparent hover:text-(--d-danger-text) [&_svg]:size-3.25"
      :title="t('engine.stoppedTitle')"
      :aria-label="t('engine.restartLabel')"
      @click="api.restartEngine()"
    >
      <RotateCw
        aria-hidden="true"
        class="size-3.25 shrink-0"
      />
      <span>{{ t('engine.stopped') }}</span>
    </Button>
  </Transition>
</template>
