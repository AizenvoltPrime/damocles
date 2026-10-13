"""Startup: the wake phrase is validated only when wake detection is on."""

from __future__ import annotations

import logging
import sys

import pytest

from damocles_voice_sidecar import __main__ as entry
from damocles_voice_sidecar import server
from damocles_voice_sidecar.protocol import SidecarConfig
from damocles_voice_sidecar.wake_phrase import WAKE_PHRASE_RULE

INVALID_PHRASE = "hey_jarvis.onnx"


@pytest.fixture
def started(monkeypatch: pytest.MonkeyPatch) -> list[SidecarConfig]:
    configs: list[SidecarConfig] = []

    async def fake_run_server(cfg: SidecarConfig, _engines) -> None:
        configs.append(cfg)

    monkeypatch.setattr(server, "run_server", fake_run_server)
    return configs


def _main(monkeypatch: pytest.MonkeyPatch, *args: str) -> None:
    argv = ["damocles-voice-sidecar", "--port", "0", "--models-dir", "unused", "--use-mocks", *args]
    monkeypatch.setattr(sys, "argv", argv)
    entry.main()


def test_tts_only_starts_with_an_invalid_phrase(monkeypatch, started) -> None:
    _main(monkeypatch, "--tts-enabled", "--wake-word", INVALID_PHRASE)
    assert len(started) == 1


def test_wake_mode_rejects_an_invalid_phrase_with_exit_3(monkeypatch, started, caplog) -> None:
    caplog.set_level(logging.ERROR)
    with pytest.raises(SystemExit) as exc:
        _main(monkeypatch, "--wake-word-enabled", "--wake-word", INVALID_PHRASE)
    assert exc.value.code == 3
    assert started == []
    assert "damocles.voice.wakeWord" in caplog.text
    assert WAKE_PHRASE_RULE in caplog.text


def test_wake_mode_passes_the_normalized_phrase(monkeypatch, started) -> None:
    _main(monkeypatch, "--wake-word-enabled", "--wake-word", " OK_Computer ")
    assert started[0].wake_word == "ok computer"
