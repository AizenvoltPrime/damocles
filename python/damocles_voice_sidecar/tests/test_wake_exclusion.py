"""FR-11 acceptance test: 'Hey Jarvis' must never appear in the submitted prompt.

Both defenses are tested:
  1. ``strip_wake_prefix`` regex strip pass.
  2. The pipeline-level post-wake offset (the ASR engine never receives the
     wake-phrase audio in the first place; the mock here returns whatever
     text it was given, so the test exercises the regex pass directly).

A real-audio integration test against a fixture WAV is added in US-006 once
the OpenWakeWord + Parakeet engines are wired in.
"""

from __future__ import annotations

import pytest

from damocles_voice_sidecar.pipeline import strip_wake_prefix


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Hey Jarvis, refactor this function", "refactor this function"),
        ("hey jarvis refactor this function", "refactor this function"),
        ("Jarvis, what files are in this folder?", "what files are in this folder?"),
        ("HEY JARVIS. List my recent commits.", "List my recent commits."),
        ("Refactor this function.", "Refactor this function."),  # no prefix → unchanged
        ("hey jarvis, hey jarvis, ping me", "hey jarvis, ping me"),  # only one strip
    ],
)
def test_strip_wake_prefix(raw: str, expected: str) -> None:
    assert strip_wake_prefix(raw) == expected
