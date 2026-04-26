"""Entrypoint: ``python -m damocles_voice_sidecar``.

Argv carries non-secret runtime config; the spawn token is delivered via
``DAMOCLES_VOICE_TOKEN`` env var (argv is world-readable on Linux/macOS).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from .protocol import ModelLoadFailed, RecoverableOomError, SidecarConfig

OOM_RESTART_EXIT_CODE = 7


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="damocles-voice-sidecar")
    p.add_argument("--port", type=int, required=True, help="WebSocket port (loopback only)")
    p.add_argument("--models-dir", type=str, required=True, help="Path to ~/.damocles/voice/models")
    p.add_argument(
        "--runtime-mode",
        choices=("cuda", "cpu", "auto"),
        default="auto",
    )
    p.add_argument("--diagnostics", action="store_true")
    p.add_argument(
        "--wake-word-enabled",
        action="store_true",
        help="Load wake/VAD/ASR engines and open the OS microphone.",
    )
    p.add_argument(
        "--tts-enabled",
        action="store_true",
        help="Load the VibeVoice TTS engine for spoken-reply playback.",
    )
    p.add_argument(
        "--use-mocks",
        action="store_true",
        help="Skip real engine loading; run with deterministic mock engines.",
    )
    return p


def _setup_logging(diagnostics: bool) -> None:
    if diagnostics:
        # Structured JSON to stderr — never includes transcript text.
        class _JsonFormatter(logging.Formatter):
            def format(self, record: logging.LogRecord) -> str:
                return json.dumps(
                    {
                        "ts": record.created,
                        "level": record.levelname,
                        "msg": record.getMessage(),
                        "name": record.name,
                    }
                )

        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(_JsonFormatter())
        logging.basicConfig(level=logging.DEBUG, handlers=[handler])
    else:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
            stream=sys.stderr,
        )


def main() -> None:
    args = _build_parser().parse_args()
    _setup_logging(args.diagnostics)

    cfg = SidecarConfig(
        port=args.port,
        models_dir=args.models_dir,
        runtime_mode=args.runtime_mode,
        diagnostics=args.diagnostics,
        wake_word_enabled=args.wake_word_enabled,
        tts_enabled=args.tts_enabled,
    )

    if not cfg.wake_word_enabled and not cfg.tts_enabled:
        logging.getLogger(__name__).error(
            "sidecar started without wake-word or TTS enabled; nothing to do"
        )
        sys.exit(5)

    if args.use_mocks:
        from .engines.mock import (
            MockAsrEngine,
            MockTtsEngine,
            MockVadEngine,
            MockWakeEngine,
        )
        from .engines.base import EngineSet

        logging.getLogger(__name__).info(
            "running with mock engines (--use-mocks)"
        )
        engines = EngineSet(
            wake=MockWakeEngine() if cfg.wake_word_enabled else None,
            vad=MockVadEngine() if cfg.wake_word_enabled else None,
            asr=MockAsrEngine() if cfg.wake_word_enabled else None,
            tts=MockTtsEngine() if cfg.tts_enabled else None,
        )
    else:
        from .engines.loader import load_real_engines

        try:
            engines = load_real_engines(cfg)
        except ModelLoadFailed as exc:
            # exc_info=True emits the full chained traceback (the
            # ModelLoadFailed wrapper plus the underlying torch /
            # transformers / file-IO exception via __cause__). Without
            # this, exit code 3 carried only str(cause), which collapses
            # the actual exception type and stack to one line.
            logging.getLogger(__name__).error(
                "model-load-failed: id=%s path=%s cause=%s",
                exc.model_id,
                exc.path,
                exc.cause,
                exc_info=True,
            )
            sys.exit(3)
        except ImportError as exc:
            logging.getLogger(__name__).error(
                "missing ML dependency: %s", exc, exc_info=True
            )
            sys.exit(4)

    from .server import run_server

    try:
        asyncio.run(run_server(cfg, engines))
    except RecoverableOomError as exc:
        logging.getLogger(__name__).warning(
            "cuda-oom unrecoverable in-process; exiting %d for cpu-mode restart: %s",
            OOM_RESTART_EXIT_CODE,
            exc,
        )
        sys.exit(OOM_RESTART_EXIT_CODE)


if __name__ == "__main__":
    main()
