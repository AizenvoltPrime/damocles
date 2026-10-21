import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installProcessLauncher, type Launcher, type OutputStream, type ProcessExit } from "../../../process-launcher";
import { CAPTURE_TAIL_LENGTH, CancelledError, createVenv, installPipRequirements } from "../python-installer";

// Every start prints `output` and exits with `code`.
function scriptedLauncher(output: Array<[OutputStream, string | Buffer]>, code: number): Launcher {
  return {
    launch() {
      const listeners: Record<OutputStream, Array<(chunk: Buffer) => void>> = { stdout: [], stderr: [] };
      const exited = new Promise<ProcessExit>((resolve) =>
        setImmediate(() => {
          for (const [stream, text] of output) for (const listener of listeners[stream]) listener(typeof text === "string" ? Buffer.from(text) : text);
          resolve({ code, signal: null });
        }),
      );
      return {
        pid: Promise.resolve(1),
        onData: (stream, listener) => void listeners[stream].push(listener),
        write: () => Promise.resolve(),
        end: () => undefined,
        exited,
        closed: exited.then(() => undefined),
        kill: () => undefined,
      };
    },
    createSessionJob: () => {
      throw new Error("not used");
    },
    dispose: async () => undefined,
  };
}

let previous: Launcher | undefined;
beforeEach(() => {
  previous = undefined;
});
afterEach(() => {
  if (previous) installProcessLauncher(previous);
});

function useLauncher(launcher: Launcher): void {
  previous = installProcessLauncher(launcher);
}

describe("pip output capture", () => {
  it("keeps at most a 64 KiB tail of carriage-return progress output", async () => {
    const progress = Array.from({ length: 20_000 }, (_, i) => `\r   Downloading torch ${i} of 20000 |████████`).join("");
    expect(progress.length).toBeGreaterThan(CAPTURE_TAIL_LENGTH * 10);
    const chunks: Array<[OutputStream, string]> = [];
    for (let i = 0; i < progress.length; i += 16_384) chunks.push(["stderr", progress.slice(i, i + 16_384)]);
    chunks.push(["stderr", "\rError: venv failed\n"]);
    useLauncher(scriptedLauncher(chunks, 1));

    const failure = await createVenv({ pythonExe: "python", venvDir: "venv-not-created" }).then(
      () => null,
      (err: Error) => err.message,
    );

    const prefix = "python -m venv failed (1): ";
    expect(failure?.startsWith(prefix)).toBe(true);
    expect(failure!.length - prefix.length).toBeLessThanOrEqual(CAPTURE_TAIL_LENGTH);
    expect(failure!.endsWith("\rError: venv failed\n")).toBe(true);
  });

  it("reports each carriage-return progress update as its own line", async () => {
    useLauncher(scriptedLauncher([["stdout", "Collecting pip\r 10%\r 55%\r\n100%\rdone"]], 0));
    const messages: string[] = [];

    await expect(
      installPipRequirements({
        venvPython: "python",
        requirementsFile: "requirements.txt",
        gpuKind: "cpu",
        onProgress: (p) => messages.push(p.message),
      }),
    ).resolves.toBeUndefined();

    expect(messages.slice(1, 6)).toEqual(["Collecting pip", " 10%", " 55%", "100%", "done"]);
  });

  it("keeps a last line that ends partway through a UTF-8 character", async () => {
    const accent = Buffer.from("é", "utf8");
    useLauncher(scriptedLauncher([
      ["stdout", Buffer.concat([Buffer.from("caf"), accent.subarray(0, 1)])],
      ["stdout", Buffer.concat([accent.subarray(1), Buffer.from(" done ")])],
      ["stdout", accent.subarray(0, 1)],
    ], 0));
    const messages: string[] = [];

    await installPipRequirements({ venvPython: "python", requirementsFile: "requirements.txt", gpuKind: "cpu", onProgress: (p) => messages.push(p.message) });

    expect(messages[1]).toBe("café done \uFFFD");
  });

  it("ends a pip run the abort killed as a cancel, not as a pip failure", async () => {
    useLauncher(scriptedLauncher([["stderr", "Downloading torch\r"]], 1));
    const controller = new AbortController();
    controller.abort();

    await expect(
      installPipRequirements({ venvPython: "python", requirementsFile: "requirements.txt", gpuKind: "cpu", signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it("shows the last 30 lines of a failed pip run", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const breaks = ["\r\n", "\r", "\n"];
    useLauncher(scriptedLauncher([["stdout", lines.map((line, i) => line + breaks[i % 3]).join("")]], 2));

    const failure = await installPipRequirements({ venvPython: "python", requirementsFile: "requirements.txt", gpuKind: "cpu" }).then(
      () => null,
      (err: Error) => err.message,
    );

    expect(failure).toBe(`pip bootstrap failed (exit 2):\n${lines.slice(-30).join("\n")}`);
  });
});
