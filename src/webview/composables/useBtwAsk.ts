import { useBtwStore } from '@/stores/useBtwStore';
import { usePlatformBridge } from './usePlatformBridge';

/** Starts a side question; a running aside is cancelled first, since the panel shows one aside at a time. */
export function useBtwAsk(): (question: string) => void {
  const btwStore = useBtwStore();
  const { postMessage } = usePlatformBridge();

  return (question: string) => {
    if (btwStore.aside?.isStreaming) postMessage({ type: 'cancelBtw', btwId: btwStore.aside.id });
    const btwId = `btw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    btwStore.addAside(btwId, question);
    postMessage({ type: 'sendBtw', btwId, question });
  };
}
