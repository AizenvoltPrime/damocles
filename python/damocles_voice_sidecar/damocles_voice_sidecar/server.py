"""WebSocket server: 127.0.0.1, token-gated, ping/pong supervised.

Token is read from the ``DAMOCLES_VOICE_TOKEN`` environment variable at
process start (never argv — argv is world-readable). Connections without
the matching ``Authorization: Bearer <token>`` header are rejected with
HTTP 401 before the protocol upgrade.

Audio path: the sidecar opens its own OS microphone via sounddevice
(``mic_input.MicInputStream``) and feeds frames into a single shared
``Pipeline`` instance. Webview clients connect for control + events only;
no audio bytes cross the WebSocket. This mirrors the
``src/extension/voice/recorder.ts`` push-to-talk path that already
bypasses the VS Code webview permission boundary the same way.

Health check: client must send ``{"type": "ping", "nonce": N}`` at least
every 10 s. Three missed pings -> sidecar exits.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from typing import Optional

import websockets
from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request, Response

from .engines import EngineSet
from .mic_input import MicInputStream
from .pipeline import Pipeline, PipelineConfig, PipelineEvent
from .protocol import (
    PROTOCOL_VERSION,
    SidecarConfig,
    ErrorCode,
    TTS_SAMPLE_RATE,
)

PING_INTERVAL_S = 2.0
PING_TIMEOUT_S = 10.0
MAX_TTS_QUEUE = 32

logger = logging.getLogger("damocles_voice_sidecar")


@dataclass
class SharedAudio:
    """Owned by run_server: one mic + one pipeline + active client emit.

    In TTS-only mode (wake-word disabled), ``pipeline`` and ``mic`` are
    ``None``; only ``current_emit`` is used for the empty event relay.
    """

    pipeline: Optional[Pipeline]
    mic: Optional[MicInputStream]
    current_emit: Optional[asyncio.Queue[PipelineEvent]] = None


def _read_token_from_env() -> str:
    token = os.environ.get("DAMOCLES_VOICE_TOKEN")
    if not token:
        logger.error("DAMOCLES_VOICE_TOKEN env var is not set; refusing to start")
        sys.exit(2)
    if len(token) < 32:
        logger.error("DAMOCLES_VOICE_TOKEN appears too short; refusing to start")
        sys.exit(2)
    return token


def _process_request_factory(token: str):
    """Returns a websockets ``process_request`` hook that gates on bearer token
    and on the ``damocles-voice.v<N>`` subprotocol header."""

    expected_subproto = f"damocles-voice.v{PROTOCOL_VERSION}"

    def _handler(connection: ServerConnection, request: Request) -> Optional[Response]:
        peer = connection.remote_address
        if peer is None or peer[0] not in ("127.0.0.1", "::1"):
            return connection.respond(403, "loopback only\n")

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return connection.respond(401, "missing bearer\n")
        presented = auth[len("Bearer "):]
        if not hmac.compare_digest(presented, token):
            return connection.respond(401, "bad token\n")

        protos = request.headers.get("Sec-WebSocket-Protocol", "")
        if expected_subproto not in (p.strip() for p in protos.split(",")):
            return connection.respond(400, f"need subprotocol {expected_subproto}\n")
        return None

    return _handler


async def _serve_connection(
    ws: ServerConnection,
    cfg: SidecarConfig,
    engines: EngineSet,
    shared: SharedAudio,
) -> None:
    out_queue: asyncio.Queue[PipelineEvent] = asyncio.Queue()
    shared.current_emit = out_queue

    device_source = engines.asr if engines.asr is not None else None
    ready_payload: dict = {
        "type": "ready",
        "protocol_version": PROTOCOL_VERSION,
        "device": device_source.device() if device_source is not None else "cpu",
        "vram_mb_free": device_source.free_vram_mb() if device_source is not None else 0.0,
        "models_loaded": [
            name
            for name, present in (
                ("wake", engines.wake is not None),
                ("vad", engines.vad is not None),
                ("asr", engines.asr is not None),
                ("tts", engines.tts is not None),
            )
            if present
        ],
    }
    fallback_reason = device_source.auto_fallback_reason() if device_source is not None else None
    if fallback_reason is not None:
        ready_payload["auto_fallback_reason"] = fallback_reason
    await ws.send(json.dumps(ready_payload))

    loop = asyncio.get_running_loop()
    state = {"last_ping": loop.time()}

    async def relay_events() -> None:
        while True:
            event = await out_queue.get()
            await ws.send(json.dumps({"type": event.kind, **event.payload}))

    tts_queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue(maxsize=MAX_TTS_QUEUE)

    async def emit_tts_synth(req_id: str, text: str) -> None:
        logger.info("tts_request: req=%s text_len=%d", req_id, len(text))
        if engines.tts is None or not engines.tts.is_loaded():
            logger.warning("tts_request: engine not loaded (req=%s)", req_id)
            await ws.send(
                json.dumps(
                    {
                        "type": "error",
                        "code": ErrorCode.TTS_FAILURE,
                        "message": "TTS engine not loaded",
                        "recoverable": True,
                    }
                )
            )
            return
        chunk_count = 0
        total_bytes = 0
        try:
            async for chunk in engines.tts.synthesize(req_id, text):
                chunk_count += 1
                total_bytes += len(chunk.pcm_float32)
                logger.info(
                    "tts_chunk: req=%s idx=%d bytes=%d sr=%d",
                    req_id, chunk_count, len(chunk.pcm_float32), chunk.sample_rate,
                )
                await ws.send(
                    json.dumps(
                        {
                            "type": "tts_audio_chunk",
                            "request_id": req_id,
                            "sample_rate": chunk.sample_rate,
                        }
                    )
                )
                await ws.send(chunk.pcm_float32)
            logger.info("tts_done: req=%s chunks=%d total_bytes=%d", req_id, chunk_count, total_bytes)
            await ws.send(json.dumps({"type": "tts_done", "request_id": req_id}))
        except Exception as exc:
            logger.exception("tts_request failed: req=%s after chunks=%d", req_id, chunk_count)
            await ws.send(
                json.dumps(
                    {
                        "type": "error",
                        "code": ErrorCode.TTS_FAILURE,
                        "message": str(exc),
                        "recoverable": True,
                    }
                )
            )

    async def tts_worker() -> None:
        """Single-flight TTS processor.

        Serializing at the Python side guarantees the JSON header / binary
        PCM frame pair is never interleaved between concurrent requests —
        which the TS-side single-slot ``pendingTtsHeader`` correlation
        relies on. Without this, TS-5 (header swapped to the wrong stream)
        is observable as soon as two requests overlap.
        """
        while True:
            req_id, text = await tts_queue.get()
            try:
                await emit_tts_synth(req_id, text)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("tts worker: unhandled error for req=%s", req_id)

    async def server_health() -> None:
        """Server-driven liveness check.

        The previous client-driven check only ran when an inbound message
        arrived, so a hung client (or a client whose mic loop crashed)
        could keep the WS open forever. This task runs unconditionally.
        """
        while True:
            await asyncio.sleep(PING_INTERVAL_S)
            if loop.time() - state["last_ping"] > PING_TIMEOUT_S:
                logger.warning("client ping timeout (server-side); closing connection")
                try:
                    await ws.close(code=1001, reason="ping timeout")
                except Exception:
                    pass
                return

    relayer = asyncio.create_task(relay_events(), name="relay-events")
    tts_task = asyncio.create_task(tts_worker(), name="tts-worker")
    health_task = asyncio.create_task(server_health(), name="server-health")
    background = (relayer, tts_task, health_task)

    try:
        async for message in ws:
            now = loop.time()
            if isinstance(message, bytes):
                await ws.send(
                    json.dumps(
                        {
                            "type": "error",
                            "code": ErrorCode.INVALID_AUDIO_FRAME,
                            "message": "binary inbound rejected: sidecar captures audio natively",
                            "recoverable": True,
                        }
                    )
                )
                continue

            try:
                msg = json.loads(message)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                state["last_ping"] = now
                await ws.send(json.dumps({"type": "pong", "nonce": msg.get("nonce", 0)}))
            elif mtype == "init":
                # Defense-in-depth: TS already rejects on receiving a
                # mismatched server "ready" version, but a client speaking
                # an older/newer protocol could otherwise silently proceed
                # past the handshake here. Reject explicitly with a
                # bad-protocol-version error and close the connection.
                pv = msg.get("protocol_version")
                if not isinstance(pv, int) or pv != PROTOCOL_VERSION:
                    await ws.send(
                        json.dumps(
                            {
                                "type": "error",
                                "code": ErrorCode.BAD_PROTOCOL_VERSION,
                                "message": (
                                    f"protocol version mismatch "
                                    f"(client={pv!r}, server={PROTOCOL_VERSION})"
                                ),
                                "recoverable": False,
                            }
                        )
                    )
                    await ws.close(code=1002, reason="protocol-version-mismatch")
                    return
                if engines.wake is not None and (sens := msg.get("wake_sensitivity")) is not None:
                    engines.wake.set_sensitivity(float(sens))
            elif mtype == "set_muted":
                if shared.mic is not None:
                    shared.mic.set_muted(bool(msg.get("muted", False)))
            elif mtype == "tts_request":
                req_id = msg.get("request_id") or ""
                text = msg.get("text") or ""
                if not req_id or not text:
                    continue
                try:
                    tts_queue.put_nowait((req_id, text))
                except asyncio.QueueFull:
                    logger.warning("tts queue full; dropping req=%s", req_id)
                    await ws.send(
                        json.dumps(
                            {
                                "type": "error",
                                "code": ErrorCode.TTS_FAILURE,
                                "message": "tts queue full",
                                "recoverable": True,
                            }
                        )
                    )
            elif mtype == "cancel_tts" and engines.tts is not None:
                raw_id = msg.get("request_id")
                # Empty/missing means cancel-current. Previously we silently
                # added "" to the cancelled-ids set, which never matched
                # anything and dropped the cancel.
                target = raw_id if isinstance(raw_id, str) and raw_id else None
                engines.tts.cancel(target)
            elif mtype == "set_voice" and engines.tts is not None:
                voice_id = msg.get("voice_id")
                if not isinstance(voice_id, str) or not voice_id:
                    await ws.send(
                        json.dumps(
                            {
                                "type": "error",
                                "code": ErrorCode.TTS_FAILURE,
                                "message": "set_voice: missing voice_id",
                                "recoverable": True,
                            }
                        )
                    )
                    continue
                # Hot-swap the prefill via run_in_executor so the SHA-256
                # hash + ~4 MB torch.load doesn't block the event loop —
                # ping handling, TTS streaming, and cancel propagation
                # must all stay responsive during the swap.
                try:
                    resolved = await loop.run_in_executor(
                        None, engines.tts.swap_voice, voice_id,
                    )
                    await ws.send(json.dumps({"type": "voice_changed", "voice_id": resolved}))
                except Exception as exc:
                    logger.exception("set_voice failed: voice_id=%s", voice_id)
                    await ws.send(
                        json.dumps(
                            {
                                "type": "error",
                                "code": ErrorCode.TTS_FAILURE,
                                "message": f"voice swap failed: {exc}",
                                "recoverable": True,
                            }
                        )
                    )
            elif mtype == "shutdown":
                break
    finally:
        for task in background:
            task.cancel()
        for task in background:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        # Cancel any in-flight TTS so a slow synth doesn't keep the engine
        # busy after the client disconnected.
        if engines.tts is not None:
            engines.tts.cancel(None)
        if shared.current_emit is out_queue:
            shared.current_emit = None


async def run_server(cfg: SidecarConfig, engines: EngineSet) -> None:
    token = _read_token_from_env()
    process_request = _process_request_factory(token)
    loop = asyncio.get_running_loop()

    shared_holder: dict[str, SharedAudio] = {}

    async def emit_event(event: PipelineEvent) -> None:
        shared = shared_holder.get("shared")
        if shared is None:
            return
        if shared.current_emit is not None:
            shared.current_emit.put_nowait(event)

    pipeline: Optional[Pipeline] = None
    mic: Optional[MicInputStream] = None
    if cfg.wake_word_enabled and engines.wake is not None and engines.vad is not None and engines.asr is not None:
        pipeline = Pipeline(
            engines=engines,
            config=PipelineConfig(
                end_of_turn_silence_ms=cfg.end_of_turn_silence_ms,
                max_utterance_ms=cfg.max_utterance_ms,
            ),
            emit=emit_event,
        )

        async def consume_frame(buf: bytes) -> None:
            assert pipeline is not None
            await pipeline.feed(buf)

        mic = MicInputStream(loop, consume_frame)
        try:
            mic.start()
        except Exception as exc:
            logger.error("failed to start native mic input: %s", exc)
            raise
    else:
        logger.info(
            "wake-word disabled; running TTS-only (no mic, no pipeline)"
        )

    shared = SharedAudio(pipeline=pipeline, mic=mic)
    shared_holder["shared"] = shared

    async def handler(ws: ServerConnection) -> None:
        try:
            await _serve_connection(ws, cfg, engines, shared)
        except websockets.exceptions.ConnectionClosed:
            pass

    try:
        async with serve(
            handler,
            host="127.0.0.1",
            port=cfg.port,
            process_request=process_request,
            subprotocols=[f"damocles-voice.v{PROTOCOL_VERSION}"],
            max_size=2 * 1024 * 1024,
        ):
            logger.info(
                "voice sidecar listening on 127.0.0.1:%d (protocol v%d, tts_rate=%d, mic=native)",
                cfg.port,
                PROTOCOL_VERSION,
                TTS_SAMPLE_RATE,
            )
            # When wake-word is enabled, block on the mic consumer's
            # failure future so a RecoverableOomError raised by the
            # pipeline propagates out through asyncio.run and into
            # __main__.main, which exits with code 7 to trigger the
            # CPU-mode restart. Awaiting a never-resolved Future here
            # used to swallow the OOM at the consumer-task boundary.
            if mic is not None:
                await mic.failure
            else:
                await asyncio.Future()
    finally:
        if mic is not None:
            mic.stop()
