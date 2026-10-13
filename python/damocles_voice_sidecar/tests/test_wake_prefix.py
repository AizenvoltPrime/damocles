"""Wake-phrase normalizer and prefix strip against the shared fixtures.

``src/core/voice/__tests__/wake-prefix-parity.test.ts`` drives the TypeScript
side from the same files, so both sides strip every listed transcript alike.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

import pytest

from damocles_voice_sidecar.protocol import ModelLoadFailed
from damocles_voice_sidecar.wake_phrase import (
    WAKE_WORD_SETTING,
    WHITESPACE,
    WORD_CHAR_CLASS,
    compile_wake_prefix,
    normalize_wake_phrase,
    strip_wake_prefix,
    wake_prefix_pattern,
)
from damocles_voice_sidecar.word_chars import (
    WORD_CHAR_RANGES,
    WORD_CHAR_UNICODE_VERSION,
)

from .wake_prefix_corpus import CORPUS_PATH, build_corpus

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "wake_prefix_cases.json").read_text(
        encoding="utf-8"
    )
)
CASES = FIXTURE["cases"]
STRIPS = [(case["phrase"], strip) for case in CASES for strip in case["strips"]]
TS_WORD_CHARS = (
    Path(__file__).parents[3] / "src" / "shared" / "generated" / "word-chars.ts"
)


@pytest.mark.parametrize("case", CASES, ids=[case["setting"] for case in CASES])
def test_normalizes_setting(case: dict) -> None:
    assert normalize_wake_phrase(case["setting"]) == case["phrase"]


@pytest.mark.parametrize(
    "phrase,strip", STRIPS, ids=[ascii(strip["text"]) for _, strip in STRIPS]
)
def test_strips_transcript(phrase: str, strip: dict) -> None:
    assert (
        strip_wake_prefix(strip["text"], compile_wake_prefix(phrase))
        == strip["expected"]
    )


@pytest.mark.parametrize("setting", FIXTURE["invalid"])
def test_rejects_invalid_setting(setting: str) -> None:
    with pytest.raises(ModelLoadFailed) as excinfo:
        normalize_wake_phrase(setting)
    message = str(excinfo.value)
    assert WAKE_WORD_SETTING in message
    assert "1 to 4 words of ASCII letters" in message


def test_pattern_source() -> None:
    # The TypeScript test expects the same text with its own spelling of the word-character class.
    assert wake_prefix_pattern("hey jarvis") == (
        r"^[\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*"
        r"([Hh][Ee][Yy][\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+)?"
        r"[Jj][Aa][Rr][Vv][Ii][Ss]"
        f"(?!{WORD_CHAR_CLASS})"
        r"[,.\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*"
    )


def test_whitespace_is_unicode_white_space() -> None:
    members = {
        code for code in range(0x110000) if re.fullmatch(f"[{WHITESPACE}]", chr(code))
    }
    assert members == {
        *range(0x09, 0x0E), 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B),
        0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
    }  # fmt: skip


def test_word_char_table_matches_typescript() -> None:
    ts_ranges = "".join(
        re.findall(
            r'^  "([^"]*)"', TS_WORD_CHARS.read_text(encoding="utf-8"), re.MULTILINE
        )
    )
    assert ts_ranges == WORD_CHAR_RANGES


@pytest.mark.skipif(
    unicodedata.unidata_version != WORD_CHAR_UNICODE_VERSION,
    reason=f"the word-character table is pinned to Unicode {WORD_CHAR_UNICODE_VERSION}",
)
def test_word_char_table_is_letters_numbers_and_underscore() -> None:
    word = re.compile(WORD_CHAR_CLASS)
    for code in range(0x110000):
        char = chr(code)
        expected = code == 0x5F or unicodedata.category(char)[0] in "LN"
        assert bool(word.fullmatch(char)) == expected, hex(code)


def test_corpus_is_current() -> None:
    assert (
        json.loads(CORPUS_PATH.read_text(encoding="utf-8"))["cases"] == build_corpus()
    )
