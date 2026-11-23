// node e2e/desktop/fixtures/wallpapers/generate-videos.mjs
// Writes the clips the flash check's tests read (README.md lists them), from FFmpeg's synthetic sources. Needs ffmpeg on PATH.
// The files are committed, so run it only to change one; an encoder of another version may write other bytes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// black, and white on every second frame
const strobe = (fps) => ['-f', 'lavfi', '-i', `color=c=black:s=64x64:r=${fps}:d=2`, '-vf', "drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='eq(mod(n,2),1)'"];
const gradients = ['-f', 'lavfi', '-i', 'gradients=s=160x90:r=30:d=2:speed=0.05:seed=3'];
const h264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
const clips = {
  'strobe-60fps.mp4': [...strobe(60), ...h264, '-profile:v', 'baseline', '-movflags', '+faststart'],
  'strobe-30fps.mp4': [...strobe(30), ...h264, '-profile:v', 'baseline', '-movflags', '+faststart'],
  'still.mp4': ['-f', 'lavfi', '-i', 'color=c=0x336699:s=64x64:r=30:d=2', ...h264, '-movflags', '+faststart'],
  // frames stored out of presentation order
  'bframes.mp4': [...gradients, ...h264, '-profile:v', 'high', '-bf', '3'],
  // an empty moov and the frames in movie fragments; its length is stated below
  'fragmented.mp4': [...gradients, ...h264, '-g', '15', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'],
  'av1.mp4': [...gradients, '-c:v', 'libsvtav1', '-pix_fmt', 'yuv420p'],
  'vp8.webm': [...gradients, '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '60k'],
};
for (const [name, args] of Object.entries(clips)) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-an', '-t', '2', name], { cwd: here, stdio: 'inherit' });
  console.log(`wrote ${name}`);
}

// FFmpeg states no length for a fragmented file, and Damocles refuses a video whose header states none: this adds the
// mvex/mehd box a packager writes, with the 2 s in mvhd's time scale of 1000. The fragments name their data from their own
// moof, so nothing else moves.
const file = join(here, 'fragmented.mp4');
const bytes = readFileSync(file);
const find = (type, start, end) => {
  for (let at = start; at + 8 <= end; at += bytes.readUInt32BE(at)) {
    if (bytes.toString('latin1', at + 4, at + 8) === type) return at;
  }
  throw new Error(`fragmented.mp4 has no ${type} box`);
};
const moov = find('moov', 0, bytes.length);
const mvex = find('mvex', moov + 8, moov + bytes.readUInt32BE(moov));
const mehd = Buffer.from([0, 0, 0, 16, ...Buffer.from('mehd', 'latin1'), 0, 0, 0, 0, 0, 0, 0x07, 0xd0]);
bytes.writeUInt32BE(bytes.readUInt32BE(moov) + mehd.length, moov);
bytes.writeUInt32BE(bytes.readUInt32BE(mvex) + mehd.length, mvex);
writeFileSync(file, Buffer.concat([bytes.subarray(0, mvex + 8), mehd, bytes.subarray(mvex + 8)]));
console.log('stated the length of fragmented.mp4');
