"""Pipeline OOM-ladder behaviour (US-013 partial integration).

These tests substitute the AsrEngine with a controllable mock that raises
``OutOfMemoryError`` (a class shaped like torch.cuda.OutOfMemoryError) on
demand, and assert:

  1. First OOM -> pipeline calls ``tts.unload()`` once, emits an
     ``error`` event with code ``cuda-oom-recovered``, retries the
     transcription, and produces ``transcript_final``.
  2. Two consecutive OOMs -> pipeline raises ``RecoverableOomError`` so
     ``__main__.py`` exits with code 7 for cpu-mode restart.
"""

from __future__ import annotations

from typing import List

import pytest

from damocles_voice_sidecar.engines.base import (
    AsrEngine,
    AsrResult,
    EngineSet,
)
from damocles_voice_sidecar.engines.mock import (
    MockTtsEngine,
    MockVadEngine,
    MockWakeEngine,
)
from damocles_voice_sidecar.pipeline import (
    POST_WAKE_OFFSET_MS,
    Pipeline,
    PipelineConfig,
    PipelineEvent,
    State,
)
from damocles_voice_sidecar.protocol import FRAME_BYTES, FRAME_DURATION_MS, RecoverableOomError


SILENCE_FRAME = b"\x00" * FRAME_BYTES


def _build_cuda_oom_class() -> type[BaseException]:
    """Build a fake CUDA OOM that subclasses the real one when available.

    The previous shim relied on a ``__class__.__name__ == "OutOfMemoryError"``
    shortcut in ``_is_cuda_oom``. That worked, but it meant a future refactor
    of ``_is_cuda_oom`` to drop the name fallback would silently break this
    test instead of failing loudly. Subclassing the real exception when
    torch is importable makes ``isinstance(exc, torch.cuda.OutOfMemoryError)``
    true for the right reason; the name shortcut remains a CI-without-torch
    safety net but is no longer the primary path.
    """
    try:
        import torch
        return type("OutOfMemoryError", (torch.cuda.OutOfMemoryError,), {})
    except ImportError:
        cls = type("OutOfMemoryError", (RuntimeError,), {})
        return cls


_CudaOom = _build_cuda_oom_class()


class FlakyAsrEngine(AsrEngine):
    """Raises OOM ``oom_count`` times, then returns a normal transcript."""

    def __init__(self, oom_count: int) -> None:
        self.oom_count = oom_count
        self.calls = 0

    def transcribe(self, pcm_int16: bytes) -> AsrResult:
        self.calls += 1
        if self.calls <= self.oom_count:
            raise _CudaOom("simulated cuda oom")
        return AsrResult(text="ok", duration_ms=10.0)

    def device(self):
        return "cuda"


def _frames_for(ms: int) -> int:
    return ms // FRAME_DURATION_MS


def _build(oom_count: int):
    captured: List[PipelineEvent] = []

    async def emit(ev: PipelineEvent) -> None:
        captured.append(ev)

    tts = MockTtsEngine()
    asr = FlakyAsrEngine(oom_count=oom_count)
    engines = EngineSet(
        wake=MockWakeEngine(fire_on_call=1),
        vad=MockVadEngine(speech_start_at=1, speech_end_at=2),
        asr=asr,
        tts=tts,
    )
    return Pipeline(engines, PipelineConfig(), emit), captured, tts, asr


async def _drive_to_transcribe(pipeline) -> None:
    await pipeline.feed(SILENCE_FRAME)
    for _ in range(_frames_for(POST_WAKE_OFFSET_MS)):
        await pipeline.feed(SILENCE_FRAME)
    await pipeline.feed(SILENCE_FRAME)
    await pipeline.feed(SILENCE_FRAME)


@pytest.mark.asyncio
async def test_single_oom_recovers_via_tts_unload() -> None:
    pipeline, events, tts, asr = _build(oom_count=1)

    await _drive_to_transcribe(pipeline)

    assert tts.is_loaded() is False, "tts.unload() should have run once"
    assert asr.calls == 2, "second transcribe should have succeeded"

    error_events = [e for e in events if e.kind == "error"]
    assert len(error_events) == 1
    assert error_events[0].payload["code"] == "cuda-oom-recovered"
    assert error_events[0].payload["recovery"] == "tts-unloaded"

    finals = [e for e in events if e.kind == "transcript_final"]
    assert len(finals) == 1
    assert finals[0].payload["text"] == "ok"
    assert pipeline.state == State.LISTENING


@pytest.mark.asyncio
async def test_double_oom_raises_recoverable_oom_error() -> None:
    pipeline, _events, tts, _asr = _build(oom_count=2)

    with pytest.raises(RecoverableOomError):
        await _drive_to_transcribe(pipeline)

    assert tts.is_loaded() is False
