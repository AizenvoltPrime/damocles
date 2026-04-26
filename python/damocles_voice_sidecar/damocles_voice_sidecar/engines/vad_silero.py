"""Silero VAD-backed VadEngine implementation.

CPU-only. Uses the pinned ``silero-vad`` package which ships an ONNX model
under the hood (loaded via ``onnxruntime`` from the same pinned wheel).

Frame contract: 320-sample int16 frames (20 ms at 16 kHz). Silero v5 expects
512-sample windows internally; this wrapper accumulates frames and runs
inference once per window so the engine still returns a per-frame
``VadEvent`` (the result for the in-progress window is replayed across the
frames covered by it, which the pipeline absorbs as the same logical state).

Thresholds:
  * ``SPEECH_PROB_ON``: probability above which the window is classified as
    speech.
  * ``SILENCE_HOLD_MS``: trailing silence required before emitting
    ``speech_ended`` (matches ``end_of_turn_silence_ms`` for parity with the
    pipeline timeout, but Silero's per-window probability handles the bulk
    of the work).
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import numpy as np

from ..protocol import FRAME_SAMPLES, SAMPLE_RATE, SidecarConfig, ModelLoadFailed
from .base import VadEngine, VadEvent

logger = logging.getLogger(__name__)

VAD_WINDOW_SAMPLES = 512
SPEECH_PROB_ON = 0.5
SPEECH_PROB_OFF = 0.35
SILENCE_HOLD_FRAMES_DEFAULT = 800 // 20


class SileroVadEngine(VadEngine):
    """Wraps the pinned ``silero-vad`` ONNX model for streaming VAD."""

    def __init__(self, cfg: SidecarConfig) -> None:
        try:
            from silero_vad import load_silero_vad
        except ImportError as exc:
            raise ModelLoadFailed(
                model_id="silero_vad",
                path="<silero-vad package not installed>",
                cause=exc,
            ) from exc

        try:
            self._model = load_silero_vad(onnx=True)
        except Exception as exc:
            raise ModelLoadFailed(
                model_id="silero_vad",
                path=self._best_effort_model_path(cfg),
                cause=exc,
            ) from exc

        self._silence_hold_frames = max(
            1, int(cfg.end_of_turn_silence_ms) // 20
        ) if cfg.end_of_turn_silence_ms else SILENCE_HOLD_FRAMES_DEFAULT
        self._buffer = np.zeros(0, dtype=np.float32)
        self._in_speech = False
        self._silence_run = 0

    @staticmethod
    def _best_effort_model_path(cfg: SidecarConfig) -> str:
        from ..models.manifest import model_version_dir
        return os.path.join(
            model_version_dir(cfg.models_dir, "silero_vad"),
            "silero_vad.onnx",
        )

    def process(self, frame: bytes) -> VadEvent:
        """Feed a 20-ms frame; return the current speech-state transition."""
        if len(frame) != FRAME_SAMPLES * 2:
            return "speech" if self._in_speech else "silence"

        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
        self._buffer = np.concatenate([self._buffer, samples])

        if self._buffer.size < VAD_WINDOW_SAMPLES:
            return "speech" if self._in_speech else "silence"

        window = self._buffer[:VAD_WINDOW_SAMPLES]
        self._buffer = self._buffer[VAD_WINDOW_SAMPLES:]

        prob = self._infer(window)
        was_speech = self._in_speech

        if prob >= SPEECH_PROB_ON:
            self._silence_run = 0
            if not was_speech:
                self._in_speech = True
                return "speech_started"
            return "speech"

        if was_speech and prob < SPEECH_PROB_OFF:
            self._silence_run += 1
            if self._silence_run >= self._silence_hold_frames:
                self._in_speech = False
                self._silence_run = 0
                return "speech_ended"
            return "speech"

        return "silence"

    def _infer(self, window: np.ndarray) -> float:
        import torch

        tensor = torch.from_numpy(window)
        with torch.no_grad():
            out = self._model(tensor, SAMPLE_RATE)
        if hasattr(out, "item"):
            return float(out.item())
        return float(out)

    def reset(self) -> None:
        """Reset internal state and any model RNN history."""
        self._buffer = np.zeros(0, dtype=np.float32)
        self._in_speech = False
        self._silence_run = 0
        reset_states = getattr(self._model, "reset_states", None)
        if callable(reset_states):
            reset_states()
