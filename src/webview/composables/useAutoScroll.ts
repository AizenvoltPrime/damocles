import { ref, computed, watch, onUnmounted, type Ref } from 'vue';

export function useAutoScroll(
  containerRef: Ref<HTMLElement | null>,
  isActive: Ref<boolean>
) {
  const wasAtBottom = ref(true);
  const manualPin = ref(false);
  const active = computed(() => isActive.value || manualPin.value);
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
    if (!container || !active.value || !wasAtBottom.value) return;
    scrollToBottom(container);
  }

  function updateBottomState() {
    const container = containerRef.value;
    if (container) {
      wasAtBottom.value = isAtBottom(container);
      if (manualPin.value && !wasAtBottom.value) manualPin.value = false;
    }
  }

  watch(active, (on) => {
    const container = containerRef.value;
    if (!container) return;

    if (on) {
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

  function pinToBottom() {
    const container = containerRef.value;
    if (!container) return;
    manualPin.value = true;
    wasAtBottom.value = true;
    scrollToBottom(container);
  }

  onUnmounted(() => {
    containerRef.value?.removeEventListener('scroll', updateBottomState);
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  return { pinToBottom };
}
