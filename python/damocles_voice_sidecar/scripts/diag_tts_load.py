"""Diagnostic: load the VibeVoice TTS engine in isolation.

Run this when the sidecar exits with code 3 during model load and the
manager.ts stderr ring buffer (64 lines, last 25 displayed) cannot
capture the actual cause because the HF "newly initialized weights"
warning is enormous and pushes the real exception off the tail.

The script mirrors ``VibeVoiceTtsEngine.__init__()`` exactly. Any error
raised inside ``__init__`` surfaces here with full Python traceback —
no truncation, no manager-side filtering.

Usage (Windows PowerShell, runtime venv):

    & "$env:USERPROFILE\\.damocles\\voice\\runtime\\venv\\Scripts\\python.exe" `
        "python\\damocles_voice_sidecar\\scripts\\diag_tts_load.py"

Defaults to ``~/.damocles/voice/models`` for ``--models-dir``. Output
also written to ``~/.damocles/voice/diag_tts_load.log`` so the file
can be attached to a bug report without re-running.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import traceback
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPT_DIR.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from damocles_voice_sidecar.protocol import (  # noqa: E402
    ModelLoadFailed,
    SidecarConfig,
)


def _setup_logging(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    for h in list(root.handlers):
        root.removeHandler(h)
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(fmt)
    root.addHandler(stderr_handler)
    file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)


def main() -> int:
    p = argparse.ArgumentParser(description="Repro VibeVoice TTS load failure.")
    p.add_argument(
        "--models-dir",
        default=None,
        help="Override models dir (default: ~/.damocles/voice/models).",
    )
    p.add_argument(
        "--runtime-mode",
        choices=("cuda", "cpu", "auto"),
        default="auto",
    )
    p.add_argument(
        "--log-path",
        default=None,
        help="Override log path (default: ~/.damocles/voice/diag_tts_load.log).",
    )
    p.add_argument(
        "--swap-to",
        default=None,
        help="After cold load, hot-swap to this voice id (e.g. 'en-Davis_man').",
    )
    args = p.parse_args()

    home = Path.home()
    log_path = Path(args.log_path) if args.log_path else home / ".damocles" / "voice" / "diag_tts_load.log"
    _setup_logging(log_path)
    logger = logging.getLogger("diag_tts_load")

    models_dir = args.models_dir or str(home / ".damocles" / "voice" / "models")
    logger.info("python: %s", sys.executable)
    logger.info("models_dir: %s", models_dir)
    logger.info("runtime_mode: %s", args.runtime_mode)
    logger.info("log_path: %s", log_path)

    try:
        import torch
        logger.info(
            "torch %s | cuda=%s | cuda_version=%s | device_count=%d",
            torch.__version__,
            torch.cuda.is_available(),
            getattr(torch.version, "cuda", None),
            torch.cuda.device_count() if torch.cuda.is_available() else 0,
        )
    except BaseException:
        logger.exception("torch import failed")
        return 4

    try:
        import transformers
        logger.info("transformers %s", transformers.__version__)
    except BaseException:
        logger.exception("transformers import failed")
        return 4

    cfg = SidecarConfig(
        port=0,
        models_dir=models_dir,
        runtime_mode=args.runtime_mode,
        diagnostics=True,
        wake_word_enabled=False,
        tts_enabled=True,
    )

    from damocles_voice_sidecar.engines.tts_vibevoice import VibeVoiceTtsEngine

    logger.info("constructing VibeVoiceTtsEngine...")
    try:
        engine = VibeVoiceTtsEngine(cfg)
    except ModelLoadFailed as exc:
        logger.error("ModelLoadFailed:")
        logger.error("  model_id=%s", exc.model_id)
        logger.error("  path=%s", exc.path)
        logger.error("  cause type=%s", type(exc.cause).__name__)
        logger.error("  cause repr=%r", exc.cause)
        logger.error("--- full chained traceback ---")
        traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write("\n--- full chained traceback ---\n")
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=fh)
        return 3
    except BaseException as exc:
        logger.error("Unexpected exception type=%s", type(exc).__name__)
        traceback.print_exc(file=sys.stderr)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write("\n--- unexpected exception ---\n")
            traceback.print_exc(file=fh)
        return 99

    logger.info("TTS engine loaded OK: device=%s loaded=%s voice=%s", engine._device, engine._loaded, engine._voice_id)

    if args.swap_to:
        logger.info("hot-swap test: requesting voice=%s", args.swap_to)
        try:
            resolved = engine.swap_voice(args.swap_to)
            logger.info("hot-swap returned voice=%s (requested=%s)", resolved, args.swap_to)
        except Exception:
            logger.exception("hot-swap failed")
            traceback.print_exc(file=sys.stderr)
            return 5

    engine.unload()
    return 0


if __name__ == "__main__":
    sys.exit(main())
