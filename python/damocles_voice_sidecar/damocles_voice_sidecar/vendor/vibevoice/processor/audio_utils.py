"""Audio normalization for VibeVoice tokenizer.

The upstream VibeVoice repo's audio_utils.py also exposes ``ffmpeg``-based
file/pipe loaders (`load_audio_use_ffmpeg`, `load_audio_bytes_use_ffmpeg`,
`_run_ffmpeg`, `COMMON_AUDIO_EXTS`, `_FFMPEG_SEM`). The streaming-inference
path Damocles uses doesn't decode audio files — the sidecar produces PCM
internally — so those helpers are dead code in our vendored copy. They were
removed (vs. left around) because vendored dead code that shells out to a
binary is an "attractive nuisance" review finding (SEC-M1): a future caller
could wire it up with attacker-influenced filenames before we noticed.

Only ``AudioNormalizer`` is referenced by the rest of the vendored
processor (`vibevoice_tokenizer_processor.py`, `vibevoice_streaming_processor.py`).
"""

from typing import Optional

import numpy as np


class AudioNormalizer:
    """Normalize input audio to a target dB FS while preventing clipping."""

    def __init__(self, target_dB_FS: float = -25, eps: float = 1e-6):
        self.target_dB_FS = target_dB_FS
        self.eps = eps

    def tailor_dB_FS(self, audio: np.ndarray) -> tuple:
        rms = np.sqrt(np.mean(audio ** 2))
        scalar = 10 ** (self.target_dB_FS / 20) / (rms + self.eps)
        return audio * scalar, rms, scalar

    def avoid_clipping(self, audio: np.ndarray, scalar: Optional[float] = None) -> tuple:
        if scalar is None:
            max_val = np.max(np.abs(audio))
            scalar = max_val + self.eps if max_val > 1.0 else 1.0
        return audio / scalar, scalar

    def __call__(self, audio: np.ndarray) -> np.ndarray:
        audio, _, _ = self.tailor_dB_FS(audio)
        audio, _ = self.avoid_clipping(audio)
        return audio
