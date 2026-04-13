import { ref, watch, onUnmounted, type Ref } from 'vue';

export function useAutoScroll(
  containerRef: Ref<HTMLElement | null>,
  isActive: Ref<boolean>
) {
  const wasAtBottom = ref(true);
  let rafId: number | null = null;
  let mutationObserver: MutationObserver | null = null;

  function isAtBottom(container: HTMLElement): boolean {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  }

  function scrollToBottom(container: HTMLElement) {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
      rafId = null;
    });
  }

  function handleMutation() {
    const container = containerRef.value;
    if (!container || !isActive.value || !wasAtBottom.value) return;
    scrollToBottom(container);
  }

  function updateBottomState() {
    const container = containerRef.value;
    if (container) {
      wasAtBottom.value = isAtBottom(container);
    }
  }

  watch(isActive, (active) => {
    const container = containerRef.value;
    if (!container) return;

    if (active) {
      scrollToBottom(container);
      wasAtBottom.value = true;

      if (!mutationObserver) {
        mutationObserver = new MutationObserver(handleMutation);
      }
      mutationObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style'],
      });
    } else {
      mutationObserver?.disconnect();
    }
  });

  watch(
    containerRef,
    (container, prevContainer) => {
      if (prevContainer) prevContainer.removeEventListener('scroll', updateBottomState);
      if (container) container.addEventListener('scroll', updateBottomState, { passive: true });
    },
    { immediate: true }
  );

  onUnmounted(() => {
    containerRef.value?.removeEventListener('scroll', updateBottomState);
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
}
