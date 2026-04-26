# damocles-voice-sidecar

On-device voice sidecar for the Damocles VS Code extension. Runs OpenWakeWord + Silero VAD + Parakeet TDT 0.6B v2 (+ optional VibeVoice-Realtime TTS) over a token-gated WebSocket.

## Layout

```
damocles_voice_sidecar/
├── __main__.py        # entrypoint — argv-driven; token via DAMOCLES_VOICE_TOKEN env
├── protocol.py        # wire types (mirrored in TS as Zod)
├── pipeline.py        # wake → VAD → ASR state machine + wake-phrase strip
├── server.py          # 127.0.0.1 WS server, ping/pong, backpressure
└── engines/
    ├── base.py        # ABCs: WakeEngine, VadEngine, AsrEngine, TtsEngine
    ├── mock.py        # deterministic fixtures for pytest
    └── loader.py      # real engine loader (US-006: OpenWakeWord/Silero/Parakeet/VibeVoice)
tests/
├── test_pipeline.py        # state machine end-to-end with mocks
├── test_wake_exclusion.py  # FR-11: wake phrase never appears in transcript
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
    --runtime-mode auto
```

The sidecar refuses non-loopback connections and missing/wrong bearer tokens at the socket layer.

## Test

```bash
pytest -q
```

Mock engines drive the full pipeline without GPU or model files. The wake-exclusion test enforces FR-11 (the wake phrase must never appear in the submitted prompt).

## Wire protocol

Subprotocol: `damocles-voice.v1`. Bearer token: `Authorization: Bearer <hex>` (256-bit, env-delivered).

**Inbound** (client → sidecar): `init`, `tts_request`, `cancel_tts`, `set_muted`, `shutdown`, `ping`. The sidecar captures audio natively via sounddevice — no audio bytes cross the WebSocket. This mirrors `src/extension/voice/recorder.ts` which spawns platform-native recording binaries for the push-to-talk path; both bypass the VS Code webview permission boundary that denies `getUserMedia` by default.

**Outbound** (sidecar → client): `ready`, `wake_detected`, `wake_aborted`, `vad_speech_started`, `vad_speech_ended`, `transcript_final`, `tts_audio_chunk` (JSON envelope + binary float32 24 kHz follow-up), `tts_done`, `error`, `pong`.

Audio: 16 kHz mono int16 LE, 20 ms / 320-sample frames. TTS: 24 kHz mono float32.

## Adding a new STT or TTS engine

1. Implement the relevant ABC in `engines/base.py`.
2. Wire it into `engines/loader.py:load_real_engines()`.
3. Add a fixture-driven test alongside `tests/test_pipeline.py`.

The pipeline never touches NeMo/transformers/etc directly; everything goes through the ABCs.

## Wake-phrase exclusion (FR-11)

Two-layer defense — both required:

1. **Audio offset:** ASR sees audio starting at `T_wake + 250 ms` (`POST_WAKE_OFFSET_MS`). Calibrated against the pre-trained `hey_jarvis_v0.1` detection latency (same model whether shipped as `.tflite` or `.onnx`; we ship `.onnx` for cross-platform parity).
2. **Regex strip:** `pipeline.strip_wake_prefix` removes any leading `^(hey\s+)?jarvis[,.\s]*` from the final transcript.

The host-side TS handler also runs the same regex pass — defense in depth so older sidecars stay correct. The two regex literals (`pipeline.py:WAKE_PREFIX_RE` and `voice-stream-handlers.ts:WAKE_PREFIX_RE`) are checked for parity by `src/extension/voice/__tests__/wake-prefix-parity.test.ts` so silent drift breaks CI.

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
sections cover Parakeet TDT 0.6B v2 (CC-BY-4.0), NeMo, OpenWakeWord,
Silero VAD, PyTorch, transformers, diffusers, accelerate, websockets,
sounddevice, NumPy, torchaudio, soundfile, onnxruntime, cuda-python,
the python-build-standalone interpreter, and the vendored
microsoft/VibeVoice modules.
