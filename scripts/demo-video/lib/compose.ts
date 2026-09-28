import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WINDOW_W, type Caption, type Recording } from './stage.ts';
import { CANVAS_W, CANVAS_H, CONTENT_X, CONTENT_Y, CAPTION_CENTER_Y, type Artwork } from './art.ts';

export const FPS = 30;
const XFADE = 0.6;

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

function captionFont(): string {
  const candidates = [
    'C:/Windows/Fonts/seguisb.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  ];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error(`No caption font found; tried ${candidates.join(', ')}`);
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

function captionFilters(captions: Caption[], duration: number, workDir: string): string[] {
  const font = filterPath(captionFont());
  return captions.map((c, i) => {
    // Scenes overlap by XFADE at each joint, so captions stay clear of both ends or two scenes' captions blend.
    const start = Math.max(c.t, XFADE + 0.1);
    const end = Math.min(captions[i + 1]?.t ?? duration, duration - XFADE) - 0.1;
    const textFile = path.join(workDir, `caption-${i}.txt`);
    fs.writeFileSync(textFile, c.text);
    const fade = 0.3;
    const alpha = `if(lt(t,${start}),0,if(lt(t,${start + fade}),(t-${start})/${fade},if(lt(t,${end - fade}),1,if(lt(t,${end}),(${end}-t)/${fade},0))))`;
    return `drawtext=fontfile=${font}:textfile=${filterPath(textFile)}:fontsize=36:fontcolor=0xfdf6e3:x=(w-text_w)/2:y=${CAPTION_CENTER_Y}-text_h/2:alpha='${alpha}':enable='between(t,${start},${end})'`;
  });
}

/** One scene: the capture placed in the window frame on the backdrop, with its captions below. */
export async function composeScene(rec: Recording, art: Artwork, workDir: string): Promise<string> {
  const raw = path.join(workDir, 'capture.mp4');
  await framesToClip(rec, raw);
  const out = path.join(workDir, 'scene.mp4');
  const graph = [
    `color=c=0x002b36:s=${CANVAS_W}x${CANVAS_H}:r=${FPS}:d=${rec.duration}[base]`,
    `[base][0:v]overlay=${CONTENT_X}:${CONTENT_Y}:shortest=1[win]`,
    `[win][1:v]overlay=0:0${captionFilters(rec.captions, rec.duration, workDir).map((f) => `,${f}`).join('')},format=yuv420p[v]`,
  ].join(';\n');
  const graphFile = path.join(workDir, 'scene.filter');
  fs.writeFileSync(graphFile, graph);
  await ffmpeg(['-i', raw, '-loop', '1', '-i', art.frame, '-/filter_complex', graphFile, '-map', '[v]', '-t', rec.duration.toFixed(3), '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', '-r', String(FPS), out]);
  return out;
}

export async function composeCard(image: string, seconds: number, out: string): Promise<string> {
  await ffmpeg(['-loop', '1', '-framerate', String(FPS), '-t', String(seconds), '-i', image,
    '-vf', `format=yuv420p`, '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', out]);
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

/** The length of `clips` once each joint overlaps by the crossfade. */
export async function crossfadedLength(clips: string[]): Promise<number> {
  const durations = await Promise.all(clips.map(probeDuration));
  return durations.reduce((a, b) => a + b, 0) - XFADE * (clips.length - 1);
}

/** Joins the clips with crossfades and lays the music under them. */
export async function composeFinal(clips: string[], music: string | null, out: string): Promise<number> {
  const durations = await Promise.all(clips.map(probeDuration));
  const parts: string[] = [];
  let prev = '0:v';
  let offset = 0;
  clips.slice(1).forEach((_, i) => {
    offset += durations[i]! - XFADE;
    const label = i === clips.length - 2 ? 'v' : `x${i}`;
    parts.push(`[${prev}][${i + 1}:v]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${label}]`);
    prev = label;
  });
  if (clips.length === 1) parts.push('[0:v]null[v]');
  const total = durations.reduce((a, b) => a + b, 0) - XFADE * (clips.length - 1);
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
export async function composeGif(cuts: GifCut[], workDir: string, out: string, width = 960, fps = 15): Promise<void> {
  const inputs = cuts.flatMap((c) => ['-ss', c.from.toFixed(3), '-t', (c.to - c.from).toFixed(3), '-i', c.clip]);
  const concat = `${cuts.map((_, i) => `[${i}:v]`).join('')}concat=n=${cuts.length}:v=1:a=0,crop=${WINDOW_W}:${CANVAS_H}:${CONTENT_X}:0,fps=${fps},scale=${width}:-1:flags=lanczos`;
  const graph = `${concat},split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[g]`;
  const graphFile = path.join(workDir, 'gif.filter');
  fs.writeFileSync(graphFile, graph);
  await ffmpeg([...inputs, '-/filter_complex', graphFile, '-map', '[g]', '-loop', '0', out]);
}
