# Third-Party Notices

This file contains notices for third-party software whose code or design patterns were incorporated into this project.

---

## Recursive Language Models (RLM)

The recall module (`src/extension/recall/`) is based on the RLM framework.

- **Source**: https://github.com/alexzhang13/rlm
- **Paper**: arXiv 2512.24601v2 — "Recursive Language Models"
- **Ported patterns**: REPL iteration loop, FINAL/FINAL_VAR protocol, code block extraction, system prompt structure, sub-call architecture

```
MIT License

Copyright (c) 2025 Alex Zhang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Agency Agents (AgentLand)

The team module's specialist agent profiles (`agent-profiles/`) are based on agent personality definitions from the Agency Agents project.

- **Source**: https://github.com/msitarzewski/agency-agents
- **Ported patterns**: Agent identity profiles, domain expertise definitions, core mission descriptions, critical rules and guardrails

```
MIT License

Copyright (c) 2025 AgentLand Contributors (msitarzewski)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Caveman

The custom system prompt (`src/extension/claude-session/system-prompt.ts`) integrates caveman-lite output rules — terse communication style adapted from the Caveman Claude Code skill.

- **Source**: https://github.com/JuliusBrussee/caveman
- **Ported patterns**: Lite-level filler/hedging/pleasantry elimination rules, action-first response pattern, auto-clarity exception for safety-critical text, code/commit boundary rules

```
MIT License

Copyright (c) 2026 Julius Brussee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Code Review Graph

The compass module (`src/extension/compass/`) v2 rewrite (v1.7.0) is a TypeScript port of the code-review-graph Python project's architecture — SQLite schema, AST extraction pipeline, impact analysis via BFS, execution flow tracing, community detection, FTS5 search, and incremental update strategy.

- **Source**: https://github.com/tirth8205/code-review-graph
- **Ported patterns**: SQLite graph schema (nodes/edges/flows/communities tables), FTS5 content-sync triggers, recursive impact traversal, git-based incremental updates, risk scoring factors, flow criticality formula, Louvain community detection pipeline, Vue SFC script block extraction, tsconfig path alias resolution

```
MIT License

Copyright (c) 2026 Tirth Kanani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Voice sidecar — model and runtime attribution

The voice sidecar (`python/damocles_voice_sidecar/`) downloads and loads several
third-party models at runtime, and ships against several third-party Python
packages installed into the sidecar venv. This section lists every model and
runtime component whose license requires attribution or whose origin we want
recorded for supply-chain provenance.

### Parakeet TDT 0.6B v2 (NVIDIA) — CC-BY-4.0

The English ASR model used by the wake-word path is NVIDIA's
`parakeet-tdt-0.6b-v2`. CC-BY-4.0 requires visible attribution.

- **Model**: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- **License**: Creative Commons Attribution 4.0 International (CC-BY-4.0)
  — https://creativecommons.org/licenses/by/4.0/
- **Use**: downloaded by the voice runtime installer to
  `<modelsDir>/parakeet_tdt_0_6b_v2/v2.0.0/parakeet-tdt-0.6b-v2.nemo` and
  loaded by `engines/asr_parakeet.py` via NeMo's
  `EncDecRNNTBPEModel.restore_from`. No modifications are made; the model
  is used as published.
- **Attribution**: "Parakeet TDT 0.6B v2 by NVIDIA, licensed under
  CC-BY-4.0."

### NeMo Toolkit (NVIDIA) — Apache-2.0

`nemo_toolkit[asr]` is the inference framework loading Parakeet.

- **Source**: https://github.com/NVIDIA/NeMo
- **License**: Apache License 2.0
- **Use**: `engines/asr_parakeet.py` imports `nemo.collections.asr`.

### OpenWakeWord — Apache-2.0

The wake-phrase detector. Model `hey_jarvis_v0.1.onnx` is bundled in
`resources/voice/wake/`.

- **Source**: https://github.com/dscripka/openWakeWord
- **License**: Apache License 2.0
- **Bundled model**:
  https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx
- **Use**: `engines/wake_openwakeword.py`.

### Silero VAD — MIT

Voice-activity detection inserted between the wake detector and ASR.

- **Source**: https://github.com/snakers4/silero-vad
- **License**: MIT
- **Use**: `engines/vad_silero.py` loads the bundled `silero_vad.onnx`
  via `onnxruntime`.

### PyTorch — BSD-3-Clause

The tensor + inference backend for VibeVoice and Parakeet.

- **Source**: https://github.com/pytorch/pytorch
- **License**: BSD 3-Clause
- **Use**: installed into the sidecar venv via the indygreg
  python-build-standalone runtime, with CUDA wheels matched to the host
  driver.

### Hugging Face Transformers — Apache-2.0

VibeVoice's `from_pretrained` plumbing.

- **Source**: https://github.com/huggingface/transformers
- **License**: Apache License 2.0
- **Use**: vendored VibeVoice modules subclass `PreTrainedModel`.

### diffusers + accelerate (Hugging Face) — Apache-2.0

The DPM-Solver scheduler used by VibeVoice's diffusion head.

- **Sources**: https://github.com/huggingface/diffusers,
  https://github.com/huggingface/accelerate
- **License**: Apache License 2.0

### websockets (Aymeric Augustin) — BSD-3-Clause

The Python WebSocket server.

- **Source**: https://github.com/python-websockets/websockets
- **License**: BSD 3-Clause
- **Use**: `server.py`.

### sounddevice (Matthias Geier) — MIT

Native microphone capture in the sidecar.

- **Source**: https://github.com/spatialaudio/python-sounddevice
- **License**: MIT
- **Use**: `mic_input.py`.

### NumPy — BSD-3-Clause

Tensor / array math throughout the sidecar (frame buffering, PCM
conversions, ASR input prep).

- **Source**: https://github.com/numpy/numpy
- **License**: BSD 3-Clause
- **Use**: `pipeline.py`, every `engines/*.py` module, mic frame
  reshaping in `mic_input.py`.

### torchaudio — BSD-2-Clause

Required by VibeVoice's vendored streaming-inference path for
resampling and tensor I/O.

- **Source**: https://github.com/pytorch/audio
- **License**: BSD 2-Clause
- **Use**: pulled in alongside torch by the runtime installer; imported
  transitively from `engines/tts_vibevoice.py`.

### soundfile (PySoundFile) — BSD-3-Clause

Backend for `sounddevice`'s file-IO helpers and used directly by
`engines/audio_utils.py` (vendored VibeVoice's `AudioNormalizer`) for
PCM resampling routines.

- **Source**: https://github.com/bastibe/python-soundfile
- **License**: BSD 3-Clause
- **Use**: pulled into the sidecar venv as a `sounddevice`/VibeVoice
  transitive dep.

### onnxruntime (Microsoft) — MIT

Inference runtime for the ONNX wake-word and VAD models.

- **Source**: https://github.com/microsoft/onnxruntime
- **License**: MIT
- **Use**: loaded by `engines/wake_openwakeword.py` (OpenWakeWord
  detector) and `engines/vad_silero.py` (Silero VAD).

### cuda-python (NVIDIA) — Apache-2.0

Required by NeMo's conditional compute graphs on CUDA. Installed only
when the runtime detects a CUDA-capable GPU and selects the cu121
torch channel; absent on CPU-only installs.

- **Source**: https://github.com/NVIDIA/cuda-python
- **License**: Apache License 2.0
- **Use**: imported transitively by `nemo.collections.asr` for
  conditional graphs on Parakeet's TDT decoder.

### node-tar (npm) — ISC

Streaming tarball extractor used by the runtime installer to unpack
the python-build-standalone interpreter bundle.

- **Source**: https://github.com/isaacs/node-tar
- **License**: ISC
- **Use**: `src/extension/voice/runtime/python-installer.ts`.

### ws (websockets/ws) — MIT

Node WebSocket client connecting the extension host to the Python
sidecar's local server.

- **Source**: https://github.com/websockets/ws
- **License**: MIT
- **Use**: `src/extension/voice/sidecar/manager.ts`.

### python-build-standalone (indygreg) — Python Software Foundation License

The hermetic Python interpreter the runtime installer downloads to
`~/.damocles/voice/runtime/python/`.

- **Source**: https://github.com/indygreg/python-build-standalone
- **License**: Python Software Foundation License
- **SHA-256 verified**: `src/extension/voice/runtime/tarball-checksums.json`
  records the expected digest of every supported tarball; the installer
  refuses to extract a non-matching archive.

---

## VibeVoice

The voice sidecar's TTS engine vendors a subset of microsoft/VibeVoice — the model architecture, processor, and DPM-Solver scheduler required to run `VibeVoice-Realtime-0.5B`. The upstream `streamingtts` install pulls heavy unused dependencies (gradio, fastapi, uvicorn, aiortc), so only the streaming-inference closure is copied.

- **Source**: https://github.com/microsoft/VibeVoice
- **Pinned commit**: `e73d1e17c3754f046352014856a922f8208fb5d3`
- **Vendored path**: `python/damocles_voice_sidecar/damocles_voice_sidecar/vendor/vibevoice/`
- **Vendored modules**: `modular/configuration_vibevoice.py`, `modular/configuration_vibevoice_streaming.py`, `modular/modeling_vibevoice_streaming.py`, `modular/modeling_vibevoice_streaming_inference.py`, `modular/modular_vibevoice_diffusion_head.py`, `modular/modular_vibevoice_text_tokenizer.py`, `modular/modular_vibevoice_tokenizer.py`, `modular/streamer.py`, `processor/audio_utils.py`, `processor/vibevoice_streaming_processor.py`, `processor/vibevoice_tokenizer_processor.py`, `schedule/dpm_solver.py`
- **Local modifications**:
  - Every absolute `from vibevoice.X …` import was rewritten to a relative form so the vendored package resolves without a top-level `vibevoice` install on `sys.path`. Specifically: two `from vibevoice.schedule.dpm_solver import DPMSolverMultistepScheduler` (in `modular/modeling_vibevoice_streaming.py` and `modular/modeling_vibevoice_streaming_inference.py`) → `from ..schedule.dpm_solver import …`, and one in-function `from vibevoice.modular.modular_vibevoice_text_tokenizer import …` (inside `processor/vibevoice_streaming_processor.py:VibeVoiceStreamingProcessor.from_pretrained`) → `from ..modular.modular_vibevoice_text_tokenizer import …`
  - `processor/audio_utils.py` was reduced to just the `AudioNormalizer` class. The upstream file's ffmpeg-based decoders (`load_audio_use_ffmpeg`, `load_audio_bytes_use_ffmpeg`, `_run_ffmpeg`, `_FFMPEG_SEM`, `COMMON_AUDIO_EXTS`) were removed because the streaming-inference path receives PCM directly from the sidecar — those helpers were unreachable in our build, and shelling out to ffmpeg with raw filenames is an attractive nuisance for a future caller.
```
MIT License

Copyright (c) 2025 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ChatGPT Codex Proxy

The OpenAI Bridge module (`src/extension/openai-bridge/`) — the Anthropic↔Codex/OpenAI translator that lets the Claude Agent SDK run against GPT models — is based on the ChatGPT Codex Proxy, a proxy that serves Claude Code requests from a ChatGPT subscription's Codex backend.

- **Source**: https://github.com/insightflo/chatgpt-codex-proxy
- **Ported patterns**: Anthropic Messages API ↔ Codex Responses API request/response transformation, Codex OAuth 2.0 (PKCE) subscription auth path, Claude → Codex model-ID mapping with env overrides, event-by-event SSE stream translation, parallel-tool-call safety for mutating tools

```
MIT License

Copyright (c) 2026 insightflo (kwak)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Claude Code Router

The explore module's proxy server architecture (`src/extension/explore/proxy-server.ts`) is inspired by Claude Code Router — a tool that routes Claude Code requests to different LLM providers via a local reverse proxy with model rewriting and auth header substitution.

- **Source**: https://github.com/musistudio/claude-code-router
- **Ported patterns**: Local HTTP reverse proxy intercepting SDK requests, model ID rewriting in request body, auth header substitution for upstream provider, streaming response passthrough, abort signal propagation from client to upstream

```
MIT License

Copyright (c) 2025 musistudio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## pi-subagents

The native subagent engine (`src/extension/pi-session/subagents/`) is a port of the pi-subagents extension's core engine — the agent registry, markdown-agent frontmatter parser, embedded default agents, concurrency-limited agent manager, session runner, prompt builder, skill preloader, enabled-models scope resolver, JSONL transcript writer, and filesystem-safety helpers. The source repo's TUI, CLI, scheduler, worktree isolation, context-inheritance, agent-memory, and cross-extension RPC were dropped; the pi-runtime boundary was rewired onto Damocles' own runtime, permission gate, and webview.

- **Source**: https://github.com/tintinweb/pi-subagents (`@tintinweb/pi-subagents` v0.10.3)
- **Ported patterns**: unified default+markdown agent registry, `tools:`/`extensions:`/`skills:` frontmatter parsing, embedded `general-purpose`/`Explore`/`Plan` agents, background concurrency queue with FIFO drain, per-agent session lifecycle + steering + graceful turn-limit enforcement, `replace`/`append` system-prompt builder, skill preloading, `enabledModels` scope resolution, JSONL output transcripts, symlink/path-traversal filesystem guards

```
MIT License

Copyright (c) 2026 tintinweb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## pi-mcp-adapter

The native MCP client (`src/extension/pi-session/mcp/`) is lifted from the pi-mcp-adapter — its transports, lifecycle/health/reconnect, tool registrar (content transform), metadata cache, npx/npm-exec binary resolver, OAuth client provider + auth flow + localhost callback server, resource-as-tool naming, and elicitation handler. The source repo's TUI, MCP-UI (`ui://` iframes / AppBridge / host HTTP server), single proxy `mcp` tool + proxy regex search, sampling handler, consent manager, slash commands, CLI, and onboarding state were dropped; the pi-runtime boundary was rewired onto Damocles' shared extension, central permission gate, `ExtensionUIContext`, and webview, and the `{server}_{tool}` tool-naming scheme was replaced with the `mcp__{server}__{tool}` scheme.

- **Source**: pi-mcp-adapter (`pi-mcp-adapter`)
- **Ported patterns**: stdio / streamable-HTTP / SSE transport selection with probe-then-fallback, connect dedup + 60s failure backoff + 30s health checks + idle shutdown + keep-alive reconnect, paginated `tools/list`/`resources/list` collection, on-disk metadata cache keyed by config hash with atomic temp+rename writes, `${VAR}`/`$env:VAR` interpolation, npx/npm-exec real-binary resolution, OAuth 2.1 (authorization_code PKCE + client_credentials) client provider + localhost callback, MCP content → text/image block transformation, resource-name → `get_*` tool slugging, form elicitation request handling

```
MIT License

Copyright (c) 2026 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Supermemory

The memory module (`src/extension/memory/`) revamp is a conceptual, local-first reimplementation inspired by supermemory's published memory model. No supermemory code was incorporated — its core engine is closed-source and was not used; the graph storage mechanics are ported separately from code-review-graph (see Compass), and this implementation uses no embeddings or vector store.

- **Source**: https://github.com/supermemoryai/supermemory
- **Inspired concepts** (ideas / data-model only, not code): fact-over-fact graph with `updates`/`extends`/`derives` relation semantics and version chains, temporal forgetting (`forget_after`/`forgotten`/`forget_reason`), content-hash deduplication with repetition strengthening, and the static/dynamic user-profile split.

```
MIT License

Copyright (c) 2025 supermemory

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
