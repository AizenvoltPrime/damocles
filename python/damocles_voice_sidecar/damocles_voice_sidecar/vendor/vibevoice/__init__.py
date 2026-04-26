"""Vendored subset of microsoft/VibeVoice.

Pinned to the commit recorded in ``UPSTREAM_COMMIT``. Only the modules
required to load and run ``VibeVoice-Realtime-0.5B`` for streaming TTS are
copied; the upstream package's ASR, fine-tuning, and demo trees are
intentionally excluded. Original code is MIT-licensed (see ``LICENSE``).
"""

from .modular.modeling_vibevoice_streaming_inference import (
    VibeVoiceStreamingForConditionalGenerationInference,
)
from .modular.configuration_vibevoice_streaming import VibeVoiceStreamingConfig
from .processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor

__all__ = [
    "VibeVoiceStreamingForConditionalGenerationInference",
    "VibeVoiceStreamingConfig",
    "VibeVoiceStreamingProcessor",
]
