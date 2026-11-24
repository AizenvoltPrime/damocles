import { nextTick, type App } from 'vue';

export const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Two frames: the first lays out and paints, the second has the painted frame ready for main's capture. */
export async function painted(): Promise<void> {
  await frame();
  await frame();
}

/**
 * Mounts a drawing of `apps` into `host` through `mount` and settles once it is painted: rendered, fonts loaded, what `mount`
 * returned settled (the drawing's own wait), every image decoded, two frames later. Rejects with an AggregateError of everything
 * that failed until then: an error Vue caught in a component, an uncaught error or an unhandled rejection in the page, an image
 * or a font face that did not load, and what `mount` or its wait threw.
 */
export async function settled(label: string, host: HTMLElement, apps: readonly App[], mount: () => (() => Promise<void>) | undefined): Promise<void> {
  const failures: unknown[] = [];
  const listening = new AbortController();
  const { signal } = listening;
  const unloaded = (image: HTMLImageElement, cause?: unknown): Error => new Error(`${label}'s image ${image.currentSrc || image.src} did not load`, { cause });
  for (const app of apps) app.config.errorHandler = (err) => void failures.push(err);
  // capture: an image's error event does not bubble, and a component may show something else in its place (ProjectAvatar's letter)
  host.addEventListener('error', (event) => {
    if (event.target instanceof HTMLImageElement) failures.push(unloaded(event.target));
  }, { capture: true, signal });
  window.addEventListener('error', (event) => void failures.push(event.error ?? new Error(event.message)), { signal });
  window.addEventListener('unhandledrejection', (event) => void failures.push(event.reason), { signal });
  try {
    const drawn = mount();
    await nextTick();
    await frame();
    await document.fonts.ready;
    // fonts.ready settles when a face fails too, and the text then falls back without a sign
    for (const face of document.fonts) if (face.status === 'error') failures.push(new Error(`the font ${face.family} did not load`));
    await drawn?.();
    await Promise.all([...host.querySelectorAll('img')].map((image) => image.decode().catch((err: unknown) => void failures.push(unloaded(image, err)))));
    await painted();
  } catch (err) {
    failures.push(err);
  } finally {
    listening.abort();
  }
  if (failures.length > 0) throw new AggregateError(failures, `${label} failed: ${String(failures[0])}`);
}
