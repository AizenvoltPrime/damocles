import * as vscode from "vscode";

let channel: vscode.OutputChannel | null = null;

export function getVoiceOutputChannel(): vscode.OutputChannel {
  if (channel === null) {
    channel = vscode.window.createOutputChannel("Damocles Voice");
  }
  return channel;
}

// Heuristic for "this stderr line is interesting even outside
// diagnostics mode". Errors and warnings from torch / NeMo / our own
// logger are surfaced; verbose info-level chatter ("Detected CUDA",
// "Loading checkpoint…", thousands of tqdm-style progress lines) is
// suppressed unless the user explicitly opts into diagnostics.
const ALWAYS_SHOW_RE = /\b(error|exception|traceback|failed|fatal|warning|cuda oom|importerror|modulenotfounderror)\b/i;

export function appendSidecarLine(line: string, diagnostics: boolean): void {
  if (channel === null) return;
  const trimmed = line.trimEnd();
  if (trimmed.length === 0) return;
  if (diagnostics && trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      channel.appendLine(JSON.stringify(parsed, null, 2));
      return;
    } catch {
      /* fall through to raw line */
    }
  }
  if (!diagnostics && !ALWAYS_SHOW_RE.test(trimmed)) {
    return;
  }
  channel.appendLine(trimmed);
}

export function disposeVoiceOutputChannel(): void {
  if (channel !== null) {
    channel.dispose();
    channel = null;
  }
}
