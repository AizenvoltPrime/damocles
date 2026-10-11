let osQuery: MediaQueryList | undefined;

/** Whether motion is reduced: the host's setting (the root's data-reduced-motion) or the OS's, read live. */
export function prefersReducedMotion(): boolean {
  if (document.documentElement.hasAttribute('data-reduced-motion')) return true;
  osQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return osQuery.matches;
}

/** Mirrors VS Code's workbench.reduceMotion, which VS Code reports as body's vscode-reduce-motion class, onto data-reduced-motion. */
export function mirrorVsCodeReduceMotion(): void {
  const apply = () => document.documentElement.toggleAttribute('data-reduced-motion', document.body.classList.contains('vscode-reduce-motion'));
  apply();
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
