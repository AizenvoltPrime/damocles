/** Whether motion is reduced (the app's setting or the OS's), for motion that script drives and CSS cannot stop. */
export function reducedMotion(): boolean {
  return document.documentElement.hasAttribute('data-reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
