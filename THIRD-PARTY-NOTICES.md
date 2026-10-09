# Third-Party Notices

This file contains notices for third-party software whose code or design patterns were incorporated into this project, and for third-party data bundled with it.

---

## Usage4Claude

The subscription usage feature (`src/core/pi-session/subscription-usage.ts`, `src/webview/components/SubscriptionUsageOverlay.vue`) is based on the endpoint and response-shape research from the Usage4Claude menu-bar app.

- **Source**: https://github.com/f-is-h/Usage4Claude
- **Ported patterns**: Claude `/api/oauth/usage` and Codex `/backend-api/wham/usage` endpoint URLs and required request headers (including the browser-like Cloudflare header set), usage/rate-limit and extra-usage/credits response shapes, and the string/int/double credits-balance normalization approach

```
MIT License

Copyright (c) 2025 f-is-h

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

The team module's specialist agent profiles (`agent-profiles/`) are based on agent personality definitions from the Agency Agents project. The native subagent prompts (`src/core/pi-session/subagents/default-agents.ts`) also distill three of its engineering templates — Explore from codebase-onboarding-engineer, Plan from software-architect, and general-purpose from minimal-change-engineer.

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

The custom system prompt (`src/core/pi-session/system-prompt.ts`) integrates caveman-lite output rules — terse communication style adapted from the Caveman Claude Code skill.

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

The compass module (`src/core/compass/`) v2 rewrite (v1.7.0) is a TypeScript port of the code-review-graph Python project's architecture — SQLite schema, AST extraction pipeline, impact analysis via BFS, execution flow tracing, community detection, FTS5 search, and incremental update strategy.

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
- **Use**: `src/core/voice/runtime/python-installer.ts`.

### ws (websockets/ws) — MIT

Node WebSocket client connecting the extension host to the Python
sidecar's local server.

- **Source**: https://github.com/websockets/ws
- **License**: MIT
- **Use**: `src/core/voice/sidecar/manager.ts`.

### python-build-standalone (indygreg) — Python Software Foundation License

The hermetic Python interpreter the runtime installer downloads to
`~/.damocles/voice/runtime/python/`.

- **Source**: https://github.com/indygreg/python-build-standalone
- **License**: Python Software Foundation License
- **SHA-256 verified**: `src/core/voice/runtime/tarball-checksums.json`
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

Damocles runs on the **pi** agent runtime and redistributes it: the `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui` and `@earendil-works/pi-mcp` packages ship in the VSIX and the desktop app as real `node_modules` (kept external and loaded via dynamic `import()`, not bundled into `dist/extension.js`). They are the agent engine behind every session — provider auth, the streaming agent loop, tool dispatch, the extension plumbing Damocles builds on, and (pi-mcp) the MCP client protocol, transports and OAuth. Listed here for attribution and MIT compliance because the published packages declare `"license": "MIT"` but do not carry their own `LICENSE` file.

- **Source**: https://github.com/earendil-works/pi
- **Packages**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@earendil-works/pi-mcp`
- **Use**: the sole agent backend (`PiSession` / `PiRuntime` in `src/core/pi-session/`) and the MCP client layer under Damocles' host layer (`src/core/pi-session/mcp/`), redistributed as node_modules

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

The native subagent engine (`src/core/pi-session/subagents/`) is a port of the pi-subagents extension's core engine — the agent registry, markdown-agent frontmatter parser, embedded default agents, concurrency-limited agent manager, session runner, prompt builder, skill preloader, enabled-models scope resolver, JSONL transcript writer, and filesystem-safety helpers. The source repo's TUI, CLI, scheduler, worktree isolation, context-inheritance, agent-memory, and cross-extension RPC were dropped; the pi-runtime boundary was rewired onto Damocles' own runtime, permission gate, and webview.

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

## Visual Studio Code (Code - OSS)

Parts of the desktop app adapt Visual Studio Code source, rewritten for Damocles: the Quick Open file scoring, the search view's case-preserving replace and query rules, the Search Editor's `.code-search` format and the grammar that colours its results, and the integrated terminal's shell detection, pty handling, flow control, link detection, paste warning, shell integration scripts, command marks and navigation.

- **Source**: https://github.com/microsoft/vscode
- **Adapted code**:
  - `src/core/quick-open/fuzzy-match.ts` from `src/vs/base/common/fuzzyScorer.ts` (`scoreFuzzy`, `prepareQuery`, `scoreItemFuzzy`, `compareItemsByFuzzyScore`)
  - `src/shared/text-search.ts` from `src/vs/base/common/search.ts` (`buildReplaceStringWithCasePreserved`), `isMultilineRegexSource` from `src/vs/editor/common/model/textModelSearch.ts` and the `parseReplaceString` escapes from `src/vs/editor/contrib/find/browser/replacePattern.ts`; its line-break handling (`crlfLineBreaks`) from `src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts` (`fixRegexNewline`, `fixNewline`)
  - `src/desktop/main/search/search-service.ts` (`findBufferMatches`) from `src/vs/editor/common/model/textModelSearch.ts`
  - `src/desktop/main/search/search-editor-format.ts` from `src/vs/workbench/contrib/searchEditor/browser/searchEditorSerialization.ts`
  - `src/desktop/shell/editor/search-result-language.ts` from `extensions/search-result/syntaxes/generateTMLanguage.js`
  - `src/desktop/main/search/rg-args.ts` (`splitGlobAware` and the include and exclude glob rules) from `src/vs/base/common/glob.ts`
  - `src/desktop/shell/terminal/pty-resize.ts` from `src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts` (the resize delay)
  - `src/desktop/main/terminal/terminal-service.ts` (the split group model: a pane right of its source, equal sizes after a split or a removal, the active pane after a removal, pane focus wrapping, Unsplit, Focus Next and Previous Terminal Group) from `src/vs/workbench/contrib/terminal/browser/terminalGroup.ts` and `terminalGroupService.ts`
  - `src/desktop/main/commands.ts` (the Split, Unsplit, Focus Pane, Focus Terminal Group and Resize Pane titles, keys and `when` clauses) from `src/vs/workbench/contrib/terminal/browser/terminalActions.ts`
  - `src/desktop/main/terminal/user-profiles.ts` and `executable-path.ts` (user profiles merged over detected ones, the first existing path, the PATH and PATHEXT lookup) from `src/vs/platform/terminal/node/terminalProfiles.ts` (`applyConfigProfilesToMap`, `validateProfilePaths`) and `src/vs/base/node/processes.ts` (`findExecutable`), and the `damocles.desktop.terminal.profiles` schema from `src/vs/platform/terminal/common/terminalPlatformConfiguration.ts`
  - `src/desktop/shell/terminal/terminal-split.ts` and `TerminalPanes.vue` (split pane sizing: SplitPaneMinSize, ResizePartCellCount, resizePane, distributeViewSizes) from `terminalGroup.ts`, and the sash resize order from `src/vs/base/browser/ui/splitview/splitview.ts`
  - `src/desktop/shell/terminal/TerminalList.vue` (the split group prefixes and aria label) from `src/vs/workbench/contrib/terminal/browser/terminalTabsList.ts`
  - `src/desktop/main/commands.ts` (`keyFires`) and `src/desktop/main/menu.ts` (an accelerator run as a keybinding resolved against its when clause) from `src/vs/platform/menubar/electron-main/menubar.ts`
  - `src/desktop/preload/file-names.ts` (`fileNameProblem`) from `src/vs/workbench/contrib/files/browser/fileActions.ts` (`validateFileName`), and the Files name box's Enter, Escape and blur rules in `src/desktop/shell/components/FilesSection.vue` from `src/vs/workbench/contrib/files/browser/views/explorerViewer.ts`
  - `src/desktop/main/documents/document-service.ts` (`moved`) and `src/desktop/main/editor-pane.ts` (`fileMoved`) from `src/vs/workbench/services/editor/browser/editorService.ts` (`handleMovedFile`); the orphaned document rules and the Deleted tab decoration from `src/vs/workbench/services/textfile/common/textFileEditorModel.ts` (`setOrphaned`) and `src/vs/workbench/services/textfile/browser/textFileService.ts`
  - `src/desktop/main/editor-pane.ts` (`showResolved`) and `src/desktop/shell/editor/ConflictBar.vue` (the Compare tab's actions) from `src/vs/workbench/contrib/files/browser/editors/textFileSaveErrorHandler.ts`
  - `src/desktop/main/documents/document-service.ts` (`openMissing`) and `src/desktop/main/editor-pane.ts` (`restoreBackup`) from `src/vs/workbench/services/textfile/common/textFileEditorModel.ts` (`resolveFromBackup`, `doResolveFromBackup`) and `src/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.ts` (`restoreBackups`)
  - `src/desktop/main/documents/confine.ts` (`confineOrCreateFolder`) from `src/vs/platform/files/common/fileService.ts` (`writeFile`, `mkdirp`)
  - `src/desktop/shell/editor/editor-store.ts` (`moveModel`) from `src/vs/workbench/services/textfile/common/textFileEditorModelManager.ts` (`onWillRunWorkingCopyFileOperation`, `onDidRunWorkingCopyFileOperation`), and the view-state carry-over from `src/vs/workbench/contrib/files/browser/editors/textFileEditor.ts` (`moveEditorViewState`)
  - `src/desktop/main/documents/document-service.ts` (`write`, `inTurn`) and `src/desktop/shell/editor/editor-store.ts` (`save`, `startSave`, `saveNow`) from `src/vs/workbench/services/textfile/common/textFileEditorModel.ts` (`doSave`, `handleSaveSuccess`, `saveSequentializer`) and `src/vs/base/common/async.ts` (`TaskSequentializer`)
  - `src/shared/text-search.ts` (`compareSearchResults`) from `src/vs/workbench/contrib/search/browser/searchCompare.ts` (`searchMatchComparer`) and `src/vs/base/common/comparers.ts` (`compareFileNames`, `compareFileExtensions`, `comparePaths`); its replace case operations from `src/vs/workbench/services/search/common/replace.ts` (`ReplacePattern`)
  - `src/desktop/quick-open-worker/file-search.ts` (scoring only the previous result set when a query extends it, and scoring in batches between event-loop turns) from `src/vs/workbench/services/search/node/rawSearchService.ts` (`getResultsFromCache`, `sortResults`)
  - `src/shared/relative-path.ts` (the reserved Windows names) from `src/vs/base/common/extpath.ts` (`WINDOWS_FORBIDDEN_NAMES`)
  - `src/desktop/main/terminal/terminal-env.ts` (`langFromLocale`, the `LANG` check, and the integration variables a terminal never inherits) from `src/vs/workbench/contrib/terminal/common/terminalEnvironment.ts` (`shouldSetLangEnvVariable`, `getLangEnvVariable`) and `src/vs/base/common/processes.ts` (`sanitizeProcessEnvironment`); the Windows launch failure codes in `src/desktop/main/terminal/terminal-service.ts` from `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts` (`parseExitResult`)
  - `src/desktop/main/editor-pane.ts` (diff titles from the file they show) from `src/vs/workbench/common/editor/diffEditorInput.ts` (`computeLabels`)
  - `src/desktop/main/files/file-tree.ts` (`delete`, `deletePermanently`) and `src/desktop/main/files/files-failure.ts` from `src/vs/workbench/contrib/files/browser/fileActions.ts` (`deleteFiles`)
  - `src/desktop/main/terminal/profiles.ts` from `src/vs/base/node/powershell.ts` (where PowerShell 7 is looked for, in order) and `src/vs/platform/terminal/node/terminalProfiles.ts` (WSL distros, Docker Desktop's skipped)
  - `src/desktop/shell/terminal/terminal-link-parsing.ts` and its tests from `src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts` and `test/browser/terminalLinkParsing.test.ts`; `src/desktop/shell/terminal/terminal-links.ts` from `terminalLocalLinkDetector.ts` and `terminalLinkHelpers.ts`; `src/desktop/main/terminal/terminal-links.ts` from `terminalLinkResolver.ts`
  - `src/desktop/main/terminal/terminal-paste.ts` from `src/vs/workbench/contrib/terminalContrib/clipboard/browser/terminalClipboard.ts`, with xterm.js's paste preparation (`src/browser/Clipboard.ts`)
  - `resources/shell-integration/` (`shellIntegration-bash.sh`, `shellIntegration-{env,profile,rc,login}.zsh`, `shellIntegration.fish`, `shellIntegration.ps1`) from `src/vs/workbench/contrib/terminal/common/scripts/`, each keeping VS Code's MIT header
  - `src/desktop/main/terminal/shell-integration-injection.ts` from `getShellIntegrationInjection` in `src/vs/platform/terminal/node/terminalEnvironment.ts`; `src/desktop/main/terminal/shell-integration.ts` (OSC 633 parsing and value escapes) from `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts`; the kill confirmation wording from `src/vs/workbench/contrib/terminal/browser/terminalService.ts`
  - `src/desktop/shell/terminal/terminal-commands.ts`, `terminal-marks.ts` and the command items of `terminal-menu.ts` from `src/vs/workbench/contrib/terminal/browser/xterm/markNavigationAddon.ts`, `decorationAddon.ts` and `src/vs/platform/terminal/common/capabilities/` (command and partial command detection)
  - `src/desktop/pty-host/sessions.ts` and the terminal channels' flow control from `src/vs/platform/terminal/node/terminalProcess.ts` and `src/vs/platform/terminal/common/terminal.ts` (the exit flush window, the conpty spawn and kill throttle, the ignored resize-after-exit errors, and the 100,000 / 5,000 / 5,000 watermarks)

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

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

## MCP TypeScript SDK

`@earendil-works/pi-mcp` adapts OAuth code from the MCP TypeScript SDK and ships the SDK's license as `LICENSES/modelcontextprotocol-typescript-sdk.txt`, which the VSIX and the desktop app keep. Damocles also ports the SDK's stdio environment allowlist (`DEFAULT_INHERITED_ENV_VARS` and `getDefaultEnvironment()`, from `@modelcontextprotocol/sdk` 1.29.0 `dist/esm/client/stdio.js`) into `src/core/pi-session/mcp/stdio-env.ts`, which esbuild bundles into `dist/extension.js` and `dist/desktop/main.js`. The SDK package itself is a development dependency and does not ship.

- **Source**: https://github.com/modelcontextprotocol/typescript-sdk (`@modelcontextprotocol/sdk`)

```
MIT License

Copyright (c) 2024 Anthropic, PBC

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

Damocles' MCP host layer (`src/core/pi-session/mcp/`) began as a port of pi-mcp-adapter. The protocol client, the stdio and streamable-HTTP transports and the OAuth authorization flow now come from `@earendil-works/pi-mcp`. These files still carry code adapted from pi-mcp-adapter and say so in their headers: `server-manager.ts` (the connection pool: connect dedup, tool and resource discovery), `lifecycle.ts` (health checks, reconnect and idle shutdown), `metadata-cache.ts`, `npx-resolver.ts`, `mcp-auth.ts` (OAuth credential storage), `mcp-callback-server.ts` (the localhost OAuth callback), `content.ts`, `elicitation-handler.ts` and `utils.ts`. The source repo's TUI, MCP-UI (`ui://` iframes / AppBridge / host HTTP server), single proxy `mcp` tool + proxy regex search, sampling handler, consent manager, slash commands, CLI, and onboarding state were dropped; the pi-runtime boundary was rewired onto Damocles' shared extension, central permission gate, `ExtensionUIContext`, and webview, and the `{server}_{tool}` tool-naming scheme was replaced with the `mcp__{server}__{tool}` scheme.

- **Source**: pi-mcp-adapter (`pi-mcp-adapter`)
- **Ported patterns**: connect dedup + 60s failure backoff + health checks + idle shutdown + keep-alive reconnect, paginated `tools/list`/`resources/list` collection, on-disk metadata cache keyed by config hash with atomic temp+rename writes, `${VAR}`/`$env:VAR` interpolation, npx/npm-exec real-binary resolution, OAuth credential storage + localhost callback server, MCP content → text/image block transformation, resource-name → `get_*` tool slugging, form elicitation request handling

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

The native web tools (`src/core/pi-session/web-access/`) port the key-free core of the pi-web-access extension — the free Exa MCP client (`web_search_exa` / `get_code_context_exa` over `https://mcp.exa.ai/mcp`, with SSE-or-JSON response parsing and the code-context → web-search fallback), the HTTP fetch + extraction pipeline (Readability over linkedom + Turndown, the dependency-free Next.js RSC flight-payload parser, the inline PDF text extractor via unpdf, and the `r.jina.ai` reader fallback). The source repo's keyed Exa Answer/Search API path, `~/.pi` usage tracking and config, activity monitor, Gemini/Perplexity providers, browser-cookie scraping, YouTube/video analysis, GitHub repo cloning, the curator browser UI, result storage + retrieval tool, and the slash commands/CLI were all dropped; the PDF extractor's `~/Downloads` write was removed (text is returned inline), and the tools were rewrapped as native per-session `pi.defineTool`s behind Damocles' central permission gate.

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

`WebFetch`'s extraction pipeline (`src/core/pi-session/web-access/extract.ts`) depends on four npm
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

The memory module (`src/core/memory/`) revamp is a conceptual, local-first reimplementation inspired by supermemory's published memory model. No supermemory code was incorporated — its core engine is closed-source and was not used; the graph storage mechanics are ported separately from code-review-graph (see Compass), and this implementation uses no embeddings or vector store.

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

The web tools' capability set for `FeedRead` and `YouTubeTranscript` (`src/core/pi-session/web-access/feed.ts`, `src/core/pi-session/web-access/youtube.ts`) was informed by Agent Reach's channel design — which capabilities are worth giving an agent (RSS/Atom feed reading, YouTube transcript retrieval) and which to leave out (social/auth platforms, the Whisper audio pipeline). No Agent Reach code was incorporated: it is a Python CLI/installer that routes an agent to external CLIs/MCP servers/public APIs, so it is not importable into this TypeScript extension. Only the *capability patterns* — what to build and, deliberately, what not to — were ported; the implementations here are original, dependency-free, and SSRF-guarded.

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

## smol-toml

Bundled and minified into `dist/extension.js`; used to read `~/.codex/config.toml`.
BSD-3-Clause requires this notice in binary redistributions.

https://github.com/squirrelchat/smol-toml

```
Copyright (c) Squirrel Chat et al., All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## Bundled runtime libraries (file locking, gitignore matching, desktop networking, watching and editing)

These npm packages ship inside the VSIX, the desktop app or both. esbuild bundles the first seven into the bundle each entry names (they are not externals), Vite bundles Monaco into the desktop app's `dist/webview/assets/monaco-*`, and electron-builder ships the last two as `node_modules` in the desktop app. Listed here for attribution and license compliance.

- **proper-lockfile** (v4.1.2) — MIT, Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio> — https://github.com/moxystudio/node-proper-lockfile
  — cross-process locks for config, auth and session-lease writes; bundled into `dist/extension.js` and `dist/desktop/main.js`.
- **graceful-fs** (v4.2.11) — ISC, Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors — https://github.com/isaacs/node-graceful-fs
  — proper-lockfile's file system layer; bundled with it.
- **signal-exit** (v3.0.7) — ISC, Copyright (c) 2015, Contributors — https://github.com/tapjs/signal-exit
  — releases proper-lockfile's locks on exit; bundled with it.
- **retry** (v0.12.0) — MIT, Copyright (c) 2011: Tim Koschützki (tim@debuggable.com), Felix Geisendörfer (felix@debuggable.com) — https://github.com/tim-kos/node-retry
  — proper-lockfile's retry backoff; bundled with it.
- **undici** (v8.10.2) — MIT, Copyright (c) Matteo Collina and Undici contributors — https://github.com/nodejs/undici
  — the desktop app's process-wide HTTP dispatcher and proxy support; bundled into `dist/desktop/main.js`.
- **picomatch** (v4.0.7) — MIT, Copyright (c) 2017-present, Jon Schlinkert. — https://github.com/micromatch/picomatch
  — glob matching for the desktop file watchers; bundled into `dist/desktop/main.js`.
- **ignore** (v7.0.12) — MIT, Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors — https://github.com/kaelzhang/node-ignore
  — gitignore-style path matching for permission rules; bundled into `dist/extension.js` and `dist/desktop/main.js`.
- **monaco-editor** (v0.57.0) — MIT, Copyright (c) 2016 - present Microsoft Corporation — https://github.com/microsoft/monaco-editor
  — the desktop app's file and diff editor. Monaco vendors further components (among them marked and DOMPurify); their notices are in Monaco's `ThirdPartyNotices.txt`, which the desktop app ships as `resources/monaco-editor-ThirdPartyNotices.txt`, and DOMPurify's license comment stays in the bundle.
- **electron-updater** (v6.8.9) — MIT, Copyright (c) 2015 Loopline Systems — https://github.com/electron-userland/electron-builder
  — the desktop app's update client; shipped as `node_modules/electron-updater` with its dependencies and their license files.
- **@parcel/watcher** (v2.6.0) — MIT, Copyright (c) 2017-present Devon Govett — https://github.com/parcel-bundler/watcher
  — the desktop app's native file watcher on macOS; shipped as `node_modules/@parcel/watcher` with its platform prebuild on macOS and Linux, and without a prebuild in the Windows package, where nothing loads it.

The desktop app also ships Electron (MIT, Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.), whose license and Chromium's third-party licenses (`LICENSE.electron.txt`, `LICENSES.chromium.html`) electron-builder packages with the app.

The MIT components are distributed under the following license, with the copyright line given for each above:

```
MIT License

Copyright (c) <year> <copyright holders>

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

The ISC components (graceful-fs, signal-exit) are distributed under the following license, with the copyright line given for each above:

```
ISC License

Copyright (c) <year> <copyright holders>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## Desktop terminal: xterm.js and node-pty — MIT

The desktop app's integrated terminal. Vite bundles xterm.js and its addons into the shell renderer (`dist/desktop-shell/`); electron-builder ships node-pty as `node_modules/node-pty` with its license file and only the target platform's prebuild.

- **@xterm/xterm** (v6.0.0) — MIT, Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js); Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com); Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/) — https://github.com/xtermjs/xterm.js
  — the terminal emulator.
- **@xterm/addon-fit** (v0.11.0) — MIT, Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
  — fitting the terminal to its pane.
- The URL pattern in `src/desktop/shell/terminal/terminal-links.ts` is adapted from **@xterm/addon-web-links** (v0.12.0) — MIT, Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js).
- **@xterm/addon-search** (v0.16.0) — MIT, Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)
  — find in the terminal.
- **@xterm/addon-unicode11** (v0.9.0) — MIT, Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
  — Unicode 11 character widths.
- **node-pty** (v1.2.0-beta.15) — MIT, Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/); Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com); Copyright (c) 2018 - present Microsoft Corporation — https://github.com/microsoft/node-pty
  — the pseudoterminal the pty host runs shells in. Its Windows prebuild includes `conpty.dll` and `OpenConsole.exe` from Microsoft's Windows Terminal (MIT, Copyright (c) Microsoft Corporation, https://github.com/microsoft/terminal).

These components are distributed under the MIT License, with the copyright lines given for each above:

```
MIT License

Copyright (c) <year> <copyright holders>

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

## English word frequencies (Google Books Ngram) — CC-BY-3.0

The memory injection gate bundles the Porter stems of the 49,104 most frequent single-token English words (`src/core/memory/injection/reference-stems.generated.ts`, generated from `english-reference.generated.ts`), used to tell ordinary English words from names and identifiers.

- **Source data**: Google Books Ngram Viewer, English 1-grams, version 20120701 (years 1950 to 2012), by Google, https://storage.googleapis.com/books/ngrams/books/datasetsv3.html
- **Intermediate list**: top-english-wordlists by david47k, https://github.com/david47k/top-english-wordlists (commit b7585f32cee8e140001054ad5b0bbf373245c360, `top_english_words_lower_50000.txt`)
- **License**: both the dataset and the compilation are licensed under Creative Commons Attribution 3.0 Unported (CC-BY-3.0), https://creativecommons.org/licenses/by/3.0/
- **Modifications**: filtered to lowercase `[a-z]{2,}` tokens, deduplicated and reduced to Porter stems by `scripts/generate-reference-words.mjs`. The source is a ranked word list with no frequency counts, and only the rank order is kept.
- **Attribution**: "English word frequencies from top-english-wordlists by david47k, derived from the Google Books Ngram dataset by Google, both licensed under CC-BY-3.0." The same attribution ships in the extension bundle as a legal comment.

---

## Software vocabulary (cspell-dicts) — MIT

The memory injection gate bundles the Porter stems of 3,682 software words absent from the English list above (`reference-stems.generated.ts`, generated from `software-reference.generated.ts`), such as `repo`, `json` and `regex`, so that everyday software vocabulary is not mistaken for a name.

- **Source**: cspell-dicts by Street Side Software, https://github.com/streetsidesoftware/cspell-dicts (commit 1d7d9f649f61c9402050a3a56450337bf165c1ba): `@cspell/dict-software-terms` 5.4.5 (`software-terms.txt`, `coding-terms.txt`, `computing-acronyms.txt`, `software-tools.txt`, `software-services.txt`, `network-protocols.txt`, `network-os.txt`, `cybersecurity-terms.txt`) and `@cspell/dict-filetypes` 3.0.18 (`filetypes.txt`)
- **Modifications**: comments and forbidden-word entries removed, lowercased, filtered to `[a-z]{2,}` tokens, deduplicated, words already in the English list removed, and reduced to Porter stems, by `scripts/generate-reference-words.mjs`. The same license notice ships in the extension bundle as a legal comment.

```
The MIT License (MIT)

Copyright (c) 2017-2025 Street Side Software <support@streetsidesoftware.nl>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
---

## Desktop fonts: Geist, Geist Mono and Inter — OFL-1.1

The desktop app ships the upright variable woff2 subsets of Geist and Geist Mono and the Greek subsets of Inter in `dist/desktop-shell/fonts/` (`src/desktop/main/desktop-fonts.ts`), each with its license text beside it. The fonts come from the Fontsource packages `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` and `@fontsource-variable/inter` 5.3.0 (https://github.com/fontsource/font-files) and are unmodified. The VS Code extension ships no font.

- **Geist and Geist Mono**: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)
- **Inter**: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

The three fonts are licensed under the SIL Open Font License, Version 1.1:

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## Provider logos: Lobe Icons — MIT

The model provider logos in `src/webview/components/icons/provider-logos.ts` (Anthropic Claude, OpenAI, DeepSeek, StepFun, OpenRouter and Google Gemini) are SVGs copied from `@lobehub/icons-static-svg` 1.45.0 (https://github.com/lobehub/lobe-icons), with their `<title>` and sizing attributes removed. The logos are trademarks of their respective owners.

```
MIT License

Copyright (c) 2023 LobeHub

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
