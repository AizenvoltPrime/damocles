import { computed, type ComputedRef } from 'vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDesignStore } from '@/stores/useDesignStore';

/** Open in browser for a design file: shown only where the host's rule set opens designs from the chat (PD-35). */
export function useOpenDesignInBrowser(): { available: ComputedRef<boolean>; open: (designId: string, relPath: string) => void } {
  const designStore = useDesignStore();
  const { postMessage } = usePlatformBridge();
  return {
    available: computed(() => designStore.openInBrowser),
    // `relPath` is relative to the design folder; core serves only a file of the panel's own design.
    open: (designId, relPath) => postMessage({ type: 'openDesignInBrowser', designId, relPath }),
  };
}
