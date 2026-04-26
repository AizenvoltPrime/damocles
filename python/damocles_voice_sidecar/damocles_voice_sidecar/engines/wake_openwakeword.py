"""OpenWakeWord-backed WakeEngine implementation.

CPU-only. 16 kHz int16 mono frames, 320 samples per frame. The detector
runs at ~5 ms per frame and never logs raw audio bytes or PCM contents.

Frame buffering: OpenWakeWord predicts on chunks of >= 1280 samples (80 ms
internally). This wrapper accumulates 20-ms frames into the detector's
expected window and queries on every call so detections are returned with
~80 ms granularity at worst.

Privacy posture (FR-11, US-011):
  * No frame bytes ever pass through ``logger``.
  * Only structural events (e.g. ``wake_detected``) are logged at info
    level, and only when ``diagnostics=True``.
  * The internal feature buffer maintained by openwakeword is never
    serialized, persisted, or copied off the engine.
"""

from __future__ import annotations

import logging
import os
from importlib import resources
from typing import Optional

import numpy as np

from ..protocol import FRAME_SAMPLES, SidecarConfig, ModelLoadFailed
from .base import WakeEngine, WakeResult

logger = logging.getLogger(__name__)

WAKE_BUFFER_SAMPLES = 1280
DEFAULT_BUNDLED_FILENAME = "hey_jarvis.onnx"
BARGE_IN_THRESHOLD = 0.75
MODEL_EXTENSION = ".onnx"
INFERENCE_FRAMEWORK = "onnx"
MELSPEC_MODEL_FILENAME = "melspectrogram.onnx"
EMBEDDING_MODEL_FILENAME = "embedding_model.onnx"


class OpenWakeWordEngine(WakeEngine):
    """Wraps ``openwakeword.Model`` for the Damocles pipeline."""

    def __init__(self, cfg: SidecarConfig) -> None:
        try:
            from openwakeword.model import Model
        except ImportError as exc:
            raise ModelLoadFailed(
                model_id=cfg.wake_word,
                path="<openwakeword package not installed>",
                cause=exc,
            ) from exc

        path = self._resolve_model_path(cfg)
        if not self._is_valid_model_file(path):
            raise ModelLoadFailed(model_id=cfg.wake_word, path=path)

        melspec_path = self._resolve_preprocessor_path(MELSPEC_MODEL_FILENAME)
        embedding_path = self._resolve_preprocessor_path(EMBEDDING_MODEL_FILENAME)

        try:
            self._model = Model(
                wakeword_models=[path],
                inference_framework=INFERENCE_FRAMEWORK,
                melspec_model_path=melspec_path,
                embedding_model_path=embedding_path,
            )
        except Exception as exc:
            raise ModelLoadFailed(model_id=cfg.wake_word, path=path, cause=exc) from exc

        self._model_path = path
        self._model_key = self._first_model_key()
        self._sensitivity = float(cfg.wake_sensitivity)
        self._diagnostics = bool(cfg.diagnostics)
        self._buffer = np.zeros(0, dtype=np.int16)

    @staticmethod
    def _resolve_preprocessor_path(filename: str) -> str:
        """Locate a bundled openwakeword preprocessing model (melspec / embedding)."""
        try:
            packaged = resources.files("damocles_voice_sidecar.models.wake").joinpath(filename)
            if packaged.is_file():
                return str(packaged)
        except (ModuleNotFoundError, FileNotFoundError):
            pass
        raise ModelLoadFailed(
            model_id=filename,
            path=f"<bundled {filename} missing — run `npm run fetch:wake-models`>",
        )

    @staticmethod
    def _is_valid_model_file(path: str) -> bool:
        """Cheap structural check before openwakeword's loader sees the file."""
        if not os.path.isfile(path):
            return False
        try:
            if os.path.getsize(path) == 0:
                return False
        except OSError:
            return False
        return os.path.splitext(path)[1].lower() == MODEL_EXTENSION

    @staticmethod
    def _resolve_model_path(cfg: SidecarConfig) -> str:
        wake = cfg.wake_word or "hey_jarvis"
        if os.path.isabs(wake) and os.path.isfile(wake):
            return wake

        candidate = os.path.join(cfg.models_dir, "wake", f"{wake}{MODEL_EXTENSION}")
        if os.path.isfile(candidate):
            return candidate

        try:
            packaged = resources.files("damocles_voice_sidecar.models.wake").joinpath(
                f"{wake}{MODEL_EXTENSION}"
            )
            if packaged.is_file():
                return str(packaged)
            packaged_default = resources.files(
                "damocles_voice_sidecar.models.wake"
            ).joinpath(DEFAULT_BUNDLED_FILENAME)
            if packaged_default.is_file():
                return str(packaged_default)
        except (ModuleNotFoundError, FileNotFoundError):
            pass

        raise ModelLoadFailed(model_id=wake, path=candidate)

    def _first_model_key(self) -> str:
        keys = list(self._model.models.keys())
        if not keys:
            raise ModelLoadFailed(
                model_id="<unknown>",
                path=self._model_path,
            )
        return keys[0]

    def process(self, frame: bytes) -> WakeResult:
        """Feed a 20-ms frame; emit a triggered WakeResult on threshold cross."""
        if len(frame) != FRAME_SAMPLES * 2:
            return WakeResult(detected=False, confidence=0.0)

        samples = np.frombuffer(frame, dtype=np.int16)
        self._buffer = np.concatenate([self._buffer, samples])
        if self._buffer.size < WAKE_BUFFER_SAMPLES:
            return WakeResult(detected=False, confidence=0.0)

        chunk = self._buffer[:WAKE_BUFFER_SAMPLES]
        self._buffer = self._buffer[WAKE_BUFFER_SAMPLES:]

        scores = self._model.predict(chunk)
        confidence = float(scores.get(self._model_key, 0.0))
        if confidence >= self._sensitivity:
            if self._diagnostics:
                logger.info("wake_detected confidence=%.3f", confidence)
            return WakeResult(detected=True, confidence=confidence)
        return WakeResult(detected=False, confidence=confidence)

    def reset(self) -> None:
        """Reset detector state and feature buffer between activations."""
        self._buffer = np.zeros(0, dtype=np.int16)
        try:
            self._model.reset()
        except AttributeError:
            for prediction_buffer in getattr(self._model, "prediction_buffer", {}).values():
                prediction_buffer.clear()

    def set_sensitivity(self, sensitivity: float) -> None:
        """Update detection threshold without reloading the model."""
        clamped = max(0.0, min(1.0, float(sensitivity)))
        self._sensitivity = clamped

    def raise_threshold_for_barge_in(self) -> None:
        """Raise threshold to the barge-in floor while TTS is playing back."""
        if self._sensitivity < BARGE_IN_THRESHOLD:
            self._sensitivity = BARGE_IN_THRESHOLD
