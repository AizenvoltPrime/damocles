"""sherpa-onnx keyword-spotting WakeEngine.

CPU-only. Runs the bundled streaming zipformer keyword spotter
(sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01, Apache-2.0) over
16 kHz int16 mono 20-ms frames and spots the configured wake phrase, which
is tokenized with the bundled BPE model. A detection reports how much audio
followed the phrase, taking the phrase end as the end of the encoder frame
that emitted the keyword's last token.

Privacy posture (FR-11, US-011):
  * No frame bytes ever pass through ``logger``.
  * ``wake_detected`` is logged at info level only when ``diagnostics=True``.
  * The stream's feature buffer is never serialized, persisted, or copied
    off the engine.
"""

from __future__ import annotations

import logging
import os
from importlib import resources

import numpy as np

from ..protocol import FRAME_BYTES, SAMPLE_RATE, ModelLoadFailed, SidecarConfig
from ..wake_phrase import normalize_wake_phrase
from .base import WakeEngine, WakeResult

logger = logging.getLogger(__name__)

WAKE_MODEL_ID = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
WAKE_MODEL_PACKAGE = "damocles_voice_sidecar.models.wake"
ENCODER_FILENAME = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
DECODER_FILENAME = "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
JOINER_FILENAME = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
TOKENS_FILENAME = "tokens.txt"
BPE_MODEL_FILENAME = "bpe.model"
# Seconds per encoder output frame (10 ms feature shift x subsampling 4); the
# spotter's token timestamps are multiples of it and mark each frame's start.
ENCODER_FRAME_S = 0.04

# Slider range of damocles.voice.wakeWordSensitivity; the TS schema enforces the same bounds.
MIN_SENSITIVITY = 0.1
MAX_SENSITIVITY = 0.95
BARGE_IN_SENSITIVITY = 0.75
# Piecewise-linear map from slider value to sherpa keyword threshold; derivation in the README.
SENSITIVITY_TO_THRESHOLD = ((0.1, 0.10), (0.5, 0.25), (0.95, 0.50))


def keyword_threshold(sensitivity: float) -> float:
    """sherpa-onnx trigger threshold (mean token probability) for a slider value."""
    xs, ys = zip(*SENSITIVITY_TO_THRESHOLD)
    return float(np.interp(sensitivity, xs, ys))


def _clamp_sensitivity(sensitivity: float) -> float:
    return max(MIN_SENSITIVITY, min(MAX_SENSITIVITY, float(sensitivity)))


def _bundled_file(filename: str) -> str:
    try:
        packaged = resources.files(WAKE_MODEL_PACKAGE).joinpath(filename)
        if packaged.is_file():
            return str(packaged)
    except (ModuleNotFoundError, FileNotFoundError):
        pass
    raise ModelLoadFailed(
        model_id=WAKE_MODEL_ID,
        path=f"<bundled {filename} missing — run `npm run fetch:wake-models`>",
    )


class SherpaKwsWakeEngine(WakeEngine):
    """Wraps ``sherpa_onnx.KeywordSpotter`` for the Damocles pipeline."""

    def __init__(self, cfg: SidecarConfig) -> None:
        phrase = normalize_wake_phrase(cfg.wake_word)
        try:
            import sentencepiece
            import sherpa_onnx
        except ImportError as exc:
            raise ModelLoadFailed(
                model_id=WAKE_MODEL_ID,
                path="<sherpa-onnx or sentencepiece package not installed>",
                cause=exc,
            ) from exc

        encoder = _bundled_file(ENCODER_FILENAME)
        decoder = _bundled_file(DECODER_FILENAME)
        joiner = _bundled_file(JOINER_FILENAME)
        tokens = _bundled_file(TOKENS_FILENAME)
        bpe_model = _bundled_file(BPE_MODEL_FILENAME)

        try:
            # The model's BPE vocabulary is upper-case (GigaSpeech transcripts).
            pieces = sentencepiece.SentencePieceProcessor(model_file=bpe_model).encode(
                phrase.upper(), out_type=str
            )
            # The keyword lives only in each stream's keyword string: the C++ side
            # requires a keywords file, and an entry there for the same phrase
            # would override the per-stream threshold that set_sensitivity uses.
            self._spotter = sherpa_onnx.KeywordSpotter(
                tokens=tokens,
                encoder=encoder,
                decoder=decoder,
                joiner=joiner,
                keywords_file=os.devnull,
                num_threads=1,
                provider="cpu",
            )
        except Exception as exc:
            raise ModelLoadFailed(model_id=WAKE_MODEL_ID, path=encoder, cause=exc) from exc

        self._keyword_pieces = " ".join(pieces)
        self._diagnostics = bool(cfg.diagnostics)
        self._sensitivity = _clamp_sensitivity(cfg.wake_sensitivity)
        self._threshold = keyword_threshold(self._sensitivity)
        self._restart_stream()

    def _restart_stream(self) -> None:
        # Token timestamps count from the stream's first sample; reset_stream moves
        # that origin to a point the Python API does not expose, so detections
        # always start a new stream instead.
        self._stream = self._spotter.create_stream(
            f"{self._keyword_pieces} #{self._threshold:.4f}"
        )
        self._samples_fed = 0

    def process(self, frame: bytes) -> WakeResult:
        """Feed a 20-ms frame; report a detection when the phrase is spotted."""
        if len(frame) != FRAME_BYTES:
            return WakeResult(detected=False, confidence=0.0)

        samples = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
        self._stream.accept_waveform(SAMPLE_RATE, samples)
        self._samples_fed += samples.size
        while self._spotter.is_ready(self._stream):
            self._spotter.decode_stream(self._stream)
            # The wrapper's get_result() and timestamps() each fetch the result, and
            # the first fetch consumes it; read keyword and timestamps from one fetch.
            result = self._spotter.keyword_spotter.get_result(self._stream)
            if result.keyword:
                phrase_end = round((result.timestamps[-1] + ENCODER_FRAME_S) * SAMPLE_RATE)
                samples_after = max(0, self._samples_fed - phrase_end)
                self._restart_stream()
                if self._diagnostics:
                    logger.info(
                        "wake_detected threshold=%.3f ms_after_phrase=%d",
                        self._threshold,
                        samples_after * 1000 // SAMPLE_RATE,
                    )
                # The spotter exposes no score; a detection means the phrase's
                # mean token probability cleared the threshold.
                return WakeResult(
                    detected=True,
                    confidence=self._threshold,
                    samples_after_phrase=samples_after,
                )
        return WakeResult(detected=False, confidence=0.0)

    def reset(self) -> None:
        """Drop all buffered audio and decoder state between activations."""
        self._restart_stream()

    def set_sensitivity(self, sensitivity: float) -> None:
        """Apply a new slider value; only the stream is rebuilt, never the model."""
        self._sensitivity = _clamp_sensitivity(sensitivity)
        self._threshold = keyword_threshold(self._sensitivity)
        self._restart_stream()

    def raise_threshold_for_barge_in(self) -> None:
        """Raise sensitivity to the barge-in floor while TTS is playing back."""
        if self._sensitivity < BARGE_IN_SENSITIVITY:
            self.set_sensitivity(BARGE_IN_SENSITIVITY)
