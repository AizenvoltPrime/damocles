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

The team module's specialist agent profiles (`agent-profiles/`) are based on agent personality definitions from the Agency Agents project. The native subagent prompts (`src/extension/pi-session/subagents/default-agents.ts`) also distill three of its engineering templates — Explore from codebase-onboarding-engineer, Plan from software-architect, and general-purpose from minimal-change-engineer.

- **Source**: https://github.com/msitarzewski/agency-agents
- **Ported patterns**: Agent identity profiles, domain expertise definitions, core mission descriptions, critical rules and guardrails; distilled exploration/planning/minimal-change guidance for the native subagents

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

## pi (agent runtime)

Damocles runs on the **pi** agent runtime and redistributes it: the `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` packages ship in the VSIX as real `node_modules` (kept external and loaded via dynamic `import()`, not bundled into `dist/extension.js`). They are the agent engine behind every session — provider auth, the streaming agent loop, tool dispatch, and the extension/MCP plumbing Damocles builds on. Listed here for attribution and MIT compliance because the published packages declare `"license": "MIT"` but do not carry their own `LICENSE` file.

- **Source**: https://github.com/earendil-works/pi
- **Packages**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`
- **Use**: the sole agent backend (`PiSession` / `PiRuntime` in `src/extension/pi-session/`), redistributed in the VSIX node_modules

```
MIT License

Copyright (c) 2025 Mario Zechner

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

## pi-web-access

The native web tools (`src/extension/pi-session/web-access/`) port the key-free core of the pi-web-access extension — the free Exa MCP client (`web_search_exa` / `get_code_context_exa` over `https://mcp.exa.ai/mcp`, with SSE-or-JSON response parsing and the code-context → web-search fallback), the HTTP fetch + extraction pipeline (Readability over linkedom + Turndown, the dependency-free Next.js RSC flight-payload parser, the inline PDF text extractor via unpdf, and the `r.jina.ai` reader fallback). The source repo's keyed Exa Answer/Search API path, `~/.pi` usage tracking and config, activity monitor, Gemini/Perplexity providers, browser-cookie scraping, YouTube/video analysis, GitHub repo cloning, the curator browser UI, result storage + retrieval tool, and the slash commands/CLI were all dropped; the PDF extractor's `~/Downloads` write was removed (text is returned inline), and the tools were rewrapped as native per-session `pi.defineTool`s behind Damocles' central permission gate.

- **Source**: https://github.com/nicobailon/pi-web-access (`pi-web-access` v0.10.7)
- **Ported patterns**: free Exa MCP JSON-RPC `tools/call` client with SSE/JSON dual parsing, `Title:/URL:/Text:` result parsing + answer/source assembly, code-context tool with sticky web-search fallback, browser-like HTTP fetch with size caps + recoverable/non-recoverable error tiers, Readability(linkedom)+Turndown HTML→markdown, Next.js RSC `self.__next_f` flight-payload extractor, unpdf page-text extraction, Jina Reader (`r.jina.ai`) markdown fallback

```
MIT License

Copyright (c) 2025 Nico Bailon

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

## Bundled web-extraction libraries (WebFetch)

`WebFetch`'s extraction pipeline (`src/extension/pi-session/web-access/extract.ts`) depends on four npm
packages that esbuild bundles directly into `dist/extension.js` (they are not externals), so their code
physically ships in the VSIX. Listed here for attribution and marketplace compliance.

- **@mozilla/readability** (v0.6.0) — Apache-2.0 — https://github.com/mozilla/readability
  — HTML article extraction (`new Readability(...).parse()`).
- **pdf.js** (vendored, serverless build) — Apache-2.0 — https://github.com/mozilla/pdf.js
  — shipped inside `unpdf`'s bundle; powers the inline PDF text extraction.
- **unpdf** (v1.6.2) — MIT, Copyright (c) Pooya Parsa — https://github.com/unjs/unpdf
  — the `getDocumentProxy` wrapper around the vendored pdf.js build.
- **linkedom** (v0.18.12) — ISC, Copyright (c) Andrea Giammarchi — https://github.com/WebReflection/linkedom
  — server-side DOM that Readability parses.
- **turndown** (v7.2.4) — MIT, Copyright (c) Dom Christie — https://github.com/mixmark-io/turndown
  — HTML → markdown conversion of the extracted article.

The Apache-2.0 components (`@mozilla/readability` and the vendored pdf.js) are distributed under the
following license:

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or Derivative
          Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
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

---

## Agent Reach

The web tools' capability set for `FeedRead` and `YouTubeTranscript` (`src/extension/pi-session/web-access/feed.ts`, `src/extension/pi-session/web-access/youtube.ts`) was informed by Agent Reach's channel design — which capabilities are worth giving an agent (RSS/Atom feed reading, YouTube transcript retrieval) and which to leave out (social/auth platforms, the Whisper audio pipeline). No Agent Reach code was incorporated: it is a Python CLI/installer that routes an agent to external CLIs/MCP servers/public APIs, so it is not importable into this TypeScript extension. Only the *capability patterns* — what to build and, deliberately, what not to — were ported; the implementations here are original, dependency-free, and SSRF-guarded.

- **Source**: https://github.com/Panniantong/Agent-Reach
- **Referenced patterns** (design/scope only, not code): treating RSS/Atom feed reading and YouTube transcript retrieval as first-class agent web capabilities; the dependency-light, key-free posture; and the explicit scope exclusion of social/auth platforms and the audio-transcription (Whisper/`yt-dlp`/`ffmpeg`) pipeline

```
MIT License

Copyright (c) 2025 Agent Eyes

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
