"""Shared helpers for tests that run the bundled keyword-spotting model.

Model tests skip unless sherpa_onnx and sentencepiece are installed and
``npm run fetch:wake-models`` has placed the model in ``models/wake``. Speech
clips come from the ``sapi`` fixture in ``conftest.py``.
"""

from __future__ import annotations

import importlib.util
from importlib import resources

import numpy as np
import pytest

from damocles_voice_sidecar.engines.wake_sherpa_kws import (
    BPE_MODEL_FILENAME,
    DECODER_FILENAME,
    ENCODER_FILENAME,
    JOINER_FILENAME,
    TOKENS_FILENAME,
    SherpaKwsWakeEngine,
)
from damocles_voice_sidecar.protocol import SAMPLE_RATE, SidecarConfig

MODEL_FILES = [ENCODER_FILENAME, DECODER_FILENAME, JOINER_FILENAME, TOKENS_FILENAME, BPE_MODEL_FILENAME]
SAPI_VOICES = ["Microsoft David Desktop", "Microsoft Zira Desktop"]


def _model_skip_reason() -> str | None:
    for module in ("sherpa_onnx", "sentencepiece"):
        if importlib.util.find_spec(module) is None:
            return f"{module} is not installed"
    wake_dir = resources.files("damocles_voice_sidecar.models.wake")
    missing = [name for name in MODEL_FILES if not wake_dir.joinpath(name).is_file()]
    if missing:
        return f"wake model files not fetched (npm run fetch:wake-models): {', '.join(missing)}"
    return None


_SKIP_REASON = _model_skip_reason()
needs_model = pytest.mark.skipif(_SKIP_REASON is not None, reason=_SKIP_REASON or "")


def kws_engine(phrase: str = "hey jarvis", sensitivity: float = 0.5) -> SherpaKwsWakeEngine:
    return SherpaKwsWakeEngine(
        SidecarConfig(port=0, models_dir="", wake_word=phrase, wake_sensitivity=sensitivity)
    )


def with_room_tone(speech: np.ndarray, lead_s: float = 0.5, tail_s: float = 1.5) -> np.ndarray:
    rng = np.random.default_rng(0)
    pcm = np.concatenate(
        [
            np.zeros(int(lead_s * SAMPLE_RATE)),
            speech.astype(np.float64),
            np.zeros(int(tail_s * SAMPLE_RATE)),
        ]
    )
    return np.clip(pcm + rng.normal(0.0, 3.0, pcm.size), -32768, 32767).astype(np.int16)
