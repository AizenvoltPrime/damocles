// The theme render page: an offscreen sandboxed window with no preload and no bridge. Main calls window.damoclesRender with
// one job's JSON at a time and waits for the answer; for a drawing it then captures the window itself. A moving wallpaper's
// analysis decodes every frame itself, with no playback, from the bytes main fed through damoclesFeed, checks each for flashing
// (src/shared/themes/flash.ts) and reports its progress through damoclesProgress.
import { createApp, h, nextTick, type App } from 'vue';
import type { ThemeAnalysisAnswer, ThemeRenderAnswer, ThemeRenderJob, ThemeSpriteAnswer } from '@shared/themes/agent';
import { decodedDurationRefused, MAX_ANIMATION_FRAMES, STILL_SIDE, THUMB_QUALITY, THUMB_SIDE } from '@shared/themes/wallpapers';
import { readVideoSamples, type VideoSamples } from '@shared/themes/video-samples';
import { analyzeLoop, FLASH_SAMPLE_SIDE, FLASH_WINDOW_MS, FlashAnalyzer, WALLPAPER_FLASH_FIELD, type FlashResult } from '@shared/themes/flash';
import ThemeMiniature from '@/components/theme/ThemeMiniature.vue';
import { paletteFromPixels } from '../themes/wallpaper-palette';
import { luminanceStats } from './stats';
import { decodeEveryFrame } from './video-frames';
import './style.css';

declare global {
  interface Window {
    damoclesRender?: (json: string) => Promise<string>;
    damoclesFeed?: (chunk: string) => void;
    damoclesProgress?: () => number;
  }
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

let mounted: { app: App; host: HTMLElement } | undefined;

function host(width: number, height: number): HTMLElement {
  if (mounted) {
    mounted.app.unmount();
    mounted.host.remove();
    mounted = undefined;
  }
  const element = document.createElement('div');
  element.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden`;
  document.body.append(element);
  return element;
}

function mount(width: number, height: number, render: () => ReturnType<typeof h>): HTMLElement {
  const element = host(width, height);
  const app = createApp({ render });
  app.mount(element);
  mounted = { app, host: element };
  return element;
}

async function draw(job: ThemeRenderJob): Promise<void> {
  if (job.kind === 'preview') {
    const looks = job.mode === 'split' ? 'dark and light looks' : `${job.mode} look`;
    mount(job.width, job.height, () => h(ThemeMiniature, { theme: job.theme, mode: job.mode, label: `${job.theme.name}, ${looks}` }));
    return;
  }
  if (job.kind === 'composite') {
    const { bounds } = job;
    const element = mount(job.width, job.height, () => h('div', { style: 'position:relative;width:100%;height:100%' }, [
      h('img', { src: job.shell, alt: '', style: `position:absolute;left:0;top:0;width:${job.width}px;height:${job.height}px` }),
      h('img', { src: job.chat, alt: '', style: `position:absolute;left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px` }),
    ]));
    await nextTick();
    await Promise.all([...element.querySelectorAll('img')].map((image) => image.decode()));
    return;
  }
  throw new Error(`Unknown render job ${String((job as { kind?: unknown }).kind)}`);
}

// The stats sample's side: 64 x 64 pixels of the whole image.
const STATS_SIDE = 64;
// The palette sample's side, for the quantizer.
const PALETTE_SIDE = 128;

function canvasOf(image: CanvasImageSource, width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d canvas');
  context.drawImage(image, 0, 0, width, height);
  return context;
}

const sampleOf = (image: CanvasImageSource, side: number): Uint8ClampedArray => canvasOf(image, side, side).getImageData(0, 0, side, side).data;

// The frames of a moving wallpaper the stats sample, spread over its length.
const STATS_FRAMES = 5;
// Browsers show a frame of 10 ms or less for 100 ms.
const MIN_FRAME_MS = 10;
const SHORT_FRAME_MS = 100;

// A moving image's bytes, fed by main in base64 pieces before its analysis: the page cannot fetch app:// itself.
let fed: Uint8Array[] = [];
// how far the running analysis is, 0 to 1, which main polls
let progress = 0;

window.damoclesFeed = (chunk: string): void => {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  fed.push(bytes);
};
window.damoclesProgress = (): number => progress;

function takeFed(): Uint8Array {
  const total = fed.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of fed) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  fed = [];
  return bytes;
}

/** The first frame as the still frame (at most STILL_SIDE a side), the thumbnail and the palette, and the stats of `samples`. */
function movingAnswer(first: CanvasImageSource, width: number, height: number, samples: readonly Uint8ClampedArray[], flash: FlashResult): string {
  const stillScale = Math.min(1, STILL_SIDE / Math.max(width, height));
  const still = canvasOf(first, Math.max(1, Math.round(width * stillScale)), Math.max(1, Math.round(height * stillScale))).canvas;
  const thumbScale = Math.min(1, THUMB_SIDE / Math.max(width, height));
  const thumb = canvasOf(still, Math.max(1, Math.round(width * thumbScale)), Math.max(1, Math.round(height * thumbScale))).canvas.toDataURL('image/webp', THUMB_QUALITY);
  const palette = paletteFromPixels(sampleOf(still, PALETTE_SIDE));
  const answer: ThemeAnalysisAnswer & { readonly width: number; readonly height: number } = {
    thumb, still: still.toDataURL('image/png'), stats: luminanceStats(samples), palette, flash, width, height,
  };
  return JSON.stringify(answer);
}

// Every frame of an animated image, decoded with WebCodecs from the bytes main fed, analysed through its loop.
async function analyzeAnimation(mime: string): Promise<string> {
  progress = 0;
  let decoder: ImageDecoder;
  try {
    decoder = new ImageDecoder({ type: mime, data: takeFed() });
  } catch {
    return JSON.stringify({ error: 'the animated image did not decode' });
  }
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (count < 1) return JSON.stringify({ error: 'the animated image has no frames' });
    if (count > MAX_ANIMATION_FRAMES) return JSON.stringify({ error: `the animated image has ${count} frames` });
    const statsAt = new Set(Array.from({ length: STATS_FRAMES }, (_, i) => Math.floor((i * count) / STATS_FRAMES)));
    const frames: Array<readonly [Uint8ClampedArray, number]> = [];
    const samples: Uint8ClampedArray[] = [];
    let first: HTMLCanvasElement | undefined;
    let width = 0;
    let height = 0;
    for (let index = 0; index < count; index++) {
      const { image } = await decoder.decode({ frameIndex: index });
      try {
        if (index === 0) {
          width = image.displayWidth;
          height = image.displayHeight;
          first = canvasOf(image, width, height).canvas;
        }
        const sample = sampleOf(image, FLASH_SAMPLE_SIDE);
        const ms = image.duration === null ? 0 : image.duration / 1000;
        frames.push([sample, ms <= MIN_FRAME_MS ? SHORT_FRAME_MS : ms]);
        if (statsAt.has(index)) samples.push(sample);
      } finally {
        image.close();
      }
      progress = ((index + 1) / count) * 0.95;
    }
    return movingAnswer(first!, width, height, samples, analyzeLoop(frames, FLASH_SAMPLE_SIDE, WALLPAPER_FLASH_FIELD));
  } catch {
    return JSON.stringify({ error: 'the animated image did not decode' });
  } finally {
    decoder.close();
  }
}

// The first frame as the wallpaper shows it: turned by the track's rotation, at its own size.
function turned(frame: VideoFrame, rotation: VideoSamples['rotation']): HTMLCanvasElement {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const sideways = rotation === 90 || rotation === 270;
  const canvas = document.createElement('canvas');
  canvas.width = sideways ? height : width;
  canvas.height = sideways ? width : height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d canvas');
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(frame, -width / 2, -height / 2, width, height);
  return canvas;
}

// Every frame the video's container declares, decoded one by one from the bytes main fed and checked in presentation order,
// then the first second again after the end, since the wallpaper loops. A frame that cannot be read refuses the file.
async function analyzeVideo(declaredMs: number | undefined): Promise<string> {
  progress = 0;
  const bytes = takeFed();
  const refused = (err: unknown): string => JSON.stringify({ error: err instanceof Error ? err.message : 'the video did not decode' });
  let track: VideoSamples;
  try {
    track = readVideoSamples(bytes);
  } catch (err) {
    return refused(err);
  }
  const { durationMs } = track;
  if (decodedDurationRefused(durationMs, declaredMs)) return JSON.stringify({ error: `the video lasts ${Math.round(durationMs / 100) / 10} seconds, more than its header declares or a wallpaper may` });
  const analyzer = new FlashAnalyzer(FLASH_SAMPLE_SIDE, WALLPAPER_FLASH_FIELD);
  const firstSecond: Array<readonly [Uint8ClampedArray, number]> = [];
  const targets = Array.from({ length: STATS_FRAMES }, (_, i) => (i * durationMs) / STATS_FRAMES);
  const nearest: Array<{ distance: number; sample?: Uint8ClampedArray }> = targets.map(() => ({ distance: Number.POSITIVE_INFINITY }));
  const still: { first?: HTMLCanvasElement } = {};
  try {
    await decodeEveryFrame(track, bytes, (frame, index) => {
      if (index === 0) still.first = turned(frame, track.rotation);
      const at = frame.timestamp / 1000;
      const sample = sampleOf(frame, FLASH_SAMPLE_SIDE);
      if (at < FLASH_WINDOW_MS) firstSecond.push([sample, at]);
      targets.forEach((target, i) => {
        const distance = Math.abs(at - target);
        if (distance < nearest[i]!.distance) nearest[i] = { distance, sample };
      });
      progress = ((index + 1) / track.shown.length) * 0.95;
      return !analyzer.push(sample, at);
    });
  } catch (err) {
    return refused(err);
  }
  const { first } = still;
  if (!first) return JSON.stringify({ error: 'the video gave no frame' });
  if (!analyzer.result().flagged) for (const [sample, at] of firstSecond) if (analyzer.push(sample, durationMs + at)) break;
  return movingAnswer(first, first.width, first.height, nearest.flatMap((entry) => (entry.sample ? [entry.sample] : [])), analyzer.result());
}

// Decoding happens only here, in the sandboxed page; the decoded size must be the header's, or its EXIF-turned one.
async function analyze(job: Extract<ThemeRenderJob, { kind: 'analyze' }>): Promise<string> {
  if (job.moving?.kind === 'animated') return analyzeAnimation(job.moving.mime);
  if (job.moving?.kind === 'video') return analyzeVideo(job.moving.durationMs);
  const image = new Image();
  image.src = job.url;
  try {
    await image.decode();
  } catch {
    return JSON.stringify({ error: 'the image did not decode' });
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
  const thumb = canvasOf(image, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))).canvas.toDataURL('image/webp', THUMB_QUALITY);
  const palette = paletteFromPixels(canvasOf(image, PALETTE_SIDE, PALETTE_SIDE).getImageData(0, 0, PALETTE_SIDE, PALETTE_SIDE).data);
  const answer: ThemeAnalysisAnswer & { readonly width: number; readonly height: number } = { thumb, stats: luminanceStats([sampleOf(image, STATS_SIDE)]), palette, width, height };
  return JSON.stringify(answer);
}

// A character sprite: a strip's frames cut from the image and an animated image's decoded from the bytes main fed, each checked
// for flashing through its loop at its own timing; an animated image's or a still SVG's first frame drawn at its own size.
async function analyzeSprite(job: Extract<ThemeRenderJob, { kind: 'sprite' }>): Promise<string> {
  progress = 0;
  if (job.animated) {
    let decoder: ImageDecoder;
    try {
      decoder = new ImageDecoder({ type: job.mime, data: takeFed() });
    } catch {
      return JSON.stringify({ error: 'the animated sprite did not decode' });
    }
    try {
      await decoder.tracks.ready;
      await decoder.completed;
      const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
      if (count < 1 || count > MAX_ANIMATION_FRAMES) return JSON.stringify({ error: `the animated sprite has ${count} frames` });
      const frames: Array<readonly [Uint8ClampedArray, number]> = [];
      let still = '';
      let width = 0;
      let height = 0;
      for (let index = 0; index < count; index++) {
        const { image } = await decoder.decode({ frameIndex: index });
        try {
          if (index === 0) {
            width = image.displayWidth;
            height = image.displayHeight;
            still = canvasOf(image, width, height).canvas.toDataURL('image/png');
          }
          const ms = image.duration === null ? 0 : image.duration / 1000;
          frames.push([sampleOf(image, FLASH_SAMPLE_SIDE), ms <= MIN_FRAME_MS ? SHORT_FRAME_MS : ms]);
        } finally {
          image.close();
        }
      }
      const answer: ThemeSpriteAnswer = { width, height, still, flash: analyzeLoop(frames) };
      return JSON.stringify(answer);
    } catch {
      return JSON.stringify({ error: 'the animated sprite did not decode' });
    } finally {
      decoder.close();
    }
  }
  const image = new Image();
  image.src = job.url;
  try {
    await image.decode();
  } catch {
    return JSON.stringify({ error: 'the sprite did not decode' });
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const { strip } = job;
  let flash: FlashResult = { flagged: false };
  if (strip) {
    const frames: Array<readonly [Uint8ClampedArray, number]> = [];
    const canvas = document.createElement('canvas');
    canvas.width = FLASH_SAMPLE_SIDE;
    canvas.height = FLASH_SAMPLE_SIDE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return JSON.stringify({ error: 'no 2d canvas' });
    for (let i = 0; i < strip.frames; i++) {
      context.clearRect(0, 0, FLASH_SAMPLE_SIDE, FLASH_SAMPLE_SIDE);
      context.drawImage(image, i * strip.frameWidth, 0, strip.frameWidth, strip.frameHeight, 0, 0, FLASH_SAMPLE_SIDE, FLASH_SAMPLE_SIDE);
      frames.push([context.getImageData(0, 0, FLASH_SAMPLE_SIDE, FLASH_SAMPLE_SIDE).data, 1000 / strip.fps]);
    }
    flash = analyzeLoop(frames);
  }
  const still = !strip && job.mime === 'image/svg+xml' ? canvasOf(image, width, height).canvas.toDataURL('image/png') : undefined;
  const answer: ThemeSpriteAnswer = { width, height, ...(still !== undefined ? { still } : {}), flash };
  return JSON.stringify(answer);
}

window.damoclesRender = async (json: string): Promise<string> => {
  const job = JSON.parse(json) as ThemeRenderJob;
  if (job.kind === 'analyze') return analyze(job);
  if (job.kind === 'sprite') return analyzeSprite(job);
  await draw(job);
  await nextTick();
  await document.fonts.ready;
  // Two frames: the first lays out and paints, the second has the painted frame ready for main's capture.
  await frame();
  await frame();
  const answer: ThemeRenderAnswer = { drawn: true, width: job.width, height: job.height };
  return JSON.stringify(answer);
};
