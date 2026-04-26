"""Wake -> VAD -> ASR pipeline state machine.

State diagram:

    LISTENING --(wake_detected)--> POST_WAKE_OFFSET --(after 250 ms)--> WAITING_FOR_SPEECH
    WAITING_FOR_SPEECH --(no speech in 1500 ms)--> wake_aborted -> LISTENING
    WAITING_FOR_SPEECH --(vad_speech_started)--> CAPTURING
    CAPTURING --(vad_speech_ended OR max_utterance_ms)--> TRANSCRIBING
    TRANSCRIBING --(transcript_final emitted)--> LISTENING

Wake-phrase exclusion is enforced two ways:
  1. ASR receives audio starting at T_wake + 250 ms (the post-wake offset).
  2. ``strip_wake_prefix`` removes any leading "(hey )?jarvis" from the
     transcript as defense-in-depth.

Both mechanisms together satisfy the FR-11 acceptance test
(``tests/test_wake_exclusion.py``).
"""

from __future__ import annotations

import asyncio
import gc
import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable

from .engines import AsrEngine, EngineSet, TtsEngine, VadEvent, WakeEngine, VadEngine
from .protocol import ErrorCode, FRAME_BYTES, FRAME_DURATION_MS, RecoverableOomError

logger = logging.getLogger(__name__)

# Tail of the wake phrase. Calibrated against the actual hey_jarvis model
# during US-006 implementation; 250 ms is the documented starting point.
POST_WAKE_OFFSET_MS = 250

# If no VAD speech onset within this window of wake_detected, the wake is
# treated as a false positive.
FALSE_WAKE_TIMEOUT_MS = 1_500

# Strip leading "Jarvis," / "Hey Jarvis," prefixes that survive the audio
# offset. Case-insensitive; trailing punctuation/whitespace are absorbed.
# MUST stay byte-identical to ``WAKE_PREFIX_RE`` in
# src/extension/chat-panel/message-router/handlers/voice-stream-handlers.ts.
# The TS-side test src/extension/voice/__tests__/wake-prefix-parity.test.ts
# reads both files as text and asserts the literals match.
WAKE_PREFIX_RE = re.compile(r"^\s*(hey\s+)?jarvis[,.\s]*", re.IGNORECASE)


def strip_wake_prefix(text: str) -> str:
    return WAKE_PREFIX_RE.sub("", text, count=1).strip()


def _is_cuda_oom(exc: BaseException) -> bool:
    """Duck-typed check so tests without torch installed can still raise it."""
    if exc.__class__.__name__ == "OutOfMemoryError":
        return True
    try:
        import torch
    except ImportError:
        return False
    return isinstance(exc, torch.cuda.OutOfMemoryError)


class State(Enum):
    LISTENING = "listening"
    POST_WAKE_OFFSET = "post_wake_offset"
    WAITING_FOR_SPEECH = "waiting_for_speech"
    CAPTURING = "capturing"
    TRANSCRIBING = "transcribing"


@dataclass
class PipelineEvent:
    """Output events the pipeline emits, consumed by the WebSocket layer."""

    kind: str
    payload: dict = field(default_factory=dict)


EmitFn = Callable[[PipelineEvent], Awaitable[None]]


@dataclass
class PipelineConfig:
    end_of_turn_silence_ms: int = 800
    max_utterance_ms: int = 30_000
    post_wake_offset_ms: int = POST_WAKE_OFFSET_MS
    false_wake_timeout_ms: int = FALSE_WAKE_TIMEOUT_MS


class Pipeline:
    """Frame-driven state machine. Audio frames go in; events come out."""

    def __init__(
        self,
        engines: EngineSet,
        config: PipelineConfig,
        emit: EmitFn,
    ) -> None:
        if engines.wake is None or engines.vad is None or engines.asr is None:
            raise ValueError(
                "Pipeline requires wake, vad, and asr engines; "
                "construct only when wake-word mode is enabled"
            )
        self._wake: WakeEngine = engines.wake
        self._vad: VadEngine = engines.vad
        self._asr: AsrEngine = engines.asr
        self._tts: TtsEngine | None = engines.tts
        self._cfg = config
        self._emit = emit

        self._state = State.LISTENING
        # Audio captured for ASR after the post-wake offset elapses.
        self._capture_buf = bytearray()
        # Frames since wake_detected, used for the post-wake offset and
        # false-wake timeout windows.
        self._frames_since_wake = 0
        # Frames captured during CAPTURING; used to enforce max_utterance_ms.
        self._frames_capturing = 0

    @property
    def state(self) -> State:
        return self._state

    def _frames(self, ms: int) -> int:
        return ms // FRAME_DURATION_MS

    async def feed(self, frame: bytes) -> None:
        if len(frame) != FRAME_BYTES:
            return  # malformed frames are dropped silently per backpressure policy

        if self._state == State.LISTENING:
            res = self._wake.process(frame)
            if res.detected:
                self._state = State.POST_WAKE_OFFSET
                self._frames_since_wake = 0
                await self._emit(PipelineEvent("wake_detected", {"confidence": res.confidence}))
            return

        if self._state == State.POST_WAKE_OFFSET:
            self._frames_since_wake += 1
            if self._frames_since_wake >= self._frames(self._cfg.post_wake_offset_ms):
                self._state = State.WAITING_FOR_SPEECH
                self._vad.reset()
                self._frames_since_wake = 0
            return

        if self._state == State.WAITING_FOR_SPEECH:
            self._frames_since_wake += 1
            ev = self._vad.process(frame)
            if ev == "speech_started":
                self._state = State.CAPTURING
                self._capture_buf.clear()
                self._capture_buf.extend(frame)
                self._frames_capturing = 1
                await self._emit(PipelineEvent("vad_speech_started"))
                return
            if self._frames_since_wake >= self._frames(self._cfg.false_wake_timeout_ms):
                await self._emit(PipelineEvent("wake_aborted", {"reason": "no-speech"}))
                self._reset_to_listening()
            return

        if self._state == State.CAPTURING:
            self._capture_buf.extend(frame)
            self._frames_capturing += 1
            ev = self._vad.process(frame)
            hit_cap = self._frames_capturing >= self._frames(self._cfg.max_utterance_ms)
            if ev == "speech_ended" or hit_cap:
                await self._emit(PipelineEvent("vad_speech_ended"))
                await self._do_transcribe()
            return

        if self._state == State.TRANSCRIBING:
            # Drop frames during transcription. State will reset shortly.
            return

    async def _do_transcribe(self) -> None:
        self._state = State.TRANSCRIBING
        pcm = bytes(self._capture_buf)
        self._capture_buf.clear()
        # On non-OOM exceptions we still reset (else feed() wedges in
        # TRANSCRIBING). On RecoverableOomError we deliberately skip
        # _reset_to_listening: it calls wake.reset()/vad.reset() which
        # touch GPU tensors and can re-allocate during the very OOM
        # unwind we're trying to recover from. The sidecar exits with
        # code 7 immediately after this raises; the manager spins up a
        # fresh process so engine state restarts from scratch anyway.
        reset_on_exit = True
        try:
            result = await self._transcribe_with_oom_recovery(pcm)
            cleaned = strip_wake_prefix(result.text)
            await self._emit(
                PipelineEvent(
                    "transcript_final",
                    {"text": cleaned, "duration_ms": result.duration_ms},
                )
            )
        except RecoverableOomError:
            reset_on_exit = False
            raise
        except Exception as exc:
            logger.exception("transcribe failed")
            await self._emit(
                PipelineEvent(
                    "error",
                    {
                        "code": ErrorCode.INTERNAL,
                        "message": f"transcribe failed: {exc}",
                        "recoverable": True,
                    },
                )
            )
        finally:
            if reset_on_exit:
                self._reset_to_listening()

    async def _transcribe_with_oom_recovery(self, pcm: bytes):
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, self._asr.transcribe, pcm)
        except Exception as exc:
            if not _is_cuda_oom(exc):
                raise
            await self._handle_cuda_oom(exc)
            try:
                return await loop.run_in_executor(None, self._asr.transcribe, pcm)
            except Exception as second:
                if _is_cuda_oom(second):
                    raise RecoverableOomError(
                        "cuda-oom persisted after tts unload"
                    ) from second
                raise

    async def _handle_cuda_oom(self, original: BaseException) -> None:
        if self._tts is not None and self._tts.is_loaded():
            self._tts.unload()
            # tts.unload() drops Python references but the CUDA allocator's
            # block cache still holds the freed pages — until the next
            # cudaMalloc, which triggers OOM again. gc.collect() drops any
            # tensors lingering in cycles; empty_cache() returns block-cache
            # pages to the driver. Without this pair the next transcribe
            # often hits OOM on the same pcm and the second-OOM ladder kicks
            # in unnecessarily.
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            except Exception as exc:
                logger.debug("post-unload cuda cleanup ignored: %s", exc)
            await self._emit(
                PipelineEvent(
                    "error",
                    {
                        "code": ErrorCode.CUDA_OOM_RECOVERED,
                        "message": "cuda oom; tts unloaded to free vram",
                        "recoverable": True,
                        "recovery": "tts-unloaded",
                    },
                )
            )
            return
        raise RecoverableOomError("cuda-oom and tts already unloaded") from original

    def _reset_to_listening(self) -> None:
        self._state = State.LISTENING
        self._wake.reset()
        self._vad.reset()
        self._frames_since_wake = 0
        self._frames_capturing = 0
        self._capture_buf.clear()
