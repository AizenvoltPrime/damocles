<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PANELS, type Panel } from '@shared/themes/schema';
import { PANE_TOKENS } from '@shared/themes/tokens';
import type { ShellWallpaper } from '@shared/themes/wallpapers';
import { useEventListener } from '@vueuse/core';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { LAYOUT_SETTLED_EVENT } from '../content-bounds';
import { playsNow, regionLayouts, videoOwners, type Rect, type RegionLayout } from './wallpaper-layout';

// The window's wallpapers, drawn once under the shell's panes (docs/invariants.md "Desktop themes"). Each region takes its
// rectangle from the pane it sits under, marked data-wallpaper-panel, measured in the same frame the pane's size changes, so a
// dragged divider moves image, dim and blur with it, and in every frame of a pane's glide to another slot, which moves the
// pane without resizing it. Decoration only: hidden from assistive technology and from the pointer.
// A moving wallpaper decodes once however many regions show it: an animated image is one image resource every region's
// background shares, and a video is one element in the first region that shows it, which every other region copies frame by
// frame onto a canvas. While paused, or blocked by its flash check, a region shows the file's still frame.
const props = defineProps<{ wallpapers: readonly ShellWallpaper[]; paused?: boolean }>();

const root = ref<HTMLElement | null>(null);
const panels = computed(() => props.wallpapers.map((wallpaper) => wallpaper.panel));

interface VideoSource {
  readonly element: HTMLVideoElement;
  readonly copies: Set<HTMLCanvasElement>;
  frame: number | undefined;
  // a region shows it playing, not its still frame
  playing: boolean;
}
const videos = new Map<string, VideoSource>();
// each canvas copy's placement of the video, relative to its own box
const copyPlacement = new WeakMap<HTMLCanvasElement, { readonly image: Rect; readonly tile: boolean }>();
// a copy's backing store never exceeds this many pixels a side
const MAX_COPY_SIDE = 4096;

function paneElement(panel: Panel): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-wallpaper-panel="${panel}"]`);
}

const rectOf = (element: Element): Rect => {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
};

// One observer for the layer's life: observers are told in the order they were made, and the wallpaper end-to-end test's
// frame recorder must come after this one in every frame.
let observer: ResizeObserver | undefined;
const observed = new Map<Panel, HTMLElement>();

// Every pane measured is observed from then on, and one that left the page no longer.
function measure(): Partial<Record<Panel, Rect>> {
  const rects: Partial<Record<Panel, Rect>> = {};
  for (const panel of PANELS) {
    const element = paneElement(panel);
    const was = observed.get(panel);
    if (was !== element) {
      if (was) observer?.unobserve(was);
      observed.delete(panel);
      if (element) {
        observer?.observe(element);
        observed.set(panel, element);
      }
    }
    if (element) rects[panel] = rectOf(element);
  }
  return rects;
}

function drawCopy(canvas: HTMLCanvasElement, video: HTMLVideoElement): void {
  const placement = copyPlacement.get(canvas);
  const context = canvas.getContext('2d');
  if (!placement || !context || video.videoWidth === 0) return;
  // CSS stretches the backing store over the box on each axis by itself, and MAX_COPY_SIDE may cap one side only
  const scaleX = canvas.width / Math.max(1, canvas.clientWidth);
  const scaleY = canvas.height / Math.max(1, canvas.clientHeight);
  const { image } = placement;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!placement.tile) {
    context.drawImage(video, image.x * scaleX, image.y * scaleY, image.width * scaleX, image.height * scaleY);
    return;
  }
  const pattern = context.createPattern(video, 'repeat');
  if (!pattern) return;
  pattern.setTransform(new DOMMatrix().translate(image.x * scaleX, image.y * scaleY).scale((image.width * scaleX) / video.videoWidth, (image.height * scaleY) / video.videoHeight));
  context.fillStyle = pattern;
  context.fillRect(0, 0, canvas.width, canvas.height);
}

// Copies follow the frames the video presents, and only while it plays and has a copy; a placement that adds one calls this.
function follow(source: VideoSource): void {
  if (source.frame !== undefined || source.copies.size === 0) return;
  const draw = (): void => {
    if (source.copies.size === 0) {
      source.frame = undefined;
      return;
    }
    for (const canvas of source.copies) drawCopy(canvas, source.element);
    source.frame = source.element.requestVideoFrameCallback(draw);
  };
  source.frame = source.element.requestVideoFrameCallback(draw);
}

function videoFor(asset: string, url: string): VideoSource {
  let source = videos.get(asset);
  if (source) return source;
  const element = document.createElement('video');
  Object.assign(element, { muted: true, defaultMuted: true, loop: true, playsInline: true, preload: 'auto', disablePictureInPicture: true, disableRemotePlayback: true });
  element.dataset['wallpaperVideo'] = asset;
  element.setAttribute('aria-hidden', 'true');
  Object.assign(element.style, { position: 'absolute', objectFit: 'fill', maxWidth: 'none' });
  element.src = url;
  element.addEventListener('loadeddata', () => {
    for (const canvas of source!.copies) drawCopy(canvas, element);
  });
  source = { element, copies: new Set(), frame: undefined, playing: false };
  videos.set(asset, source);
  return source;
}

function dropVideo(asset: string): void {
  const source = videos.get(asset);
  if (!source) return;
  if (source.frame !== undefined) source.element.cancelVideoFrameCallback(source.frame);
  source.element.pause();
  source.element.removeAttribute('src');
  source.element.load();
  source.element.remove();
  for (const canvas of source.copies) canvas.remove();
  videos.delete(asset);
}

// A canvas copies the one video its data-wallpaper-copy names, and leaves that video's copies as it leaves the page.
function dropCopy(canvas: HTMLCanvasElement): void {
  videos.get(canvas.dataset['wallpaperCopy'] ?? '')?.copies.delete(canvas);
  canvas.remove();
}

function sizeCopy(canvas: HTMLCanvasElement, box: { readonly width: number; readonly height: number }): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.min(MAX_COPY_SIDE, Math.round(box.width * ratio)));
  const height = Math.max(1, Math.min(MAX_COPY_SIDE, Math.round(box.height * ratio)));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

// The region's video element or canvas copy, placed and shown or hidden; a still region holds neither.
function placeVideo(image: HTMLElement, layout: RegionLayout, owner: boolean, playing: boolean): void {
  const source = videoFor(layout.asset, layout.url);
  if (owner && source.element.parentElement !== image) image.append(source.element);
  if (owner) {
    Object.assign(source.element.style, { left: `${layout.image.x}px`, top: `${layout.image.y}px`, width: `${layout.image.width}px`, height: `${layout.image.height}px`, visibility: playing ? 'visible' : 'hidden' });
  }
  let canvas = image.querySelector<HTMLCanvasElement>(':scope > canvas');
  // a tiled video is drawn as a pattern in every region, its own included
  const copy = !owner || layout.fit === 'tile';
  if (canvas && (!copy || canvas.dataset['wallpaperCopy'] !== layout.asset)) {
    dropCopy(canvas);
    canvas = null;
  }
  if (!copy) return;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.dataset['wallpaperCopy'] = layout.asset;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    image.append(canvas);
  }
  source.copies.add(canvas);
  copyPlacement.set(canvas, { image: layout.image, tile: layout.fit === 'tile' });
  const box = image.getBoundingClientRect();
  sizeCopy(canvas, box);
  canvas.style.visibility = playing ? 'visible' : 'hidden';
  if (playing) drawCopy(canvas, source.element);
}

// the image URL each shown region's background draws, as place() last set it
const shownImages = new Map<Panel, string>();

function decoded(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  return image.decode().catch((err: unknown) => {
    throw new Error(`the wallpaper image ${url} did not load`, { cause: err });
  });
}

// Settles once the video has a frame; rejects when it failed, and when it is emptied or aborted (dropVideo) before it has one.
function firstFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  const failure = (): Error => new Error(`the wallpaper video ${video.dataset['wallpaperVideo'] ?? ''} did not load`);
  // a video that failed before now fires no further event
  if (video.error) return Promise.reject(failure());
  return new Promise((resolve, reject) => {
    const listening = new AbortController();
    const { signal } = listening;
    const fail = (): void => {
      listening.abort();
      reject(failure());
    };
    video.addEventListener('loadeddata', () => {
      listening.abort();
      resolve();
    }, { signal });
    for (const type of ['error', 'emptied', 'abort']) video.addEventListener(type, fail, { signal });
  });
}

/**
 * Settles once every shown region's image has decoded and every video a region plays has a frame; rejects when one does not
 * load. A wallpaper change of the flush this is called in is placed by the time its tick ends, so it waits for the new set.
 */
async function whenDrawn(): Promise<void> {
  await nextTick();
  const playing = [...videos.values()].filter((source) => source.playing);
  await Promise.all([...[...new Set(shownImages.values())].map(decoded), ...playing.map((source) => firstFrame(source.element))]);
}

// Written to the DOM directly from the observer's callback, so the regions move in the frame the panes did.
function place(): void {
  const host = root.value;
  if (!host) return;
  const all = regionLayouts(props.wallpapers, measure(), rectOf(host));
  const layouts = new Map(all.map((layout) => [layout.panel, layout]));
  const owners = videoOwners(all);
  // main's flag carries what only main sees (focus, power, the settings); reduce motion is also read here, as all script motion is
  const paused = props.paused === true || prefersReducedMotion();
  shownImages.clear();
  for (const region of host.querySelectorAll<HTMLElement>('[data-wallpaper-region]')) {
    const layout = layouts.get(region.dataset['wallpaperRegion'] as Panel);
    region.hidden = layout === undefined;
    const copy = region.querySelector<HTMLCanvasElement>('canvas');
    if (!layout) {
      if (copy) dropCopy(copy);
      continue;
    }
    const { rect, margin } = layout;
    const pane = PANE_TOKENS[layout.panel];
    // a fitted or centred image leaves the rest of the region in the pane's own color
    Object.assign(region.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, backgroundColor: `rgb(from var(${pane}) r g b)` });
    const image = region.firstElementChild as HTMLElement;
    const playing = playsNow(layout, paused);
    // an animated image moves as its own resource; a video's still frame shows under its element until that has a frame
    const shown = layout.moving && !(playing && layout.moving.kind === 'animated') ? layout.moving.still : layout.url;
    Object.assign(image.style, {
      inset: `-${margin}px`,
      backgroundImage: `url("${shown}")`,
      backgroundSize: layout.size,
      backgroundPosition: layout.position,
      backgroundRepeat: layout.repeat,
      filter: layout.blur > 0 ? `blur(${layout.blur}px)` : '',
    });
    image.dataset['wallpaperPlaying'] = String(playing);
    shownImages.set(layout.panel, shown);
    if (layout.moving?.kind === 'video') placeVideo(image, layout, owners.get(layout.asset) === layout.panel, playing);
    else if (copy) dropCopy(copy);
    (image.nextElementSibling as HTMLElement).style.backgroundColor = `rgb(from var(${pane}) r g b / ${layout.dim})`;
  }
  syncPlayback(all, paused);
  followGlide();
}

// A pane gliding to another slot moves without a resize, so the regions are placed again each frame until it rests.
let glideFrame: number | undefined;
function followGlide(): void {
  if (glideFrame !== undefined) return;
  const gliding = [...observed.values()].some((pane) => pane.getAnimations().some((animation) => animation.playState === 'running'));
  if (!gliding) return;
  glideFrame = requestAnimationFrame(() => {
    glideFrame = undefined;
    place();
  });
}

// Each video plays while a region shows it and nothing pauses it; one no region shows any more is let go.
function syncPlayback(layouts: readonly RegionLayout[], paused: boolean): void {
  const shown = new Map(layouts.filter((layout) => layout.moving?.kind === 'video').map((layout) => [layout.asset, layout]));
  for (const asset of [...videos.keys()]) if (!shown.has(asset)) dropVideo(asset);
  for (const [asset, layout] of shown) {
    const source = videos.get(asset);
    if (!source) continue;
    for (const canvas of [...source.copies]) if (!canvas.isConnected) source.copies.delete(canvas);
    source.playing = playsNow(layout, paused);
    if (source.playing) {
      void source.element.play().catch(() => undefined);
      follow(source);
    } else {
      source.element.pause();
      if (source.frame !== undefined) source.element.cancelVideoFrameCallback(source.frame);
      source.frame = undefined;
    }
  }
}

onMounted(() => {
  observer = new ResizeObserver(place);
  if (root.value) observer.observe(root.value);
  place();
});
// Every state push carries the wallpapers in a new array, so the set is compared by value. A new one is placed in the post flush
// that rendered its regions, with no further tick, which whenDrawn relies on.
watch(() => JSON.stringify(props.wallpapers), () => place(), { flush: 'post' });
watch(() => props.paused, () => place());
useEventListener(window, LAYOUT_SETTLED_EVENT, place);
onBeforeUnmount(() => {
  observer?.disconnect();
  if (glideFrame !== undefined) cancelAnimationFrame(glideFrame);
  for (const asset of [...videos.keys()]) dropVideo(asset);
});

defineExpose({ place, whenDrawn });
</script>

<template>
  <div
    ref="root"
    class="pointer-events-none absolute inset-0 -z-1 overflow-hidden"
    aria-hidden="true"
    data-testid="wallpaper-layer"
  >
    <div
      v-for="panel in panels"
      :key="panel"
      class="absolute overflow-hidden"
      :data-wallpaper-region="panel"
      hidden
    >
      <div class="absolute" />
      <div class="absolute inset-0" />
    </div>
  </div>
</template>
