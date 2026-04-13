import { ref, watch, onUnmounted, type Ref } from 'vue';

export function useStickyMessages(scrollContainerRef: Ref<HTMLElement | null>) {
  const stuckMessageIds = ref(new Set<string>());
  const elToId = new Map<HTMLElement, string>();
  const idToEl = new Map<string, HTMLElement>();
  let observer: IntersectionObserver | null = null;

  function createObserver(root: HTMLElement) {
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        const next = new Set(stuckMessageIds.value);
        for (const entry of entries) {
          const id = elToId.get(entry.target as HTMLElement);
          if (!id) continue;
          const rootTop = entry.rootBounds?.top ?? 0;
          if (!entry.isIntersecting && entry.boundingClientRect.top < rootTop) {
            next.add(id);
          } else {
            next.delete(id);
          }
        }
        stuckMessageIds.value = next;
      },
      { root, rootMargin: '-1px 0px 0px 0px', threshold: [0] }
    );
    for (const el of elToId.keys()) observer.observe(el);
  }

  function registerSentinel(messageId: string, el: HTMLElement | null) {
    const prev = idToEl.get(messageId);
    if (prev) { observer?.unobserve(prev); elToId.delete(prev); }
    idToEl.delete(messageId);
    if (el) {
      elToId.set(el, messageId);
      idToEl.set(messageId, el);
      observer?.observe(el);
    } else {
      const next = new Set(stuckMessageIds.value);
      if (next.delete(messageId)) stuckMessageIds.value = next;
    }
  }

  function scrollToOriginal(messageId: string) {
    idToEl.get(messageId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  watch(scrollContainerRef, (container) => {
    if (container) createObserver(container);
    else { observer?.disconnect(); observer = null; }
  }, { immediate: true });

  onUnmounted(() => {
    observer?.disconnect();
    observer = null;
    elToId.clear();
    idToEl.clear();
  });

  return { stuckMessageIds, registerSentinel, scrollToOriginal };
}
