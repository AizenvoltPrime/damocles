"""FR-11 acceptance test: the wake phrase must never appear in the submitted prompt.

Both defenses are tested:
  1. ``strip_wake_prefix`` regex strip pass.
  2. The pipeline replays only audio after the phrase end the wake engine
     reports, so ASR never receives the wake-phrase audio; that is covered
     in ``test_wake_pre_roll.py``, and this file exercises the regex pass.
"""

from __future__ import annotations

import pytest

from damocles_voice_sidecar.wake_phrase import (
    DEFAULT_WAKE_PHRASE,
    compile_wake_prefix,
    strip_wake_prefix,
)


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
    assert strip_wake_prefix(raw, compile_wake_prefix(DEFAULT_WAKE_PHRASE)) == expected
