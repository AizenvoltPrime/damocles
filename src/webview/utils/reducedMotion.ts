import { onScopeDispose, readonly, ref, type Ref } from 'vue';

let osQuery: MediaQueryList | undefined;

/** Whether motion is reduced: the host's setting (the root's data-reduced-motion) or the OS's, read live. */
export function prefersReducedMotion(): boolean {
  if (document.documentElement.hasAttribute('data-reduced-motion')) return true;
  osQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return osQuery.matches;
}

/** `prefersReducedMotion` as a ref that follows the host's setting and the OS's while its scope lives. */
export function useReducedMotion(): Readonly<Ref<boolean>> {
  const reduced = ref(prefersReducedMotion());
  const update = (): void => {
    reduced.value = prefersReducedMotion();
  };
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] });
  const query = osQuery;
  query?.addEventListener?.('change', update);
  onScopeDispose(() => {
    observer.disconnect();
    query?.removeEventListener?.('change', update);
  });
  return readonly(reduced);
}

/** Mirrors VS Code's workbench.reduceMotion, which VS Code reports as body's vscode-reduce-motion class, onto data-reduced-motion. */
export function mirrorVsCodeReduceMotion(): void {
  const apply = () => document.documentElement.toggleAttribute('data-reduced-motion', document.body.classList.contains('vscode-reduce-motion'));
  apply();
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
