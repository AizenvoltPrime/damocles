// Host to voice archive extraction worker and back. The worker imports only tar and the Node standard library.

export const VOICE_EXTRACT_WORKER_MARKER = 'damocles-voice-extract-worker';

export interface ExtractWorkerData {
  marker: typeof VOICE_EXTRACT_WORKER_MARKER;
  file: string;
  cwd: string;
}

/** A worker answers its one archive with `done` or `error`, then exits. */
export type ExtractEvent = { type: 'done' } | { type: 'error'; message: string };
