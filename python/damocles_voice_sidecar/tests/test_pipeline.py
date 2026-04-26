"""End-to-end pipeline state-machine test using mock engines.

Asserts:
  * Frames before wake stay in LISTENING.
  * Wake -> POST_WAKE_OFFSET window -> WAITING_FOR_SPEECH transition.
  * VAD speech_started -> CAPTURING -> speech_ended -> transcript_final.
  * False-wake (no speech in window) -> wake_aborted, no transcript_final.
  * The wake-phrase prefix is stripped before transcript_final.
"""

from __future__ import annotations

import asyncio
from typing import List

import pytest

from damocles_voice_sidecar.engines.base import EngineSet
from damocles_voice_sidecar.engines.mock import (
    MockAsrEngine,
    MockTtsEngine,
    MockVadEngine,
    MockWakeEngine,
)
from damocles_voice_sidecar.pipeline import (
    FALSE_WAKE_TIMEOUT_MS,
    POST_WAKE_OFFSET_MS,
    Pipeline,
    PipelineConfig,
    PipelineEvent,
    State,
)
from damocles_voice_sidecar.protocol import FRAME_BYTES, FRAME_DURATION_MS

SILENCE_FRAME = b"\x00" * FRAME_BYTES


def _frames_for(ms: int) -> int:
    return ms // FRAME_DURATION_MS


def _make_pipeline(
    wake_fire_at: int = 1,
    vad_start_at: int = 1,
    vad_end_at: int = 5,
    asr_text: str = "Hey Jarvis, ping me",
):
    captured: List[PipelineEvent] = []

    async def emit(ev: PipelineEvent) -> None:
        captured.append(ev)

    engines = EngineSet(
        wake=MockWakeEngine(fire_on_call=wake_fire_at),
        vad=MockVadEngine(speech_start_at=vad_start_at, speech_end_at=vad_end_at),
        asr=MockAsrEngine(text=asr_text),
        tts=MockTtsEngine(),
    )
    return Pipeline(engines, PipelineConfig(), emit), captured


@pytest.mark.asyncio
async def test_happy_path_strips_wake_prefix() -> None:
    pipeline, events = _make_pipeline(
        wake_fire_at=1,
        vad_start_at=1,
        vad_end_at=5,
        asr_text="Hey Jarvis, refactor this function.",
    )

    # 1 frame to fire wake.
    await pipeline.feed(SILENCE_FRAME)
    assert pipeline.state == State.POST_WAKE_OFFSET

    # Burn through the post-wake offset (250 ms = 12 frames at 20 ms).
    for _ in range(_frames_for(POST_WAKE_OFFSET_MS)):
        await pipeline.feed(SILENCE_FRAME)
    assert pipeline.state == State.WAITING_FOR_SPEECH

    # First post-offset frame: VAD signals speech_started.
    await pipeline.feed(SILENCE_FRAME)
    assert pipeline.state == State.CAPTURING

    # Drive VAD to speech_ended.
    for _ in range(5):
        await pipeline.feed(SILENCE_FRAME)

    # transcript_final should have fired and the prefix stripped.
    final = next(e for e in events if e.kind == "transcript_final")
    assert final.payload["text"] == "refactor this function."
    assert pipeline.state == State.LISTENING


@pytest.mark.asyncio
async def test_false_wake_aborts_when_no_speech_in_window() -> None:
    pipeline, events = _make_pipeline(
        wake_fire_at=1,
        # VAD never signals speech_started within the false-wake window.
        vad_start_at=10_000,
        vad_end_at=10_001,
    )

    # Fire wake.
    await pipeline.feed(SILENCE_FRAME)
    # Burn through the post-wake offset.
    for _ in range(_frames_for(POST_WAKE_OFFSET_MS)):
        await pipeline.feed(SILENCE_FRAME)
    # Burn through the false-wake timeout.
    for _ in range(_frames_for(FALSE_WAKE_TIMEOUT_MS) + 1):
        await pipeline.feed(SILENCE_FRAME)

    kinds = [e.kind for e in events]
    assert "wake_aborted" in kinds
    assert "transcript_final" not in kinds
    assert pipeline.state == State.LISTENING
