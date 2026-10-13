"""Differential corpus for the wake-prefix strip, shared with the TypeScript host.

Inputs mix each phrase's words with characters from the classes the two regex
engines used to read differently (word characters, whitespace, case-folding
letters, punctuation), plus a seeded sample of BMP code points. Outputs are the
sidecar's ``strip_wake_prefix``; ``src/core/voice/__tests__/wake-prefix-parity.test.ts``
asserts the same outputs and ``test_wake_prefix.py`` asserts the file is current.

Rewrite the file from ``python/damocles_voice_sidecar``:

    uv run python -m tests.wake_prefix_corpus
"""

from __future__ import annotations

import json
from pathlib import Path

from damocles_voice_sidecar.wake_phrase import compile_wake_prefix, strip_wake_prefix

CORPUS_PATH = Path(__file__).parent / "fixtures" / "wake_prefix_corpus.json"

PHRASES = ("hey jarvis", "ok house robot")
RANDOM_CASES_PER_PHRASE = 1000
SEED = 0x5EED_2024

UNICODE_WHITE_SPACE = [
    *range(0x09, 0x0E), 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B),
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000,
]  # fmt: skip
# Whitespace to one engine's \s or str.strip but not Unicode White_Space.
ENGINE_ONLY_SPACE = [*range(0x1C, 0x20), 0x180E, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF]
WORD_CHARS = [
    0x5F, 0x30, 0x32, 0x78, 0x58, 0xAA, 0xB2, 0xBD, 0xDF, 0xE9, 0x1C5, 0x2C6, 0x3A9, 0x663,
    0x216B, 0x3007, 0x4E2D, 0xFF10, 0xFF21, 0x10000, 0x1D7CE,
]  # fmt: skip
NON_WORD_CHARS = [
    0x2C, 0x2E, 0x27, 0x2019, 0x21, 0x3F, 0x2D, 0x3A, 0x3B, 0x22, 0x3001, 0x3002, 0xFF0C,
    0xFF0E, 0x301, 0x200E, 0x2E2F, 0x1F600, 0xDC00,
]  # fmt: skip
# Letters assigned after WORD_CHAR_UNICODE_VERSION: not word characters to the pinned table, letters to a newer \p{L}.
LATER_UNICODE_LETTERS = [0xC5C, 0x1C89, 0xA7CB, 0x11F04, 0x31350]
CASE_FOLD_TRAPS = [0x130, 0x131, 0x17F, 0x212A]
BOUNDARY = [
    chr(code)
    for code in UNICODE_WHITE_SPACE
    + ENGINE_ONLY_SPACE
    + WORD_CHARS
    + NON_WORD_CHARS
    + LATER_UNICODE_LETTERS
    + CASE_FOLD_TRAPS
]


class _Rng:
    """xorshift64*, so the corpus does not depend on the Python version's ``random``."""

    def __init__(self, seed: int) -> None:
        self._state = seed or 1

    def below(self, bound: int) -> int:
        x = self._state
        x ^= x >> 12
        x ^= (x << 25) & 0xFFFFFFFFFFFFFFFF
        x ^= x >> 27
        self._state = x
        return ((x * 0x2545F4914F6CDD1D) & 0xFFFFFFFFFFFFFFFF) % bound

    def pick(self, items: list[str] | tuple[str, ...]) -> str:
        return items[self.below(len(items))]


def _random_bmp(rng: _Rng) -> str:
    # Surrogates are left out: a high one followed by a low one would become one code point in JSON.
    while True:
        code = rng.below(0x10000)
        if not 0xD800 <= code <= 0xDFFF:
            return chr(code)


def _random_case(rng: _Rng, word: str) -> str:
    return "".join(letter.upper() if rng.below(2) else letter for letter in word)


def _boundary_texts(words: list[str]) -> list[str]:
    phrase = " ".join(words)
    last = words[-1]
    texts: list[str] = []
    for char in BOUNDARY:
        texts.append(f"{char}{phrase} go")
        texts.append(f"{phrase}{char} go")
        texts.append(f"{phrase}{char}{char}go")
        texts.append(f"{last}{char}go")
        texts.append(f"{phrase} go{char}")
        for gap in range(len(words) - 1):
            texts.append(
                " ".join(words[: gap + 1]) + char + " ".join(words[gap + 1 :]) + " go"
            )
    for trap in CASE_FOLD_TRAPS:
        for index, word in enumerate(words):
            for position in range(len(word)):
                swapped = word[:position] + chr(trap) + word[position + 1 :]
                texts.append(
                    " ".join([*words[:index], swapped, *words[index + 1 :]]) + " go"
                )
    return texts


def _random_texts(words: list[str], rng: _Rng) -> list[str]:
    def piece() -> str:
        return BOUNDARY[rng.below(len(BOUNDARY))] if rng.below(2) else _random_bmp(rng)

    texts: list[str] = []
    for _ in range(RANDOM_CASES_PER_PHRASE):
        parts = ["".join(piece() for _ in range(rng.below(3)))]
        start = rng.below(len(words))
        for word in words[start:-1]:
            separator = rng.pick((" ", "  ", piece(), piece() + piece()))
            parts.append(_random_case(rng, word) + separator)
        parts.append(_random_case(rng, words[-1]))
        parts.append("".join(piece() for _ in range(rng.below(4))))
        parts.append(rng.pick(("", " go", " open the file", piece() + "go")))
        texts.append("".join(parts))
    return texts


def build_corpus() -> dict[str, list[list[str]]]:
    rng = _Rng(SEED)
    corpus: dict[str, list[list[str]]] = {}
    for phrase in PHRASES:
        words = phrase.split(" ")
        prefix = compile_wake_prefix(phrase)
        texts = _boundary_texts(words) + _random_texts(words, rng)
        corpus[phrase] = [[text, strip_wake_prefix(text, prefix)] for text in texts]
    return corpus


COMMENT = (
    "Generated by python/damocles_voice_sidecar/tests/wake_prefix_corpus.py; do not edit. "
    "Each case is [transcript, sidecar strip_wake_prefix output] for the phrase it is listed under."
)


def render(corpus: dict[str, list[list[str]]]) -> str:
    """One case per line, ASCII-escaped, so diffs stay readable."""
    lines = ["{", f'  "$comment": {json.dumps(COMMENT)},', '  "cases": {']
    for phrase_index, (phrase, cases) in enumerate(corpus.items()):
        lines.append(f"    {json.dumps(phrase)}: [")
        for case_index, case in enumerate(cases):
            comma = "," if case_index < len(cases) - 1 else ""
            lines.append(f"      {json.dumps(case, ensure_ascii=True)}{comma}")
        lines.append("    ]," if phrase_index < len(corpus) - 1 else "    ]")
    lines.extend(["  }", "}"])
    return "\n".join(lines) + "\n"


def main() -> None:
    corpus = build_corpus()
    CORPUS_PATH.write_text(render(corpus), encoding="utf-8")
    print(
        f"wrote {sum(len(cases) for cases in corpus.values())} cases to {CORPUS_PATH}"
    )


if __name__ == "__main__":
    main()
