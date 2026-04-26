"""Pluggable engine abstractions: WakeEngine, VadEngine, AsrEngine, TtsEngine.

Real implementations (OpenWakeWord, Silero, Parakeet TDT, VibeVoice-Realtime)
plug in via ``loader.load_engines``. Mock implementations live in
``mock.py`` and drive the pytest pipeline tests without GPU or model files.
"""

from .base import (
    AsrEngine,
    AsrResult,
    EngineSet,
    TtsChunk,
    TtsEngine,
    VadEngine,
    VadEvent,
    WakeEngine,
    WakeResult,
)

__all__ = [
    "AsrEngine",
    "AsrResult",
    "EngineSet",
    "TtsChunk",
    "TtsEngine",
    "VadEngine",
    "VadEvent",
    "WakeEngine",
    "WakeResult",
]
