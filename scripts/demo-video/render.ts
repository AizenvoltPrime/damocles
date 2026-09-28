/**
 * Renders the Damocles demo video from the real built webview.
 *
 *   npm run build                                   # the webview under dist/webview is what gets filmed
 *   node scripts/demo-video/render.ts               # every scene, then out/damocles-demo.mp4 + .gif
 *   node scripts/demo-video/render.ts --only core   # re-film some scenes, reuse the rest from out/scenes
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
import { renderArtwork } from './lib/art.ts';
import { bootMessages } from './lib/script.ts';
import { composeCard, composeFinal, composeGif, composeScene, crossfadedLength, synthesizeMusic, type GifCut } from './lib/compose.ts';
import type { Scene } from './lib/scene.ts';
import { core } from './scenes/core.ts';
import { plan } from './scenes/plan.ts';
import { subagents } from './scenes/subagents.ts';
import { team } from './scenes/team.ts';
import { stats } from './scenes/stats.ts';

const SCENES: Scene[] = [core, plan, subagents, team, stats];

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.join(here, 'out');

const { values } = parseArgs({ options: { only: { type: 'string' }, 'no-music': { type: 'boolean', default: false } } });
const only = values.only ? new Set(values.only.split(',')) : null;
const unknown = [...(only ?? [])].filter((id) => !SCENES.some((s) => s.id === id));
if (unknown.length) throw new Error(`Unknown scene(s): ${unknown.join(', ')}. Known: ${SCENES.map((s) => s.id).join(', ')}`);

const server = await startServer(repoRoot, path.join(here, 'theme', 'solarized-dark.css'));
const browser = await launchBrowser();
try {
  const art = await renderArtwork(browser, repoRoot, path.join(outDir, 'art'));
  const clips: string[] = [await composeCard(art.intro, 3.5, path.join(outDir, 'art', 'intro.mp4'))];
  const gifCuts: GifCut[] = [];

  for (const scene of SCENES) {
    const dir = path.join(outDir, 'scenes', scene.id);
    const meta = path.join(dir, 'recording.json');
    const clip = path.join(dir, 'scene.mp4');
    let rec: Recording;
    if (only && !only.has(scene.id) && fs.existsSync(meta) && fs.existsSync(clip)) {
      rec = JSON.parse(fs.readFileSync(meta, 'utf8')) as Recording;
      console.log(`[${scene.id}] reusing ${path.relative(repoRoot, clip)}`);
    } else {
      console.log(`[${scene.id}] filming`);
      const stage = await openStage(browser, server.url, scene.boot ?? bootMessages());
      await stage.startRecording(path.join(dir, 'frames'));
      try {
        await scene.run(stage);
      } catch (err) {
        await stage.page.screenshot({ path: path.join(dir, 'failure.png') });
        throw err;
      }
      rec = await stage.stopRecording();
      await stage.page.context().close();
      console.log(`[${scene.id}] ${rec.frames.length} frames over ${rec.duration.toFixed(1)}s, composing`);
      await composeScene(rec, art, dir);
      fs.writeFileSync(meta, JSON.stringify(rec));
    }
    clips.push(clip);
    const { 'gif-start': from, 'gif-end': to } = rec.marks;
    if (from !== undefined && to !== undefined) gifCuts.push({ clip, from, to });
  }

  clips.push(await composeCard(art.outro, 4.5, path.join(outDir, 'art', 'outro.mp4')));

  const video = path.join(outDir, 'damocles-demo.mp4');
  const music = values['no-music'] ? null : await synthesizeMusic(await crossfadedLength(clips), path.join(outDir, 'music.wav'));
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
