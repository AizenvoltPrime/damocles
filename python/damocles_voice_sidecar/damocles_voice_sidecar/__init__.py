"""Damocles voice sidecar: on-device wake-word, VAD, ASR, and TTS over WebSocket."""

from .protocol import (
    InboundMessage,
    OutboundMessage,
    PROTOCOL_VERSION,
    SAMPLE_RATE,
    FRAME_SAMPLES,
    FRAME_DURATION_MS,
)

__all__ = [
    "InboundMessage",
    "OutboundMessage",
    "PROTOCOL_VERSION",
    "SAMPLE_RATE",
    "FRAME_SAMPLES",
    "FRAME_DURATION_MS",
]
