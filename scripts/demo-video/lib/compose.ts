import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEVICE_SCALE, WINDOW_W, type CameraKey, type Caption, type Recording } from './stage.ts';
import { CANVAS_W, CANVAS_H, CAPTION_Y, CONTENT_X, CONTENT_Y, TITLE_BAR_H, WINDOW_X, WINDOW_Y, driftExpr, type Artwork } from './art.ts';

export const FPS = 30;
export const XFADE = 0.6;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-3000)}`))));
  });
}

const ffmpeg = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

export async function probeDuration(file: string): Promise<number> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number.parseFloat(out.trim());
}

/** A path inside a filtergraph option value: forward slashes, and the drive colon escaped. */
const filterPath = (p: string) => `'${path.resolve(p).replace(/\\/g, '/').replace(/:/g, '\\:')}'`;

function titleFont(): string {
  const candidates = ['C:/Windows/Fonts/segoeui.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error(`No title font found; tried ${candidates.join(', ')}`);
  return found;
}

/** Captured frames arrive only when the page repaints, so each one holds until the next. */
async function framesToClip(rec: Recording, out: string): Promise<void> {
  const list = path.join(rec.framesDir, 'frames.ffconcat');
  const lines = ['ffconcat version 1.0'];
  rec.frames.forEach((f, i) => {
    const next = rec.frames[i + 1]?.t ?? Math.max(rec.duration, f.t + 1 / FPS);
    lines.push(`file '${path.basename(f.file)}'`, `duration ${Math.max(next - f.t, 0.001).toFixed(6)}`);
  });
  lines.push(`file '${path.basename(rec.frames.at(-1)!.file)}'`);
  fs.writeFileSync(list, lines.join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', out]);
}

/** Captions stay clear of both ends, because scenes overlap by XFADE at each joint and two scenes' captions would blend. */
const captionSpan = (captions: Caption[], i: number, duration: number) => ({
  start: Math.max(captions[i]!.t, XFADE + 0.1),
  end: Math.min(captions[i + 1]?.t ?? duration, duration - XFADE) - 0.1,
});

interface View { l: number; t: number; r: number; b: number }
const FULL_VIEW: View = { l: 0, t: 0, r: CANVAS_W, b: CANVAS_H };
const CAMERA_MOVE_SECONDS = 0.9;

/** The canvas rectangle that frames `key.rect` with some margin, at the canvas aspect ratio and inside the canvas. */
function viewFor(key: CameraKey): View {
  if (!key.rect) return FULL_VIEW;
  const pad = 36;
  const x = CONTENT_X + key.rect.x * DEVICE_SCALE - pad;
  const y = CONTENT_Y + key.rect.y * DEVICE_SCALE - pad;
  const w = key.rect.width * DEVICE_SCALE + 2 * pad;
  const h = key.rect.height * DEVICE_SCALE + 2 * pad;
  const zoom = Math.min(key.maxZoom, Math.max(1, Math.min(CANVAS_W / w, CANVAS_H / h)));
  const vw = CANVAS_W / zoom;
  const vh = CANVAS_H / zoom;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const cx = clamp(x + w / 2, vw / 2, CANVAS_W - vw / 2);
  const cy = clamp(y + h / 2, vh / 2, CANVAS_H - vh / 2);
  return { l: cx - vw / 2, t: cy - vh / 2, r: cx + vw / 2, b: cy + vh / 2 };
}

/**
 * The camera as a `perspective` filter: each view corner eases (smoothstep) between keyframes, and the source
 * rectangle maps onto the whole frame, which resamples sub-pixel so slow zooms do not shimmer.
 */
function cameraFilter(camera: CameraKey[]): string | null {
  if (!camera.length) return null;
  const keys: { t: number; v: View }[] = [{ t: 0, v: FULL_VIEW }];
  for (const k of camera) keys.push({ t: Math.max(k.t, keys.at(-1)!.t + CAMERA_MOVE_SECONDS), v: viewFor(k) });
  const T = `(in/${FPS})`;
  const n = (v: number) => v.toFixed(2);
  const corner = (side: keyof View): string => {
    let expr = n(keys.at(-1)!.v[side]);
    for (let i = keys.length - 1; i >= 1; i--) {
      const from = keys[i - 1]!.v[side];
      const to = keys[i]!.v[side];
      const t = keys[i]!.t;
      const p = `((${T}-${n(t)})/${CAMERA_MOVE_SECONDS})`;
      expr = `if(lt(${T},${n(t + CAMERA_MOVE_SECONDS)}),${n(from)}+(${n(to - from)})*${p}*${p}*(3-2*${p}),${expr})`;
      expr = `if(lt(${T},${n(t)}),${n(from)},${expr})`;
    }
    return `'${expr}'`;
  };
  const [l, t, r, b] = [corner('l'), corner('t'), corner('r'), corner('b')];
  return `perspective=x0=${l}:y0=${t}:x1=${r}:y1=${t}:x2=${l}:y2=${b}:x3=${r}:y3=${b}:interpolation=cubic:sense=source:eval=frame`;
}

function titleFilters(titles: Caption[], duration: number, workDir: string): string[] {
  const font = filterPath(titleFont());
  return titles.map((title, i) => {
    const textFile = path.join(workDir, `title-${i}.txt`);
    fs.writeFileSync(textFile, title.text);
    const end = titles[i + 1]?.t ?? duration + 1;
    return `drawtext=fontfile=${font}:textfile=${filterPath(textFile)}:fontsize=14:fontcolor=0x93a1a1:x=${WINDOW_X}+(${WINDOW_W}-text_w)/2:y=${WINDOW_Y}+(${TITLE_BAR_H}-text_h)/2:enable='gte(t,${title.t.toFixed(3)})*lt(t,${end.toFixed(3)})'`;
  });
}

export interface SceneInputs {
  rec: Recording;
  art: Artwork;
  captionImages: string[];
  workDir: string;
  /** Where the scene starts in the final video, so the backdrop drift continues across joints. */
  t0: number;
  /** Rebuild capture.mp4 from the frames; otherwise reuse the one already built from this recording. */
  freshCapture: boolean;
  /** Holds the backdrop still, for the GIF, where a moving backdrop changes every pixel of every frame. */
  stillBackdrop?: boolean;
  out: string;
}

/** One scene: the capture in the window chrome over the drifting backdrop, filmed by the camera, with caption pills below. */
export async function composeScene({ rec, art, captionImages, workDir, t0, freshCapture, stillBackdrop = false, out }: SceneInputs): Promise<string> {
  const raw = path.join(workDir, 'capture.mp4');
  if (freshCapture || !fs.existsSync(raw)) await framesToClip(rec, raw);
  const drift = driftExpr(stillBackdrop ? t0.toFixed(3) : `${t0.toFixed(3)}+t`);
  const camera = cameraFilter(rec.camera);
  const graph = [
    `[1:v]crop=${CANVAS_W}:${CANVAS_H}:x='${drift.x}':y='${drift.y}'[bg]`,
    `[bg][0:v]overlay=${CONTENT_X}:${CONTENT_Y}:format=yuv444[win]`,
    `[win][2:v]overlay=0:0:format=yuv444${titleFilters(rec.titles, rec.duration, workDir).map((f) => `,${f}`).join('')}${camera ? `,${camera}` : ''}[c0]`,
  ];
  captionImages.forEach((_, i) => {
    const { start, end } = captionSpan(rec.captions, i, rec.duration);
    const rise = `${CAPTION_Y}+18*pow(max(0,1-(t-${start.toFixed(3)})/0.45),3)`;
    graph.push(
      `[${3 + i}:v]format=rgba,fade=t=in:st=${start.toFixed(3)}:d=0.35:alpha=1,fade=t=out:st=${(end - 0.3).toFixed(3)}:d=0.3:alpha=1[p${i}]`,
      `[c${i}][p${i}]overlay=0:y='${rise}':format=yuv444:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[c${i + 1}]`,
    );
  });
  graph.push(`[c${captionImages.length}]format=yuv420p[v]`);
  const graphFile = path.join(workDir, 'scene.filter');
  fs.writeFileSync(graphFile, graph.join(';\n'));
  const still = (file: string) => ['-loop', '1', '-framerate', String(FPS), '-t', rec.duration.toFixed(3), '-i', file];
  await ffmpeg(['-i', raw, ...still(art.backdrop), ...still(art.frame), ...captionImages.flatMap(still),
    '-/filter_complex', graphFile, '-map', '[v]', '-t', rec.duration.toFixed(3), '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', '-r', String(FPS), out]);
  return out;
}

export async function composeCard(framesPattern: string, out: string): Promise<string> {
  await ffmpeg(['-framerate', String(FPS), '-i', framesPattern, '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', out]);
  return out;
}

/**
 * An ambient A-minor pad (Am, F, C, G, four seconds each) built from detuned sines, so the video ships
 * with a track that needs no license. Each chord swells over five seconds, overlapping the next by one.
 */
export async function synthesizeMusic(seconds: number, out: string): Promise<string> {
  const chords = [
    [110, 220, 261.63, 329.63],
    [87.31, 174.61, 220, 261.63],
    [130.81, 196, 261.63, 329.63],
    [98, 196, 246.94, 293.66],
  ];
  const period = 4;
  const cycle = period * chords.length;
  const channel = (detune: number) =>
    chords
      .map((notes, k) => {
        const p = `mod(t-${k * period}+${cycle},${cycle})`;
        const env = `if(lt(${p},${period + 1}),pow(sin(PI*${p}/${period + 1}),2),0)`;
        const voices = notes
          .map((f, j) => {
            const amp = j === 0 ? 0.11 : 0.07;
            return `${amp}*(sin(2*PI*${f}*t)+0.6*sin(2*PI*${(f * detune).toFixed(3)}*t)+0.12*sin(4*PI*${f}*t))`;
          })
          .join('+');
        return `${env}*(${voices})`;
      })
      .join('+');
  const expr = `${channel(1.0035)}|${channel(0.9968)}`;
  await ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}':s=48000:d=${seconds}`,
    '-af', `lowpass=f=1600,aecho=0.8:0.55:190|370:0.3|0.2,afade=t=in:d=2.5,afade=t=out:st=${Math.max(0, seconds - 3.5)}:d=3.5,volume=1.1,alimiter=limit=0.8`,
    '-c:a', 'pcm_s16le', out]);
  return out;
}

/** Joins the clips with crossfades and lays the music under them. */
export async function composeFinal(clips: string[], music: string | null, out: string): Promise<number> {
  const durations = await Promise.all(clips.map(probeDuration));
  const parts: string[] = [];
  let prev = '0:v';
  let offset = 0;
  clips.slice(1).forEach((_, i) => {
    offset += durations[i]! - XFADE;
    const label = i === clips.length - 2 ? 'joined' : `x${i}`;
    parts.push(`[${prev}][${i + 1}:v]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${label}]`);
    prev = label;
  });
  if (clips.length === 1) parts.push('[0:v]null[joined]');
  const total = durations.reduce((a, b) => a + b, 0) - XFADE * (clips.length - 1);
  parts.push(`[joined]fade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[v]`);
  const graphFile = `${out}.filter`;
  fs.writeFileSync(graphFile, parts.join(';\n'));
  const inputs = clips.flatMap((c) => ['-i', c]);
  await ffmpeg([...inputs, ...(music ? ['-i', music] : []), '-/filter_complex', graphFile, '-map', '[v]',
    ...(music ? ['-map', `${clips.length}:a`, '-c:a', 'aac', '-b:a', '160k'] : []),
    '-t', total.toFixed(3), '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
  return total;
}

export interface GifCut {
  clip: string;
  from: number;
  to: number;
}

/** A silent highlight loop for READMEs that cannot embed video, using a palette built from its own frames. */
export async function composeGif(cuts: GifCut[], workDir: string, out: string, width = 880, fps = 12): Promise<void> {
  const inputs = cuts.flatMap((c) => ['-ss', c.from.toFixed(3), '-t', (c.to - c.from).toFixed(3), '-i', c.clip]);
  const concat = `${cuts.map((_, i) => `[${i}:v]`).join('')}concat=n=${cuts.length}:v=1:a=0,fps=${fps},scale=${width}:-1:flags=lanczos`;
  const graph = `${concat},split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[g]`;
  const graphFile = path.join(workDir, 'gif.filter');
  fs.writeFileSync(graphFile, graph);
  await ffmpeg([...inputs, '-/filter_complex', graphFile, '-map', '[g]', '-loop', '0', out]);
}
