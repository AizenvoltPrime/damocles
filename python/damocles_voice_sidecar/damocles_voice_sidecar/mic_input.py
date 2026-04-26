"""Native OS microphone capture via sounddevice (PortAudio).

The audio path is: OS mic -> PortAudio worker thread -> bounded asyncio
queue -> Pipeline.feed() on the asyncio loop. Bypasses VS Code webview
permission boundaries (which deny getUserMedia by default in the Electron
sandbox) — same pattern as src/extension/voice/recorder.ts uses for the
push-to-talk path with platform-native binaries.

Threading model: sounddevice fires its callback on PortAudio's audio
thread; we hand frames to the asyncio loop via call_soon_threadsafe.
Backpressure: bounded queue (~1.28 s of audio) with drop-oldest on
overflow. Transcripts are never dropped; only inbound mic frames are.

Frame contract: int16 mono LE, 16 kHz, 320 samples (640 bytes) per 20 ms.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

from .protocol import FRAME_SAMPLES, RecoverableOomError, SAMPLE_RATE

logger = logging.getLogger(__name__)

MAX_QUEUED_FRAMES = 64

FrameSink = Callable[[bytes], Awaitable[None]]


class MicInputStream:
    """sounddevice InputStream wrapped for asyncio consumption."""

    def __init__(self, loop: asyncio.AbstractEventLoop, sink: FrameSink) -> None:
        self._loop = loop
        self._sink = sink
        self._stream = None  # type: ignore[assignment]
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=MAX_QUEUED_FRAMES)
        self._consumer_task: Optional[asyncio.Task[None]] = None
        self._muted = False
        self._failure: asyncio.Future[None] = loop.create_future()

    @property
    def failure(self) -> asyncio.Future[None]:
        """Future that becomes done with an exception if the consumer
        loop hits a non-recoverable error (currently RecoverableOomError).
        run_server awaits this so the OOM ladder propagates instead of
        getting silently logged as an unhandled task exception."""
        return self._failure

    def start(self) -> None:
        import sounddevice as sd

        def _callback(indata, _frames, _time, status) -> None:
            if status:
                logger.warning("mic input callback status: %s", status)
            if self._muted:
                return
            buf = bytes(indata)
            self._loop.call_soon_threadsafe(self._enqueue_or_drop, buf)

        self._stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
            callback=_callback,
        )
        self._stream.start()
        self._consumer_task = self._loop.create_task(self._consume_loop())
        logger.info(
            "mic input started (samplerate=%d, blocksize=%d, queue_max=%d)",
            SAMPLE_RATE,
            FRAME_SAMPLES,
            MAX_QUEUED_FRAMES,
        )

    def stop(self) -> None:
        if self._consumer_task is not None:
            self._consumer_task.cancel()
            self._consumer_task = None
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception as exc:
                logger.warning("mic input stop error: %s", exc)
            self._stream = None

    def set_muted(self, muted: bool) -> None:
        self._muted = muted
        logger.info("mic input muted=%s", muted)

    def _enqueue_or_drop(self, buf: bytes) -> None:
        if self._queue.full():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self._queue.put_nowait(buf)
        except asyncio.QueueFull:
            pass

    async def _consume_loop(self) -> None:
        while True:
            buf = await self._queue.get()
            try:
                await self._sink(buf)
            except asyncio.CancelledError:
                raise
            except RecoverableOomError as exc:
                if not self._failure.done():
                    self._failure.set_exception(exc)
                raise
            except Exception as exc:
                logger.exception("mic frame sink raised: %s", exc)
