"""SherpaKwsWakeEngine against the real bundled keyword-spotting model.

Model tests skip unless sherpa_onnx and sentencepiece are installed and
``npm run fetch:wake-models`` has placed the model in ``models/wake``. Speech
clips are synthesized at test time with Windows SAPI (System.Speech), so the
speech tests also skip off Windows or without the en-US Desktop voices.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from damocles_voice_sidecar.engines import wake_sherpa_kws
from damocles_voice_sidecar.engines.wake_sherpa_kws import (
    BARGE_IN_SENSITIVITY,
    ENCODER_FILENAME,
    SherpaKwsWakeEngine,
    keyword_threshold,
)
from damocles_voice_sidecar.models.manifest import load_manifest
from damocles_voice_sidecar.protocol import FRAME_SAMPLES, ModelLoadFailed

from .kws_support import MODEL_FILES, SAPI_VOICES, kws_engine as _engine, needs_model
from .kws_support import with_room_tone as _with_room_tone

# Spotted at threshold 0.25 but not 0.5 (measured); flips if the sensitivity map changes.
SENSITIVE_CLIP = ("Hey, Jarvis", "Microsoft Zira Desktop", 0)
FIXTURE = Path(__file__).parent / "fixtures" / "wake_prefix_cases.json"


def _feed(engine: SherpaKwsWakeEngine, pcm: np.ndarray) -> list[int]:
    """Return the index of every frame that reported a detection."""
    hits = []
    for i in range(pcm.size // FRAME_SAMPLES):
        frame = pcm[i * FRAME_SAMPLES : (i + 1) * FRAME_SAMPLES].tobytes()
        if engine.process(frame).detected:
            hits.append(i)
    return hits


def test_model_filenames_match_manifest() -> None:
    files = [entry["filename"] for entry in load_manifest()["wake_model"]["files"]]
    assert sorted(files) == sorted(MODEL_FILES)


@pytest.mark.parametrize("setting", json.loads(FIXTURE.read_text(encoding="utf-8"))["invalid"])
def test_invalid_phrase_raises_model_load_failed(setting: str) -> None:
    with pytest.raises(ModelLoadFailed, match="damocles.voice.wakeWord"):
        _engine(setting)


def test_missing_model_file_names_the_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    pytest.importorskip("sherpa_onnx")
    pytest.importorskip("sentencepiece")
    monkeypatch.setattr(wake_sherpa_kws.resources, "files", lambda _package: tmp_path)
    with pytest.raises(ModelLoadFailed, match=ENCODER_FILENAME):
        _engine()


def test_sensitivity_map_is_monotonic_and_pinned_at_default() -> None:
    thresholds = [keyword_threshold(s / 100) for s in range(10, 96)]
    assert thresholds == sorted(thresholds)
    assert keyword_threshold(0.5) == pytest.approx(0.25)


@needs_model
def test_ignores_silence_and_noise() -> None:
    engine = _engine(sensitivity=0.1)
    rng = np.random.default_rng(1)
    silence = np.zeros(10 * 16000, dtype=np.int16)
    noise = np.clip(rng.normal(0.0, 3000.0, 10 * 16000), -32768, 32767).astype(np.int16)
    assert _feed(engine, np.concatenate([silence, noise])) == []


@needs_model
def test_rejects_malformed_frames() -> None:
    result = _engine().process(b"\x00" * 10)
    assert result.detected is False


@needs_model
@pytest.mark.parametrize("voice", SAPI_VOICES)
def test_detects_hey_jarvis(sapi, voice: str) -> None:
    speech = sapi("Hey Jarvis", voice)
    pcm = _with_room_tone(speech)
    hits = _feed(_engine(), pcm)
    assert len(hits) == 1
    speech_end_frame = (8000 + speech.size) // FRAME_SAMPLES
    assert hits[0] >= speech_end_frame - 5


@needs_model
@pytest.mark.parametrize("voice", SAPI_VOICES)
def test_ignores_other_speech(sapi, voice: str) -> None:
    speech = sapi(
        "Please open the settings file, run the unit tests again, and show me the last commit.",
        voice,
    )
    assert _feed(_engine(sensitivity=0.1), _with_room_tone(speech)) == []


@needs_model
def test_custom_phrase(sapi) -> None:
    speech = _with_room_tone(sapi("OK computer", SAPI_VOICES[1]))
    assert len(_feed(_engine("ok computer"), speech)) == 1
    assert _feed(_engine("hey jarvis"), speech) == []


@needs_model
def test_is_deterministic(sapi) -> None:
    pcm = _with_room_tone(sapi("Hey Jarvis", SAPI_VOICES[0]))
    frames = [
        pcm[i : i + FRAME_SAMPLES].tobytes()
        for i in range(0, pcm.size - FRAME_SAMPLES + 1, FRAME_SAMPLES)
    ]
    engine_a, engine_b = _engine(), _engine()
    first = [engine_a.process(f) for f in frames]
    second = [engine_b.process(f) for f in frames]
    assert first == second
    assert any(r.detected for r in first)


@needs_model
def test_reset_clears_partial_phrase(sapi) -> None:
    speech = sapi("Hey Jarvis", SAPI_VOICES[1])
    engine = _engine()
    head = _with_room_tone(speech[: int(speech.size * 0.6)], tail_s=0.0)
    tail = _with_room_tone(speech[int(speech.size * 0.6) :], lead_s=0.0)
    assert _feed(engine, head) == []
    engine.reset()
    assert _feed(engine, tail) == []
    assert len(_feed(_engine(), np.concatenate([head, tail]))) == 1


@needs_model
def test_set_sensitivity_applies_without_reloading(sapi, monkeypatch: pytest.MonkeyPatch) -> None:
    import sherpa_onnx

    pcm = _with_room_tone(sapi(*SENSITIVE_CLIP))
    engine = _engine(sensitivity=0.1)
    spotter = engine._spotter

    def no_reload(*_args, **_kwargs):
        raise AssertionError("set_sensitivity must not construct a new KeywordSpotter")

    monkeypatch.setattr(sherpa_onnx, "KeywordSpotter", no_reload)
    assert len(_feed(engine, pcm)) == 1
    engine.set_sensitivity(0.95)
    assert _feed(engine, pcm) == []
    engine.set_sensitivity(0.1)
    assert len(_feed(engine, pcm)) == 1
    assert engine._spotter is spotter


@needs_model
def test_barge_in_raises_the_threshold_floor() -> None:
    engine = _engine(sensitivity=0.5)
    engine.raise_threshold_for_barge_in()
    assert engine._threshold == pytest.approx(keyword_threshold(BARGE_IN_SENSITIVITY))
    engine.set_sensitivity(0.9)
    engine.raise_threshold_for_barge_in()
    assert engine._threshold == pytest.approx(keyword_threshold(0.9))
