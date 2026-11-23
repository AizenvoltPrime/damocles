# Moving wallpaper fixtures

Authored for Damocles' tests from FFmpeg's synthetic sources (no third-party footage or art), under the repository's own
license. `themes-motion.spec.ts` plays and checks them, and `src/shared/themes/__tests__/video-samples.test.ts` reads the
frames their containers declare. `node e2e/desktop/fixtures/wallpapers/generate-videos.mjs` writes the clips of the second
table (FFmpeg on PATH); an encoder of another version may write other bytes, so regenerate one only to change it.

Made with `ffmpeg version 9.0-full_build-www.gyan.dev` (libavformat 63.1.100, libavcodec 63.1.100, x264 core 165 r3223), as
`ffmpeg -version` names it and as each file's own metadata records.

| File | What it is | Why it is here | Made with |
| --- | --- | --- | --- |
| `moov-start.mp4` | 160x90, 3 s, H.264 (avc1), moov before mdat | The plain case: the index comes first, so a player can start from the first bytes. It is the video that spans two panels and the one the pause test plays. | `ffmpeg -f lavfi -i "gradients=s=160x90:r=15:d=3:speed=0.02:seed=7" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -an -movflags +faststart -t 3 moov-start.mp4` |
| `moov-end.mp4` | 160x90, 3 s, H.264 (avc1), moov after mdat | The index is at the end of the file, so the demuxer has to find it there before it can play. At 3.6 KB the first answer already holds the whole file, so it forces no separate read of the tail; the byte ranges themselves are asserted by direct requests for parts of this file. | the same with `seed=8` and no `-movflags +faststart` |
| `loop.webm` | 160x90, 3 s, VP9 (vp09) | The other container and codec family a wallpaper may use, and the tiled one. | `ffmpeg -f lavfi -i "gradients=s=160x90:r=15:d=3:speed=0.02:seed=9" -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 0 -crf 40 -an -t 3 loop.webm` |
| `flash-4hz.png` | 64x64 APNG, 16 frames at 8 a second: the top half alternates black and white, 4 flashes a second over half the frame | Past the limit of WCAG 2.3.1 (three flashes in any one second) and past its general flash threshold in size, since half the frame flashes: the check must flag it, at its first transition, 125 ms in. | `ffmpeg -f lavfi -i "color=c=gray:s=64x64:r=8:d=2" -vf "drawbox=x=0:y=0:w=64:h=32:color=black:t=fill:enable='eq(mod(n,2),0)',drawbox=x=0:y=0:w=64:h=32:color=white:t=fill:enable='eq(mod(n,2),1)'" -f apng -plays 0 -t 2 flash-4hz.png` |

Written by `generate-videos.mjs`, each 2 s long:

| File | What it is | Why it is here |
| --- | --- | --- |
| `strobe-60fps.mp4` | 64x64, H.264, 60 frames a second: black, and white on every second frame, so a 30 Hz flash over the whole frame | A check that read every second frame would see one color and pass it; only a check of every frame flags it, 17 ms in. |
| `strobe-30fps.mp4` | the same at 30 frames a second: a 15 Hz flash | The same at the usual frame rate, flagged 33 ms in. |
| `still.mp4` | 64x64, H.264, 30 frames a second of one color | Must pass. The test also zeroes one frame of a copy of it, which must then get no verdict: a clip that flashes would be flagged before the check reached the damaged frame. |
| `bframes.mp4` | 160x90, H.264 High with B-frames: the frames are stored out of presentation order | The check must hand the decoder the frames in stored order and still count every one. |
| `fragmented.mp4` | 160x90, H.264 in movie fragments under an empty `moov`, its length stated in `mvex/mehd`, which the script adds: FFmpeg states none, and Damocles refuses a video whose header states no length | The frames are listed in `moof` boxes, not in `moov`, and must all be found. |
| `av1.mp4` | 160x90, AV1 (av01) | Each codec a wallpaper may use is decoded by the check once. Its bytes differ from one encoder run to the next. |
| `vp8.webm` | 160x90, VP8 (vp08) | The same, for the WebM codec other than VP9. |
