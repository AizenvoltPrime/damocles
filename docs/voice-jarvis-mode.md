# Jarvis Mode — local on-device voice

Hands-free voice input via a "Hey Jarvis" wake word, automatic transcription on end-of-turn, and spoken assistant replies. Runs fully on-device. No audio and no transcripts ever leave the machine.

## Quick start

1. Open Damocles settings (Command Palette → "Damocles: Open Settings").
2. Under "Voice", set **Mode** to **Wake-word (local)**.
3. Accept the first-run privacy modal.
4. Wait for the runtime + models to download (~11 GB CUDA / ~6 GB CPU on first activation; models account for ~4.5 GB).
5. When the status bar shows `🎙️ Listening`, say *"Hey Jarvis, ..."*.

## Engines (all permissively licensed)

| Component | Model | License | VRAM |
|---|---|---|---|
| Wake word | OpenWakeWord `hey_jarvis_v0.1.tflite` | Apache-2.0 | 0 (CPU) |
| VAD | Silero VAD (ONNX) | MIT | 0 (CPU) |
| ASR | NVIDIA Parakeet TDT 0.6B v2 (English) | CC-BY-4.0 | ~1.7 GB |
| TTS | Microsoft VibeVoice-Realtime 0.5B | MIT | ~1.5 GB |

Steady-state with TTS enabled: ~3.7 GB GPU, well within a 6 GB RTX 4050. With TTS disabled: ~2.2 GB.

## Privacy posture

- Mic is always-hot in wake-word mode — disclosed up-front in the first-run modal.
- The wake phrase ("Hey Jarvis") is dropped before transcription and never appears in the submitted prompt.
- Two enforcement mechanisms: (a) ASR receives audio starting 250 ms after wake detection, and (b) a regex strip pass removes any leading `(hey )?jarvis` from the final transcript.
- No off-machine telemetry of audio content, transcripts, or wake events.
- Voice-driven prompts persist to the same session JSONL as typed prompts.
- Sidecar diagnostic logs scrub transcript text by default; only structural events ("wake_detected", "transcript_final emitted N chars") are written unless `damocles.voice.diagnostics === true`.
- Auto-disable on system sleep / lock / panel close. NOT on window blur.

## Settings

| Key | Default | Description |
|---|---|---|
| `damocles.voice.mode` | `off` | `push-to-talk` for cloud STT, `wake-word` activates Jarvis. |
| `damocles.voice.wakeWord` | `hey_jarvis` | ID of bundled wake-word model, or path to a custom `.onnx`. |
| `damocles.voice.wakeWordSensitivity` | `0.5` | 0.1–0.95. Lower = triggers more easily. |
| `damocles.voice.tts.enabled` | `false` | Speak the assistant's final reply. |
| `damocles.voice.localGpu` | `auto` | `auto` / `cuda` / `cpu`. |
| `damocles.voice.endOfTurnSilenceMs` | `800` | Silence ms ending an utterance. |
| `damocles.voice.maxUtteranceMs` | `30000` | Hard cap on a single utterance. |
| `damocles.voice.autoSubmit` | `true` | Auto-send on `transcript_final`. |
| `damocles.voice.diagnostics` | `false` | Verbose sidecar logs. |
| `damocles.voice.runtimePath` | `""` | Advanced: existing CUDA-PyTorch venv to skip the bundled runtime. |
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
                                  ├─ health (ping/pong 2s)        ├─ wake (OpenWakeWord)
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
- Single source of truth for the contract: `python/.../protocol.py` (Python) and `src/extension/voice/sidecar/protocol.ts` (TypeScript Zod).

### Lifecycle

- Sidecar runs only when `mode === wake-word` AND a Damocles chat panel is open.
- Singleton-per-machine via mkdir lock at `~/.damocles/voice/sidecar.lock`. Multiple VS Code windows attach to the same sidecar; the sidecar self-terminates 30 s after the last client disconnects.
- Health check: ping every 2 s; 3 missed pongs → restart.
- Restart strategy: parses stderr for fatal signatures (`CUDA error`, `ImportError`, etc.); on those, surfaces the actual error and stops. Otherwise restarts up to 2 times in 60 s.
- Cold-start: ~5–10 s warm, ~15–30 s on first launch (cuDNN handle creation + weight load). Mic is gated until `ready` arrives.

### Wake-phrase exclusion (FR-11)

Two defenses, both required:

1. **Audio offset:** ASR receives audio starting at `T_wake + 250 ms`. The 250 ms is calibrated against `hey_jarvis_v0.1.tflite`'s detection latency.
2. **Regex strip:** after transcript_final is computed, leading `^(hey\s+)?jarvis[,.\s]*` is removed (case-insensitive).

A pytest fixture asserts the joint invariant in `python/damocles_voice_sidecar/tests/test_wake_exclusion.py`.

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

## Custom wake words

The bundled `hey_jarvis` model is good for the default phrase. To train a custom phrase:

1. Use the [OpenWakeWord training notebook](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb).
2. Export an `.onnx` model. (`.tflite` is not supported on Windows because `tflite-runtime` has no Windows wheel; we standardize on `.onnx` for cross-platform parity.)
3. In Damocles settings, set `damocles.voice.wakeWord` to the absolute path of your file.
4. Restart wake-word mode.

The settings panel's "Custom" wake-word picker copies the file into `~/.damocles/voice/runtime/share/wake/`. The sidecar verifies the file exists, is non-empty, and has a `.onnx` extension before handing it to openwakeword's loader (which catches malformed binaries).

## Performance budget

| Stage | Target | Measured (RTX 4050) |
|---|---|---|
| Wake-word mic-to-event | ≤ 500 ms | ~250 ms |
| Post-VAD transcript appears in input | ≤ 600 ms | ~300 ms (10 s utterance, RTFx 3386) |
| Total end-of-turn (default 800 ms silence threshold) | ≤ 1.5 s | ~1.1 s |
| TTS first audible byte | ≤ 800 ms | ~300 ms |

CPU mode runs ~3–5× slower; documented as the explicit fallback when CUDA is unavailable.
