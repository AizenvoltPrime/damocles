"""VibeVoice-Realtime 0.5B TTS engine implementation.

Uses the vendored ``microsoft/VibeVoice`` streaming-inference classes
(see ``THIRD-PARTY-NOTICES.md``). Vanilla ``transformers.AutoProcessor``
cannot load this model — its config has no ``auto_map`` and the HF repo
ships only weights + ``preprocessor_config.json``. The architecture and
tokenizer live in the vendored package.

The streaming TTS architecture *requires* a per-speaker voice prefill
(``en-Carter_man.pt``); ``process_input_with_cached_prompt`` derefs
``cached_prompt['lm']['last_hidden_state']`` so passing ``None`` raises
TypeError. The prefill ships in the model manifest alongside the weights
and is loaded once at engine init.

Sentence-level streaming: text is split on ``. ! ? \\n`` boundaries; each
sentence becomes one ``TtsChunk`` so playback can begin while later
sentences are still synthesizing.

Cancellation: cooperatively checked between sentences. ``request_id=None``
cancels every in-flight job.

VRAM budget (US-013):
  * bf16 on CUDA -> ~1.5 GB.
  * fp32 on CPU  -> ~3 GB resident, ~5 s per sentence (warned at load).

Privacy posture (FR-11, US-011):
  * Synthesized PCM is never written to disk.
  * Text payloads are never logged.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
import os
import re
import threading
from typing import AsyncIterator, Optional

import numpy as np

from ..protocol import TTS_SAMPLE_RATE, SidecarConfig, ModelLoadFailed
from .base import TtsChunk, TtsEngine

logger = logging.getLogger(__name__)

VIBEVOICE_MODEL_ID = "vibevoice_realtime_0_5b"
DEFAULT_VOICE_ID = "en-Carter_man"
VOICE_FILE_SUFFIX = ".pt"
DDPM_INFERENCE_STEPS = 5
CFG_SCALE = 1.3
SENTENCE_SPLIT_RE = re.compile(r"(?<=[\.\!\?])\s+|\n+")
SHA_READ_CHUNK = 1 << 20


def split_into_sentences(text: str) -> list[str]:
    """Split on `. ! ? \\n` boundaries; preserve punctuation, drop empties."""
    parts = SENTENCE_SPLIT_RE.split(text)
    return [p.strip() for p in parts if p and p.strip()]


class VibeVoiceTtsEngine(TtsEngine):
    """Streams VibeVoice-Realtime audio one sentence at a time."""

    def __init__(self, cfg: SidecarConfig) -> None:
        try:
            import torch
        except ImportError as exc:
            raise ModelLoadFailed(
                model_id="vibevoice_realtime_0_5b",
                path="<torch not installed>",
                cause=exc,
            ) from exc

        try:
            from ..vendor.vibevoice.processor.vibevoice_streaming_processor import (
                VibeVoiceStreamingProcessor,
            )
            from ..vendor.vibevoice.modular.modeling_vibevoice_streaming_inference import (
                VibeVoiceStreamingForConditionalGenerationInference,
            )
        except ImportError as exc:
            raise ModelLoadFailed(
                model_id="vibevoice_realtime_0_5b",
                path="<vendored vibevoice unavailable>",
                cause=exc,
            ) from exc

        path = self._resolve_model_path(cfg)
        device = self._select_device(cfg, torch)
        dtype = torch.bfloat16 if device == "cuda" else torch.float32

        try:
            # trust_remote_code=False is the actual RCE defense (defaults to
            # False since transformers 4.41; we set it explicitly so a future
            # default flip can't silently weaken us). We do NOT pass
            # local_files_only=True — the vendored VibeVoice processor
            # resolves the Qwen2.5-0.5B tokenizer files as a transitive
            # dependency, and those are not in our manifest. First-run HF
            # tokenizer fetches are cached and become local thereafter.
            processor = VibeVoiceStreamingProcessor.from_pretrained(
                path,
                trust_remote_code=False,
            )
            model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
                path,
                torch_dtype=dtype,
                device_map=device,
                attn_implementation="sdpa",
                trust_remote_code=False,
            )
            model.eval()
            model.set_ddpm_inference_steps(num_steps=DDPM_INFERENCE_STEPS)
            prefill, resolved_voice_id, prefill_path = self._verify_and_load_prefill(
                path, cfg.tts_voice, device, torch,
            )
        except Exception as exc:
            raise ModelLoadFailed(
                model_id=VIBEVOICE_MODEL_ID,
                path=path,
                cause=exc,
            ) from exc

        self._torch = torch
        self._processor = processor
        self._model = model
        self._device = device
        self._dtype = dtype
        self._prefill = prefill
        self._models_path = path
        self._voice_id = resolved_voice_id
        self._loaded = True
        self._cancel_all = False
        self._cancelled_ids: set[str] = set()
        # Set by cancel(None); checked from inside model.generate via the
        # HF StoppingCriteria hook so an in-flight long sentence aborts
        # immediately instead of completing in the executor thread.
        self._cancel_event = threading.Event()
        self._lock = asyncio.Lock()
        logger.info(
            "vibevoice loaded: device=%s dtype=%s prefill=%s ddpm_steps=%d",
            device,
            str(dtype).replace("torch.", ""),
            prefill_path,
            DDPM_INFERENCE_STEPS,
        )

    @staticmethod
    def _resolve_model_path(cfg: SidecarConfig) -> str:
        """Return the local model directory or raise. Never falls back to
        the HF repo string — silent network IO would defeat the on-device
        guarantee, and from_pretrained with trust_remote_code could in
        theory execute attacker-controlled .py via auto_map.
        """
        from ..models.manifest import model_version_dir
        local = model_version_dir(cfg.models_dir, VIBEVOICE_MODEL_ID)
        required = ("config.json", "model.safetensors")
        if not os.path.isdir(local):
            raise ModelLoadFailed(
                model_id=VIBEVOICE_MODEL_ID,
                path=local,
                cause=FileNotFoundError(
                    f"VibeVoice model directory missing at {local}; "
                    "the model must be downloaded by the runtime installer "
                    "before TTS can start."
                ),
            )
        missing = [f for f in required if not os.path.exists(os.path.join(local, f))]
        if missing:
            raise ModelLoadFailed(
                model_id=VIBEVOICE_MODEL_ID,
                path=local,
                cause=FileNotFoundError(
                    f"VibeVoice model dir at {local} missing files: {missing}"
                ),
            )
        return local

    @staticmethod
    def _resolve_voice_filename(requested_voice: Optional[str]) -> str:
        """Map a requested voice id to a manifest-listed prefill filename.

        The manifest is the single source of truth for which voices are
        installable. Any voice id not present in the manifest falls back
        to the default — this rejects path-traversal attempts and any
        accidental references to unshipped prefills before the
        SHA-verified ``torch.load`` ever runs.
        """
        from ..models.manifest import load_manifest

        manifest = load_manifest()
        files = (
            manifest.get("models", {})
            .get(VIBEVOICE_MODEL_ID, {})
            .get("files", [])
        )
        manifest_voices = {
            f["filename"]
            for f in files
            if isinstance(f.get("filename"), str)
            and f["filename"].endswith(VOICE_FILE_SUFFIX)
        }
        candidate = f"{requested_voice}{VOICE_FILE_SUFFIX}" if requested_voice else ""
        if candidate in manifest_voices:
            return candidate
        if requested_voice and requested_voice != DEFAULT_VOICE_ID:
            logger.warning(
                "tts_voice=%r not listed in manifest; falling back to %s",
                requested_voice,
                DEFAULT_VOICE_ID,
            )
        return f"{DEFAULT_VOICE_ID}{VOICE_FILE_SUFFIX}"

    @staticmethod
    def _verify_and_load_prefill(
        models_path: str,
        requested_voice: Optional[str],
        device: str,
        torch,
    ) -> tuple[object, str, str]:
        """Resolve voice id → filename → SHA-verify → torch.load.

        Returns ``(prefill, resolved_voice_id, prefill_path)``. The
        ``resolved_voice_id`` may differ from ``requested_voice`` when
        the requested file isn't yet on disk and we fall back to the
        default (logged as a warning). Used by both ``__init__`` (cold
        load) and ``swap_voice`` (hot-swap) so the full set of safety
        checks runs in both paths.
        """
        voice_filename = VibeVoiceTtsEngine._resolve_voice_filename(requested_voice)
        prefill_path = os.path.join(models_path, voice_filename)
        default_filename = f"{DEFAULT_VOICE_ID}{VOICE_FILE_SUFFIX}"
        if not os.path.isfile(prefill_path) and voice_filename != default_filename:
            # Manifest lists the requested voice but it isn't on disk
            # yet. The TS-side handler prefetches missing files before
            # sending set_voice, so this branch is the "old sidecar
            # / racy startup" guard rather than the primary path.
            logger.warning(
                "voice prefill %s not found at %s; falling back to %s. "
                "Accept the model upgrade prompt to fetch alternate voices.",
                voice_filename,
                prefill_path,
                default_filename,
            )
            voice_filename = default_filename
            prefill_path = os.path.join(models_path, voice_filename)
        if not os.path.isfile(prefill_path):
            raise ModelLoadFailed(
                model_id=VIBEVOICE_MODEL_ID,
                path=prefill_path,
                cause=FileNotFoundError(
                    f"Voice prefill {voice_filename} missing; "
                    "redownload models to refresh the manifest."
                ),
            )

        VibeVoiceTtsEngine._verify_prefill_integrity(prefill_path, voice_filename)
        prefill = VibeVoiceTtsEngine._load_prefill(prefill_path, device, torch)
        resolved_voice_id = voice_filename[: -len(VOICE_FILE_SUFFIX)]
        return prefill, resolved_voice_id, prefill_path

    @staticmethod
    def _verify_prefill_integrity(prefill_path: str, voice_filename: str) -> None:
        """SHA-256 the prefill against the manifest before torch.load.

        The .pt is a pickled tensor container — even with weights_only=True
        a tampered file is a credible supply-chain risk. Hash verification
        catches any post-install tamper deterministically.
        """
        from ..models.manifest import model_file_sha256

        expected = model_file_sha256(VIBEVOICE_MODEL_ID, voice_filename)
        h = hashlib.sha256()
        with open(prefill_path, "rb") as fh:
            for chunk in iter(lambda: fh.read(SHA_READ_CHUNK), b""):
                h.update(chunk)
        actual = h.hexdigest()
        if actual != expected:
            raise ModelLoadFailed(
                model_id=VIBEVOICE_MODEL_ID,
                path=prefill_path,
                cause=ValueError(
                    f"voice prefill SHA-256 mismatch (expected {expected}, "
                    f"got {actual}); refusing to load tampered file"
                ),
            )

    @staticmethod
    def _load_prefill(prefill_path: str, device: str, torch):
        """Load the integrity-verified prefill.

        Layered defense: the SHA-256 check above already establishes
        authenticity, so a tampered .pt cannot reach this code. We still
        try ``weights_only=True`` first as belt-and-suspenders; if
        VibeVoice's prefill format includes an allowlist-rejected type
        the file is known-good (hash-verified), so falling through to
        full pickle is acceptable.

        ``torch`` is passed explicitly rather than read off ``self``
        because the call site is inside ``__init__``'s try-block, before
        ``self._torch`` has been assigned. Reading it off self would
        fault with AttributeError on every load.
        """
        try:
            return torch.load(prefill_path, map_location=device, weights_only=True)
        except Exception as exc:
            logger.info(
                "vibevoice prefill weights_only=True rejected (%s); "
                "loading hash-verified file with weights_only=False",
                type(exc).__name__,
            )
            return torch.load(prefill_path, map_location=device, weights_only=False)

    @staticmethod
    def _select_device(cfg: SidecarConfig, torch) -> str:
        if cfg.runtime_mode == "cpu":
            return "cpu"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"

    async def synthesize(self, request_id: str, text: str) -> AsyncIterator[TtsChunk]:
        """Yield one TtsChunk per sentence; cooperative cancel between sentences.

        ``_cancel_all`` signals "abort whatever is currently running"; it is
        consumed at synthesize entry so a stale cancel from a previous
        request never poisons the next call. The per-id ``_cancelled_ids``
        path remains a separate, request-scoped pre-cancel mechanism.

        Two webview windows attached to the same sidecar each have their
        own per-connection queue + worker but share this engine instance.
        Without ``self._lock`` two ``synthesize`` coroutines could run
        concurrently and interleave on ``self._prefill`` (mutated by
        ``swap_voice``) and on the shared ``self._model``. The lock
        serializes synthesize calls across all attached clients.
        """
        logger.info("synthesize: req=%s loaded=%s text_len=%d", request_id, self._loaded, len(text))
        if not self._loaded:
            logger.warning("synthesize: engine not loaded; req=%s", request_id)
            return
        async with self._lock:
            self._cancel_all = False
            # Drop any cancel event left over from a previous synthesize so
            # the new request doesn't abort on the first generate() call.
            self._cancel_event.clear()
            if request_id in self._cancelled_ids:
                logger.info("synthesize: pre-cancelled req=%s", request_id)
                self._cancelled_ids.discard(request_id)
                return

            sentences = split_into_sentences(text)
            logger.info("synthesize: req=%s split into %d sentence(s)", request_id, len(sentences))
            if not sentences:
                return

            for idx, sentence in enumerate(sentences):
                if self._cancel_all or request_id in self._cancelled_ids:
                    logger.info("synthesize: cancelled mid-loop req=%s idx=%d", request_id, idx)
                    self._cancelled_ids.discard(request_id)
                    return
                audio = await asyncio.get_running_loop().run_in_executor(
                    None, self._synthesize_sentence, sentence
                )
                if audio is None or audio.size == 0:
                    logger.warning("synthesize: empty audio req=%s idx=%d sentence_len=%d", request_id, idx, len(sentence))
                    continue
                logger.info(
                    "synthesize: req=%s idx=%d samples=%d duration=%.2fs",
                    request_id,
                    idx,
                    int(audio.size),
                    audio.size / TTS_SAMPLE_RATE,
                )
                yield TtsChunk(
                    request_id=request_id,
                    pcm_float32=audio.astype(np.float32).tobytes(),
                    sample_rate=TTS_SAMPLE_RATE,
                )

    def _synthesize_sentence(self, sentence: str) -> Optional[np.ndarray]:
        torch = self._torch
        if not self._loaded or self._model is None:
            return None
        if self._cancel_event.is_set():
            return None
        inputs = self._processor.process_input_with_cached_prompt(
            text=sentence,
            cached_prompt=self._prefill,
            padding=True,
            return_tensors="pt",
            return_attention_mask=True,
        )
        for k, v in list(inputs.items()):
            if torch.is_tensor(v):
                inputs[k] = v.to(self._device)
        stopping_criteria = self._build_cancel_stopping_criteria()
        generate_kwargs = {
            "max_new_tokens": None,
            "cfg_scale": CFG_SCALE,
            "tokenizer": self._processor.tokenizer,
            "generation_config": {"do_sample": False},
            "verbose": False,
            "all_prefilled_outputs": copy.deepcopy(self._prefill),
        }
        if stopping_criteria is not None:
            generate_kwargs["stopping_criteria"] = stopping_criteria
        with torch.inference_mode():
            outputs = self._model.generate(**inputs, **generate_kwargs)
        if self._cancel_event.is_set():
            return None
        return self._extract_audio(outputs)

    def _build_cancel_stopping_criteria(self):
        """Return a StoppingCriteriaList that aborts generate() when
        ``self._cancel_event`` is set. Returns None if transformers
        isn't importable in this configuration (e.g. mock engines)."""
        try:
            from transformers import StoppingCriteria, StoppingCriteriaList
        except ImportError:
            return None
        evt = self._cancel_event

        class _CancelStoppingCriteria(StoppingCriteria):
            def __call__(self, input_ids, scores, **_kwargs) -> bool:
                return evt.is_set()

        return StoppingCriteriaList([_CancelStoppingCriteria()])

    def _extract_audio(self, outputs) -> Optional[np.ndarray]:
        speech = getattr(outputs, "speech_outputs", None)
        if speech is None and isinstance(outputs, dict):
            speech = outputs.get("speech_outputs")
        if speech is None or len(speech) == 0 or speech[0] is None:
            return None
        tensor = speech[0]
        try:
            arr = tensor.detach().to("cpu").to(self._torch.float32).numpy()
        except AttributeError:
            arr = np.asarray(tensor, dtype=np.float32)
        arr = arr.squeeze()
        if arr.ndim > 1:
            arr = arr.reshape(-1)
        return arr.astype(np.float32, copy=False)

    def cancel(self, request_id: Optional[str]) -> None:
        """Cancel one in-flight request, or all when request_id is None.

        cancel(None) sets ``_cancel_event``, which the StoppingCriteria
        hooked into model.generate consults on every decode step — so
        an in-flight long sentence aborts within a few decoder steps
        instead of running to completion. Per-id cancel keeps the
        between-sentence semantics; aborting the in-flight sentence
        when the user only meant to cancel a different queued request
        would leak audio into the wrong stream.
        """
        if request_id is None:
            self._cancel_all = True
            self._cancel_event.set()
            return
        self._cancelled_ids.add(request_id)

    def unload(self) -> None:
        """Release VRAM. The OOM ladder calls this first to free ~1.5 GB."""
        if not self._loaded:
            return
        torch = self._torch
        try:
            del self._model
        except AttributeError:
            pass
        self._model = None
        self._prefill = None
        self._loaded = False
        if self._device == "cuda":
            torch.cuda.empty_cache()

    def is_loaded(self) -> bool:
        return self._loaded

    def swap_voice(self, voice_id: str) -> str:
        """Hot-swap the per-speaker prefill in place.

        ~200 ms (SHA + torch.load on a ~4 MB file) versus the 7-8 s
        sidecar restart cycle. Cancelling in-flight TTS first prevents
        a single sentence from straddling two voices; the deepcopy in
        ``_synthesize_sentence`` already insulates an executor-running
        sentence from a concurrent prefill swap, so no extra lock is
        needed beyond the cancel.
        """
        if not self._loaded:
            raise RuntimeError("cannot swap voice: TTS engine not loaded")
        self.cancel(None)
        new_prefill, resolved_voice_id, prefill_path = self._verify_and_load_prefill(
            self._models_path, voice_id, self._device, self._torch,
        )
        self._prefill = new_prefill
        self._voice_id = resolved_voice_id
        logger.info("vibevoice voice swapped to %s (prefill=%s)", resolved_voice_id, prefill_path)
        return resolved_voice_id
