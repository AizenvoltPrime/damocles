<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Globe, Monitor } from 'lucide-vue-next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useOpenDesignInBrowser } from '@/composables/useOpenDesignInBrowser';
import { useOpenDesignPreview } from '@/composables/useOpenDesignPreview';
import { useDesignStore } from '@/stores/useDesignStore';
import { DESIGN_MENU_CONTENT, DESIGN_MENU_ITEM, DESIGN_MENU_LABEL, DESIGN_MENU_STATUS } from './design-menu';

// Open in browser or Open preview for a design: its trigger (the slot) opens a menu of the design's screens, and the one picked
// opens in the user's browser or in the desktop preview tab.
const props = defineProps<{ designId: string; target: 'browser' | 'preview' }>();
const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const designStore = useDesignStore();
const inBrowser = useOpenDesignInBrowser();
const inPreview = useOpenDesignPreview();

const SCREEN = /^screens\/[^/]+\.html$/i;
const fileList = computed(() => designStore.fileLists[props.designId]);
const screens = computed(() => (fileList.value?.files ?? []).filter((file) => SCREEN.test(file.path)));

function onOpenChange(open: boolean): void {
  if (!open) return;
  designStore.filesRequested(props.designId);
  postMessage({ type: 'requestDesignFiles', designId: props.designId });
}

function openScreen(file: string): void {
  (props.target === 'preview' ? inPreview : inBrowser).open(props.designId, file);
}
</script>

<template>
  <DropdownMenu @update:open="onOpenChange">
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      :class="['w-72 max-w-[calc(100vw-2rem)]', DESIGN_MENU_CONTENT]"
      data-testid="design-screens"
      :data-target="target"
    >
      <DropdownMenuLabel :class="[DESIGN_MENU_LABEL, 'font-semibold tracking-[.06em] uppercase']">
        {{ t('design.browser.screens') }}
      </DropdownMenuLabel>
      <DropdownMenuItem
        v-if="!fileList?.loaded"
        disabled
        :class="DESIGN_MENU_STATUS"
      >
        {{ t('design.header.filesLoading') }}
      </DropdownMenuItem>
      <DropdownMenuItem
        v-else-if="fileList.failed"
        disabled
        :class="[DESIGN_MENU_STATUS, 'text-(--d-danger-text)']"
      >
        {{ t('design.header.filesFailed') }}
      </DropdownMenuItem>
      <DropdownMenuItem
        v-else-if="screens.length === 0"
        disabled
        :class="DESIGN_MENU_STATUS"
        data-testid="design-no-screens"
      >
        {{ t('design.browser.noScreens') }}
      </DropdownMenuItem>
      <div
        v-else
        class="max-h-64 overflow-y-auto"
      >
        <DropdownMenuItem
          v-for="screen in screens"
          :key="screen.path"
          :class="DESIGN_MENU_ITEM"
          :text-value="screen.path.slice('screens/'.length)"
          :aria-label="target === 'preview' ? t('design.preview.openScreen', { file: screen.path }) : t('design.browser.openScreen', { file: screen.path })"
          data-testid="design-screen"
          @select="openScreen(screen.path)"
        >
          <component
            :is="target === 'preview' ? Monitor : Globe"
            class="text-(--d-design)"
            aria-hidden="true"
          />
          <span
            class="min-w-0 flex-1 truncate font-mono text-11.5"
            dir="ltr"
          >{{ screen.path }}</span>
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
