# Jarvis Mode — local on-device voice

Hands-free voice input via a wake phrase ("Hey Jarvis" by default), automatic transcription on end-of-turn, and spoken assistant replies. Runs fully on-device. No audio and no transcripts ever leave the machine.

## Quick start

1. Open Damocles settings (Command Palette → "Damocles: Open Settings").
2. Under "Voice", set **Mode** to **Wake-word (local)**.
3. Accept the first-run privacy modal.
4. Wait for the runtime + models to download (~11 GB CUDA / ~6 GB CPU on first activation; models account for ~4.5 GB).
5. When the status bar shows `🎙️ Listening`, say *"Hey Jarvis, ..."* (or your own phrase; see [Changing the wake phrase](#changing-the-wake-phrase)).

## Engines (all permissively licensed)

| Component | Model | License | VRAM |
|---|---|---|---|
| Wake phrase | sherpa-onnx keyword spotting, `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (int8 ONNX) | Apache-2.0 (code and weights) | 0 (CPU) |
| VAD | Silero VAD (ONNX) | MIT | 0 (CPU) |
| ASR | NVIDIA Parakeet TDT 0.6B v2 (English) | CC-BY-4.0 | ~1.7 GB |
| TTS | Microsoft VibeVoice-Realtime 0.5B | MIT | ~1.5 GB |

Steady-state with TTS enabled: ~3.7 GB GPU, well within a 6 GB RTX 4050. With TTS disabled: ~2.2 GB.

## Privacy posture

- Mic is always-hot in wake-word mode — disclosed up-front in the first-run modal.
- The wake phrase is dropped before transcription and never appears in the submitted prompt.
- Two enforcement mechanisms: (a) ASR receives audio starting a fixed offset after wake detection, and (b) a regex strip pass removes the leading phrase, or its last word alone, from the final transcript.
- No off-machine telemetry of audio content, transcripts, or wake events.
- Voice-driven prompts persist to the same session JSONL as typed prompts.
- Sidecar diagnostic logs scrub transcript text by default; only structural events ("wake_detected", "transcript_final emitted N chars") are written unless `damocles.voice.diagnostics === true`.
- Auto-disable on system sleep / lock / panel close. NOT on window blur.

## Settings

| Key | Default | Description |
|---|---|---|
| `damocles.voice.mode` | `off` | `push-to-talk` for cloud STT on any platform, `wake-word` activates Jarvis on Windows x64, Linux x64 and macOS arm64 only (see [Python and platforms](#python-and-platforms)). |
| `damocles.voice.wakeWord` | `hey jarvis` | Wake phrase: 1 to 4 English words of letters only. Case does not matter and underscores read as spaces. User settings only (machine scope). |
| `damocles.voice.wakeWordSensitivity` | `0.5` | 0.1–0.95. Lower = triggers more easily. |
| `damocles.voice.tts.enabled` | `false` | Speak the assistant's final reply. |
| `damocles.voice.localGpu` | `auto` | `auto` / `cuda` / `cpu`. |
| `damocles.voice.endOfTurnSilenceMs` | `800` | Silence ms ending an utterance. |
| `damocles.voice.maxUtteranceMs` | `30000` | Hard cap on a single utterance. |
| `damocles.voice.autoSubmit` | `true` | Auto-send on `transcript_final`. |
| `damocles.voice.diagnostics` | `false` | Verbose sidecar logs. |
| `damocles.voice.runtimePath` | `""` | Advanced: the Python of an existing venv that already holds the pinned voice stack, used instead of the downloaded runtime. Damocles only smoke-checks it. Windows x64, Linux x64 and macOS arm64 only. |
| `damocles.voice.pinModelVersion` | `{}` | Advanced: per-model version pin. |

## Architecture

```
Webview (Vue)             Extension Host (Node)               Sidecar (Python)
─────────────             ─────────────────────               ────────────────
useJarvisLifecycle ──ws──> voice-stream-handlers ──ws/json──> server.py
  (enable/disable,         (relays control msgs;                  │
   TTS playback)            no audio bytes)                       ├─ mic_input (sounddevice)
                                                                  │   captures audio
                          VoiceService                            │   natively, never
                            ├─ VoiceRuntimeInstaller              │   over the wire
                            └─ VoiceSidecarManager                ▼
                                  ├─ spawn (token via env)    pipeline.feed(frame)
                                  ├─ health (ping/pong 2s)        ├─ wake (sherpa-onnx KWS)
                                  ├─ lockfile (singleton/machine) ├─ vad  (Silero)
                                  └─ output-channel               ├─ asr  (Parakeet TDT)
                                                                  └─ tts  (VibeVoice)
```

### IPC

- Transport: WebSocket on `ws://127.0.0.1:<random-port>`, subprotocol `damocles-voice.v1`.
- Auth: `Authorization: Bearer <256-bit-token>`. Token delivered via `DAMOCLES_VOICE_TOKEN` env var (never argv — argv is world-readable on Linux/macOS).
- Bind: `127.0.0.1` only — sidecar refuses non-loopback connections at the socket layer.
- Inbound (control-only): `init`, `tts_request`, `cancel_tts`, `set_muted`, `set_voice`, `shutdown`, `ping`. Audio is captured natively in the sidecar via sounddevice — no audio bytes cross the WebSocket.
- Outbound: `ready`, `wake_detected`, `wake_aborted`, `vad_speech_started`, `vad_speech_ended`, `transcript_final`, `tts_audio_chunk` (binary float32 24 kHz follows JSON envelope), `tts_done`, `voice_changed`, `error`, `pong`.
- Single source of truth for the contract: `python/.../protocol.py` (Python) and `src/core/voice/sidecar/protocol.ts` (TypeScript Zod).

### Lifecycle

- Sidecar runs only when `mode === wake-word` AND a Damocles chat panel is open.
- Singleton-per-machine via mkdir lock at `~/.damocles/voice/sidecar.lock`. Multiple VS Code windows attach to the same sidecar; the sidecar self-terminates 30 s after the last client disconnects.
- Health check: ping every 2 s; 3 missed pongs → restart.
- Restart strategy: parses stderr for fatal signatures (`CUDA error`, `ImportError`, etc.); on those, surfaces the actual error and stops. Otherwise restarts up to 2 times in 60 s.
- Cold-start: ~5–10 s warm, ~15–30 s on first launch (cuDNN handle creation + weight load). Mic is gated until `ready` arrives.

### Wake-phrase exclusion (FR-11)

Two defenses, both required:

1. **Audio offset:** ASR receives audio starting a fixed offset after `T_wake`, calibrated against the keyword spotter's detection latency.
2. **Regex strip:** the sidecar and the extension host each remove the leading phrase from `transcript_final` once, then trim whitespace from both ends. For the normalized phrase's words `w1 … wn`, the strip matches optional whitespace, then optionally `w1 … w(n-1)` each followed by whitespace, then `wn`, then any run of `,`, `.` and whitespace. So `Hey Jarvis, open the file` and `jarvis. run the tests` lose the phrase, and `house robot lights on` keeps it for `ok house robot`.
   - **Letters:** each wake-word letter matches only its ASCII upper or lower case. `ſ` (U+017F), the Kelvin sign `K` (U+212A), `İ` and `ı` never stand in for `s`, `k` or `i`.
   - **Word end:** the last word must not be followed by a word character: a Unicode letter, a Unicode number or `_`. So `jarvisx`, `jarvisé`, `jarvis2` and `jarvis_x` are left unchanged. An apostrophe is not a word character, so `Jarvis's calendar` loses `Jarvis` and keeps `'s calendar`.
   - **Whitespace:** exactly Unicode White_Space: U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F and U+3000. U+FEFF and U+001C–U+001F are not whitespace, so `hey` followed by either and `jarvis` is left unchanged.
   - **Punctuation:** only the ASCII comma and period are dropped after the phrase. A fullwidth comma (U+FF0C) stays in the transcript.

JavaScript and Python read `\s`, `\b`, `\w` and case-insensitive letters differently, and the extension host's Node ships a newer Unicode database than the sidecar's CPython. Both patterns therefore use only explicit character classes, and neither uses a case-insensitive flag. The word characters are a table of Unicode 14.0.0 letters, numbers and `_`, which is CPython 3.11's `\w`. `python/damocles_voice_sidecar/scripts/gen_word_chars.py` writes the table to `src/shared/generated/word-chars.ts` and `damocles_voice_sidecar/word_chars.py`.

Both sides normalize the setting the same way (underscores to spaces, trim, collapse whitespace, lowercase). `src/shared/wake-phrase.ts` and the sidecar are tested against `python/damocles_voice_sidecar/tests/fixtures/wake_prefix_cases.json`, plus a generated corpus of about 3,000 transcripts with the sidecar's output for each, `wake_prefix_corpus.json`. To rewrite the corpus, run `uv run python -m tests.wake_prefix_corpus` from `python/damocles_voice_sidecar`; pytest fails while it is stale. A pytest fixture asserts the joint invariant in `python/damocles_voice_sidecar/tests/test_wake_exclusion.py`.

## Troubleshooting

### "Voice runtime smoke check failed: ImportError: ..."

The bundled venv is corrupt or missing dependencies. Fix:

```bash
rm -rf ~/.damocles/voice/runtime
```

Then re-enable wake-word mode to trigger a fresh install.

### "Need ~16 GB free, have 4 GB"

Set `damocles.voice.runtimePath` to a path on a different filesystem with more free space, or free disk via the settings panel's "Free disk space (delete unused versions)" button. The disk pre-check applies a ×1.5 safety margin over the raw install size.

### "Your CUDA driver appears incompatible with the installed PyTorch wheel"

Either upgrade your NVIDIA driver to ≥ 535 (for the `cu121` wheel) or set `damocles.voice.localGpu` to `cpu` and reinstall — installer will pick the CPU wheel.

### Mic not detected on macOS

Open *System Settings → Privacy & Security → Microphone* and grant access to VS Code. The OS prompt will appear once on first activation.

### "VS Code Speech extension is active and may compete for the microphone"

Disable the `ms-vscode.vscode-speech` extension — both extensions trying to open the OS mic at once causes ALSA/CoreAudio contention, especially on Linux.

### OOM during inference (`cuda-oom`)

The sidecar's OOM ladder runs automatically:

1. Unload TTS (frees ~1.5 GB) and disable `tts.enabled` for the session.
2. If OOM persists during ASR: restart in CPU mode and warn.

You'll see a yellow chip in the webview header when the fallback engages. Restore by disabling other GPU workloads (games, Photoshop) and restarting Damocles.

## Uninstall

VS Code's "Uninstall Extension" does **not** remove the multi-GB `~/.damocles/voice/` directory. Two options:

1. **From Damocles:** Voice settings panel → "Remove all voice files (X.X GB)".
2. **Manual:**
   ```bash
   rm -rf ~/.damocles/voice
   ```

## Changing the wake phrase

The keyword spotter listens for any typed English phrase, so a new phrase needs no training and no model file.

1. Open Damocles settings, go to **Voice**, and with **Mode** set to **Wake word**, type the phrase into **Wake phrase**.
2. Press Enter or leave the field to save it. The field refuses a phrase that breaks the rules below and saves nothing.
3. Damocles restarts the voice sidecar, which then listens for the new phrase.

You can also set `damocles.voice.wakeWord` in your user settings (`settings.json`, or `~/.damocles/settings.json` in the desktop app). The setting is machine-scoped, so a workspace or project settings file cannot change it.

The rules:

- 1 to 4 English words made of the letters a to z, separated by spaces, such as `hey jarvis`, `computer` or `ok house robot`.
- Case does not matter and underscores read as spaces, so `Hey_Jarvis` is the same as `hey jarvis`.
- Digits, hyphens, punctuation, other alphabets and file paths are not valid. A custom `.onnx` wake-word model is not supported.

If the stored setting breaks these rules, wake-word mode does not start. The voice status shows an error naming `damocles.voice.wakeWord` and the stored value; fix it in settings and wake-word mode starts again. Push-to-talk and spoken replies do not use the phrase, so an invalid one does not stop them.

Distinct multi-syllable phrases work best; a short common word can trigger on ordinary speech.

## Wake-phrase accuracy

Measured for the default phrase, `hey jarvis`, with the bundled keyword-spotting model, offline on recorded audio rather than through a microphone.

**Method.**

- **Positives:** 688 clips. 172 synthetic "hey jarvis" utterances, from 9 Windows SAPI voices at 5 speaking rates and 127 Piper voice and speaker combinations (LibriTTS-R, VCTK, L2-ARCTIC and 11 single-speaker voices). Each utterance sits between a lead-in sentence and a command, and each is played four ways: clean, with pink noise at 20 dB and at 10 dB SNR, and with babble at 10 dB SNR. Recall is the share of clips where the phrase is detected.
- **Negatives:** LibriSpeech dev-clean and dev-other, 10.82 hours, each fed as one continuous stream. A false accept is any detection in that speech.
- **Threshold:** `damocles.voice.wakeWordSensitivity` maps to the spotter's threshold piecewise linearly: 0.1 → 0.10, 0.5 (the default) → 0.25, 0.95 → 0.50.

**Results.**

| Threshold | Recall | False accepts/h |
| --- | --- | --- |
| 0.10 | 87.5% | 0 |
| 0.20 | 87.1% | 0 |
| 0.25 (default) | 86.8% (91% clean, 83% at 10 dB) | 0 |
| 0.30 | 85.5% | 0 |
| 0.40 | 78.2% | 0 |
| 0.50 | 58.4% | 0 |
| 0.60 | 30.1% | 0 |

- No false accepts occurred at any threshold in 10.82 hours. Zero events bound the true rate at 0.28 per hour with 95% confidence (3 / 10.82 h, the rule of three); the test cannot show a lower rate.
- Most misses come from the non-native L2-ARCTIC voices: 37 of their 64 clips missed, against 10 of 180 SAPI clips and 12 of 240 LibriTTS-R clips.
- Detection fires 49–659 ms after the phrase ends: median 304 ms, p95 524 ms.
- The openWakeWord detector this replaced was not measured on this set, so there is no baseline to compare against.

**Pre-roll.**

Because detection fires after the phrase ends, the sidecar keeps the last 1000 ms of microphone audio while it listens (`PRE_ROLL_MS` in `pipeline.py`, covering the 659 ms worst case). On a detection the spotter's token timestamps give the phrase end, and the buffered audio after that point goes through the same VAD and speech-recognition path as live audio, so a command spoken right after the phrase is captured from its start. The buffer is never logged or stored. On 24 SAPI clips with a 0 to 300 ms gap between "hey jarvis" and the command, at most 32 ms of the command's start was lost (one clip), against up to 434 ms (median 191 ms) without the buffer. Up to about 100 ms of the phrase's last sound can come before the replay point; the transcript strip removes any wake word that survives.

## Python and platforms

The Jarvis runtime (wake phrase and spoken replies) is a local Python sidecar built on torch, NeMo ASR, onnxruntime and sherpa-onnx, and it supports exactly three platforms:

| Platform | Jarvis runtime | Why |
|---|---|---|
| Windows x64 | Supported | |
| Linux x64 | Supported | |
| macOS arm64 | Supported | |
| macOS x64 (Intel) | Refused | torch publishes no macOS x86_64 wheels after 2.2.2, and onnxruntime none after 1.23.2. |
| Windows arm64 | Refused | torch has win_arm64 wheels only from 2.7, for cp312, on pytorch.org's index; numpy needs 2.3 or later and onnxruntime 1.24 or later. Support waits for a deliberate upgrade of the voice stack. |
| Linux arm64 and anything else | Refused | Outside the supported set. |

On a supported platform the installer downloads CPython 3.11.10 from python-build-standalone, creates a venv and pip-installs the pinned `python/damocles_voice_sidecar/requirements.txt`. On every other platform Damocles refuses before any download, disk or GPU check, venv or pip run, and `damocles.voice.runtimePath` is refused too: Damocles only smoke-checks a user-supplied venv and never installs into it, and the sidecar targets the pinned `requirements.txt`, which cannot install there. The refusal names the platform, lists the supported ones and says push-to-talk still works: push-to-talk records through the OS and transcribes with the cloud provider (Whisper, Deepgram or Google), with no sidecar. It shows as the Jarvis error in the chat input and, in wake-word mode, on the VS Code status bar; the Voice settings show it under Mode and hide Re-download models and Test voice.

The supported pairs are declared once, in `VOICE_RUNTIME_PLATFORMS` (`src/core/voice/runtime/supported-platforms.ts`), next to each pair's python-build-standalone triple; every release in `tarball-checksums.json` must list exactly those triples, which a test enforces. The desktop app hides voice on macOS for a separate reason (an ad hoc signed app gets no microphone input), so on macOS arm64 Jarvis runs in the VS Code extension only.

## Performance budget

| Stage | Target | Measured (RTX 4050) |
|---|---|---|
| Wake-word phrase-end-to-event | ≤ 500 ms | 304 ms median, 524 ms p95 (CPU, offline; see [Wake-phrase accuracy](#wake-phrase-accuracy)) |
| Post-VAD transcript appears in input | ≤ 600 ms | ~300 ms (10 s utterance, RTFx 3386) |
| Total end-of-turn (default 800 ms silence threshold) | ≤ 1.5 s | ~1.1 s |
| TTS first audible byte | ≤ 800 ms | ~300 ms |

CPU mode runs ~3–5× slower; documented as the explicit fallback when CUDA is unavailable.
