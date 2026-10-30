import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../__mocks__/source-tree";
import { renderLocalizedText, type LocalizedText } from "../../../../shared/localized-text";
import { getCxxInstallInstructions } from "../compiler-check";
import { checkRuntimeModeCompatibility, smokeFailureText } from "../index";
import { downloadWithResumeAndVerify } from "../python-installer";
import { getPortAudioInstallInstructions } from "../system-libs-check";

// The voice runtime's failures are Damocles' own sentences, each translated, with only the foreign part (a command, a path,
// a traceback) as written.
const GREEK = JSON.parse(readFileSync(path.join(REPO_ROOT, "l10n", "bundle.l10n.el.json"), "utf8")) as Record<string, string>;
const greek = (text: LocalizedText): string => renderLocalizedText(text, (key) => GREEK[key], "el");

describe("the voice runtime's failures in Greek", () => {
  it("words the CUDA refusal and its reason", () => {
    const result = checkRuntimeModeCompatibility({ kind: "cpu", reason: "driver-too-old" }, "cuda");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(greek(result.message)).toBe(
      "Η προτίμηση GPU για τη φωνή είναι «cuda», αλλά το CUDA δεν μπορεί να χρησιμοποιηθεί εδώ. Το πρόγραμμα οδήγησης NVIDIA είναι παλαιότερο από το 525.x, την ελάχιστη έκδοση για το πακέτο torch cu118. Εγκαταστήστε ή ενημερώστε το πρόγραμμα οδήγησης NVIDIA και βεβαιωθείτε ότι το nvidia-smi μπορεί να βρεθεί, ή ορίστε την προτίμηση GPU (damocles.voice.localGpu) σε «auto» (συνιστάται) ή «cpu».",
    );
  });

  it("words a failed import check around Python's own traceback and the log's path", () => {
    const text = smokeFailureText({ ok: false, stderr: "Traceback (most recent call last):\nImportError: no torch", exitCode: 1, failedModule: "torch", logPath: "/v/smoke.log" });
    expect(greek(text)).toBe("Ο έλεγχος του περιβάλλοντος εκτέλεσης φωνής απέτυχε κατά την εισαγωγή του torch.\nTraceback (most recent call last):\nImportError: no torch\nΤο πλήρες ίχνος στοίβας γράφτηκε στο /v/smoke.log");
  });

  it("words the build tool and PortAudio instructions, keeping their commands as written", () => {
    expect(greek(getCxxInstallInstructions("darwin"))).toBe(
      "Το περιβάλλον εκτέλεσης φωνής χρειάζεται μεταγλωττιστή C++ για να δημιουργήσει το texterrors, για το οποίο δεν υπάρχει έτοιμο πακέτο για macOS με Python 3.11.\nΕγκαταστήστε τα Xcode Command Line Tools:\n  xcode-select --install",
    );
    expect(greek(getPortAudioInstallInstructions("linux"))).toMatch(/^Το περιβάλλον εκτέλεσης φωνής χρειάζεται το PortAudio για την είσοδο μικροφώνου, το οποίο δεν περιλαμβάνεται στο πακέτο sounddevice για Linux\.\nΕγκαταστήστε το πακέτο PortAudio της διανομής σας:\n {2}Debian \/ Ubuntu \/ WSL: {2}sudo apt update && sudo apt install libportaudio2\n/);
  });

  it("formats the downloaded megabytes in the reader's locale", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "damocles-download-"));
    try {
      const bytes = new Uint8Array(1.5 * 1024 * 1024);
      const messages: string[] = [];
      await downloadWithResumeAndVerify({
        url: "https://example.invalid/python.tar.gz",
        destFile: path.join(dir, "python.tar.gz"),
        expectedSha256: "PLACEHOLDER_test",
        onProgress: (progress) => messages.push(greek(progress.message)),
        fetchImpl: (async () => new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } })) as typeof fetch,
      });
      expect(messages.at(-1)).toBe("Λήφθηκαν 1,5 MB από 1,5 MB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
