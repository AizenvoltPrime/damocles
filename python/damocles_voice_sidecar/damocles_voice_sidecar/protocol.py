"""Wire protocol for the Damocles voice sidecar.

Single source of truth for the JSON envelope used over the WebSocket. The
TypeScript side mirrors these shapes via Zod in
``src/extension/voice/sidecar/protocol.ts``. Any change here requires a
matching update on the TypeScript side; the protocol version below must be
bumped on breaking changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, TypedDict, Union

# Bump on breaking wire changes. Stays in sync with the WebSocket
# subprotocol token "damocles-voice.v<N>" and the TypeScript Zod schemas.
PROTOCOL_VERSION = 1

# Audio format — fixed across the protocol so neither side has to negotiate.
SAMPLE_RATE = 16_000
FRAME_DURATION_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_DURATION_MS // 1000  # 320 samples
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono

# TTS audio is delivered at VibeVoice-Realtime's native rate.
TTS_SAMPLE_RATE = 24_000


class InitMessage(TypedDict):
    type: Literal["init"]
    protocol_version: int
    wake_word: str
    wake_sensitivity: float
    end_of_turn_silence_ms: int
    max_utterance_ms: int
    tts_enabled: bool
    tts_voice: str
    diagnostics: bool


class TtsRequestMessage(TypedDict):
    type: Literal["tts_request"]
    request_id: str
    text: str


class CancelTtsMessage(TypedDict):
    type: Literal["cancel_tts"]
    request_id: str | None  # None cancels all in-flight requests


class SetMutedMessage(TypedDict):
    """Toggle the OS mic input on/off without tearing the sidecar down."""

    type: Literal["set_muted"]
    muted: bool


class SetVoiceMessage(TypedDict):
    """Hot-swap the TTS voice prefill without restarting the sidecar.

    Loads the new prefill (~4 MB) in place. Avoids the 7-8 s smoke-check
    + model-reload cycle that a full sidecar restart incurs.
    """

    type: Literal["set_voice"]
    voice_id: str


class ShutdownMessage(TypedDict):
    type: Literal["shutdown"]


class PingMessage(TypedDict):
    type: Literal["ping"]
    nonce: int


InboundMessage = Union[
    InitMessage,
    TtsRequestMessage,
    CancelTtsMessage,
    SetMutedMessage,
    SetVoiceMessage,
    ShutdownMessage,
    PingMessage,
]


CpuFallbackReason = Literal["no-cuda", "low-vram", "user-pref", "cuda-oom-fallback"]


class ReadyMessage(TypedDict, total=False):
    type: Literal["ready"]
    protocol_version: int
    device: Literal["cuda", "cpu"]
    vram_mb_free: float
    models_loaded: list[str]
    auto_fallback_reason: CpuFallbackReason


class WakeDetectedMessage(TypedDict):
    type: Literal["wake_detected"]
    confidence: float


class WakeAbortedMessage(TypedDict):
    type: Literal["wake_aborted"]
    reason: Literal["no-speech", "user-cancel"]


class VadSpeechStartedMessage(TypedDict):
    type: Literal["vad_speech_started"]


class VadSpeechEndedMessage(TypedDict):
    type: Literal["vad_speech_ended"]


class TranscriptFinalMessage(TypedDict):
    type: Literal["transcript_final"]
    text: str
    duration_ms: float


class TtsAudioChunkMessage(TypedDict):
    """Sent as binary frame; this TypedDict documents the JSON-side metadata.

    Binary-frame layout: float32 mono PCM at TTS_SAMPLE_RATE. The control
    JSON message that immediately precedes the binary frame carries
    ``request_id`` and ``sample_rate``.
    """

    type: Literal["tts_audio_chunk"]
    request_id: str
    sample_rate: int


class TtsDoneMessage(TypedDict):
    type: Literal["tts_done"]
    request_id: str


class VoiceChangedMessage(TypedDict):
    """Acknowledgement that the engine swapped to a new voice prefill."""

    type: Literal["voice_changed"]
    voice_id: str


class ErrorMessage(TypedDict):
    type: Literal["error"]
    code: str
    message: str
    recoverable: bool


class PongMessage(TypedDict):
    type: Literal["pong"]
    nonce: int


OutboundMessage = Union[
    ReadyMessage,
    WakeDetectedMessage,
    WakeAbortedMessage,
    VadSpeechStartedMessage,
    VadSpeechEndedMessage,
    TranscriptFinalMessage,
    TtsAudioChunkMessage,
    TtsDoneMessage,
    VoiceChangedMessage,
    ErrorMessage,
    PongMessage,
]


# Error codes — referenced by extension-side restart/OOM ladder logic.
class ErrorCode:
    CUDA_OOM = "cuda-oom"
    CUDA_OOM_RECOVERED = "cuda-oom-recovered"
    CUDA_UNAVAILABLE = "cuda-unavailable"
    MODEL_LOAD_FAILED = "model-load-failed"
    INVALID_AUDIO_FRAME = "invalid-audio-frame"
    BAD_TOKEN = "bad-token"
    BAD_PROTOCOL_VERSION = "bad-protocol-version"
    TTS_FAILURE = "tts-failure"
    INTERNAL = "internal"


class RecoverableOomError(RuntimeError):
    """Raised by the pipeline when CUDA OOM cannot be recovered in-process.

    The sidecar process exits with code 7 so the manager can relaunch in CPU mode.
    """


class ModelLoadFailed(RuntimeError):
    """Engine model file is missing or rejected by its loader.

    Carries the model id and resolved path so __main__.py can surface a clear
    error code and the manager can decide whether to retry or stop.
    """

    def __init__(self, model_id: str, path: str, cause: BaseException | None = None) -> None:
        self.model_id = model_id
        self.path = path
        self.cause = cause
        message = f"model-load-failed: {model_id} at {path}"
        if cause is not None:
            message = f"{message} ({type(cause).__name__}: {cause})"
        super().__init__(message)


@dataclass
class SidecarConfig:
    """Resolved CLI + init-message config for the running sidecar."""

    port: int
    models_dir: str
    runtime_mode: Literal["cuda", "cpu", "auto"] = "auto"
    diagnostics: bool = False
    wake_word: str = "hey_jarvis"
    wake_sensitivity: float = 0.5
    end_of_turn_silence_ms: int = 800
    max_utterance_ms: int = 30_000
    wake_word_enabled: bool = True
    tts_enabled: bool = False
    tts_voice: str = "en-Carter_man"
    extra: dict = field(default_factory=dict)
