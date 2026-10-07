/**
 * Renders the Damocles demo video from the real built webview.
 *
 *   npm run build                                   # the webview under dist/webview is what gets filmed
 *   node scripts/demo-video/render.ts               # film every scene, then out/damocles-demo.mp4 + .gif
 *   node scripts/demo-video/render.ts --only core   # re-film some scenes, reuse the other recordings
 *   node scripts/demo-video/render.ts --only none   # re-film nothing; recompose from the saved recordings
 *   node scripts/demo-video/render.ts --no-music
 *
 * Needs Google Chrome and ffmpeg/ffprobe on PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startServer } from './lib/server.ts';
import { launchBrowser, openStage, type Recording } from './lib/stage.ts';
import { renderArtwork, renderCaptions, renderCard } from './lib/art.ts';
import { windowTitle } from './lib/script.ts';
import { FPS, XFADE, composeCard, composeFinal, composeGif, composeScene, synthesizeMusic, type GifCut } from './lib/compose.ts';
import type { Scene } from './lib/scene.ts';
import { core } from './scenes/core.ts';
import { plan } from './scenes/plan.ts';
import { folders } from './scenes/folders.ts';
import { subagents } from './scenes/subagents.ts';
import { team } from './scenes/team.ts';
import { stats } from './scenes/stats.ts';

const SCENES: Scene[] = [core, plan, folders, subagents, team, stats];
const INTRO_SECONDS = 4;
const OUTRO_SECONDS = 5;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.join(here, 'out');

const { values } = parseArgs({ options: { only: { type: 'string' }, 'no-music': { type: 'boolean', default: false } } });
const only = values.only ? new Set(values.only.split(',').filter((id) => id !== 'none')) : null;
const unknown = [...(only ?? [])].filter((id) => !SCENES.some((s) => s.id === id));
if (unknown.length) throw new Error(`Unknown scene(s): ${unknown.join(', ')}. Known: ${SCENES.map((s) => s.id).join(', ')}`);

const server = await startServer(repoRoot, path.join(here, 'theme', 'solarized-dark.css'));
const browser = await launchBrowser();
try {
  const artDir = path.join(outDir, 'art');
  const art = await renderArtwork(browser, repoRoot, artDir);

  const recordings = new Map<string, Recording>();
  for (const scene of SCENES) {
    const dir = path.join(outDir, 'scenes', scene.id);
    const meta = path.join(dir, 'recording.json');
    if (only && !only.has(scene.id)) {
      if (!fs.existsSync(meta)) throw new Error(`[${scene.id}] has no saved recording; film it with --only ${scene.id}`);
      recordings.set(scene.id, JSON.parse(fs.readFileSync(meta, 'utf8')) as Recording);
      continue;
    }
    console.log(`[${scene.id}] filming`);
    const stage = await openStage(browser, server.url, scene.boot);
    await stage.startRecording(path.join(dir, 'frames'));
    stage.windowTitle(windowTitle('acme-api'));
    try {
      await scene.run(stage);
    } catch (err) {
      await stage.page.screenshot({ path: path.join(dir, 'failure.png') });
      throw err;
    }
    const rec = await stage.stopRecording();
    await stage.page.context().close();
    fs.writeFileSync(meta, JSON.stringify(rec));
    console.log(`[${scene.id}] ${rec.frames.length} frames over ${rec.duration.toFixed(1)}s`);
    recordings.set(scene.id, rec);
  }

  // Each clip starts XFADE before the previous one ends.
  let t0 = INTRO_SECONDS - XFADE;
  const clips = [await composeCard(await renderCard(browser, repoRoot, art, 'intro', INTRO_SECONDS, FPS, 0, path.join(artDir, 'intro')), path.join(artDir, 'intro.mp4'))];
  const gifCuts: GifCut[] = [];
  for (const scene of SCENES) {
    const rec = recordings.get(scene.id)!;
    const dir = path.join(outDir, 'scenes', scene.id);
    console.log(`[${scene.id}] composing`);
    const captionImages = await renderCaptions(browser, rec.captions, scene.chapter, scene.accent, dir);
    const inputs = { rec, art, captionImages, workDir: dir, t0 };
    clips.push(await composeScene({ ...inputs, out: path.join(dir, 'scene.mp4') }));
    const { 'gif-start': from, 'gif-end': to } = rec.marks;
    if (from !== undefined && to !== undefined) {
      gifCuts.push({ clip: await composeScene({ ...inputs, stillBackdrop: true, out: path.join(dir, 'scene-gif.mp4') }), from, to });
    }
    t0 += rec.duration - XFADE;
  }
  clips.push(await composeCard(await renderCard(browser, repoRoot, art, 'outro', OUTRO_SECONDS, FPS, t0, path.join(artDir, 'outro')), path.join(artDir, 'outro.mp4')));
  const length = t0 + OUTRO_SECONDS;

  const video = path.join(outDir, 'damocles-demo.mp4');
  const music = values['no-music'] ? null : await synthesizeMusic(length, path.join(outDir, 'music.wav'));
  const total = await composeFinal(clips, music, video);
  console.log(`video: ${path.relative(repoRoot, video)} (${total.toFixed(1)}s)`);

  if (gifCuts.length) {
    const gif = path.join(outDir, 'damocles-demo.gif');
    await composeGif(gifCuts, outDir, gif);
    console.log(`gif:   ${path.relative(repoRoot, gif)} (${(fs.statSync(gif).size / 1e6).toFixed(1)} MB)`);
  }
} finally {
  await browser.close();
  await server.close();
}
