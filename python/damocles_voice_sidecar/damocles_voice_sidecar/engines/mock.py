"""Deterministic mock engines for pytest-driven pipeline tests.

These let us verify the wake -> VAD -> ASR -> TTS -> protocol orchestration
without GPU, without model files, and without internet. Real engines live in
``loader.py`` and load NeMo / OpenWakeWord / Silero / VibeVoice on demand.
"""

from __future__ import annotations

from typing import AsyncIterator

from .base import AsrEngine, AsrResult, TtsChunk, TtsEngine, VadEngine, VadEvent, WakeEngine, WakeResult


class MockWakeEngine(WakeEngine):
    """Triggers a wake on the Nth call to ``process``. Used by tests.

    The fire window is consumed once per test lifetime: ``reset()`` clears
    transient counters but does NOT re-arm the trigger. Tests that need
    multiple wakes within one scenario can pass ``max_fires>1``.
    """

    def __init__(
        self,
        fire_on_call: int = 5,
        confidence: float = 0.8,
        max_fires: int = 1,
    ) -> None:
        self.fire_on_call = fire_on_call
        self.confidence = confidence
        self.max_fires = max_fires
        self._calls = 0
        self._times_fired = 0
        self._sensitivity = 0.5

    def process(self, frame: bytes) -> WakeResult:
        self._calls += 1
        if self._calls == self.fire_on_call and self._times_fired < self.max_fires:
            self._times_fired += 1
            return WakeResult(detected=True, confidence=self.confidence)
        return WakeResult(detected=False, confidence=0.0)

    def reset(self) -> None:
        self._calls = 0

    def set_sensitivity(self, sensitivity: float) -> None:
        self._sensitivity = sensitivity


class MockVadEngine(VadEngine):
    """Programmable VAD: caller specifies which call indexes start/end speech."""

    def __init__(self, speech_start_at: int = 1, speech_end_at: int = 10) -> None:
        self.speech_start_at = speech_start_at
        self.speech_end_at = speech_end_at
        self._calls = 0
        self._in_speech = False

    def process(self, frame: bytes) -> VadEvent:
        self._calls += 1
        if self._calls == self.speech_start_at and not self._in_speech:
            self._in_speech = True
            return "speech_started"
        if self._calls == self.speech_end_at and self._in_speech:
            self._in_speech = False
            return "speech_ended"
        return "speech" if self._in_speech else "silence"

    def reset(self) -> None:
        self._calls = 0
        self._in_speech = False


class MockAsrEngine(AsrEngine):
    """Returns a fixed transcript. Tests assert the regex strip pass works."""

    def __init__(self, text: str = "Hey Jarvis, refactor this function.") -> None:
        self.text = text

    def transcribe(self, pcm_int16: bytes) -> AsrResult:
        # Pretend transcription took 150 ms regardless of input size.
        return AsrResult(text=self.text, duration_ms=150.0)

    def device(self):
        return "cpu"


class MockTtsEngine(TtsEngine):
    """Yields a single 240-byte chunk per request. Tracks load/unload state."""

    def __init__(self) -> None:
        self._loaded = True
        self._cancelled: set[str] = set()

    async def synthesize(self, request_id: str, text: str) -> AsyncIterator[TtsChunk]:
        if request_id in self._cancelled:
            return
        # 60 float32 samples = 0.0025 s of audio at 24 kHz; cheap test fixture.
        yield TtsChunk(
            request_id=request_id,
            pcm_float32=b"\x00" * 240,
            sample_rate=24_000,
        )

    def cancel(self, request_id: str | None) -> None:
        if request_id is None:
            return
        self._cancelled.add(request_id)

    def unload(self) -> None:
        self._loaded = False

    def is_loaded(self) -> bool:
        return self._loaded
