import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { log } from "../logger";
import { processLauncher, type LaunchedProcess } from "../process-launcher";
import { posixTool, windowsPowerShell } from "../system-tools";

export interface RecordingResult {
  audioBuffer: Buffer;
  mimeType: string;
}

interface Recorder {
  readonly process: LaunchedProcess;
  exited: boolean;
}

let activeProcess: Recorder | null = null;
let tempFilePath = "";
let tempScriptPath = "";
let recording = false;
// e2e hooks only (e2e.fakeVoice): a stand-in recorder started through the same launcher, so it is this core's child
let e2eTranscript: string | undefined;
let e2eStarts = 0;
let e2eRecorderPid: number | null = null;

/** e2e hooks only: from now on recording starts a stand-in recorder and the transcript is `transcript`. */
export function fakeVoiceForE2e(transcript: string): void {
  e2eTranscript = transcript;
}

/** e2e hooks only: the stand-in transcript, undefined while recording is real. */
export function e2eFakeTranscript(): string | undefined {
  return e2eTranscript;
}

export function e2eVoiceRecorder(): { starts: number; recorderPid: number | null } {
  return { starts: e2eStarts, recorderPid: e2eRecorderPid };
}

export function isRecording(): boolean {
  return recording;
}

export async function startRecording(): Promise<void> {
  if (recording) throw new Error("Already recording");

  tempFilePath = path.join(os.tmpdir(), `damocles-voice-${Date.now()}.wav`);

  if (e2eTranscript !== undefined) {
    await startFakeRecording(tempFilePath);
  } else if (process.platform === "win32") {
    await startWindowsRecording(tempFilePath);
  } else if (process.platform === "darwin") {
    await startMacRecording(tempFilePath);
  } else if (process.platform === "linux") {
    await startLinuxRecording(tempFilePath);
  } else {
    throw new Error(
      `Voice recording is not supported on ${process.platform}`,
    );
  }

  recording = true;
}

export async function stopRecording(): Promise<RecordingResult> {
  if (!recording) throw new Error("Not recording");

  await stopActiveProcess();
  recording = false;

  const audioBuffer = await fs.promises.readFile(tempFilePath);
  cleanupTempFiles();

  return { audioBuffer, mimeType: "audio/wav" };
}

export function cancelRecording(): void {
  if (!recording) return;

  if (activeProcess) {
    activeProcess.process.kill();
    activeProcess = null;
  }
  recording = false;
  cleanupTempFiles();
}

function cleanupTempFiles(): void {
  fs.promises.unlink(tempFilePath).catch(() => {});
  if (tempScriptPath) {
    fs.promises.unlink(tempScriptPath).catch(() => {});
    tempScriptPath = "";
  }
}

// writes a 44-byte empty 16 kHz mono WAV at argv[1] once stdin has a line
const FAKE_RECORDER = `const fs=require('fs');process.stdout.write('RECORDING_STARTED\\n');process.stdin.once('data',()=>{const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(0,40);fs.writeFileSync(process.argv[1],h);process.exit(0);});`;

async function startFakeRecording(outputPath: string): Promise<void> {
  await spawnRecorder(process.execPath, ["-e", FAKE_RECORDER, outputPath], { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
  e2eStarts++;
  e2eRecorderPid = activeProcess ? await activeProcess.process.pid : null;
}

function spawnRecorder(command: string, args: string[], env?: Readonly<Record<string, string | undefined>>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = processLauncher().launch({ file: command, args, stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
    const recorder: Recorder = { process: proc, exited: false };
    activeProcess = recorder;

    let resolved = false;
    let stderrOutput = "";

    proc.onData("stdout", (data) => {
      const output = data.toString().trim();
      log("[Recorder] stdout:", output);
      if (output.includes("RECORDING_STARTED") && !resolved) {
        resolved = true;
        resolve();
      }
    });

    proc.onData("stderr", (data) => {
      stderrOutput += data.toString();
      log("[Recorder] stderr:", data.toString().trim());
    });

    const ended = (): void => {
      recorder.exited = true;
    };
    proc.exited.then(ended, ended);
    Promise.all([proc.exited, proc.closed]).then(([{ code }]) => {
      log("[Recorder] process closed with code:", code);
      if (!resolved) {
        resolved = true;
        reject(
          new Error(
            code !== 0
              ? stderrOutput.trim() ||
                `Recording process exited with code ${code}`
              : "Recording process exited without starting",
          ),
        );
      }
    }, (err: unknown) => {
      log("[Recorder] process error:", err);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        reject(new Error("Recording process startup timed out"));
      }
    }, 15_000);
  });
}

function startWindowsRecording(outputPath: string): Promise<void> {
  const psPath = outputPath.replace(/'/g, "''");

  const script = `$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinMM {
    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    public static extern int mciSendString(string lpszCommand, StringBuilder lpszReturnString, int cchReturn, IntPtr hwndCallback);
}
"@
$sb = New-Object System.Text.StringBuilder 256
$outFile = '${psPath}'
$r = [WinMM]::mciSendString("open new type waveaudio alias dmrec", $sb, 256, [IntPtr]::Zero)
if ($r -ne 0) { Write-Error "Failed to open audio device (MCI error $r)"; exit 1 }
$r = [WinMM]::mciSendString("record dmrec", $sb, 256, [IntPtr]::Zero)
if ($r -ne 0) {
  [WinMM]::mciSendString("close dmrec", $sb, 256, [IntPtr]::Zero)
  Write-Error "Failed to start recording (MCI error $r)"
  exit 1
}
Write-Output "RECORDING_STARTED"
$null = [Console]::In.ReadLine()
[WinMM]::mciSendString("stop dmrec", $sb, 256, [IntPtr]::Zero)
$saveCmd = 'save dmrec "' + $outFile + '"'
[WinMM]::mciSendString($saveCmd, $sb, 256, [IntPtr]::Zero)
[WinMM]::mciSendString("close dmrec", $sb, 256, [IntPtr]::Zero)
Write-Output "RECORDING_SAVED"`;

  return spawnRecorder(windowsPowerShell(), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
}

function startMacRecording(outputPath: string): Promise<void> {
  const swiftScript = `import AVFoundation
import Foundation

let outputPath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: outputPath)
let semaphore = DispatchSemaphore(value: 0)
var micGranted = false
AVCaptureDevice.requestAccess(for: .audio) { granted in
    micGranted = granted
    semaphore.signal()
}
semaphore.wait()
guard micGranted else {
    FileHandle.standardError.write("Microphone access denied. Grant permission in System Settings > Privacy & Security > Microphone.\\n".data(using: .utf8)!)
    exit(1)
}
let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 44100.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false
]
do {
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    guard recorder.record() else {
        FileHandle.standardError.write("Failed to start recording\\n".data(using: .utf8)!)
        exit(1)
    }
    print("RECORDING_STARTED")
    fflush(stdout)
    _ = readLine()
    recorder.stop()
    print("RECORDING_SAVED")
} catch {
    FileHandle.standardError.write("Recording error: \\(error.localizedDescription)\\n".data(using: .utf8)!)
    exit(1)
}`;

  tempScriptPath = path.join(
    os.tmpdir(),
    `damocles-recorder-${Date.now()}.swift`,
  );
  fs.writeFileSync(tempScriptPath, swiftScript);

  // macOS's own shim, which runs the Command Line Tools' swift or offers to install them
  return spawnRecorder("/usr/bin/swift", [tempScriptPath, outputPath]).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Swift not found. Install Xcode Command Line Tools: xcode-select --install",
      );
    }
    throw err;
  });
}

function startLinuxRecording(outputPath: string): Promise<void> {
  const script = `OUTPUT="$1"
if command -v arecord >/dev/null 2>&1; then
  arecord -f S16_LE -r 44100 -c 1 -t wav -q "$OUTPUT" &
elif command -v parecord >/dev/null 2>&1; then
  parecord --format=s16le --rate=44100 --channels=1 --file-format=wav "$OUTPUT" &
elif command -v pw-record >/dev/null 2>&1; then
  pw-record --format=s16 --rate=44100 --channels=1 "$OUTPUT" &
else
  echo "No audio recorder found. Install alsa-utils (arecord), pulseaudio-utils (parecord), or pipewire (pw-record)." >&2
  exit 1
fi
RECORDER_PID=$!
sleep 0.2
if ! kill -0 $RECORDER_PID 2>/dev/null; then
  echo "Audio recorder failed to start" >&2
  exit 1
fi
trap 'kill -INT $RECORDER_PID 2>/dev/null; wait $RECORDER_PID 2>/dev/null' EXIT
echo "RECORDING_STARTED"
read -r
kill -INT $RECORDER_PID 2>/dev/null
wait $RECORDER_PID 2>/dev/null
trap - EXIT
echo "RECORDING_SAVED"`;

  const bash = posixTool("bash");
  if (bash === undefined) return Promise.reject(new Error("bash was not found"));
  return spawnRecorder(bash, ["-c", script, "_", outputPath]);
}

function stopActiveProcess(): Promise<void> {
  return new Promise((resolve, reject) => {
    const recorder = activeProcess;
    if (!recorder) {
      resolve();
      return;
    }

    if (recorder.exited) {
      activeProcess = null;
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      recorder.process.kill();
      activeProcess = null;
      reject(new Error("Stop recording timed out"));
    }, 10_000);

    const closed = (): void => {
      clearTimeout(timeout);
      activeProcess = null;
      resolve();
    };
    recorder.process.closed.then(closed, closed);

    recorder.process.end("\n");
  });
}
