# damocles-voice-sidecar

On-device voice sidecar for the Damocles VS Code extension. Runs sherpa-onnx keyword spotting + Silero VAD + Parakeet TDT 0.6B v2 (+ optional VibeVoice-Realtime TTS) over a token-gated WebSocket.

## Layout

```
damocles_voice_sidecar/
├── __main__.py        # entrypoint — argv-driven; token via DAMOCLES_VOICE_TOKEN env
├── protocol.py        # wire types (mirrored in TS as Zod)
├── pipeline.py        # wake → VAD → ASR state machine
├── wake_phrase.py     # wake-phrase normalizer + transcript prefix strip
├── word_chars.py      # generated Unicode 14.0.0 word-character table (scripts/gen_word_chars.py)
├── server.py          # 127.0.0.1 WS server, ping/pong, backpressure
└── engines/
    ├── base.py        # ABCs: WakeEngine, VadEngine, AsrEngine, TtsEngine
    ├── mock.py        # deterministic fixtures for pytest
    ├── wake_sherpa_kws.py  # sherpa-onnx keyword spotter (bundled model in models/wake)
    └── loader.py      # real engine loader (sherpa-onnx KWS/Silero/Parakeet/VibeVoice)
tests/
├── test_pipeline.py        # state machine end-to-end with mocks
├── test_main.py            # startup: phrase validated only in wake mode
├── test_wake_pre_roll.py   # pre-roll replay from the phrase end (mocks + real KWS model)
├── test_wake_exclusion.py  # FR-11: wake phrase never appears in transcript
├── test_wake_prefix.py     # normalizer + prefix strip vs fixtures/wake_prefix_cases.json and wake_prefix_corpus.json (shared with TS)
├── wake_prefix_corpus.py   # generates fixtures/wake_prefix_corpus.json
├── test_wake_sherpa_kws.py # real bundled KWS model; skips without sherpa-onnx or fetched model
├── test_cpu_mode.py        # CPU fallback path
└── test_oom_ladder.py      # CUDA-OOM → unload TTS → CPU restart
```

## Run

```bash
cd python/damocles_voice_sidecar
pip install --prefer-binary -e .[dev]
DAMOCLES_VOICE_TOKEN=$(python -c "import secrets; print(secrets.token_hex(32))") \
  python -m damocles_voice_sidecar \
    --port 17000 \
    --models-dir ~/.damocles/voice/models \
    --runtime-mode auto \
    --wake-word-enabled --wake-word "hey jarvis"
```

The sidecar refuses non-loopback connections and missing/wrong bearer tokens at the socket layer.

## Test

```bash
pytest -q
```

Mock engines drive the full pipeline without GPU or model files. The wake-exclusion test enforces FR-11 (the wake phrase must never appear in the submitted prompt).

## Wire protocol

Subprotocol: `damocles-voice.v1`. Bearer token: `Authorization: Bearer <hex>` (256-bit, env-delivered).

**Inbound** (client → sidecar): `init`, `tts_request`, `cancel_tts`, `set_muted`, `shutdown`, `ping`. The sidecar captures audio natively via sounddevice — no audio bytes cross the WebSocket. This mirrors `src/core/voice/recorder.ts` which spawns platform-native recording binaries for the push-to-talk path; both bypass the VS Code webview permission boundary that denies `getUserMedia` by default.

**Outbound** (sidecar → client): `ready`, `wake_detected`, `wake_aborted`, `vad_speech_started`, `vad_speech_ended`, `transcript_final`, `tts_audio_chunk` (JSON envelope + binary float32 24 kHz follow-up), `tts_done`, `error`, `pong`.

Audio: 16 kHz mono int16 LE, 20 ms / 320-sample frames. TTS: 24 kHz mono float32.

## Adding a new STT or TTS engine

1. Implement the relevant ABC in `engines/base.py`.
2. Wire it into `engines/loader.py:load_real_engines()`.
3. Add a fixture-driven test alongside `tests/test_pipeline.py`.

The pipeline never touches NeMo/transformers/etc directly; everything goes through the ABCs.

## Wake pre-roll

The keyword spotter decodes in 320 ms chunks and only fires after the phrase has ended: on 602 detected synthetic positives the detection came 49 ms (min), 128 ms (p5), 304 ms (median), 524 ms (p95), 659 ms (max) after the end of the phrase. Command speech often starts inside that window.

While listening, the pipeline keeps the last `PRE_ROLL_MS` (1000 ms, 50 frames, 32 KB) of microphone frames in a ring buffer. The size covers the 659 ms worst-case latency plus margin. On detection the wake engine reports how many samples were fed after the phrase ended. The pipeline replays the whole buffered frames after that point through the same VAD → capture path that live frames take, then continues live. The false-wake timeout counts from the phrase end. The buffer is cleared whenever the pipeline returns to listening. It is never logged or persisted.

The phrase end comes from sherpa-onnx itself. The engine reads one `KeywordResult` from the native spotter (`KeywordSpotter.keyword_spotter.get_result`). The wrapper's `get_result()` and `timestamps()` each fetch the result, and the first fetch consumes it. The end is the last keyword token's timestamp plus one 40 ms encoder frame. Timestamps count from the stream's first sample. sherpa-onnx 1.13.8 does not expose `start_time` to Python, and `reset_stream` moves the origin, so each detection starts a new stream.

Measured with the real spotter (2 SAPI voices × 3 rates, "hey jarvis" + 0/100/200/300 ms gap + "open the settings file", 24 of 24 detected), the replay starts between 105 ms before and 72 ms after the trimmed phrase end. At most 32 ms of command onset was lost (one case, 0 ms gap). Without the pre-roll, up to 434 ms was lost (median 191 ms).

## Wake-phrase exclusion (FR-11)

Two-layer defense — both required:

1. **Replay point:** VAD and ASR receive only frames after the phrase end the spotter reports (see above). At most the last ~100 ms of the phrase's final sound can precede that point.
2. **Regex strip:** `wake_phrase.strip_wake_prefix` removes a leading wake phrase (or its last word) from the final transcript once, then trims whitespace. Wake-word letters match ASCII upper or lower case only. The last word must not be followed by a Unicode letter, a Unicode number or `_`. Whitespace is exactly Unicode White_Space. See `docs/voice-jarvis-mode.md` for the full rule.

The host-side TS handler (`src/shared/wake-phrase.ts`) builds its pattern from the same explicit classes, never `\s`, `\b`, `\w` or a case-insensitive flag, which the two regex engines read differently. The word characters are a Unicode 14.0.0 table that `scripts/gen_word_chars.py` writes to `damocles_voice_sidecar/word_chars.py` and `src/shared/generated/word-chars.ts`. Both sides are checked against `tests/fixtures/wake_prefix_cases.json` and the generated corpus `tests/fixtures/wake_prefix_corpus.json`. Rewrite the corpus with `uv run python -m tests.wake_prefix_corpus`.

## Wake phrase and sensitivity

`damocles.voice.wakeWord` arrives only as `--wake-word`; the `init` message carries no phrase. With `--wake-word-enabled` it is normalized (`_` → space, trim, collapse whitespace, lowercase) and must be 1 to 4 words of `[a-z]`; anything else raises `ModelLoadFailed` (exit 3). Without wake detection the phrase is not read, so an invalid value cannot stop TTS-only mode. The phrase is tokenized with the bundled `bpe.model` and spotted by `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (Apache-2.0).

`wake_sensitivity` (slider 0.1–0.95, lower triggers more easily) maps piecewise-linearly to the sherpa keyword threshold: 0.1 → 0.10, 0.5 → 0.25, 0.95 → 0.50. Barge-in raises the slider floor to 0.75 (threshold 0.39). Measured with keyword boost 1.0 and one trailing blank:

| threshold | recall (688 positives) | false accepts on 10.82 h LibriSpeech dev-clean + dev-other |
|---|---|---|
| 0.10 | 87.5% | 0 |
| 0.15 | 87.5% | 0 |
| 0.20 | 87.1% | 0 |
| 0.25 (default) | 86.8% | 0 |
| 0.30 | 85.5% | 0 |
| 0.35 | 82.8% | 0 |
| 0.40 | 78.2% | 0 |
| 0.50 | 58.4% | 0 |
| 0.60 | 30.1% | 0 |

The positives are 172 synthetic "hey jarvis" utterances: 9 Windows SAPI voices at 5 rates, and Piper voices (LibriTTS-R, VCTK, L2-ARCTIC, and 11 single-speaker voices). Each one is embedded between a lead-in sentence and a command, then played clean, with pink noise at 20 dB and 10 dB SNR, and with babble at 10 dB SNR. At the default, recall is 91% clean and 83% at 10 dB SNR. Most misses are the non-native L2-ARCTIC voice (37 of 64 missed); the SAPI voices miss 10 of 180 and LibriTTS-R misses 12 of 240. With zero false accepts in 10.82 h, the 95% upper bound is 0.28 false accepts per hour. Thresholds below 0.10 were not measured, which is why the slider minimum stops there.

## First-run network access

The sidecar is on-device for audio and transcripts — **no audio bytes or transcript text ever leave the machine**. There is one carve-out worth disclosing:

- **VibeVoice TTS first run:** `VibeVoiceStreamingProcessor.from_pretrained` instantiates a Qwen2.5-0.5B tokenizer whose `tokenizer.json` and `tokenizer_config.json` are not bundled in our model manifest. On first launch with TTS enabled, transformers fetches those two metadata files from `huggingface.co/Qwen/Qwen2.5-0.5B`. The fetch is a one-time HTTP GET of static tokenizer metadata — no audio, no transcripts, no telemetry. Subsequent runs read from the HF cache.
- **No other network calls** are made by the sidecar at runtime. Wake, VAD, ASR, and synthesis are fully local.

If you need a strict no-network posture for first launch, run `python -m damocles_voice_sidecar` once on a connected machine to populate the cache, then copy `~/.cache/huggingface/hub/models--Qwen--Qwen2.5-0.5B/` to the air-gapped target before launching there.

## Licenses

This sidecar ships with several third-party models and Python packages.
Full attribution and license text live in the top-level
[`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md) — the
"Voice sidecar — model and runtime attribution" and "VibeVoice"
sections cover Parakeet TDT 0.6B v2 (CC-BY-4.0), NeMo, sherpa-onnx and its
GigaSpeech keyword-spotting model, sentencepiece, Silero VAD, PyTorch, transformers, diffusers, accelerate, websockets,
sounddevice, NumPy, torchaudio, soundfile, onnxruntime, cuda-python,
the python-build-standalone interpreter, and the vendored
microsoft/VibeVoice modules.
