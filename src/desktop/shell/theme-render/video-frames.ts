// Every frame of a video handed to a WebCodecs decoder one by one, with no playback and so no clock a frame can fall behind:
// the decoder's outputs must be the frames the container declares, each once and in presentation order, or the read fails.
import type { VideoSamples } from '@shared/themes/video-samples';

// The encoded frames waiting in the decoder at once.
export const DECODE_QUEUE = 8;

export interface FrameCodecs {
  readonly Decoder: typeof VideoDecoder;
  readonly Chunk: typeof EncodedVideoChunk;
}

const errorOf = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Calls `each` with every shown frame of `track` in presentation order; `each` answers false to end the read early. Rejects
 * when the decoder refuses the codec or a frame, gives a frame out of its place, or ends without having given them all.
 * Software decoding, so one file reads alike on every computer.
 */
export async function decodeEveryFrame(
  track: VideoSamples,
  bytes: Uint8Array,
  each: (frame: VideoFrame, index: number) => boolean,
  codecs: FrameCodecs = { Decoder: VideoDecoder, Chunk: EncodedVideoChunk },
): Promise<void> {
  const config: VideoDecoderConfig = {
    codec: track.codec, ...(track.description ? { description: track.description } : {}), codedWidth: track.width, codedHeight: track.height, hardwareAcceleration: 'prefer-software',
  };
  if ((await codecs.Decoder.isConfigSupported(config)).supported !== true) throw new Error(`the ${track.codec} video cannot be decoded on this computer`);
  let read = 0;
  let ended = false;
  let failure: Error | undefined;
  let wake = (): void => undefined;
  const fail = (err: Error): void => {
    failure ??= err;
    wake();
  };
  const decoder = new codecs.Decoder({
    output: (frame) => {
      try {
        if (failure !== undefined || ended) return;
        if (frame.timestamp !== track.shown[read]) {
          fail(new Error(read < track.shown.length ? `frame ${read + 1} of the video was not read in its place` : 'the decoder gave a frame the video does not declare'));
          return;
        }
        if (!each(frame, read++)) {
          ended = true;
          wake();
        }
      } catch (err) {
        fail(errorOf(err));
      } finally {
        frame.close();
      }
    },
    error: (err) => fail(new Error(`a frame of the video did not decode: ${err.message}`)),
  });
  decoder.addEventListener('dequeue', () => wake());
  try {
    decoder.configure(config);
    for (const sample of track.samples) {
      if (failure !== undefined || ended) break;
      decoder.decode(new codecs.Chunk({ type: sample.key ? 'key' : 'delta', timestamp: sample.timestamp, data: bytes.subarray(sample.offset, sample.offset + sample.size) }));
      // an error or an early end wakes the wait too: a closed decoder fires no dequeue
      while (decoder.decodeQueueSize > DECODE_QUEUE && failure === undefined && !ended) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    if (failure === undefined && !ended) await decoder.flush();
  } catch (err) {
    fail(new Error(`a frame of the video did not decode: ${errorOf(err).message}`));
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failure !== undefined) throw failure;
  if (!ended && read !== track.shown.length) throw new Error(`the decoder read ${read} of the video's ${track.shown.length} frames`);
}
