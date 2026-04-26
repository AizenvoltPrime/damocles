"""Real engine loader — Parakeet TDT + OpenWakeWord + Silero VAD + VibeVoice.

This module is the single entry point that wires the four production
engines into an ``EngineSet``. All ML-library imports are confined to
the engine modules below; the loader itself never touches torch/NeMo/
openwakeword/transformers directly so unit tests can import it without
the heavy deps installed.

Failure mode contract:
  * ``ImportError`` while loading an engine module is re-raised so the
    caller (``__main__.py``) can decide whether to fall back to mocks
    (``--use-mocks`` / smoke-test path) or surface the error.
  * ``ModelLoadFailed`` is also re-raised; it carries ``model_id`` and
    resolved ``path`` so the manager can log a precise diagnostic.
"""

from __future__ import annotations

from ..protocol import SidecarConfig, ModelLoadFailed
from .base import EngineSet


def load_real_engines(cfg: SidecarConfig) -> EngineSet:
    """Construct production engines per ``cfg``; raise on any failure.

    Wake-word, VAD, and ASR engines load only when ``cfg.wake_word_enabled``
    is true. The TTS engine loads independently when ``cfg.tts_enabled`` is
    true, so spoken-reply preview ("Test voice") works without activating
    the OS microphone.
    """
    wake = None
    vad = None
    asr = None
    if cfg.wake_word_enabled:
        from .wake_openwakeword import OpenWakeWordEngine
        from .vad_silero import SileroVadEngine
        from .asr_parakeet import ParakeetAsrEngine

        wake = OpenWakeWordEngine(cfg)
        vad = SileroVadEngine(cfg)
        asr = ParakeetAsrEngine(cfg)

    tts = None
    if cfg.tts_enabled:
        from .tts_vibevoice import VibeVoiceTtsEngine

        tts = VibeVoiceTtsEngine(cfg)

    return EngineSet(wake=wake, vad=vad, asr=asr, tts=tts)


__all__ = ["load_real_engines", "ModelLoadFailed"]
