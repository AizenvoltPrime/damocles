import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TS_PATH = join(
  REPO_ROOT,
  "src",
  "extension",
  "chat-panel",
  "message-router",
  "handlers",
  "voice-stream-handlers.ts",
);
const PY_PATH = join(
  REPO_ROOT,
  "python",
  "damocles_voice_sidecar",
  "damocles_voice_sidecar",
  "pipeline.py",
);

// Capture the literal between the slashes in `const WAKE_PREFIX_RE = /…/i;`
const TS_PATTERN = /const\s+WAKE_PREFIX_RE\s*=\s*\/(.+?)\/([gimsuy]*)\s*;/;
// Capture the raw string literal in `WAKE_PREFIX_RE = re.compile(r"…", re.IGNORECASE)`
const PY_PATTERN =
  /WAKE_PREFIX_RE\s*=\s*re\.compile\(\s*r"([^"]+)"\s*,\s*([A-Za-z._]+)\s*\)/;

function extractTs(): { source: string; flags: string } {
  const text = readFileSync(TS_PATH, "utf8");
  const match = TS_PATTERN.exec(text);
  if (match === null) {
    throw new Error(`Could not locate WAKE_PREFIX_RE in ${TS_PATH}`);
  }
  return { source: match[1]!, flags: match[2]! };
}

function extractPy(): { source: string; flags: string } {
  const text = readFileSync(PY_PATH, "utf8");
  const match = PY_PATTERN.exec(text);
  if (match === null) {
    throw new Error(`Could not locate WAKE_PREFIX_RE in ${PY_PATH}`);
  }
  return { source: match[1]!, flags: match[2]! };
}

describe("WAKE_PREFIX_RE parity", () => {
  // The TS handler and the Python pipeline strip the wake phrase from
  // the transcript independently — two-layer defense for FR-11. If the
  // two regex literals drift the defense becomes asymmetric: a phrase
  // accepted by one and not the other would either leak the wake word
  // through to the model OR get double-stripped on benign text.
  it("source patterns are byte-identical", () => {
    const ts = extractTs();
    const py = extractPy();
    expect(py.source).toBe(ts.source);
  });

  it("both sides apply case-insensitive matching", () => {
    const ts = extractTs();
    const py = extractPy();
    expect(ts.flags).toContain("i");
    expect(py.flags).toContain("IGNORECASE");
  });

  it("compiled TS regex strips canonical inputs", () => {
    const ts = extractTs();
    const re = new RegExp(ts.source, ts.flags);
    expect("Jarvis, build it".replace(re, "")).toBe("build it");
    expect("hey jarvis run tests".replace(re, "")).toBe("run tests");
    expect("HEY JARVIS. ship".replace(re, "")).toBe("ship");
    expect("nothing to strip".replace(re, "")).toBe("nothing to strip");
  });
});
