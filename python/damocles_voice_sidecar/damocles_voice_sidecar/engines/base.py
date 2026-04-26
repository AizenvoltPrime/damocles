"""Engine ABCs — the pipeline talks to these, not to specific ML libraries.

This indirection is what makes the pipeline testable without GPU and without
NeMo/OpenWakeWord/etc installed. ``mock.py`` provides deterministic
implementations driven by the test fixtures.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Literal


@dataclass
class WakeResult:
    detected: bool
    confidence: float


class WakeEngine(ABC):
    """Frame-by-frame wake-word detector. CPU-side, ~5 ms per frame."""

    @abstractmethod
    def process(self, frame: bytes) -> WakeResult:
        """Feed a 320-sample int16 mono frame; return detection state.

        Implementations MUST be pure-functional w.r.t. the frame stream:
        same input sequence -> same output sequence.
        """

    @abstractmethod
    def reset(self) -> None:
        """Clear internal ring buffer / detector state. Called after each
        wake-detected -> transcript_final -> back-to-listening cycle."""

    @abstractmethod
    def set_sensitivity(self, sensitivity: float) -> None:
        """Update detection threshold without reloading the model."""


VadEvent = Literal["speech_started", "speech_ended", "silence", "speech"]


class VadEngine(ABC):
    """Silero-VAD wrapper. Emits start/end events bracketing speech."""

    @abstractmethod
    def process(self, frame: bytes) -> VadEvent:
        """Feed a 320-sample frame; return current state transition."""

    @abstractmethod
    def reset(self) -> None: ...


@dataclass
class AsrResult:
    text: str
    duration_ms: float


class AsrEngine(ABC):
    """Parakeet TDT — VAD-triggered batch ASR.

    Per Section 1 of the plan, the chosen model is batch-only; there is no
    streaming path and no ``transcript_partial`` event. The pipeline calls
    ``transcribe`` once on ``vad_speech_ended`` with the captured utterance.
    """

    @abstractmethod
    def transcribe(self, pcm_int16: bytes) -> AsrResult: ...

    @abstractmethod
    def device(self) -> Literal["cuda", "cpu"]: ...

    def auto_fallback_reason(self) -> Literal["no-cuda", "low-vram", "user-pref"] | None:
        """Optional: explain why we landed on CPU when CUDA could've been used."""
        return None

    def free_vram_mb(self) -> float:
        """Optional: report free VRAM at construction time."""
        return 0.0


@dataclass
class TtsChunk:
    request_id: str
    pcm_float32: bytes
    sample_rate: int


class TtsEngine(ABC):
    """VibeVoice-Realtime — sentence-level streaming TTS."""

    @abstractmethod
    async def synthesize(self, request_id: str, text: str) -> AsyncIterator[TtsChunk]:
        """Yield audio chunks as sentences synthesize. Caller may cancel by
        breaking out of the iterator."""

    @abstractmethod
    def cancel(self, request_id: str | None) -> None: ...

    @abstractmethod
    def unload(self) -> None:
        """Free GPU memory. Called by the OOM ladder before falling back to
        CPU mode."""

    @abstractmethod
    def is_loaded(self) -> bool: ...

    def swap_voice(self, voice_id: str) -> str:
        """Hot-swap the per-speaker prefill in place.

        Returns the resolved voice id actually loaded (may differ from the
        requested id if the engine fell back to a default). Default
        implementation raises — engines that don't support hot-swap must
        rely on the manager restarting the sidecar.
        """
        raise NotImplementedError("swap_voice not supported by this engine")


@dataclass
class EngineSet:
    """The full set of engines wired into the pipeline.

    ``wake``/``vad``/``asr`` are present only when wake-word mode is enabled;
    in TTS-only mode they are ``None`` and the WebSocket server skips the mic
    input + pipeline construction entirely.
    """

    wake: WakeEngine | None
    vad: VadEngine | None
    asr: AsrEngine | None
    tts: TtsEngine | None
