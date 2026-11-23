import type { ShellPageMotion } from '../../preload/shell-channels';

// What the page knows that main uses to pause moving wallpapers (docs/invariants.md "Desktop themes"): Chromium sets
// document.visibilityState hidden while another window covers this one (native occlusion tracking) or it is minimized, and
// prefers-reduced-motion follows the OS. Reported on load and on each change; returns the unsubscribe.
export function watchPageMotion(report: (motion: ShellPageMotion) => void): () => void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const send = (): void => report({ visible: document.visibilityState === 'visible', reducedMotion: query.matches });
  document.addEventListener('visibilitychange', send);
  query.addEventListener('change', send);
  send();
  return () => {
    document.removeEventListener('visibilitychange', send);
    query.removeEventListener('change', send);
  };
}
