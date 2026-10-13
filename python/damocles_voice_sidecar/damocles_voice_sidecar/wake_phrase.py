"""Wake-phrase normalization and the transcript wake-prefix strip.

The TypeScript host implements the same normalizer and strip in
``src/shared/wake-phrase.ts``; both sides are checked against
``tests/fixtures/wake_prefix_cases.json`` and ``tests/fixtures/wake_prefix_corpus.json``.
"""

from __future__ import annotations

import re

from .protocol import ModelLoadFailed
from .word_chars import WORD_CHAR_RANGES

# Unicode White_Space as a class body; src/shared/wake-phrase.ts uses this text verbatim, never \s.
WHITESPACE = r"\t-\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"

WORD_CHAR_CLASS = (
    "["
    + "".join(
        "-".join(f"\\U{int(bound, 16):08x}" for bound in token.split("-"))
        for token in WORD_CHAR_RANGES.split()
    )
    + "]"
)

_TRIM_RE = re.compile(rf"^[{WHITESPACE}]+|[{WHITESPACE}]+\Z")

WAKE_WORD_SETTING = "damocles.voice.wakeWord"
DEFAULT_WAKE_PHRASE = "hey jarvis"
MAX_WAKE_PHRASE_WORDS = 4
WAKE_PHRASE_RULE = (
    f"{WAKE_WORD_SETTING} must be 1 to {MAX_WAKE_PHRASE_WORDS} words of ASCII letters a-z, "
    "separated by spaces or underscores"
)

_WORD_RE = re.compile(r"[a-z]+")
_WHITESPACE_RE = re.compile(r"\s+")


def normalize_wake_phrase(setting: str) -> str:
    """Return the canonical phrase for a ``damocles.voice.wakeWord`` value.

    Raises ``ModelLoadFailed`` naming the setting and the rule when the value is
    not a valid phrase.
    """
    phrase = _WHITESPACE_RE.sub(" ", setting.replace("_", " ").strip()).lower()
    words = phrase.split(" ") if phrase else []
    if not 1 <= len(words) <= MAX_WAKE_PHRASE_WORDS or not all(
        _WORD_RE.fullmatch(word) for word in words
    ):
        raise ModelLoadFailed(
            model_id="wake-phrase",
            path=f"{WAKE_WORD_SETTING}={setting!r}",
            cause=ValueError(WAKE_PHRASE_RULE),
        )
    return phrase


def _letters(word: str) -> str:
    return "".join(f"[{letter.upper()}{letter}]" for letter in word)


def wake_prefix_pattern(phrase: str) -> str:
    """Regex source that matches the normalized phrase, or its last word alone, at the start,
    when the last word is not followed by a word character."""
    words = phrase.split(" ")
    last = _letters(words[-1])
    if len(words) == 1:
        return rf"^[{WHITESPACE}]*{last}(?!{WORD_CHAR_CLASS})[,.{WHITESPACE}]*"
    leading = "".join(f"{_letters(word)}[{WHITESPACE}]+" for word in words[:-1])
    return rf"^[{WHITESPACE}]*({leading})?{last}(?!{WORD_CHAR_CLASS})[,.{WHITESPACE}]*"


def compile_wake_prefix(phrase: str) -> re.Pattern[str]:
    # No IGNORECASE: it also matches U+0130, U+0131, U+017F and U+212A against ASCII letters.
    return re.compile(wake_prefix_pattern(phrase))


def strip_wake_prefix(text: str, prefix: re.Pattern[str]) -> str:
    return _TRIM_RE.sub("", prefix.sub("", text, count=1))
