"""Pre-roll replay: audio after the wake phrase reaches VAD and ASR despite detection latency."""

from __future__ import annotations

import numpy as np
import pytest

from damocles_voice_sidecar.engines.base import AsrEngine, AsrResult, EngineSet
from damocles_voice_sidecar.engines.mock import MockVadEngine, MockWakeEngine
from damocles_voice_sidecar.pipeline import (
    FALSE_WAKE_TIMEOUT_MS,
    PRE_ROLL_MS,
    Pipeline,
    PipelineConfig,
    PipelineEvent,
    State,
)
from damocles_voice_sidecar.protocol import (
    FRAME_BYTES,
    FRAME_DURATION_MS,
    FRAME_SAMPLES,
    SAMPLE_RATE,
)

from .kws_support import SAPI_VOICES, kws_engine, needs_model, with_room_tone

PHRASE_IDS = list(range(1, 11))
COMMAND_IDS = list(range(100, 140))
# Frames between the phrase end and the detection in the mock scenarios.
LATENCY_FRAMES = 6
# The spotter places the phrase end on a 40 ms encoder frame; measured worst case
# is the replay starting 105 ms before the trimmed SAPI phrase end.
PHRASE_END_TOLERANCE_MS = 120
ENCODER_FRAME_MS = 40


def _frame(frame_id: int) -> bytes:
    return np.full(FRAME_SAMPLES, frame_id, dtype=np.int16).tobytes()


def _ids(pcm: bytes) -> list[int]:
    return [int.from_bytes(pcm[i : i + 2], "little") for i in range(0, len(pcm), FRAME_BYTES)]


class RecordingAsr(AsrEngine):
    def __init__(self) -> None:
        self.pcm: bytes | None = None

    def transcribe(self, pcm_int16: bytes) -> AsrResult:
        self.pcm = pcm_int16
        return AsrResult(text="open the settings file", duration_ms=1.0)

    def device(self):
        return "cpu"


class RecordingVad(MockVadEngine):
    def __init__(self, speech_start_at: int, speech_end_at: int) -> None:
        super().__init__(speech_start_at=speech_start_at, speech_end_at=speech_end_at)
        self.seen: list[bytes] = []

    def process(self, frame: bytes):
        self.seen.append(frame)
        return super().process(frame)


def _pipeline(wake: MockWakeEngine, vad: MockVadEngine) -> tuple[Pipeline, RecordingAsr, list[str]]:
    kinds: list[str] = []

    async def emit(ev: PipelineEvent) -> None:
        kinds.append(ev.kind)

    asr = RecordingAsr()
    engines = EngineSet(wake=wake, vad=vad, asr=asr, tts=None)
    return Pipeline(engines, PipelineConfig(), emit), asr, kinds


@pytest.mark.asyncio
@pytest.mark.parametrize("phrase_end_into_frame", [0, FRAME_SAMPLES - 1])
async def test_command_right_after_the_phrase_reaches_asr_without_phrase_audio(
    phrase_end_into_frame: int,
) -> None:
    detect_at = len(PHRASE_IDS) + LATENCY_FRAMES
    wake = MockWakeEngine(
        fire_on_call=detect_at,
        samples_after_phrase=LATENCY_FRAMES * FRAME_SAMPLES + phrase_end_into_frame,
    )
    pipeline, asr, kinds = _pipeline(wake, MockVadEngine(speech_start_at=1, speech_end_at=30))

    for frame_id in PHRASE_IDS + COMMAND_IDS:
        await pipeline.feed(_frame(frame_id))

    assert asr.pcm is not None
    assert _ids(asr.pcm) == COMMAND_IDS[:30]
    assert kinds[:2] == ["wake_detected", "vad_speech_started"]


@pytest.mark.asyncio
async def test_replay_is_bounded_by_the_pre_roll() -> None:
    listening_ids = list(range(1, 5 * 1000 // FRAME_DURATION_MS + 1))
    vad = RecordingVad(speech_start_at=10_000, speech_end_at=10_001)
    wake = MockWakeEngine(fire_on_call=len(listening_ids), samples_after_phrase=10**9)
    pipeline, _asr, _kinds = _pipeline(wake, vad)

    for frame_id in listening_ids:
        await pipeline.feed(_frame(frame_id))

    pre_roll_frames = PRE_ROLL_MS // FRAME_DURATION_MS
    assert _ids(b"".join(vad.seen)) == listening_ids[-pre_roll_frames:]


@pytest.mark.asyncio
async def test_reset_clears_the_pre_roll() -> None:
    vad = RecordingVad(speech_start_at=10_000, speech_end_at=10_001)
    wake = MockWakeEngine(fire_on_call=3, max_fires=2, samples_after_phrase=10**9)
    pipeline, _asr, kinds = _pipeline(wake, vad)

    for frame_id in range(1, 4):
        await pipeline.feed(_frame(frame_id))
    # The three replayed frames already count toward the false-wake timeout.
    for _ in range(FALSE_WAKE_TIMEOUT_MS // FRAME_DURATION_MS - 3):
        await pipeline.feed(_frame(50))
    assert kinds[-1] == "wake_aborted"
    assert pipeline.state == State.LISTENING

    vad.seen.clear()
    for frame_id in range(200, 203):
        await pipeline.feed(_frame(frame_id))

    assert _ids(b"".join(vad.seen)) == [200, 201, 202]


async def _captured_start(pcm: np.ndarray) -> int:
    """Feed ``pcm`` through a real-spotter pipeline; return the first captured sample index."""
    asr = RecordingAsr()

    async def emit(_ev: PipelineEvent) -> None:
        pass

    engines = EngineSet(
        wake=kws_engine(),
        vad=MockVadEngine(speech_start_at=1, speech_end_at=100),
        asr=asr,
        tts=None,
    )
    pipeline = Pipeline(engines, PipelineConfig(), emit)
    for i in range(pcm.size // FRAME_SAMPLES):
        await pipeline.feed(pcm[i * FRAME_SAMPLES : (i + 1) * FRAME_SAMPLES].tobytes())
    assert asr.pcm is not None, "wake phrase not detected"
    offset = pcm.tobytes().find(asr.pcm[:FRAME_BYTES])
    assert offset >= 0 and offset % FRAME_BYTES == 0
    return offset // 2


@needs_model
@pytest.mark.asyncio
@pytest.mark.parametrize("voice", SAPI_VOICES)
@pytest.mark.parametrize("gap_ms", [0, 300])
async def test_real_spotter_replays_from_the_phrase_end(sapi, voice: str, gap_ms: int) -> None:
    phrase = sapi("Hey Jarvis", voice)
    command = sapi("open the settings file", voice)
    gap = np.zeros(gap_ms * SAMPLE_RATE // 1000, dtype=np.int16)
    lead_s = 0.5
    pcm = with_room_tone(np.concatenate([phrase, gap, command]), lead_s=lead_s, tail_s=2.5)
    phrase_end = int(lead_s * SAMPLE_RATE) + phrase.size
    command_start = phrase_end + gap.size

    start = await _captured_start(pcm)

    assert start >= phrase_end - PHRASE_END_TOLERANCE_MS * SAMPLE_RATE // 1000
    assert start <= command_start + ENCODER_FRAME_MS * SAMPLE_RATE // 1000
