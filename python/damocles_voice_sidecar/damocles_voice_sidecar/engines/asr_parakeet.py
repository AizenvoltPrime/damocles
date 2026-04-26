"""Parakeet TDT 0.6B v2 ASR engine implementation.

NeMo 2.x ships the auto-dispatching ``ASRModel.restore_from()`` factory
that resolves the right concrete class (``EncDecRNNTBPEModel`` or
``EncDecHybridRNNTCTCBPEModel``) from the .nemo manifest. Using the
factory lets the engine survive minor checkpoint repacks; if NeMo
upstream renames or drops ``ASRModel.restore_from()`` in a future pin
this is the function to update.

Device selection (US-013, US-014):
  * ``runtime_mode == "cuda"``: refuse to fall back; raise if CUDA missing.
  * ``runtime_mode == "cpu"``: never touch CUDA (US-014 strict CPU mode).
  * ``runtime_mode == "auto"``: CUDA if available AND >= 2.5 GiB free VRAM,
    otherwise CPU with an info log.

Precision: bf16 on CUDA (saves VRAM with negligible WER hit on
Parakeet TDT), fp32 on CPU (CPU bf16 is lossy + not faster on x86 prior
to AVX-512 BF16).

Privacy posture (FR-11, US-011):
  * Transcript text is never logged unless ``cfg.diagnostics`` AND env
    ``LOG_TRANSCRIPTS=true`` are both set.
  * No audio buffers are written to disk.
"""

from __future__ import annotations

import contextlib
import logging
import os
import time
from typing import Literal, Optional

import numpy as np

from ..protocol import SAMPLE_RATE, SidecarConfig, ModelLoadFailed
from .base import AsrEngine, AsrResult

logger = logging.getLogger(__name__)

CUDA_FREE_VRAM_FLOOR_BYTES = int(2.5 * 1024 * 1024 * 1024)
PARAKEET_FILENAME = "parakeet-tdt-0.6b-v2.nemo"

DeviceSelection = tuple[Literal["cuda", "cpu"], Optional[Literal["no-cuda", "low-vram", "user-pref"]], float]


def select_device(cfg: SidecarConfig) -> DeviceSelection:
    """Pick cuda/cpu honoring runtime_mode + VRAM headroom.

    Returns (device, auto_fallback_reason, free_vram_mb). auto_fallback_reason is
    populated only when runtime_mode=auto landed on CPU because of an environmental
    constraint, or when runtime_mode=cpu forced CPU on a CUDA-capable host. None
    when CUDA was selected normally or when CPU was selected on a non-CUDA host
    in pure auto mode (no fallback occurred — there was no GPU to fall back from).
    """
    import torch

    mode = cfg.runtime_mode
    cuda_available = torch.cuda.is_available()
    free_mb = 0.0
    if cuda_available:
        try:
            free_bytes, _ = torch.cuda.mem_get_info()
            free_mb = free_bytes / (1024.0 * 1024.0)
        except (RuntimeError, AssertionError):
            free_mb = 0.0

    if mode == "cpu":
        return ("cpu", "user-pref" if cuda_available else None, free_mb)

    if mode == "cuda":
        if not cuda_available:
            raise ModelLoadFailed(
                model_id="parakeet_tdt_0_6b_v2",
                path="<runtime_mode=cuda but CUDA unavailable>",
            )
        return ("cuda", None, free_mb)

    if not cuda_available:
        return ("cpu", "no-cuda", 0.0)

    if free_mb * 1024.0 * 1024.0 < CUDA_FREE_VRAM_FLOOR_BYTES:
        logger.info(
            "auto-fallback: free vram below 2.5GB threshold, using cpu"
        )
        return ("cpu", "low-vram", free_mb)
    return ("cuda", None, free_mb)


class ParakeetAsrEngine(AsrEngine):
    """NVIDIA Parakeet TDT 0.6B v2, RNNT-decoded via NeMo."""

    def __init__(self, cfg: SidecarConfig) -> None:
        try:
            import torch
        except ImportError as exc:
            raise ModelLoadFailed(
                model_id="parakeet_tdt_0_6b_v2",
                path="<torch not installed>",
                cause=exc,
            ) from exc

        try:
            from nemo.collections.asr.models import ASRModel
        except ImportError as exc:
            raise ModelLoadFailed(
                model_id="parakeet_tdt_0_6b_v2",
                path="<nemo-toolkit[asr] not installed>",
                cause=exc,
            ) from exc

        path = self._resolve_model_path(cfg)
        device, fallback_reason, free_vram_mb = select_device(cfg)

        try:
            model = ASRModel.restore_from(restore_path=path, map_location=device)
        except Exception as exc:
            raise ModelLoadFailed(
                model_id="parakeet_tdt_0_6b_v2",
                path=path,
                cause=exc,
            ) from exc

        model = model.to(device)
        model.eval()
        if device == "cuda":
            model = model.to(dtype=torch.bfloat16)

        self._torch = torch
        self._model = model
        self._device = device
        self._auto_fallback_reason = fallback_reason
        self._free_vram_mb = free_vram_mb
        self._dtype = torch.bfloat16 if device == "cuda" else torch.float32
        self._diagnostics = bool(cfg.diagnostics)
        self._log_transcripts = (
            self._diagnostics
            and os.environ.get("LOG_TRANSCRIPTS", "").lower() == "true"
        )
        self._model_path = path

        if device == "cpu" and cfg.tts_enabled:
            logger.warning(
                "TTS on CPU is slow (~5s/sentence). Consider disabling."
            )

    @staticmethod
    def _resolve_model_path(cfg: SidecarConfig) -> str:
        from ..models.manifest import model_version_dir
        candidate = os.path.join(
            model_version_dir(cfg.models_dir, "parakeet_tdt_0_6b_v2"),
            PARAKEET_FILENAME,
        )
        if os.path.isfile(candidate):
            return candidate
        raise ModelLoadFailed(
            model_id="parakeet_tdt_0_6b_v2",
            path=candidate,
        )

    def transcribe(self, pcm_int16: bytes) -> AsrResult:
        """Run a single batch-of-1 RNNT inference; return text + duration."""
        torch = self._torch
        samples = np.frombuffer(pcm_int16, dtype=np.int16).astype(np.float32) / 32768.0
        if samples.size == 0:
            return AsrResult(text="", duration_ms=0.0)

        # NeMo's transcribe() accepts numpy arrays directly and handles its
        # own device placement internally. The previous bytes -> numpy ->
        # torch.from_numpy(...).to(device) -> .cpu().numpy() round trip
        # paid two device transfers for nothing. Pass the numpy array
        # straight through.
        started = time.perf_counter()
        try:
            with torch.inference_mode():
                ctx = (
                    torch.autocast(device_type="cuda", dtype=torch.bfloat16)
                    if self._device == "cuda"
                    else contextlib.nullcontext()
                )
                with ctx:
                    hypotheses = self._model.transcribe(
                        audio=[samples],
                        batch_size=1,
                        return_hypotheses=False,
                    )
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            raise

        duration_ms = (time.perf_counter() - started) * 1000.0
        text = self._unwrap_first(hypotheses)
        if self._log_transcripts:
            logger.info("transcript text=%r duration_ms=%.1f", text, duration_ms)
        return AsrResult(text=text, duration_ms=duration_ms)

    @staticmethod
    def _unwrap_first(out) -> str:
        if not out:
            return ""
        first = out[0]
        if isinstance(first, str):
            return first
        text = getattr(first, "text", None)
        if isinstance(text, str):
            return text
        return str(first)

    def device(self) -> Literal["cuda", "cpu"]:
        return self._device

    def auto_fallback_reason(self) -> Optional[Literal["no-cuda", "low-vram", "user-pref"]]:
        return self._auto_fallback_reason

    def free_vram_mb(self) -> float:
        return self._free_vram_mb

    def dispose(self) -> None:
        """Release GPU memory; safe to call multiple times."""
        torch = self._torch
        try:
            del self._model
        except AttributeError:
            pass
        self._model = None
        if self._device == "cuda":
            torch.cuda.empty_cache()
