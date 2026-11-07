import { computed, type ComputedRef } from 'vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDesignStore } from '@/stores/useDesignStore';

/** Open preview for a design screen: shown only where the host's rule set has the preview tab (PD-35, desktop). */
export function useOpenDesignPreview(): { available: ComputedRef<boolean>; open: (designId: string, relPath: string) => void } {
  const designStore = useDesignStore();
  const { postMessage } = usePlatformBridge();
  return {
    available: computed(() => designStore.openPreview),
    // `relPath` is relative to the design folder; core opens only a screen of a design the panel holds.
    open: (designId, relPath) => postMessage({ type: 'openDesignPreview', designId, relPath }),
  };
}
